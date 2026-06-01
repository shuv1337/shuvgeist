import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { getAppStorage, SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { Toast } from "../components/Toast.js";
import {
	getOAuthProviderName,
	isOAuthCredentials,
	type OAuthProviderId,
	oauthLogin,
	parseOAuthCredentials,
	serializeOAuthCredentials,
} from "../oauth/index.js";
import type { OAuthCredentials } from "../oauth/types.js";
import { getProviderCredentialStorageKey, OAUTH_PROVIDER_IDS } from "../providers/catalog.js";

export class ApiKeysOAuthTab extends SettingsTab {
	private oauthStatuses: Record<
		string,
		"none" | "logged-in" | "logging-in" | "awaiting-code" | "paste-token" | "error"
	> = {};
	private oauthErrors: Record<string, string> = {};
	private deviceCode: string | null = null;
	private anthropicCodeInput = "";
	private anthropicCodeResolve: ((value: string) => void) | null = null;
	private pasteTokenInput = "";

	getTabName(): string {
		return "Subscriptions";
	}

	override async connectedCallback() {
		super.connectedCallback();
		await this.loadOAuthStatuses();
	}

	private async loadOAuthStatuses() {
		const storage = getAppStorage();
		for (const provider of OAUTH_PROVIDER_IDS) {
			const key = getProviderCredentialStorageKey(provider);
			const stored = await storage.providerKeys.get(key);
			if (stored && isOAuthCredentials(stored)) {
				const creds = parseOAuthCredentials(stored);
				const expired = Date.now() >= creds.expires;
				this.oauthStatuses[provider] = expired ? "none" : "logged-in";
			} else {
				this.oauthStatuses[provider] = "none";
			}
		}
		this.requestUpdate();
	}

	private submitAnthropicCode() {
		const value = this.anthropicCodeInput.trim();
		if (!value || !this.anthropicCodeResolve) return;
		this.anthropicCodeResolve(value);
		this.anthropicCodeResolve = null;
		this.anthropicCodeInput = "";
		this.oauthStatuses.anthropic = "logging-in";
		this.requestUpdate();
	}

	private cancelAnthropicCode() {
		if (this.anthropicCodeResolve) {
			this.anthropicCodeResolve("");
			this.anthropicCodeResolve = null;
		}
		this.anthropicCodeInput = "";
		this.oauthStatuses.anthropic = "none";
		this.requestUpdate();
	}

	/**
	 * Parse a pasted token string. Accepts:
	 * - Raw sk-ant-oat... access token
	 * - Full ~/.claude/.credentials.json content
	 * - The claudeAiOauth object from that file
	 */
	private parseAnthropicToken(input: string): OAuthCredentials | null {
		const trimmed = input.trim();

		// Raw access token
		if (trimmed.startsWith("sk-ant-oat")) {
			return {
				providerId: "anthropic",
				access: trimmed,
				refresh: "",
				// No refresh token — set expiry far in the future; user re-pastes if it expires
				expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
			};
		}

		// JSON — try to parse
		try {
			const parsed = JSON.parse(trimmed);

			// Full credentials.json: { claudeAiOauth: { accessToken, refreshToken, expiresAt, ... } }
			const oauth = parsed.claudeAiOauth ?? parsed;
			if (oauth.accessToken && typeof oauth.accessToken === "string") {
				return {
					providerId: "anthropic",
					access: oauth.accessToken,
					refresh: oauth.refreshToken || "",
					expires: typeof oauth.expiresAt === "number" ? oauth.expiresAt : Date.now() + 3600 * 1000,
				};
			}

			// Already our OAuthCredentials format
			if (oauth.access && oauth.providerId === "anthropic") {
				return oauth as OAuthCredentials;
			}
		} catch {
			// Not JSON
		}

		return null;
	}

	private showPasteToken(provider: OAuthProviderId) {
		this.oauthStatuses[provider] = "paste-token";
		this.pasteTokenInput = "";
		this.oauthErrors[provider] = "";
		this.requestUpdate();
	}

	private cancelPasteToken(provider: OAuthProviderId) {
		this.oauthStatuses[provider] = "none";
		this.pasteTokenInput = "";
		this.requestUpdate();
	}

	private async submitPasteToken(provider: OAuthProviderId) {
		const creds = this.parseAnthropicToken(this.pasteTokenInput);
		if (!creds) {
			this.oauthErrors[provider] =
				"Could not parse token. Paste a sk-ant-oat... token or ~/.claude/.credentials.json content.";
			this.requestUpdate();
			return;
		}

		const storage = getAppStorage();
		const key = getProviderCredentialStorageKey(provider);
		await storage.providerKeys.set(key, serializeOAuthCredentials(creds));
		this.oauthStatuses[provider] = "logged-in";
		this.pasteTokenInput = "";
		Toast.success(`Token saved for ${getOAuthProviderName(provider)}`);
		this.requestUpdate();
	}

	private async handleLogin(provider: OAuthProviderId) {
		this.oauthStatuses[provider] = "logging-in";
		this.oauthErrors[provider] = "";
		this.deviceCode = null;
		this.requestUpdate();

		try {
			const storage = getAppStorage();

			const anthropicCodeCallback =
				provider === "anthropic"
					? () => {
							return new Promise<string>((resolve) => {
								this.anthropicCodeResolve = resolve;
								this.oauthStatuses.anthropic = "awaiting-code";
								this.anthropicCodeInput = "";
								this.requestUpdate();
							});
						}
					: undefined;

			const credentials = await oauthLogin(
				provider,
				undefined,
				(info) => {
					this.deviceCode = info.userCode;
					this.requestUpdate();
				},
				anthropicCodeCallback,
			);

			const key = getProviderCredentialStorageKey(provider);
			await storage.providerKeys.set(key, serializeOAuthCredentials(credentials));

			this.oauthStatuses[provider] = "logged-in";
			this.deviceCode = null;
			Toast.success(`Logged in to ${getOAuthProviderName(provider)}`);
		} catch (error) {
			console.error(`OAuth login failed for ${provider}:`, error);
			this.oauthStatuses[provider] = "error";
			this.oauthErrors[provider] = error instanceof Error ? error.message : "Login failed";
			this.deviceCode = null;
		}
		this.requestUpdate();
	}

	private async handleLogout(provider: OAuthProviderId) {
		const storage = getAppStorage();
		const key = getProviderCredentialStorageKey(provider);
		await storage.providerKeys.delete(key);
		this.oauthStatuses[provider] = "none";
		this.oauthErrors[provider] = "";
		this.requestUpdate();
	}

	private renderPasteTokenInput(provider: OAuthProviderId): TemplateResult {
		const error = this.oauthErrors[provider] || "";
		return html`
			<div class="p-4 rounded-lg border border-border bg-card space-y-3">
				<div class="text-sm font-medium text-foreground">${getOAuthProviderName(provider)}</div>
				<div class="text-xs text-muted-foreground">
					Paste a token from <code class="text-foreground">claude setup-token</code>
					or the contents of <code class="text-foreground">~/.claude/.credentials.json</code>
				</div>
				${error ? html`<div class="text-xs text-destructive">${error}</div>` : ""}
				<textarea
					class="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary font-mono min-h-[60px] resize-y"
					placeholder="sk-ant-oat... or JSON credentials"
					.value=${this.pasteTokenInput}
					@input=${(e: Event) => {
						this.pasteTokenInput = (e.target as HTMLTextAreaElement).value;
						this.requestUpdate();
					}}
					@paste=${() => {
						setTimeout(() => {
							const el = this.querySelector<HTMLTextAreaElement>("textarea");
							if (el) this.pasteTokenInput = el.value;
							this.requestUpdate();
						}, 0);
					}}
					@keydown=${(e: KeyboardEvent) => {
						if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) this.submitPasteToken(provider);
						if (e.key === "Escape") this.cancelPasteToken(provider);
					}}
				></textarea>
				<div class="flex gap-2 justify-end">
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: () => this.cancelPasteToken(provider),
						children: "Cancel",
					})}
					${Button({
						variant: "default",
						size: "sm",
						disabled: !this.pasteTokenInput.trim(),
						onClick: () => this.submitPasteToken(provider),
						children: "Save Token",
					})}
				</div>
			</div>
		`;
	}

	private renderOAuthProvider(provider: OAuthProviderId): TemplateResult {
		const status = this.oauthStatuses[provider] || "none";
		const error = this.oauthErrors[provider] || "";

		// Paste token mode
		if (provider === "anthropic" && status === "paste-token") {
			return this.renderPasteTokenInput(provider);
		}

		// Anthropic awaiting-code: show inline paste input
		if (provider === "anthropic" && status === "awaiting-code") {
			return html`
				<div class="p-4 rounded-lg border border-border bg-card space-y-3">
					<div class="text-sm font-medium text-foreground">${getOAuthProviderName(provider)}</div>
					<div class="text-xs text-muted-foreground">
						Waiting for login to complete. If the redirect was not detected automatically,
						paste the callback URL or code below.
					</div>
					<div class="flex gap-2">
						<input
							type="text"
							class="flex-1 px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary font-mono"
							placeholder="Paste code or callback URL here"
							.value=${this.anthropicCodeInput}
							@input=${(e: Event) => {
								this.anthropicCodeInput = (e.target as HTMLInputElement).value;
								this.requestUpdate();
							}}
							@paste=${() => {
								setTimeout(() => {
									const el = this.querySelector<HTMLInputElement>("input[type=text]");
									if (el) this.anthropicCodeInput = el.value;
									this.requestUpdate();
								}, 0);
							}}
							@keydown=${(e: KeyboardEvent) => {
								if (e.key === "Enter") this.submitAnthropicCode();
								if (e.key === "Escape") this.cancelAnthropicCode();
							}}
						/>
						${Button({
							variant: "default",
							size: "sm",
							disabled: !this.anthropicCodeInput.trim(),
							onClick: () => this.submitAnthropicCode(),
							children: "Submit",
						})}
						${Button({
							variant: "ghost",
							size: "sm",
							onClick: () => this.cancelAnthropicCode(),
							children: "Cancel",
						})}
					</div>
				</div>
			`;
		}

		const statusContent =
			status === "logged-in"
				? html`<span class="text-green-600 dark:text-green-400">Connected</span>`
				: status === "logging-in"
					? provider === "anthropic"
						? html`<span>Opening browser...</span>`
						: this.deviceCode
							? html`<span>Enter code: <strong class="text-foreground font-mono">${this.deviceCode}</strong></span>`
							: html`<span>Logging in...</span>`
					: status === "error"
						? html`<span class="text-destructive">${error}</span>`
						: html`<span>Not connected</span>`;

		return html`
			<div class="flex items-center justify-between p-4 rounded-lg border border-border bg-card">
				<div class="flex-1">
					<div class="text-sm font-medium text-foreground">${getOAuthProviderName(provider)}</div>
					<div class="text-xs text-muted-foreground mt-1">${statusContent}</div>
				</div>
				<div class="flex gap-2">
					${
						status === "logged-in"
							? Button({
									variant: "outline",
									size: "sm",
									onClick: () => this.handleLogout(provider),
									children: "Logout",
								})
							: html`
							${
								provider === "anthropic"
									? Button({
											variant: "outline",
											size: "sm",
											onClick: () => this.showPasteToken(provider),
											children: "Paste Token",
										})
									: ""
							}
							${Button({
								variant: "default",
								size: "sm",
								disabled: status === "logging-in",
								loading: status === "logging-in",
								onClick: () => this.handleLogin(provider),
								children: "Login",
							})}
						`
					}
				</div>
			</div>
		`;
	}

	private renderOAuthSection(): TemplateResult {
		return html`
			<div class="flex flex-col gap-4">
				<div>
					<h3 class="text-sm font-semibold text-foreground mb-2">Subscription Login</h3>
					<p class="text-sm text-muted-foreground mb-4">
						Log in with your existing subscription. No API key needed.
						Tokens are stored locally and refreshed automatically.
					</p>
				</div>

				<div class="flex flex-col gap-3">
					${OAUTH_PROVIDER_IDS.map((p) => this.renderOAuthProvider(p))}
				</div>
			</div>
		`;
	}

	render(): TemplateResult {
		return html`${this.renderOAuthSection()}`;
	}
}

if (!customElements.get("api-keys-oauth-tab")) {
	customElements.define("api-keys-oauth-tab", ApiKeysOAuthTab);
}
