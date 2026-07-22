import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { SettingsTab } from "@shuv1337/pi-web-ui";
import { html } from "lit";
import {
	BRIDGE_ELECTRON_STATE_KEY,
	type BridgeElectronStateData,
	type BridgeSettings,
} from "../bridge/internal-messages.js";
import { BRIDGE_RUNTIME_STATE_KEYS, readBridgeRuntimeState } from "../bridge/runtime-state.js";
import { readBridgeSettings } from "../bridge/settings.js";
import { Toast } from "../components/Toast.js";

export class ElectronTargetsTab extends SettingsTab {
	label = "Electron Targets";
	private state: BridgeElectronStateData = { sessions: [], updatedAt: "" };
	private refreshError = "";
	private thumbnails = new Map<string, string>();
	private refreshTimer: ReturnType<typeof setInterval> | null = null;

	getTabName(): string {
		return this.label;
	}

	private readonly storageChangeListener = (
		changes: Record<string, chrome.storage.StorageChange>,
		areaName: string,
	) => {
		if (areaName === "session" && changes[BRIDGE_ELECTRON_STATE_KEY]) {
			this.state = (changes[BRIDGE_ELECTRON_STATE_KEY].newValue as BridgeElectronStateData | undefined) ?? {
				sessions: [],
				updatedAt: "",
			};
			this.updateThumbnailRefresh();
			this.requestUpdate();
		}
	};

	override async connectedCallback() {
		super.connectedCallback();
		await this.loadState();
		chrome.storage.onChanged.addListener(this.storageChangeListener);
		document.addEventListener("visibilitychange", this.visibilityChangeListener);
		this.updateThumbnailRefresh();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		chrome.storage.onChanged.removeListener(this.storageChangeListener);
		document.removeEventListener("visibilitychange", this.visibilityChangeListener);
		this.stopThumbnailRefresh();
	}

	private readonly visibilityChangeListener = () => this.updateThumbnailRefresh();

	private async loadState() {
		this.state = (await readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.electron)) ?? {
			sessions: [],
			updatedAt: "",
		};
	}

	private async loadBridgeSettings(): Promise<BridgeSettings> {
		return readBridgeSettings();
	}

	private bridgeHttpUrl(wsUrl: string, path: string): string {
		const url = new URL(wsUrl);
		url.protocol = url.protocol === "wss:" ? "https:" : "http:";
		url.pathname = path;
		url.search = "";
		url.hash = "";
		return url.toString();
	}

	private async refreshFromBridge() {
		try {
			const settings = await this.loadBridgeSettings();
			const response = await fetch(this.bridgeHttpUrl(settings.url, "/status"));
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const status = (await response.json()) as { electron?: { sessions?: BridgeElectronStateData["sessions"] } };
			this.state = { sessions: status.electron?.sessions ?? [], updatedAt: new Date().toISOString() };
			this.refreshError = "";
			this.updateThumbnailRefresh();
			this.requestUpdate();
		} catch (error) {
			this.refreshError = error instanceof Error ? error.message : String(error);
			Toast.error(`Failed to refresh Electron targets: ${this.refreshError}`);
			this.requestUpdate();
		}
	}

	private updateThumbnailRefresh() {
		if (document.visibilityState === "visible" && this.state.sessions.some((session) => session.windows.length > 0)) {
			if (!this.refreshTimer) {
				void this.refreshThumbnails();
				this.refreshTimer = setInterval(() => void this.refreshThumbnails(), 5000);
			}
			return;
		}
		this.stopThumbnailRefresh();
	}

	private stopThumbnailRefresh() {
		if (!this.refreshTimer) return;
		clearInterval(this.refreshTimer);
		this.refreshTimer = null;
	}

	private async refreshThumbnails() {
		if (document.visibilityState !== "visible") {
			this.stopThumbnailRefresh();
			return;
		}
		const settings = await this.loadBridgeSettings();
		await Promise.all(
			this.state.sessions.flatMap((session) =>
				session.windows.map(async (window) => {
					const response = await fetch(this.bridgeHttpUrl(settings.url, "/electron/thumbnail"), {
						method: "POST",
						headers: {
							authorization: `Bearer ${settings.token}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({ sessionId: session.id, windowRef: window.ref, maxWidth: 320 }),
					});
					if (!response.ok) return;
					const result = (await response.json()) as { dataUrl?: string };
					if (result.dataUrl) this.thumbnails.set(`${session.id}:${window.ref}`, result.dataUrl);
				}),
			),
		);
		this.requestUpdate();
	}

	private async detach(sessionId: string) {
		try {
			const settings = await this.loadBridgeSettings();
			const response = await fetch(this.bridgeHttpUrl(settings.url, "/electron/detach"), {
				method: "POST",
				headers: {
					authorization: `Bearer ${settings.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ sessionId }),
			});
			if (!response.ok) {
				const body = (await response.json()) as { error?: string };
				throw new Error(body.error ?? `HTTP ${response.status}`);
			}
			Toast.success(`Detached ${sessionId}`);
			await this.refreshFromBridge();
		} catch (error) {
			Toast.error(`Failed to detach Electron session: ${(error as Error).message}`);
		}
	}

	render() {
		return html`
			<div class="flex flex-col gap-4">
				<div class="flex items-center justify-between gap-3">
					<p class="text-sm text-muted-foreground">
						Observe attached Electron sessions and detach local CDP targets.
					</p>
					${Button({ variant: "outline", size: "sm", onClick: () => this.refreshFromBridge(), children: "Refresh" })}
				</div>
				${
					this.refreshError
						? html`<div class="text-sm text-destructive">Failed to refresh Electron targets: ${this.refreshError}</div>`
						: ""
				}
				${
					this.state.sessions.length === 0
						? html`<div class="text-sm text-muted-foreground">No Electron sessions attached.</div>`
						: html`
						<div class="space-y-3">
							${this.state.sessions.map(
								(session) => html`
									<div class="border border-border rounded-lg p-4 bg-card space-y-3">
										<div class="flex items-start justify-between gap-3">
											<div>
												<div class="font-semibold text-foreground">${session.appRef ?? session.appId ?? session.id}</div>
												<div class="text-xs text-muted-foreground font-mono">
													${session.id} · ${session.appId ?? "unknown app"} · ${session.windows.length} window(s)
												</div>
												<div class="text-xs text-muted-foreground">Attached ${session.startedAt}</div>
											</div>
											${Button({
												variant: "destructive",
												size: "sm",
												onClick: () => this.detach(session.id),
												children: "Detach",
											})}
										</div>
										<div class="grid gap-2">
											${session.windows.map((window) => {
												const thumbnail = this.thumbnails.get(`${session.id}:${window.ref}`);
												return html`
													<div class="border border-border rounded p-2 text-xs">
														${
															thumbnail
																? html`<img
																src=${thumbnail}
																alt=""
																class="mb-2 w-full max-h-32 object-contain rounded border border-border bg-background"
															/>`
																: ""
														}
														<div class="font-mono text-foreground">
															${window.ref}${window.label ? ` · ${window.label}` : ""}${window.isPrimary ? " · primary" : ""}
														</div>
														<div class="text-muted-foreground">${window.title ?? "Untitled"}</div>
														<div class="text-muted-foreground truncate">${window.url ?? ""}</div>
													</div>
												`;
											})}
										</div>
									</div>
								`,
							)}
						</div>
					`
				}
			</div>
		`;
	}
}

customElements.define("electron-targets-tab", ElectronTargetsTab);
