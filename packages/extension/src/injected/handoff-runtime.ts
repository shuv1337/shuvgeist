import type { HandoffBinding } from "../bridge/handoff-coordinator.js";

export interface HandoffOverlayCommand {
	action: "show" | "ready" | "remove";
	binding: HandoffBinding;
	message?: string;
}

interface HandoffRuntimeResponse {
	ok: boolean;
	reason?: string;
}

declare global {
	interface Window {
		__shuvgeistHandoffId?: string;
	}
}

const OVERLAY_ID = "shuvgeist-human-handoff";

export function runHandoffOverlay(command: HandoffOverlayCommand): { installed: boolean } {
	const existing = document.getElementById(OVERLAY_ID);
	if (command.action === "remove") {
		if (existing?.dataset.handoffId === command.binding.handoffId) existing.remove();
		if (window.__shuvgeistHandoffId === command.binding.handoffId) delete window.__shuvgeistHandoffId;
		return { installed: false };
	}
	if (command.action === "ready") {
		if (existing?.dataset.handoffId !== command.binding.handoffId) {
			throw new Error("The active human handoff does not match");
		}
		const status = existing.querySelector<HTMLElement>('[data-handoff-role="status"]');
		const primary = existing.querySelector<HTMLButtonElement>('[data-handoff-role="primary"]');
		if (!status || !primary) throw new Error("The human handoff overlay is incomplete");
		status.textContent = "Automation is paused. Complete the step, then resume.";
		primary.textContent = "Resume automation";
		primary.disabled = false;
		return { installed: true };
	}
	if (existing || window.__shuvgeistHandoffId) {
		throw new Error("A human handoff is already active in this frame");
	}

	const overlay = document.createElement("section");
	overlay.id = OVERLAY_ID;
	overlay.dataset.handoffId = command.binding.handoffId;
	overlay.setAttribute("role", "dialog");
	overlay.setAttribute("aria-modal", "true");
	overlay.setAttribute("aria-label", "Shuvgeist human handoff");
	overlay.style.cssText =
		"position:fixed;inset:0;z-index:2147483647;background:rgba(8,12,20,.62);display:grid;place-items:center;font:14px/1.45 system-ui,sans-serif;color:#eef2ff";
	const panel = document.createElement("div");
	panel.style.cssText =
		"width:min(520px,calc(100vw - 32px));background:#111827;border:1px solid #475569;border-radius:12px;padding:24px;box-shadow:0 24px 72px rgba(0,0,0,.5)";
	const title = document.createElement("h2");
	title.textContent =
		command.binding.kind === "browser-native" ? "Browser action needs you" : "Automation paused for you";
	title.style.cssText = "margin:0 0 8px;font-size:20px";
	const body = document.createElement("p");
	body.textContent = command.message || "Complete the requested step in this page, then resume automation.";
	body.style.cssText = "margin:0 0 18px;color:#cbd5e1";
	const status = document.createElement("p");
	status.dataset.handoffRole = "status";
	status.textContent = "Review the request, then begin the manual step.";
	status.style.cssText = "margin:0 0 18px;color:#93c5fd";
	const controls = document.createElement("div");
	controls.style.cssText = "display:flex;gap:10px;justify-content:flex-end";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "Cancel";
	const primary = document.createElement("button");
	primary.dataset.handoffRole = "primary";
	primary.type = "button";
	primary.textContent = "Begin manual step";
	for (const button of [cancel, primary]) {
		button.style.cssText =
			"border:1px solid #64748b;border-radius:7px;padding:8px 13px;background:#1e293b;color:#f8fafc;cursor:pointer";
	}
	primary.style.background = "#2563eb";
	controls.append(cancel, primary);
	panel.append(title, body, status, controls);
	overlay.append(panel);
	document.documentElement.append(overlay);
	window.__shuvgeistHandoffId = command.binding.handoffId;

	const send = async (state: "acknowledged" | "completed" | "cancelled"): Promise<boolean> => {
		try {
			const response = (await chrome.runtime.sendMessage({
				type: "shuvgeist-handoff-lifecycle",
				handoffId: command.binding.handoffId,
				taskId: command.binding.taskId,
				sessionId: command.binding.sessionId,
				tabId: command.binding.tabId,
				frameId: command.binding.frameId,
				navigationGeneration: command.binding.navigationGeneration,
				state,
			})) as HandoffRuntimeResponse;
			if (response?.ok) return true;
		} catch {
			// A missing/restarted worker deterministically cancels the orphaned overlay.
		}
		if (document.contains(overlay)) {
			overlay.remove();
			delete window.__shuvgeistHandoffId;
		}
		return false;
	};

	cancel.addEventListener("click", () => {
		void send("cancelled").finally(() => {
			overlay.remove();
			delete window.__shuvgeistHandoffId;
		});
	});
	let acknowledged = false;
	primary.addEventListener("click", () => {
		primary.disabled = true;
		if (!acknowledged) {
			void send("acknowledged").then((accepted) => {
				if (!accepted) return;
				acknowledged = true;
				status.textContent = "Starting the handoff…";
			});
			return;
		}
		void send("completed").then((completed) => {
			if (!completed) return;
			overlay.remove();
			delete window.__shuvgeistHandoffId;
		});
	});
	return { installed: true };
}
