import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { getAppStorage } from "@shuv1337/pi-web-ui";
import { html } from "lit";
import { Toast } from "../components/Toast.js";
import {
	getOAuthProviderName,
	isOAuthProvider,
	type OAuthProviderId,
	oauthLogin,
	serializeOAuthCredentials,
} from "../oauth/index.js";
// ProviderKeyInput custom element is registered via pi-web-ui main export
import "@shuv1337/pi-web-ui";

/**
 * Prompt dialog shown when trying to use a provider with no key.
 * Shows both OAuth login (if available) and API key entry.
 */
export class ApiKeyOrOAuthDialog extends DialogBase {
	private provider = "";
	private resolvePromise?: (success: boolean) => void;
	private checkInterval?: ReturnType<typeof setInterval>;
	private oauthStatus: "idle" | "logging-in" | "awaiting-code" | "error" = "idle";
	private oauthError = "";
	private deviceCode: string | null = null;
	private anthropicCodeInput = "";
	private anthropicCodeResolve: ((value: string) => void) | null = null;

	protected modalWidth = "min(500px, 90vw)";
	protected modalHeight = "auto";

	static async prompt(provider: string): Promise<boolean> {
		const dialog = new ApiKeyOrOAuthDialog();
		dialog.provider = provider;
		dialog.open();

		return new Promise((resolve) => {
			dialog.resolvePromise = resolve;
		});
	}

	override connectedCallback() {
		super.connectedCallback();

		// Poll for key existence
		this.checkInterval = setInterval(async () => {
			const hasKey = !!(await getAppStorage().providerKeys.get(this.provider));
			if (hasKey) {
				if (this.checkInterval) clearInterval(this.checkInterval);
				this.resolvePromise?.(true);
				this.resolvePromise = undefined;
				this.close();
			}
		}, 500);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		if (this.checkInterval) clearInterval(this.checkInterval);
	}

	override close() {
		super.close();
		if (this.anthropicCodeResolve) {
			this.anthropicCodeResolve("");
			this.anthropicCodeResolve = null;
		}
		if (this.resolvePromise) {
			this.resolvePromise(false);
		}
	}

	private submitAnthropicCode() {
		const value = this.anthropicCodeInput.trim();
		if (!value || !this.anthropicCodeResolve) return;
		this.anthropicCodeResolve(value);
		this.anthropicCodeResolve = null;
		this.anthropicCodeInput = "";
		this.oauthStatus = "logging-in";
		this.requestUpdate();
	}

	private cancelAnthropicCode() {
		if (this.anthropicCodeResolve) {
			this.anthropicCodeResolve("");
			this.anthropicCodeResolve = null;
		}
		this.anthropicCodeInput = "";
		this.oauthStatus = "idle";
		this.requestUpdate();
	}

	private async handleOAuthLogin() {
		this.oauthStatus = "logging-in";
		this.oauthError = "";
		this.deviceCode = null;
		this.requestUpdate();

		try {
			const storage = getAppStorage();

			const anthropicCodeCallback =
				this.provider === "anthropic"
					? () => {
							return new Promise<string>((resolve) => {
								this.anthropicCodeResolve = resolve;
								this.oauthStatus = "awaiting-code";
								this.anthropicCodeInput = "";
								this.requestUpdate();
							});
						}
					: undefined;

			const credentials = await oauthLogin(
				this.provider as OAuthProviderId,
				undefined,
				(info) => {
					this.deviceCode = info.userCode;
					this.requestUpdate();
				},
				anthropicCodeCallback,
			);

			await storage.providerKeys.set(this.provider, serializeOAuthCredentials(credentials));

			this.oauthStatus = "idle";
			this.deviceCode = null;
			Toast.success(`Logged in to ${getOAuthProviderName(this.provider as OAuthProviderId)}`);
		} catch (error) {
			console.error(`OAuth login failed for ${this.provider}:`, error);
			this.oauthStatus = "error";
			this.oauthError = error instanceof Error ? error.message : "Login failed";
			this.deviceCode = null;
			this.requestUpdate();
		}
	}

	private renderAnthropicCodeInput() {
		return html`
			<div class="flex flex-col gap-2 p-3 rounded-lg border border-border bg-card">
				<div class="text-sm font-medium text-foreground">
					${getOAuthProviderName(this.provider as OAuthProviderId)}
				</div>
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

	protected renderContent() {
		const supportsOAuth = isOAuthProvider(this.provider);

		const oauthDescription =
			this.oauthStatus === "logging-in"
				? this.provider === "anthropic"
					? "Opening browser..."
					: this.deviceCode
						? html`Enter code: <strong class="text-foreground font-mono">${this.deviceCode}</strong>`
						: "Logging in..."
				: this.oauthStatus === "error"
					? html`<span class="text-destructive">${this.oauthError}</span>`
					: this.provider === "anthropic"
						? "Log in, then paste the code or callback URL."
						: "Log in with your existing subscription";

		return html`
			${DialogContent({
				className: "flex flex-col gap-4",
				children: html`
					${DialogHeader({
						title: `Connect to ${this.provider}`,
						description: "Set up authentication to use this provider's models.",
					})}

					${
						supportsOAuth
							? html`
							<div class="flex flex-col gap-3">
								<h3 class="text-sm font-semibold text-foreground">Subscription Login</h3>

								${
									this.oauthStatus === "awaiting-code" && this.provider === "anthropic"
										? this.renderAnthropicCodeInput()
										: html`
										<div class="flex items-center justify-between p-3 rounded-lg border border-border bg-card">
											<div class="flex-1">
												<div class="text-sm font-medium text-foreground">
													${getOAuthProviderName(this.provider as OAuthProviderId)}
												</div>
												<div class="text-xs text-muted-foreground mt-1">
													${oauthDescription}
												</div>
											</div>
											${Button({
												variant: "default",
												size: "sm",
												disabled: this.oauthStatus === "logging-in",
												loading: this.oauthStatus === "logging-in",
												onClick: () => this.handleOAuthLogin(),
												children: "Login",
											})}
										</div>
									`
								}
							</div>

							<div class="flex items-center gap-3">
								<div class="flex-1 border-t border-border"></div>
								<span class="text-xs text-muted-foreground">or</span>
								<div class="flex-1 border-t border-border"></div>
							</div>
						`
							: ""
					}

					<div class="flex flex-col gap-3">
						<h3 class="text-sm font-semibold text-foreground">API Key</h3>
						<provider-key-input .provider=${this.provider}></provider-key-input>
					</div>
				`,
			})}
		`;
	}
}

if (!customElements.get("api-key-or-oauth-dialog")) {
	customElements.define("api-key-or-oauth-dialog", ApiKeyOrOAuthDialog);
}
