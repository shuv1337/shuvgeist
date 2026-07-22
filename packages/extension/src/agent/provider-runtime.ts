import type { StreamFn } from "@shuv1337/pi-agent-core";
import { type Api, getModels, getProviders, type KnownProvider, type Model, registerModels } from "@shuv1337/pi-ai";
import { createStreamFn } from "@shuv1337/pi-web-ui";
import type { CustomProvider } from "@shuv1337/pi-web-ui/storage/stores/custom-providers-store.js";
import { resolveApiKey } from "../oauth/index.js";
import { BUNDLED_FREE_TIER_PROVIDER, createBundledFreeTierModel } from "../providers/free-tier.js";
import {
	normalizeModelForRuntime,
	resolveDefaultModel,
	resolveProviderCredential,
} from "../sidepanel/model-resolution.js";
import {
	loadLastUsedModel,
	loadPlannerValidatorEnabled,
	loadProxySettings,
	type PersistentAppSettingsStore,
	saveLastUsedModel,
} from "../storage/persistent-settings.js";
import type { RuntimeModelDescriptor, RuntimeRecord, RuntimeValue } from "./runtime-protocol.js";

export interface OffscreenProviderKeysStore {
	get(provider: string): Promise<string | null>;
	set(provider: string, value: string): Promise<void>;
	list(): Promise<string[]>;
}

export interface OffscreenCustomProvidersStore {
	getAll(): Promise<CustomProvider[]>;
}

export interface OffscreenProviderRuntimeStorage {
	settings: PersistentAppSettingsStore;
	providerKeys: OffscreenProviderKeysStore;
	customProviders: OffscreenCustomProvidersStore;
}

export interface OffscreenAgentProviderRuntime {
	readonly streamFn: StreamFn;
	getApiKey(provider: string): Promise<string | undefined>;
	resolveModel(descriptor: RuntimeModelDescriptor, signal: AbortSignal): Promise<Model<Api>>;
	resolveDefaultModel(signal: AbortSignal): Promise<Model<Api>>;
	normalizeModel(model: Model<Api>): Model<Api>;
	saveSelectedModel(model: Model<Api>, signal: AbortSignal): Promise<void>;
	isPlannerValidatorEnabled(signal: AbortSignal): Promise<boolean>;
}

export interface CreateOffscreenProviderRuntimeOptions {
	storage: OffscreenProviderRuntimeStorage;
	resolveStoredCredential?: (storedValue: string, provider: string, proxyUrl?: string) => Promise<string>;
}

const FIREWORKS_SESSION_AFFINITY =
	typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: Math.random().toString(36).slice(2) + Date.now().toString(36);

const FIREWORKS_EXTENSION_MODELS: Model<"openai-completions">[] = [
	{
		id: "accounts/fireworks/routers/kimi-k2p6-turbo",
		name: "Kimi K2.6 Turbo (Fireworks)",
		api: "openai-completions",
		provider: "fireworks",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
		headers: { "x-session-affinity": FIREWORKS_SESSION_AFFINITY },
		compat: {
			maxTokensField: "max_tokens",
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: true,
		},
	},
];

const MINIMAX_EXTENSION_MODELS: Model<"anthropic-messages">[] = [
	{
		id: "MiniMax-M2.7",
		name: "MiniMax M2.7",
		api: "anthropic-messages",
		provider: "minimax",
		baseUrl: "https://api.minimax.io/anthropic",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
		contextWindow: 204800,
		maxTokens: 8192,
	},
	{
		id: "MiniMax-M2.7-highspeed",
		name: "MiniMax M2.7 Highspeed",
		api: "anthropic-messages",
		provider: "minimax",
		baseUrl: "https://api.minimax.io/anthropic",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 },
		contextWindow: 204800,
		maxTokens: 8192,
	},
];

let extensionModelsRegistered = false;

export function registerShuvgeistProviderModels(): void {
	if (extensionModelsRegistered) return;
	registerModels(FIREWORKS_EXTENSION_MODELS);
	registerModels(MINIMAX_EXTENSION_MODELS);
	extensionModelsRegistered = true;
}

function throwIfAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const error = new Error("Offscreen provider operation was aborted");
	error.name = "AbortError";
	throw error;
}

function isKnownProvider(provider: string): provider is KnownProvider {
	const providers: readonly string[] = getProviders();
	return providers.includes(provider);
}

function findBuiltInModel(provider: string, modelId: string): Model<Api> | undefined {
	if (!isKnownProvider(provider)) return undefined;
	return getModels(provider).find((model) => model.id === modelId);
}

