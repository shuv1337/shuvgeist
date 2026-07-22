import type { ElementInfo, ElementPickerCommand } from "@shuvgeist/driver/injected-contracts";
import { buildInjectedArtifactInvocation } from "@shuvgeist/driver/injected-invocation";
import { ELEMENT_PICKER_INJECTED_ARTIFACT } from "../../injected/extension-artifacts.generated.js";

export type { ElementInfo } from "@shuvgeist/driver/injected-contracts";

export class ElementPickCancelled extends Error {
	readonly code = "cancelled" as const;

	constructor(message = "Element selection was cancelled") {
		super(message);
		this.name = "ElementPickCancelled";
	}
}

export interface PickElementOptions {
	message?: string;
	signal?: AbortSignal;
}

/**
 * Inject the bundled element picker and wait for a selection. Cancellation is
 * sent through the same typed artifact contract so cleanup cannot drift from
 * picker startup.
 */
export async function pickElement(tabId: number, opts: PickElementOptions = {}): Promise<ElementInfo> {
	const { message, signal } = opts;
	if (signal?.aborted) throw new ElementPickCancelled();
	if (!chrome.userScripts || typeof chrome.userScripts.execute !== "function") {
		throw new Error("userScripts.execute() not available. This tool requires Chrome 138+ with User Scripts enabled.");
	}

	const command: ElementPickerCommand = { action: "pick", ...(message ? { message } : {}) };
	const executePromise = chrome.userScripts.execute({
		target: { tabId, allFrames: false },
		world: "USER_SCRIPT",
		injectImmediately: true,
		js: [
			{
				code: buildInjectedArtifactInvocation(ELEMENT_PICKER_INJECTED_ARTIFACT, [JSON.stringify(command)]),
			},
		],
	}) as Promise<Array<{ result?: ElementInfo | null }>>;

	let results: Array<{ result?: ElementInfo | null }>;
	if (signal) {
		const abortPromise = new Promise<never>((_resolve, reject) => {
			const onAbort = () => {
				const cleanupCommand: ElementPickerCommand = { action: "cancel" };
				chrome.userScripts
					?.execute({
						target: { tabId, allFrames: false },
						world: "USER_SCRIPT",
						injectImmediately: true,
						js: [
							{
								code: buildInjectedArtifactInvocation(ELEMENT_PICKER_INJECTED_ARTIFACT, [
									JSON.stringify(cleanupCommand),
								]),
							},
						],
					})
					.catch(() => undefined);
				reject(new ElementPickCancelled("Element selection was aborted"));
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		results = await Promise.race([executePromise, abortPromise]);
	} else {
		results = await executePromise;
	}

	const info = results[0]?.result;
	if (!info) throw new ElementPickCancelled();
	return info;
}
