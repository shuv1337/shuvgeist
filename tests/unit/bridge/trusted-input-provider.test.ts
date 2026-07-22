import { describe, expect, it } from "vitest";
import { TrustedInputProvider } from "@shuvgeist/driver/trusted-input-provider";
import type {
	CdpSession,
	CdpSessionCloseListener,
	CdpSessionDomain,
	CdpSessionEnsureDomainOptions,
	CdpSessionEventListener,
	CdpSessionTarget,
	CdpSessionTraceOptions,
} from "@shuvgeist/driver/cdp-session";

class FakeCdpSession implements CdpSession {
	readonly target: CdpSessionTarget = { kind: "electron-ws", id: "fake" };
	readonly navigationGeneration = 0;
	readonly ensureDomainCalls: Array<{ domain: CdpSessionDomain; options?: CdpSessionEnsureDomainOptions }> = [];
	readonly sentCommands: Array<{ method: string; params?: Record<string, unknown> }> = [];

	async acquire(_owner: string, _trace?: CdpSessionTraceOptions): Promise<void> {}

	async release(_owner: string, _trace?: CdpSessionTraceOptions): Promise<void> {}

	async ensureDomain(domain: CdpSessionDomain, options?: CdpSessionEnsureDomainOptions): Promise<void> {
		this.ensureDomainCalls.push({ domain, options });
	}

	async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
		this.sentCommands.push({ method, params });
		return undefined as T;
	}

	onEvent(_method: string, _listener: CdpSessionEventListener): () => void {
		return () => {};
	}

	onClose(_listener: CdpSessionCloseListener): () => void {
		return () => {};
	}
}

describe("TrustedInputProvider", () => {
	it("dispatches trusted mouse input without enabling Runtime on the action path", async () => {
		const session = new FakeCdpSession();
		const provider = new TrustedInputProvider(session);

		const result = await provider.click({ x: 120, y: 72 });

		expect(result).toEqual({
			ok: true,
			point: { x: 120, y: 72 },
			methods: ["Input.dispatchMouseEvent", "Input.dispatchMouseEvent"],
		});
		expect(session.ensureDomainCalls).toEqual([]);
		expect(session.sentCommands.map((command) => command.method)).toEqual([
			"Input.dispatchMouseEvent",
			"Input.dispatchMouseEvent",
		]);
		expect(session.sentCommands).not.toContainEqual(expect.objectContaining({ method: "Runtime.enable" }));
	});

	it("rejects non-finite coordinates before sending input", async () => {
		const session = new FakeCdpSession();
		const provider = new TrustedInputProvider(session);

		await expect(provider.click({ x: Number.NaN, y: 1 })).rejects.toThrow("finite coordinates");
		expect(session.sentCommands).toEqual([]);
	});
});
