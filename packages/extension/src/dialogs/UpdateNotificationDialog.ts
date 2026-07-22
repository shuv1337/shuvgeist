import { html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import "../utils/i18n-extension.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { i18n } from "@mariozechner/mini-lit/dist/i18n.js";

@customElement("update-notification-dialog")
export class UpdateNotificationDialog extends DialogBase {
	@property() latestVersion = "";

	protected modalWidth = "min(500px, 90vw)";
	protected modalHeight = "auto";

	/**
	 * Show update notification dialog.
	 * User must update - dialog cannot be dismissed.
	 */
	static async show(latestVersion: string): Promise<void> {
		const dialog = new UpdateNotificationDialog();
		dialog.latestVersion = latestVersion;
		document.body.appendChild(dialog);

		// Dialog blocks until browser is restarted with new version
		return new Promise(() => {
			// Never resolves - blocks forever until restart
		});
	}

	// Override close to prevent dismissal
	override close() {
		// Do nothing - user must click Update button
	}

	private handleUpdate() {
		window.open("https://geist.shuv.ai/install#updating", "_blank");
		// Don't close - keep blocking until extension is actually updated and restarted
	}

	protected renderContent(): TemplateResult {
		const description = i18n("A new version ({version}) is available. Please update to continue.").replace(
			"{version}",
			this.latestVersion,
		);

		return html`
			${DialogContent({
				children: html`
					${DialogHeader({
						title: i18n("Update Required"),
						description,
					})}

					<div class="mt-6 flex justify-end">
						${Button({
							children: i18n("Update Now"),
							onClick: () => this.handleUpdate(),
							variant: "default",
						})}
					</div>
				`,
			})}
		`;
	}
}
