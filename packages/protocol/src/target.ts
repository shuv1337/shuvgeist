export type BridgeTarget =
	| { kind: "chrome-tab"; tabRef?: string; tabId?: number; frameId?: number }
	| { kind: "electron-window"; appRef?: string; sessionId?: string; windowRef?: string; targetId?: string };

export function defaultTarget(): BridgeTarget {
	return { kind: "chrome-tab" };
}

export function isChromeTarget(target: BridgeTarget): target is Extract<BridgeTarget, { kind: "chrome-tab" }> {
	return target.kind === "chrome-tab";
}

export function isElectronTarget(target: BridgeTarget): target is Extract<BridgeTarget, { kind: "electron-window" }> {
	return target.kind === "electron-window";
}

export function requestTarget(request: { target?: BridgeTarget }): BridgeTarget {
	return request.target ?? defaultTarget();
}

export function parseTargetSpec(spec: string): BridgeTarget {
	const trimmed = spec.trim();
	if (!trimmed) throw new Error("target must not be empty");

	if (trimmed.startsWith("chrome:")) {
		const tabRef = trimmed.slice("chrome:".length);
		if (!tabRef) throw new Error("chrome target must include a tab reference");
		const numeric = Number.parseInt(tabRef, 10);
		if (/^\d+$/.test(tabRef) && Number.isFinite(numeric)) return { kind: "chrome-tab", tabId: numeric };
		return { kind: "chrome-tab", tabRef };
	}

	if (trimmed.startsWith("electron-session:")) {
		const sessionId = trimmed.slice("electron-session:".length);
		if (!sessionId) throw new Error("electron-session target must include a session id");
		return { kind: "electron-window", sessionId, windowRef: "w1" };
	}

	if (trimmed.startsWith("electron:")) {
		const rest = trimmed.slice("electron:".length);
		const separator = rest.includes("/") ? "/" : ":";
		const [targetRef, windowRef = "w1"] = rest.split(separator);
		if (!targetRef) throw new Error("electron target must include an app id, alias, or session id");
		if (!windowRef) throw new Error("electron target window reference must not be empty");
		if (/^e\d+$/u.test(targetRef)) return { kind: "electron-window", sessionId: targetRef, windowRef };
		return { kind: "electron-window", appRef: targetRef, windowRef };
	}

	throw new Error("target must start with chrome:, electron:, or electron-session:");
}

export function formatTargetSpec(target: BridgeTarget): string {
	if (target.kind === "chrome-tab") {
		if (typeof target.tabId === "number") return `chrome:${target.tabId}`;
		return `chrome:${target.tabRef ?? "active"}`;
	}
	if (target.sessionId) return `electron-session:${target.sessionId}`;
	return `electron:${target.appRef ?? "unknown"}:${target.windowRef ?? "w1"}`;
}

export function targetTeachingLabel(target: BridgeTarget): string {
	if (target.kind === "chrome-tab") return formatTargetSpec(target);
	if (target.appRef) return target.appRef;
	if (target.sessionId) return target.sessionId;
	if (target.targetId) return target.targetId;
	return "unknown";
}
