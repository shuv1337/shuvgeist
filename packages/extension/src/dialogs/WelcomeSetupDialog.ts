import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html } from "lit";

export type WelcomeSetupChoice = "free-tier" | "subscription-settings" | "provider-settings";

/**
 * Shown on first launch when no API keys are configured.
 * Blocks until the user chooses a built-in free tier or provider settings.
 */
export class WelcomeSetupDialog extends DialogBase {
	private resolvePromise?: (choice: WelcomeSetupChoice) => void;
	private choice: WelcomeSetupChoice = "provider-settings";

	protected modalWidth = "min(450px, 90vw)";
	protected modalHeight = "auto";

	static show(): Promise<WelcomeSetupChoice> {
		return new Promise((resolve) => {
			const dialog = new WelcomeSetupDialog();
			dialog.resolvePromise = resolve;
			dialog.open();
		});
	}

	private choose(choice: WelcomeSetupChoice) {
		this.choice = choice;
		this.close();
	}

	override close() {
		super.close();
		this.resolvePromise?.(this.choice);
	}

	protected renderContent() {
		return html`
			${DialogContent({
				className: "flex flex-col gap-4",
				children: html`
					${DialogHeader({
						title: "Welcome to Shuvgeist",
					})}
					<p class="text-sm text-foreground">
						Start with the bundled free tier, log in with an existing subscription,
						or bring your own API key. You can change providers any time.
					</p>
					<div class="grid gap-3">
						${Button({
							variant: "default",
							onClick: () => this.choose("free-tier"),
							children: "Use free tier",
						})}
						${Button({
							variant: "secondary",
							onClick: () => this.choose("subscription-settings"),
							children: "Log in with subscription",
						})}
						${Button({
							variant: "secondary",
							onClick: () => this.choose("provider-settings"),
							children: "Bring API key",
						})}
					</div>
				`,
			})}
		`;
	}
}

if (!customElements.get("welcome-setup-dialog")) {
	customElements.define("welcome-setup-dialog", WelcomeSetupDialog);
}
