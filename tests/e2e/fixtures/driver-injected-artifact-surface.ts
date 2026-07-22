import {
	PAGE_REF_ACTION_INJECTED_ARTIFACT,
	SNAPSHOT_INJECTED_ARTIFACT,
} from "@shuvgeist/driver/driver-artifacts-generated";
import type {
	PageRefActionInjectionRequest,
	SnapshotInjectionConfig,
} from "@shuvgeist/driver/injected-contracts";
import {
	createArtifactDescriptorSurface,
	createArtifactInvocationSurface,
	type InjectedArtifactDescriptorSurface,
	type InjectedArtifactInvocationSurface,
} from "./injected-artifact-surface.js";

export const DRIVER_INJECTED_ARTIFACT_SURFACE_GLOBAL = "__SHUVGEIST_DRIVER_INJECTED_ARTIFACT_SURFACE__";

export interface DriverInjectedArtifactBuildSurface {
	artifacts: {
		snapshot: InjectedArtifactDescriptorSurface;
		pageRefAction: InjectedArtifactDescriptorSurface;
	};
	snapshot(config: SnapshotInjectionConfig): InjectedArtifactInvocationSurface;
	pageRefAction(request: PageRefActionInjectionRequest): InjectedArtifactInvocationSurface;
}

export function createSnapshotArtifactSurface(config: SnapshotInjectionConfig): InjectedArtifactInvocationSurface {
	return createArtifactInvocationSurface(SNAPSHOT_INJECTED_ARTIFACT, config);
}

export function createPageRefActionArtifactSurface(
	request: PageRefActionInjectionRequest,
): InjectedArtifactInvocationSurface {
	return createArtifactInvocationSurface(PAGE_REF_ACTION_INJECTED_ARTIFACT, request);
}

export const driverInjectedArtifactBuildSurface: DriverInjectedArtifactBuildSurface = {
	artifacts: {
		snapshot: createArtifactDescriptorSurface(SNAPSHOT_INJECTED_ARTIFACT),
		pageRefAction: createArtifactDescriptorSurface(PAGE_REF_ACTION_INJECTED_ARTIFACT),
	},
	snapshot: createSnapshotArtifactSurface,
	pageRefAction: createPageRefActionArtifactSurface,
};

type DriverArtifactSurfaceGlobal = typeof globalThis & {
	__SHUVGEIST_DRIVER_INJECTED_ARTIFACT_SURFACE__?: DriverInjectedArtifactBuildSurface;
};

(globalThis as DriverArtifactSurfaceGlobal).__SHUVGEIST_DRIVER_INJECTED_ARTIFACT_SURFACE__ =
	driverInjectedArtifactBuildSurface;
