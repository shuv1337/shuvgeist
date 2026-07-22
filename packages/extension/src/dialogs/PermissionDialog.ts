import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { i18n } from "@mariozechner/mini-lit/dist/i18n.js";
import { html } from "lit";

export abstract class PermissionDialog extends DialogBase {
	protected requesting = false;
	protected errorMessage = "";

	protected modalWidth = "min(500px, 90vw)";
	protected modalHeight = "auto";

	private grantCallback?: () => Promise<{ granted: boolean; message?: string }>;

	/**
	 * Header information for the dialog
	 */
	protected abstract header(): { title: string; description: string };

	/**
	 * Explanation of why this permission is needed
	 */
	protected abstract why(): string;

	/**
	 * List of what granting this permission means
	 */
	protected abstract what(): string[];

	/**
	 * Open the dialog and request permission.
	 * The callback is invoked when user clicks "Grant" and runs in the context of the user gesture.
	 * Returns true if permission granted, false otherwise.
	 */
	protected async requestPermission(
		callback: () => Promise<{ granted: boolean; message?: string }>,
	): Promise<boolean> {
		this.grantCallback = callback;
		this.open();

		return new Promise<boolean>((resolve) => {
			this.addEventListener(
				"close",
				() => {
					resolve(false);
				},
				{ once: true },
			);

			// Store resolve for success case
			(this as any)._resolvePromise = resolve;
		});
	}

	private async handleGrant() {
		if (!this.grantCallback) return;

		this.requesting = true;
		this.errorMessage = "";
		this.requestUpdate();

		try {
			// Call the callback immediately while in user gesture context
			const result = await this.grantCallback();

			if (result.granted) {
				// Resolve with success
				const resolve = (this as any)._resolvePromise;
				if (resolve) {
					resolve(true);
					delete (this as any)._resolvePromise;
				}
				this.close();
			} else {
				this.errorMessage = result.message || i18n("Permission request failed");
				this.requesting = false;
				this.requestUpdate();
			}
		} catch (error) {
			this.errorMessage = `${error}`;
			this.requesting = false;
			this.requestUpdate();
		}
	}

	private handleDeny() {
		const resolve = (this as any)._resolvePromise;
		if (resolve) {
			resolve(false);
			delete (this as any)._resolvePromise;
		}
		this.close();
	}

	protected override renderContent() {
		const headerInfo = this.header();

		return html`
			${DialogContent({
				children: html`
					${DialogHeader({
						title: headerInfo.title,
						description: headerInfo.description,
					})}

					<div class="mt-4 flex flex-col gap-4">
						<div class="flex gap-3 p-4 bg-warning/10 border border-warning/20 rounded-lg">
							<div class="flex-shrink-0 text-warning">
								<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
									<line x1="12" y1="9" x2="12" y2="13"></line>
									<line x1="12" y1="17" x2="12.01" y2="17"></line>
								</svg>
							</div>
							<div class="text-sm">
								<p class="font-medium text-foreground mb-1">${i18n("Why is this needed?")}</p>
								<p class="text-muted-foreground">${this.why()}</p>
							</div>
						</div>

						<div class="text-sm text-muted-foreground">
							<p class="mb-2">${i18n("What this means:")}</p>
							<ul class="list-disc list-inside space-y-1 ml-2">
								${this.what().map((item) => html`<li>${item}</li>`)}
							</ul>
						</div>

						${
							this.errorMessage
								? html`
									<div class="p-3 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive">
										${this.errorMessage}
									</div>
							  `
								: ""
						}
					</div>

					<div class="mt-6 flex gap-3 justify-end">
						${Button({
							variant: "outline",
							onClick: () => this.handleDeny(),
							disabled: this.requesting,
							children: i18n("Continue Anyway"),
						})}
						${Button({
							variant: "default",
							onClick: () => this.handleGrant(),
							disabled: this.requesting,
							children: this.requesting ? i18n("Requesting...") : i18n("Grant Permission"),
						})}
					</div>
				`,
			})}
		`;
	}
}
