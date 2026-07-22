import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import { html, type TemplateResult } from "lit";
import { Sparkles } from "lucide";
import { SkillDialog } from "../dialogs/SkillDialog.js";
import type { Skill } from "../storage/stores/skills-store.js";

export function SkillPill(nameOrSkill: string | Skill, clickable = false): TemplateResult {
	const skill = typeof nameOrSkill === "string" ? null : nameOrSkill;
	const name = typeof nameOrSkill === "string" ? nameOrSkill : nameOrSkill.name;

	const handleClick = () => {
		if (!skill) return;
		SkillDialog.open(skill);
	};

	return html`
		<div
			class="inline-flex items-center gap-2 px-2 py-1 text-xs bg-muted/50 border border-border rounded ${
				clickable ? "cursor-pointer hover:bg-muted transition-colors" : ""
			}"
			@click=${clickable && skill ? handleClick : null}
		>
			${icon(Sparkles, "sm")}
			<span class="text-foreground">${name}</span>
		</div>
	`;
}
