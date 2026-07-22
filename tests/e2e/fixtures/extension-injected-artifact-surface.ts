import {
	BROWSERJS_WRAPPER_INJECTED_ARTIFACT,
	ELEMENT_PICKER_INJECTED_ARTIFACT,
	PAGE_EXECUTION_INJECTED_ARTIFACT,
	REPL_OVERLAY_INJECTED_ARTIFACT,
} from "@shuvgeist/extension/injected/extension-artifacts.generated";
import type { ElementPickerCommand, ReplOverlayCommand } from "@shuvgeist/driver/injected-contracts";
import {
	createArtifactDescriptorSurface,
	createArtifactInvocationSurface,
	type InjectedArtifactDescriptorSurface,
	type InjectedArtifactInvocationSurface,
} from "./injected-artifact-surface.js";

export const EXTENSION_INJECTED_ARTIFACT_SURFACE_GLOBAL =
	"__SHUVGEIST_EXTENSION_INJECTED_ARTIFACT_SURFACE__";

export interface ExtensionInjectedArtifactBuildSurface {
	artifacts: {
		browserJsWrapper: InjectedArtifactDescriptorSurface;
		pageExecution: InjectedArtifactDescriptorSurface;
		overlay: InjectedArtifactDescriptorSurface;
		picker: InjectedArtifactDescriptorSurface;
	};
	overlay(command: ReplOverlayCommand): InjectedArtifactInvocationSurface;
	picker(command: ElementPickerCommand): InjectedArtifactInvocationSurface;
}

export function createOverlayArtifactSurface(command: ReplOverlayCommand): InjectedArtifactInvocationSurface {
	return createArtifactInvocationSurface(REPL_OVERLAY_INJECTED_ARTIFACT, command);
}

export function createPickerArtifactSurface(command: ElementPickerCommand): InjectedArtifactInvocationSurface {
	return createArtifactInvocationSurface(ELEMENT_PICKER_INJECTED_ARTIFACT, command);
}

export const extensionInjectedArtifactBuildSurface: ExtensionInjectedArtifactBuildSurface = {
	artifacts: {
		browserJsWrapper: createArtifactDescriptorSurface(BROWSERJS_WRAPPER_INJECTED_ARTIFACT),
		pageExecution: createArtifactDescriptorSurface(PAGE_EXECUTION_INJECTED_ARTIFACT),
		overlay: createArtifactDescriptorSurface(REPL_OVERLAY_INJECTED_ARTIFACT),
		picker: createArtifactDescriptorSurface(ELEMENT_PICKER_INJECTED_ARTIFACT),
	},
	overlay: createOverlayArtifactSurface,
	picker: createPickerArtifactSurface,
};

type ExtensionArtifactSurfaceGlobal = typeof globalThis & {
	__SHUVGEIST_EXTENSION_INJECTED_ARTIFACT_SURFACE__?: ExtensionInjectedArtifactBuildSurface;
};

(globalThis as ExtensionArtifactSurfaceGlobal).__SHUVGEIST_EXTENSION_INJECTED_ARTIFACT_SURFACE__ =
	extensionInjectedArtifactBuildSurface;