function findCustomProvider(providers: readonly CustomProvider[], providerName: string): CustomProvider | undefined {
	return providers.find((provider) => provider.name === providerName || provider.id === providerName);
}

function findCustomModel(
	providers: readonly CustomProvider[],
	descriptor: RuntimeModelDescriptor,
): Model<Api> | undefined {
	return findCustomProvider(providers, descriptor.provider)?.models?.find((model) => model.id === descriptor.id);
}

function normalizeRuntimeMetadata(value: unknown, label: string, ancestors = new Set<object>()): RuntimeValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite numbers`);
		return value;
	}
	if (typeof value !== "object") throw new Error(`${label} contains non-runtime data`);
	if (ancestors.has(value)) throw new Error(`${label} contains a cycle`);
	const nextAncestors = new Set(ancestors);
	nextAncestors.add(value);
	if (Array.isArray(value)) {
		return value.map((entry, index) => normalizeRuntimeMetadata(entry, `${label}[${index}]`, nextAncestors));
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${label} contains a non-plain object`);
	}
	const record: RuntimeRecord = {};
	for (const [key, entry] of Object.entries(value as { [key: string]: unknown })) {
		if (entry !== undefined) record[key] = normalizeRuntimeMetadata(entry, `${label}.${key}`, nextAncestors);
	}
	return record;
}

function cloneRuntimeRecord(value: unknown, label: string): RuntimeRecord {
	const normalized = normalizeRuntimeMetadata(value, label);
	if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
		throw new Error(`${label} must be a plain runtime record`);
	}
	return normalized;
}

/** Encode every Pi model field needed to execute the same provider request after a restart. */
export function modelToRuntimeDescriptor(model: Model<Api>): RuntimeModelDescriptor {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		api: model.api,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
		input: model.input.slice(),
		cost: { ...model.cost },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		...(model.headers ? { headers: { ...model.headers } } : {}),
		...(model.compat ? { compat: cloneRuntimeRecord(model.compat, "Model compatibility metadata") } : {}),
	};
}

function isCompleteRuntimeModelDescriptor(descriptor: RuntimeModelDescriptor): boolean {
	return (
		descriptor.provider.trim().length > 0 &&
		descriptor.id.trim().length > 0 &&
		typeof descriptor.name === "string" &&
		descriptor.name.trim().length > 0 &&
		typeof descriptor.api === "string" &&
		descriptor.api.trim().length > 0 &&
		typeof descriptor.baseUrl === "string" &&
		typeof descriptor.reasoning === "boolean" &&
		Array.isArray(descriptor.input) &&
		descriptor.input.every((input) => input === "text" || input === "image") &&
		descriptor.cost !== undefined &&
		Object.values(descriptor.cost).every(Number.isFinite) &&
		Number.isInteger(descriptor.contextWindow) &&
		(descriptor.contextWindow ?? 0) > 0 &&
		Number.isInteger(descriptor.maxTokens) &&
		(descriptor.maxTokens ?? 0) > 0
	);
}

/** Decode a complete wire model without replacing custom execution metadata from a registry. */
export function modelFromRuntimeDescriptor(descriptor: RuntimeModelDescriptor): Model<Api> | undefined {
	if (!isCompleteRuntimeModelDescriptor(descriptor)) return undefined;
	const model: Model<Api> = {
		provider: descriptor.provider,
		id: descriptor.id,
		name: descriptor.name ?? "",
		api: descriptor.api ?? "",
		baseUrl: descriptor.baseUrl ?? "",
		reasoning: descriptor.reasoning ?? false,
		...(descriptor.thinkingLevelMap ? { thinkingLevelMap: { ...descriptor.thinkingLevelMap } } : {}),
		input: descriptor.input?.slice() ?? [],
		cost: { ...(descriptor.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) },
		contextWindow: descriptor.contextWindow ?? 0,
		maxTokens: descriptor.maxTokens ?? 0,
		...(descriptor.headers ? { headers: { ...descriptor.headers } } : {}),
	};
	return descriptor.compat
		? Object.assign(model, { compat: cloneRuntimeRecord(descriptor.compat, "Model compatibility metadata") })
		: model;
}

function assertModelMatchesDescriptor(model: Model<Api>, descriptor: RuntimeModelDescriptor): Model<Api> {
	if (model.provider !== descriptor.provider || model.id !== descriptor.id) {
		throw new Error(`Resolved model does not match ${descriptor.provider}/${descriptor.id}`);
	}
	return normalizeModelForRuntime(model);
}

