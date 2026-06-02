import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { type CustomProvider, getAppStorage, ProvidersModelsTab } from "@shuv1337/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { Toast } from "../components/Toast.js";

/**
 * Extended providers tab that wraps the upstream ProvidersModelsTab
 * and adds provider import/export functionality.
 */
export class ShuvgeistProvidersTab extends ProvidersModelsTab {
	private importConflicts: { provider: CustomProvider; selected: boolean }[] = [];
	private pendingImportProviders: CustomProvider[] = [];

	override getTabName(): string {
		return "Providers & Models";
	}

	private async exportProviders() {
		const storage = getAppStorage();
		const providers = await storage.customProviders.getAll();

		if (providers.length === 0) {
			Toast.error("No custom providers to export");
			return;
		}

		// Strip sensitive keys before export, replace with placeholder
		const sanitized = providers.map((p) => ({
			...p,
			apiKey: p.apiKey ? "<enter-your-key>" : undefined,
		}));

		const json = JSON.stringify(sanitized, null, 2);
		const blob = new Blob([json], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `shuvgeist-providers-${new Date().toISOString().split("T")[0]}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	private async importProviders() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "application/json,.json";
		input.onchange = async (e) => {
			const file = (e.target as HTMLInputElement).files?.[0];
			if (!file) return;

			try {
				const text = await file.text();
				let parsed = JSON.parse(text);

				// Accept both a single provider object and an array
				if (!Array.isArray(parsed)) {
					parsed = [parsed];
				}

				const providers = parsed as CustomProvider[];

				// Validate minimal shape
				for (const p of providers) {
					if (!p.name || !p.type || !p.baseUrl) {
						Toast.error(`Invalid provider: missing name, type, or baseUrl`);
						return;
					}
					// Assign an ID if missing (for preset files)
					if (!p.id) {
						p.id = crypto.randomUUID();
					}
				}

				this.pendingImportProviders = providers;

				// Check for conflicts
				const storage = getAppStorage();
				const conflicts: { provider: CustomProvider; selected: boolean }[] = [];

				for (const provider of providers) {
					const existing = await storage.customProviders.getAll();
					const conflict = existing.find((e) => e.name === provider.name);
					if (conflict) {
						conflicts.push({ provider, selected: true });
					}
				}

				if (conflicts.length > 0) {
					this.importConflicts = conflicts;
					this.requestUpdate();
				} else {
					await this.performImport(providers);
				}
			} catch (error) {
				Toast.error(`Failed to import providers: ${(error as Error).message}`);
			}
		};
		input.click();
	}

	private async performImport(providers: CustomProvider[]) {
		const storage = getAppStorage();

		// Filter out providers that are in conflicts and not selected
		const skipNames = new Set(this.importConflicts.filter((c) => !c.selected).map((c) => c.provider.name));
		const toImport = providers.filter((p) => !skipNames.has(p.name));

		let imported = 0;
		for (const provider of toImport) {
			// If overwriting, find and reuse the existing ID
			const existing = (await storage.customProviders.getAll()).find((e) => e.name === provider.name);
			if (existing) {
				provider.id = existing.id;
			}
			await storage.customProviders.set(provider);
			imported++;
		}

		this.importConflicts = [];
		this.pendingImportProviders = [];

		// Reload the upstream provider list
		await (this as any).loadCustomProviders?.();
		this.requestUpdate();
		Toast.success(`Imported ${imported} provider(s)`);
	}

	private toggleConflictSelection(index: number) {
		this.importConflicts[index].selected = !this.importConflicts[index].selected;
		this.requestUpdate();
	}

	private cancelImport() {
		this.importConflicts = [];
		this.pendingImportProviders = [];
		this.requestUpdate();
	}

	private renderConflictResolution(): TemplateResult {
		return html`
			<div class="border border-border rounded-lg p-4 bg-card space-y-4">
				<h3 class="font-semibold text-foreground">Import Conflicts</h3>
				<p class="text-sm text-muted-foreground">
					The following providers already exist. Check the ones you want to overwrite:
				</p>

				<div class="space-y-2">
					${this.importConflicts.map(
						(conflict, index) => html`
						<label class="flex items-start gap-3 p-3 border border-border rounded cursor-pointer hover:bg-muted/50">
							<input
								type="checkbox"
								.checked=${conflict.selected}
								@change=${() => this.toggleConflictSelection(index)}
								class="mt-1"
							/>
							<div class="flex-1">
								<div class="font-medium text-foreground">${conflict.provider.name}</div>
								<div class="text-xs text-muted-foreground">
									<span class="capitalize">${conflict.provider.type}</span>
									${conflict.provider.baseUrl ? html` &mdash; ${conflict.provider.baseUrl}` : ""}
								</div>
							</div>
						</label>
					`,
					)}
				</div>

				<div class="flex justify-end gap-2">
					${Button({
						variant: "outline",
						onClick: () => this.cancelImport(),
						children: "Cancel",
					})}
					${Button({
						variant: "default",
						onClick: () => this.performImport(this.pendingImportProviders),
						children: "Import Selected",
					})}
				</div>
			</div>
		`;
	}

	private renderImportExport(): TemplateResult {
		return html`
			<div class="flex gap-2 mb-4">
				${Button({
					variant: "outline",
					size: "sm",
					onClick: () => this.exportProviders(),
					children: "Export Providers",
				})}
				${Button({
					variant: "outline",
					size: "sm",
					onClick: () => this.importProviders(),
					children: "Import Provider",
				})}
			</div>
		`;
	}

	override render(): TemplateResult {
		if (this.importConflicts.length > 0) {
			return html`
				<div class="flex flex-col gap-6">
					${this.renderConflictResolution()}
				</div>
			`;
		}

		return html`
			<div class="flex flex-col gap-8">
				${this.renderImportExport()}
				${super.render()}
			</div>
		`;
	}
}

if (!customElements.get("shuvgeist-providers-tab")) {
	customElements.define("shuvgeist-providers-tab", ShuvgeistProvidersTab);
}
