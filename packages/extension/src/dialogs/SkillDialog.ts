import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import { html } from "lit";
import { Sparkles } from "lucide";
import { DomainPill } from "../components/DomainPill.js";
import type { Skill } from "../storage/stores/skills-store.js";

export class SkillDialog extends DialogBase {
	private skill: Skill | null = null;

	protected modalWidth = "min(800px, 90vw)";
	protected modalHeight = "90vh";

	/**
	 * Open dialog to view skill details.
	 * Creates dialog instance and appends to body.
	 */
	static open(skill: Skill) {
		const dialog = new SkillDialog();
		dialog.skill = skill;
		document.body.appendChild(dialog);
		dialog.open();
		dialog.requestUpdate();
	}

	protected override renderContent() {
		if (!this.skill) return html``;

		const skill = this.skill;

		return html`
			<div class="flex flex-col h-full overflow-hidden">
				<div class="p-6 flex-shrink-0 border-b border-border">
					<div class="pr-8">
						<h2 class="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
							${icon(Sparkles, "sm")}
							${skill.name}
						</h2>
						<div class="flex flex-wrap gap-2 mb-2">
							${skill.domainPatterns.map((pattern) => DomainPill(pattern))}
						</div>
						${skill.shortDescription ? html`<p class="text-sm text-muted-foreground">${skill.shortDescription}</p>` : ""}
					</div>
				</div>

				<div class="flex-1 overflow-y-auto px-6 pb-6">
					<div class="mt-4 flex flex-col gap-4">

						<!-- Description -->
						${
							skill.description
								? html`
									<div>
										<div class="text-sm font-medium text-muted-foreground mb-2">Description</div>
										<markdown-block .content=${skill.description}></markdown-block>
									</div>
							  `
								: ""
						}

						<!-- Examples -->
						${
							skill.examples
								? html`
									<div>
										<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Examples")}</div>
										<code-block .code=${skill.examples} language="javascript"></code-block>
									</div>
							  `
								: ""
						}

						<!-- Library Code -->
						${
							skill.library
								? html`
									<div>
										<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Library")}</div>
										<code-block .code=${skill.library} language="javascript"></code-block>
									</div>
							  `
								: ""
						}
					</div>
				</div>
			</div>
		`;
	}
}

customElements.define("skill-dialog", SkillDialog);
