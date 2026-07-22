import { getSharedDebuggerManager } from "./debugger-manager.js";

export interface WaitOptions {
	timeoutMs?: number;
	quietMs?: number;
	frameId?: number;
}

export async function waitForNavigation(tabId: number, timeoutMs = 30_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
			reject(new Error(`Timed out waiting for navigation after ${timeoutMs}ms`));
		}, timeoutMs);

		const listener = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
			if (details.tabId !== tabId || details.frameId !== 0) {
				return;
			}
			clearTimeout(timer);
			chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
			resolve(details.url);
		};

		chrome.webNavigation.onDOMContentLoaded.addListener(listener);
	});
}

export async function waitForDomStable(tabId: number, options: WaitOptions = {}): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const quietMs = options.quietMs ?? 500;
	const frameId = options.frameId ?? 0;
	const worldId = "shuvgeist-waits";

	try {
		await chrome.userScripts.configureWorld({
			worldId,
			messaging: true,
		});
	} catch {
		// Already configured.
	}

	const startedAt = Date.now();
	let lastHash = "";
	let stableSince = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		const [result] = (await chrome.userScripts.execute({
			js: [
				{
					code: `(() => {
						const body = document.body;
						const text = body?.innerText?.slice(0, 4000) ?? "";
						const html = body?.innerHTML?.slice(0, 4000) ?? "";
						return {
							readyState: document.readyState,
							hash: JSON.stringify([text.length, html.length, text.slice(0, 300), html.slice(0, 300)]),
						};
					})()`,
				},
			],
			target: { tabId, frameIds: [frameId] },
			world: "USER_SCRIPT",
			worldId,
			injectImmediately: true,
		})) as Array<{ result?: { readyState?: string; hash?: string } }>;

		const readyState = result?.result?.readyState;
		const hash = result?.result?.hash ?? "";
		if (readyState !== "loading" && hash === lastHash) {
			if (Date.now() - stableSince >= quietMs) {
				return;
			}
		} else {
			stableSince = Date.now();
			lastHash = hash;
		}

		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	throw new Error(`Timed out waiting for DOM stability after ${timeoutMs}ms`);
}

export async function waitForNetworkQuiet(tabId: number, options: WaitOptions = {}): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const quietMs = options.quietMs ?? 500;
	const manager = getSharedDebuggerManager();
	const owner = `network-wait:${tabId}:${Date.now()}`;
	let inflight = 0;
	let lastActivity = Date.now();
	let removeListener: (() => void) | undefined;

	await manager.acquire(tabId, owner);
	try {
		await manager.ensureDomain(tabId, "Network");
		removeListener = manager.addEventListener(tabId, (method) => {
			if (method === "Network.requestWillBeSent") {
				inflight += 1;
				lastActivity = Date.now();
			} else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
				inflight = Math.max(0, inflight - 1);
				lastActivity = Date.now();
			}
		});

		const startedAt = Date.now();
		while (Date.now() - startedAt < timeoutMs) {
			if (inflight === 0 && Date.now() - lastActivity >= quietMs) {
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`Timed out waiting for network quiet after ${timeoutMs}ms`);
	} finally {
		removeListener?.();
		await manager.release(tabId, owner);
	}
}
