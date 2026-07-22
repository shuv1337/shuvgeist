import {
	type BridgeCommandDefinition,
	BridgeCommandDefinitions as BridgeCommandDefinitionList,
	type BridgeCommandRoute,
	type BridgeCommandTargetKind,
	type BridgeCommandTimeout,
	type BridgeSchemaMethod,
	ElectronTargetBridgeMethods,
} from "./command-schemas.js";

export { ElectronTargetBridgeMethods };

export type { BridgeCommandRoute, BridgeCommandTargetKind, BridgeCommandTimeout };

export type CatalogBridgeMethod = BridgeSchemaMethod;
export type CatalogBridgeCapability = (typeof BridgeCommandDefinitionList)[number]["capabilities"][number];
type CatalogCommandDefinition = (typeof BridgeCommandDefinitionList)[number];
type DefinitionWithCliBindings = Extract<CatalogCommandDefinition, { cli: { kind: "bridge" } }>;
type CliBindingFromDefinition<Definition> = Definition extends {
	cli: { bindings: readonly (infer Binding)[] };
}
	? Binding
	: never;
type PropertyFromUnion<Value, Key extends PropertyKey> = Value extends Record<Key, infer Property> ? Property : never;
export type CatalogCliBinding = CliBindingFromDefinition<DefinitionWithCliBindings>;
export type CatalogCliCommand = PropertyFromUnion<CatalogCliBinding, "family"> & string;
export type CatalogCliCodec = PropertyFromUnion<CatalogCliBinding, "codec"> & string;
export type CatalogCliRunner = PropertyFromUnion<CatalogCliBinding, "runner"> & string;
export type BridgeCommandMetadata = Omit<BridgeCommandDefinition, "params" | "result"> & {
	method: CatalogBridgeMethod;
	/** Compatibility projection derived from the canonical CLI bindings. */
	cliCommands?: readonly string[];
};

export interface CatalogBridgeCliBinding {
	method: CatalogBridgeMethod;
	binding: CatalogCliBinding;
}

export interface BridgeCommandTargetSupport {
	chromeTab: boolean;
	electronWindow: boolean;
}

export const BridgeCommandCatalog = BridgeCommandDefinitionList.map(
	({ params: _params, result: _result, ...metadata }) => ({
		...metadata,
		...(metadata.cli.kind === "bridge"
			? { cliCommands: [...new Set(metadata.cli.bindings.map((binding) => binding.family))] }
			: {}),
	}),
) as readonly BridgeCommandMetadata[];

export const CatalogBridgeMethods = BridgeCommandDefinitionList.map((entry) => entry.method) as CatalogBridgeMethod[];

export const CatalogBridgeCapabilities = BridgeCommandDefinitionList.flatMap(
	(entry) => entry.capabilities,
) as CatalogBridgeCapability[];

export const CatalogExtensionBridgeCapabilities = BridgeCommandDefinitionList.filter(
	(entry) => entry.route === "extension",
).flatMap((entry) => entry.capabilities) as CatalogBridgeCapability[];

/** Every bridge-backed CLI route, paired with the method declared at the same source site. */
export const BridgeCliBindings = BridgeCommandDefinitionList.flatMap((entry) =>
	entry.cli.kind === "bridge" ? entry.cli.bindings.map((binding) => ({ method: entry.method, binding })) : [],
) as readonly CatalogBridgeCliBinding[];

const BridgeCommandMetadataByMethod = new Map<CatalogBridgeMethod, BridgeCommandMetadata>(
	BridgeCommandCatalog.map((entry) => [entry.method, entry]),
);

type SourceDefinitionFor<M extends CatalogBridgeMethod> = Extract<
	(typeof BridgeCommandDefinitionList)[number],
	{ method: M }
>;
export type BridgeCommandDefinitionMap = {
	[M in CatalogBridgeMethod]: SourceDefinitionFor<M> & { targetSupport: BridgeCommandTargetSupport };
};

export const BridgeCommandDefinitions = Object.fromEntries(
	BridgeCommandDefinitionList.map((entry) => [
		entry.method,
		{ ...entry, targetSupport: getBridgeCommandTargetSupport(entry.method) },
	]),
) as BridgeCommandDefinitionMap;

export function getBridgeCommandMetadata(method: string): BridgeCommandMetadata | undefined {
	return BridgeCommandMetadataByMethod.get(method as CatalogBridgeMethod);
}

export function isSensitiveBridgeCapability(capability: string): boolean {
	return BridgeCommandCatalog.some(
		(entry) => entry.sensitive && entry.capabilities.some((candidate) => candidate === capability),
	);
}

export function isCatalogWriteMethod(method: string): boolean {
	return Boolean(getBridgeCommandMetadata(method)?.write);
}

export function isCatalogServerLocalMethod(method: string): boolean {
	return getBridgeCommandMetadata(method)?.route === "server-local";
}

export function getBridgeCommandTargetSupport(method: string): BridgeCommandTargetSupport {
	const metadata = getBridgeCommandMetadata(method);
	const targets: readonly BridgeCommandTargetKind[] = metadata?.targets ?? [];
	return {
		chromeTab: targets.includes("chrome-tab"),
		electronWindow: targets.includes("electron-window"),
	};
}

export function isCatalogTargetDispatchedMethod(
	method: string,
	targetKind: BridgeCommandTargetKind = "chrome-tab",
): boolean {
	const support = getBridgeCommandTargetSupport(method);
	return targetKind === "chrome-tab" ? support.chromeTab : support.electronWindow;
}

export function getCatalogCliCommands(): string[] {
	return Array.from(new Set(BridgeCliBindings.map(({ binding }) => binding.family))).sort();
}
