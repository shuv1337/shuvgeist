import { buildInjectedArtifactInvocation } from "@shuvgeist/driver/injected-invocation";
import type { HandoffBinding } from "../bridge/handoff-coordinator.js";
import { HANDOFF_INJECTED_ARTIFACT } from "../injected/extension-artifacts.generated.js";
import type { HandoffOverlayCommand } from "../injected/handoff-runtime.js";

export interface HandoffOverlayOptions {
	binding: HandoffBinding;
	message?: string;
}

export interface HandoffOverlayHandle {
	ready(): Promise<void>;
	remove(): Promise<void>;
}

async function execute(command: HandoffOverlayCommand): Promise<void> {
	if (!chrome.userScripts || typeof chrome.userScripts.execute !== "function") {
		throw new Error("Human handoff requires Chrome with User Scripts enabled");
	}
	const results = await chrome.userScripts.execute({
		target: {
			tabId: command.binding.tabId,
			frameIds: [command.binding.frameId],
		},
		world: "USER_SCRIPT",
		injectImmediately: true,
		js: [{ code: buildInjectedArtifactInvocation(HANDOFF_INJECTED_ARTIFACT, [JSON.stringify(command)]) }],
	});
	if ((results as Array<{ error?: string }>)[0]?.error) {
		throw new Error((results as Array<{ error?: string }>)[0]?.error);
	}
}

export async function showHandoffOverlay(options: HandoffOverlayOptions): Promise<HandoffOverlayHandle> {
	await execute({
		action: "show",
		binding: options.binding,
		...(options.message ? { message: options.message } : {}),
	});
	return {
		ready: () => execute({ action: "ready", binding: options.binding }),
		remove: () => execute({ action: "remove", binding: options.binding }),
	};
}