export function createOffscreenProviderRuntime(
	options: CreateOffscreenProviderRuntimeOptions,
): OffscreenAgentProviderRuntime {
	registerShuvgeistProviderModels();
	const { storage } = options;
	const getCustomProviderByName = async (providerName: string): Promise<CustomProvider | undefined> =>
		findCustomProvider(await storage.customProviders.getAll(), providerName);
	const streamFn = createStreamFn(async () => {
		const proxy = await loadProxySettings(storage.settings);
		return proxy.enabled ? proxy.url : undefined;
	});
	const credentialFlights = new Map<string, Promise<string | undefined>>();
	const resolveProviderApiKey = async (provider: string): Promise<string | undefined> => {
		const credential = await resolveProviderCredential(provider, {
			getStoredProviderKey: async (storageKey) => (await storage.providerKeys.get(storageKey)) ?? undefined,
			getCustomProviderByName,
			resolveStoredCredential: async (storedValue, storageKey) => {
				const proxy = await loadProxySettings(storage.settings);
				return options.resolveStoredCredential
					? await options.resolveStoredCredential(storedValue, storageKey, proxy.enabled ? proxy.url : undefined)
					: await resolveApiKey(
							storedValue,
							storageKey,
							storage.providerKeys,
							proxy.enabled ? proxy.url : undefined,
						);
			},
		});
		return credential?.apiKey;
	};

	return {
		streamFn,

		getApiKey(provider: string): Promise<string | undefined> {
			const existing = credentialFlights.get(provider);
			if (existing) return existing;
			const flight = resolveProviderApiKey(provider);
			const clearingFlight = flight.finally(() => {
				if (credentialFlights.get(provider) === clearingFlight) credentialFlights.delete(provider);
			});
			credentialFlights.set(provider, clearingFlight);
			return clearingFlight;
		},

		async resolveModel(descriptor: RuntimeModelDescriptor, signal: AbortSignal): Promise<Model<Api>> {
			throwIfAborted(signal);
			const completeModel = modelFromRuntimeDescriptor(descriptor);
			if (completeModel) return normalizeModelForRuntime(completeModel);

			const builtIn = findBuiltInModel(descriptor.provider, descriptor.id);
			if (builtIn) return assertModelMatchesDescriptor(builtIn, descriptor);

			const providers = await storage.customProviders.getAll();
			throwIfAborted(signal);
			const custom = findCustomModel(providers, descriptor);
			if (custom) return assertModelMatchesDescriptor(custom, descriptor);

			if (descriptor.provider === BUNDLED_FREE_TIER_PROVIDER) {
				const bundled = createBundledFreeTierModel(descriptor.id);
				if (bundled) return assertModelMatchesDescriptor(bundled, descriptor);
			}

			throw new Error(`Model not found: ${descriptor.provider}/${descriptor.id}`);
		},

		async resolveDefaultModel(signal: AbortSignal): Promise<Model<Api>> {
			throwIfAborted(signal);
			const savedModel = await loadLastUsedModel(storage.settings);
			throwIfAborted(signal);
			if (savedModel) return normalizeModelForRuntime(savedModel);

			const providerNames = new Set<string>();
			for (const provider of await storage.providerKeys.list()) {
				throwIfAborted(signal);
				if (await storage.providerKeys.get(provider)) providerNames.add(provider);
			}
			const customProviders = await storage.customProviders.getAll();
			throwIfAborted(signal);
			for (const provider of customProviders) {
				if ((provider.models?.length ?? 0) > 0 || provider.apiKey) providerNames.add(provider.name);
			}

			const sources = {
				getCustomProviderByName: async (providerName: string) => findCustomProvider(customProviders, providerName),
				getAllCustomProviders: async () => customProviders.slice(),
			};
			const resolved = await resolveDefaultModel([...providerNames], sources);
			throwIfAborted(signal);
			if (resolved) return normalizeModelForRuntime(resolved);

			const fallback = await resolveDefaultModel(["anthropic"], sources);
			throwIfAborted(signal);
			if (!fallback) throw new Error("No model is available for the offscreen agent runtime");
			return normalizeModelForRuntime(fallback);
		},

		normalizeModel(model: Model<Api>): Model<Api> {
			return normalizeModelForRuntime(model);
		},

		async saveSelectedModel(model: Model<Api>, signal: AbortSignal): Promise<void> {
			throwIfAborted(signal);
			await saveLastUsedModel(model, storage.settings);
			throwIfAborted(signal);
		},

		async isPlannerValidatorEnabled(signal: AbortSignal): Promise<boolean> {
			throwIfAborted(signal);
			const enabled = await loadPlannerValidatorEnabled(storage.settings);
			throwIfAborted(signal);
			return enabled;
		},
	};
}
