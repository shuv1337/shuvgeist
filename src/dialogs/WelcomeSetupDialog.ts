import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html } from "lit";

/**
 * Shown on first launch when no API keys are configured.
 * Blocks until user clicks OK, then opens the API Keys & OAuth settings.
 */
export class WelcomeSetupDialog extends DialogBase {
	private resolvePromise?: () => void;

	protected modalWidth = "min(450px, 90vw)";
	protected modalHeight = "auto";

	static show(): Promise<void> {
		return new Promise((resolve) => {
			const dialog = new WelcomeSetupDialog();
			dialog.resolvePromise = resolve;
			dialog.open();
		});
	}

	override close() {
		super.close();
		this.resolvePromise?.();
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
						To get started, you need to connect at least one AI provider.
						You can either log in with an existing subscription (Anthropic, OpenAI, or GitHub Copilot)
						or enter an API key.
					</p>
					<div class="flex justify-end">
						${Button({
							variant: "default",
							onClick: () => this.close(),
							children: "Set up provider",
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
