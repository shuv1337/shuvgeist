import { getAppStorage, SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { BridgeConnectionState } from "../bridge/extension-client.js";

/**
 * Callback for the BridgeTab to notify the sidepanel when bridge settings
 * change so it can connect/disconnect the BridgeClient.
 */
export type BridgeSettingsChangeCallback = (settings: { enabled: boolean; url: string; token: string }) => void;

/** Injected by the sidepanel so the tab can show live connection state. */
let currentBridgeState: BridgeConnectionState = "disabled";
let currentBridgeDetail: string | undefined;
let settingsChangeCallback: BridgeSettingsChangeCallback | undefined;

export function setBridgeStateForTab(state: BridgeConnectionState, detail?: string): void {
	currentBridgeState = state;
	currentBridgeDetail = detail;
}

export function getBridgeStateForTab(): { state: BridgeConnectionState; detail?: string } {
	return {
		state: currentBridgeState,
		detail: currentBridgeDetail,
	};
}

export function setBridgeSettingsChangeCallback(cb: BridgeSettingsChangeCallback): void {
	settingsChangeCallback = cb;
}

export function getBridgeSettingsChangeCallback(): BridgeSettingsChangeCallback | undefined {
	return settingsChangeCallback;
}

@customElement("bridge-tab")
export class BridgeTab extends SettingsTab {
	@state() private enabled = false;
	@state() private url = "";
	@state() private token = "";
	@state() private bridgeState: BridgeConnectionState = "disabled";
	@state() private bridgeDetail: string | undefined;

	private pollInterval: ReturnType<typeof setInterval> | null = null;

	getTabName(): string {
		return "Bridge";
	}

	override async connectedCallback() {
		super.connectedCallback();
		await this.loadSettings();

		// Poll for bridge state changes (the BridgeClient updates the module-level state)
		this.pollInterval = setInterval(() => {
			if (this.bridgeState !== currentBridgeState || this.bridgeDetail !== currentBridgeDetail) {
				this.bridgeState = currentBridgeState;
				this.bridgeDetail = currentBridgeDetail;
			}
		}, 500);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async loadSettings() {
		const storage = getAppStorage();
		this.enabled = (await storage.settings.get<boolean>("bridge.enabled")) ?? false;
		this.url = (await storage.settings.get<string>("bridge.url")) ?? "ws://127.0.0.1:19285/ws";
		this.token = (await storage.settings.get<string>("bridge.token")) ?? "";
		this.bridgeState = currentBridgeState;
		this.bridgeDetail = currentBridgeDetail;
	}

	private async setEnabled(enabled: boolean) {
		this.enabled = enabled;
		await getAppStorage().settings.set("bridge.enabled", enabled);
		this.notifyChange();
	}

	private async setUrl(url: string) {
		this.url = url;
		await getAppStorage().settings.set("bridge.url", url);
		// Only notify when enabled — avoids spurious reconnects while editing
	}

	private async setToken(token: string) {
		this.token = token;
		await getAppStorage().settings.set("bridge.token", token);
	}

	private notifyChange() {
		settingsChangeCallback?.({
			enabled: this.enabled,
			url: this.url,
			token: this.token,
		});
	}

	/** Called when the user finishes editing the URL or token (on blur/enter). */
	private handleFieldCommit() {
		if (this.enabled) {
			this.notifyChange();
		}
	}

	private stateLabel(): string {
		switch (this.bridgeState) {
			case "disabled":
				return "Disabled";
			case "disconnected":
				return "Disconnected";
			case "connecting":
				return "Connecting...";
			case "connected":
				return "Connected";
			case "error":
				return this.bridgeDetail ? "Error: " + this.bridgeDetail : "Error";
		}
	}

	private stateColor(): string {
		switch (this.bridgeState) {
			case "connected":
				return "text-green-400";
			case "connecting":
				return "text-yellow-400";
			case "error":
				return "text-red-400";
			default:
				return "text-muted-foreground";
		}
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-4">
				<div class="space-y-2">
					<h3 class="text-lg font-semibold text-foreground">CLI Bridge</h3>
					<p class="text-sm text-muted-foreground">
						Allow external CLI tools to control the browser through this sidepanel.
					</p>
				</div>

				<!-- Enable toggle -->
				<label class="flex items-center gap-3 cursor-pointer">
					<input
						type="checkbox"
						class="w-4 h-4 rounded border-border accent-primary"
						.checked=${this.enabled}
						@change=${(e: Event) => this.setEnabled((e.target as HTMLInputElement).checked)}
					/>
					<span class="text-sm font-medium text-foreground">Enable bridge</span>
				</label>

				<!-- Connection status -->
				<div class="flex items-center gap-2">
					<span class="text-xs font-medium text-muted-foreground">Status:</span>
					<span class="text-xs font-medium ${this.stateColor()}">${this.stateLabel()}</span>
				</div>

				<!-- URL input -->
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground">Bridge Server URL</label>
					<input
						type="text"
						class="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
						placeholder="ws://127.0.0.1:19285/ws"
						.value=${this.url}
						@input=${(e: Event) => this.setUrl((e.target as HTMLInputElement).value)}
						@blur=${() => this.handleFieldCommit()}
						@keydown=${(e: KeyboardEvent) => {
							if (e.key === "Enter") this.handleFieldCommit();
						}}
					/>
				</div>

				<!-- Token input -->
				<div class="space-y-1">
					<label class="text-xs font-medium text-muted-foreground">Token</label>
					<input
						type="password"
						class="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
						placeholder="Shared bridge token"
						.value=${this.token}
						@input=${(e: Event) => this.setToken((e.target as HTMLInputElement).value)}
						@blur=${() => this.handleFieldCommit()}
						@keydown=${(e: KeyboardEvent) => {
							if (e.key === "Enter") this.handleFieldCommit();
						}}
					/>
				</div>

				<!-- Help text -->
				<div class="p-3 rounded-lg bg-muted/50 border border-border space-y-2">
					<p class="text-xs text-muted-foreground">
						<strong>Same host:</strong> Use <code class="text-foreground">ws://127.0.0.1:19285/ws</code>
					</p>
					<p class="text-xs text-muted-foreground">
						<strong>LAN host:</strong> Use <code class="text-foreground">ws://&lt;bridge-ip&gt;:19285/ws</code>
					</p>
					<p class="text-xs text-muted-foreground">
						Start the bridge server with: <code class="text-foreground">shuvgeist serve</code>
					</p>
				</div>

				<!-- Network warning -->
				<div class="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
					<p class="text-xs text-yellow-300">
						V1 bridge traffic is unencrypted. Use only on a trusted local network.
					</p>
				</div>
			</div>
		`;
	}
}
