import { i18n } from "@mariozechner/mini-lit/dist/i18n.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import "../utils/i18n-extension.js";

@customElement("about-tab")
export class AboutTab extends SettingsTab {
	@state() private updateAvailable = false;
	@state() private latestVersion = "";
	@state() private checking = true;
	@state() private error = false;

	getTabName(): string {
		return i18n("About");
	}

	override async connectedCallback() {
		super.connectedCallback();
		await this.checkForUpdates();
	}

	private async checkForUpdates() {
		try {
			const response = await fetch("https://sitegeist.ai/uploads/version.json", {
				cache: "no-cache",
			});
			const data = await response.json();
			const currentVersion = chrome.runtime.getManifest().version;

			this.latestVersion = data.version;
			this.updateAvailable = data.version !== currentVersion;
			this.checking = false;
		} catch (err) {
			console.warn("[AboutTab] Failed to check for updates:", err);
			this.error = true;
			this.checking = false;
		}
	}

	private openUpdatePage() {
		window.open("https://sitegeist.ai/install.html#updating", "_blank");
	}

	render(): TemplateResult {
		// Get version from the manifest
		const version = chrome.runtime.getManifest().version;

		return html`
			<div class="flex flex-col gap-4">
				<div class="space-y-2">
					<h3 class="text-lg font-semibold text-foreground">Shuvgeist</h3>
					<p class="text-sm text-muted-foreground">${i18n("AI-powered browser extension for web navigation and interaction")}</p>
				</div>

				<div class="space-y-1">
					<div class="text-sm">
						<span class="font-medium text-foreground">${i18n("Version:")}</span>
						<span class="text-muted-foreground ml-2">${version}</span>
					</div>
				</div>

				${
					this.checking
						? html`
								<div class="text-xs text-muted-foreground">
									${i18n("Checking for updates...")}
								</div>
							`
						: this.updateAvailable
							? html`
									<div class="p-3 rounded-lg bg-orange-500/10 border border-orange-500/30">
										<div class="flex items-start justify-between gap-3">
											<div class="flex-1">
												<div class="text-sm font-medium text-foreground mb-1">
													${i18n("Update Available")}
												</div>
												<div class="text-xs text-muted-foreground">
													${i18n("A new version ({version}) is available").replace("{version}", this.latestVersion)}
												</div>
											</div>
											<button
												@click=${this.openUpdatePage}
												class="px-3 py-1.5 text-xs font-medium rounded-md bg-orange-500/20 hover:bg-orange-500/30 border border-orange-500/50 text-foreground transition-colors"
											>
												${i18n("Update")}
											</button>
										</div>
									</div>
								`
							: !this.error
								? html`
										<div class="text-xs text-green-600 dark:text-green-400">
											✓ ${i18n("You're up to date")}
										</div>
									`
								: ""
				}

				<div class="pt-4 space-y-2">
					<div class="text-xs text-muted-foreground space-x-3">
						<a href="https://sitegeist.ai" target="_blank" class="text-primary hover:underline">${i18n("Website")}</a>
						<span>·</span>
						<a href="https://sitegeist.ai/imprint" target="_blank" class="text-primary hover:underline">${i18n("Imprint")}</a>
						<span>·</span>
						<a href="https://sitegeist.ai/privacy" target="_blank" class="text-primary hover:underline">${i18n("Privacy")}</a>
					</div>
				</div>
			</div>
		`;
	}
}
