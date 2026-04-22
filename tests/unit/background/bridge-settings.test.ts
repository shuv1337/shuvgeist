import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapTokenIfNeeded, getBootstrapUrl } from "../../../src/bridge/bootstrap.js";
import {
	getDefaultBridgeSettings,
	loadBridgeSettings,
	readLegacyBridgeSettingsFromIndexedDb,
	settingsRequireReconnect,
} from "../../../src/bridge/settings.js";
import type { BridgeSettings } from "../../../src/bridge/internal-messages.js";

describe("bridge settings helpers", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("creates default bridge settings for auto-connect local mode", () => {
		expect(getDefaultBridgeSettings()).toEqual({
			enabled: true,
			url: "ws://127.0.0.1:19285/ws",
			token: "",
			sensitiveAccessEnabled: false,
			observability: {
				enabled: false,
				ingestUrl: "http://localhost:3474",
				publicIngestKey: "",
			},
		});
	});

	it("loads existing local settings without reseeding storage", async () => {
		const adapter = {
			getLocalSettings: vi.fn<() => Promise<BridgeSettings | undefined>>().mockResolvedValue({
				enabled: false,
				url: "ws://bridge.example/ws",
				token: "manual-token",
				sensitiveAccessEnabled: true,
				observability: {
					enabled: true,
					ingestUrl: "http://localhost:3474",
					publicIngestKey: "maple_pk_demo",
				},
			}),
			setLocalSettings: vi.fn<(_: BridgeSettings) => Promise<void>>(),
		};

		const result = await loadBridgeSettings(adapter, async () => {
			throw new Error("legacy read should not run");
		});

		expect(result).toEqual({
			settings: {
				enabled: false,
				url: "ws://bridge.example/ws",
				token: "manual-token",
				sensitiveAccessEnabled: true,
				observability: {
					enabled: true,
					ingestUrl: "http://localhost:3474",
					publicIngestKey: "maple_pk_demo",
				},
			},
			source: "local",
			seededLocalStorage: false,
		});
		expect(adapter.setLocalSettings).not.toHaveBeenCalled();
	});

	it("migrates legacy IndexedDB settings exactly once when local settings are absent", async () => {
		const adapter = {
			getLocalSettings: vi.fn<() => Promise<BridgeSettings | undefined>>().mockResolvedValue(undefined),
			setLocalSettings: vi.fn<(_: BridgeSettings) => Promise<void>>().mockResolvedValue(undefined),
		};

		const result = await loadBridgeSettings(adapter, async () => ({
			enabled: false,
			url: "ws://192.168.1.50:19285/ws",
			token: "legacy-token",
			sensitiveAccessEnabled: true,
		}));

		expect(result).toEqual({
			settings: {
				enabled: false,
				url: "ws://192.168.1.50:19285/ws",
				token: "legacy-token",
				sensitiveAccessEnabled: true,
				observability: {
					enabled: false,
					ingestUrl: "http://localhost:3474",
					publicIngestKey: "",
				},
			},
			source: "legacy",
			seededLocalStorage: true,
		});
		expect(adapter.setLocalSettings).toHaveBeenCalledTimes(1);
	});

	it("falls back to defaults when local and legacy settings are absent", async () => {
		const adapter = {
			getLocalSettings: vi.fn<() => Promise<BridgeSettings | undefined>>().mockResolvedValue(undefined),
			setLocalSettings: vi.fn<(_: BridgeSettings) => Promise<void>>().mockResolvedValue(undefined),
		};

		const result = await loadBridgeSettings(adapter, async () => null);
		expect(result.settings).toEqual(getDefaultBridgeSettings());
		expect(result.source).toBe("defaults");
		expect(result.seededLocalStorage).toBe(true);
	});

	it("reads legacy bridge settings from IndexedDB out-of-line keys", async () => {
		const store = {
			get(key: string) {
				const request = {} as IDBRequest;
				queueMicrotask(() => {
					request.result = {
						"bridge.enabled": false,
						"bridge.url": "ws://remote-bridge/ws",
						"bridge.token": "legacy-token",
						"bridge.sensitiveAccessEnabled": true,
					}[key];
					request.onsuccess?.({ target: request } as Event);
				});
				return request;
			},
		} as unknown as IDBObjectStore;
		const database = {
			objectStoreNames: { contains: (name: string) => name === "settings" },
			transaction: () => ({ objectStore: () => store }),
			close: vi.fn(),
		} as unknown as IDBDatabase;
		const openRequest = {} as IDBOpenDBRequest;
		const indexedDbFactory = {
			open: vi.fn(() => {
				queueMicrotask(() => {
					openRequest.result = database;
					openRequest.onsuccess?.({ target: openRequest } as Event);
				});
				return openRequest;
			}),
		};

		await expect(readLegacyBridgeSettingsFromIndexedDb(indexedDbFactory)).resolves.toEqual({
			enabled: false,
			url: "ws://remote-bridge/ws",
			token: "legacy-token",
			sensitiveAccessEnabled: true,
		});
		expect(database.close).toHaveBeenCalled();
	});

	it("bootstraps the loopback token when the local bridge is enabled and tokenless", async () => {
		const settings = getDefaultBridgeSettings();
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ version: 1, token: "bootstrapped-token" }),
			text: async () => "",
		}));

		const result = await bootstrapTokenIfNeeded(settings, fetchImpl);
		expect(fetchImpl).toHaveBeenCalledWith(getBootstrapUrl(settings.url), {
			method: "GET",
			headers: { "X-Shuvgeist-Bootstrap": "1" },
		});
		expect(result).toEqual({
			settings: { ...settings, token: "bootstrapped-token" },
			persistedToken: true,
			attemptedBootstrap: true,
		});
	});

	it("skips bootstrap for non-loopback URLs", async () => {
		const fetchImpl = vi.fn();
		const result = await bootstrapTokenIfNeeded(
			{ ...getDefaultBridgeSettings(), url: "ws://192.168.1.8:19285/ws" },
			fetchImpl,
		);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(result.attemptedBootstrap).toBe(false);
	});

	it("skips bootstrap when a token already exists", async () => {
		const fetchImpl = vi.fn();
		const result = await bootstrapTokenIfNeeded(
			{ ...getDefaultBridgeSettings(), token: "manual-token" },
			fetchImpl,
		);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(result.settings.token).toBe("manual-token");
	});

	it("detects reconnect-worthy bridge settings changes", () => {
		const base = getDefaultBridgeSettings();
		expect(settingsRequireReconnect(null, base)).toBe(true);
		expect(settingsRequireReconnect(base, { ...base })).toBe(false);
		expect(settingsRequireReconnect(base, { ...base, url: "ws://192.168.1.10:19285/ws" })).toBe(true);
		expect(settingsRequireReconnect(base, { ...base, token: "x" })).toBe(true);
		expect(settingsRequireReconnect(base, { ...base, sensitiveAccessEnabled: true })).toBe(true);
		expect(settingsRequireReconnect(base, { ...base, enabled: false })).toBe(true);
		expect(
			settingsRequireReconnect(base, {
				...base,
				observability: { ...base.observability, enabled: true },
			}),
		).toBe(false);
	});
});
