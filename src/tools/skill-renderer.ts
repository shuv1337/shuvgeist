import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { icon } from "@mariozechner/mini-lit";
import { Diff } from "@mariozechner/mini-lit/dist/Diff.js";
import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import {
	registerToolRenderer,
	renderCollapsibleHeader,
	renderHeader,
	type ToolRenderer,
	type ToolRenderResult,
} from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Sparkles } from "lucide";
import { DomainPill } from "../components/DomainPill.js";
import { SkillPill } from "../components/SkillPill.js";
import type { Skill } from "../storage/stores/skills-store.js";
import type { SkillParams, SkillResultDetails } from "./skill.js";

export const skillRenderer: ToolRenderer<SkillParams, SkillResultDetails> = {
	render(
		params: SkillParams | undefined,
		result: ToolResultMessage<SkillResultDetails> | undefined,
	): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";

		// Helper to render domain pills
		const renderDomainPills = (patterns: string[]) => html`
			<div class="flex flex-wrap gap-2">
				${patterns.map((pattern) => DomainPill(pattern))}
			</div>
		`;

		// Helper to render header text with inline skill pill
		const renderHeaderWithPill = (labelText: string, skillName?: string, skill?: Partial<Skill>): TemplateResult => {
			if (skillName && skill) {
				// Create full Skill object for pill
				const fullSkill: Skill = {
					name: skillName,
					domainPatterns: skill.domainPatterns || [],
					shortDescription: skill.shortDescription || "",
					description: skill.description || "",
					examples: skill.examples || "",
					library: skill.library || "",
					createdAt: skill.createdAt || "",
					lastUpdated: skill.lastUpdated || "",
				};
				return html`<span>${labelText} ${SkillPill(fullSkill, true)}</span>`;
			}
			return html`<span>${labelText}</span>`;
		};

		// Helper to render skill fields (used by create/update/get)
		const renderSkillFields = (skill: Partial<Skill>, showLibrary: boolean) => html`
			${skill.domainPatterns?.length ? renderDomainPills(skill.domainPatterns) : ""}
			${skill.shortDescription ? html`<div class="text-sm text-muted-foreground mt-3">${skill.shortDescription}</div>` : ""}
			${skill.description ? html`<div class="mt-3"><markdown-block .content=${skill.description}></markdown-block></div>` : ""}
			${
				skill.examples
					? html`
					<div class="mt-3">
						<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Examples")}</div>
						<code-block .code=${skill.examples} language="javascript"></code-block>
					</div>
				`
					: ""
			}
			${
				showLibrary && skill.library
					? html`
					<div class="mt-3">
						<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Library")}</div>
						<code-block .code=${skill.library} language="javascript"></code-block>
					</div>
				`
					: ""
			}
		`;

		// Error handling
		if (result?.isError) {
			const action = params?.action;
			const skillName = params?.name || params?.data?.name;
			const labels: Record<string, string> = {
				get: i18n("Getting skill"),
				list: i18n("Listing skills"),
				create: i18n("Creating skill"),
				rewrite: i18n("Rewriting skill"),
				update: i18n("Updating skill"),
				delete: i18n("Deleting skill"),
			};
			const headerText = skillName ? `${labels[action!] || action} ${skillName}` : labels[action!] || action || "";

			// For create/rewrite errors, show partial skill data with error at bottom - COLLAPSED BY DEFAULT
			if ((action === "create" || action === "rewrite") && params?.data) {
				const contentRef = createRef<HTMLElement>();
				const chevronRef = createRef<HTMLElement>();
				const skillName = params?.data?.name;

				return {
					content: html`
					<div>
						${renderCollapsibleHeader(state, Sparkles, skillName ? renderHeaderWithPill(headerText, skillName, params.data) : headerText, contentRef, chevronRef, false)}
						<div ${ref(contentRef)} class="overflow-hidden transition-all duration-200 ease-in-out max-h-0 space-y-3">
							${renderSkillFields(params.data, true)}
							<div class="w-full px-3 py-2 text-sm text-destructive bg-destructive/10 border border-destructive rounded">
								${result.content.find((c) => c.type === "text")?.text || ""}
							</div>
						</div>
					</div>
				`,
					isCustom: false,
				};
			}

			return {
				content: html`
				<div class="space-y-3">
					${renderHeader(state, Sparkles, headerText)}
					<div class="text-sm text-destructive">${result.content.find((c) => c.type === "text")?.text || ""}</div>
				</div>
			`,
				isCustom: false,
			};
		}

		// Full params + result
		if (result && params) {
			const { action } = params;
			const skill = result.details;

			switch (action) {
				case "get": {
					// Show clickable skill pill in header
					if (!skill?.name) {
						return {
							content: renderHeader(state, Sparkles, i18n("No skills found")),
							isCustom: false,
						};
					}

					// Create a full Skill object from the result details
					const fullSkill: Skill = {
						name: skill.name,
						domainPatterns: skill.domainPatterns || [],
						shortDescription: skill.shortDescription || "",
						description: skill.description || "",
						examples: skill.examples || "",
						library: skill.library || "",
						createdAt: "",
						lastUpdated: "",
					};

					const statusIcon = html`<span class="inline-block text-green-600 dark:text-green-500">${icon(Sparkles, "sm")}</span>`;

					return {
						content: html`
						<div class="flex items-center gap-2 text-sm text-muted-foreground">
							${statusIcon}
							<span>${i18n("Got skill")}</span>
							${SkillPill(fullSkill, true)}
						</div>
					`,
						isCustom: false,
					};
				}

				case "list": {
					// Show "Skills for <domain>" header + skill pills
					const skills = skill?.skills || [];
					if (skills.length === 0) {
						return {
							content: renderHeader(state, Sparkles, i18n("No skills found")),
							isCustom: false,
						};
					}

					// Get domain from first skill
					const domain = skills[0]?.domainPatterns?.[0] || "";
					const statusIcon = html`<span class="inline-block text-green-600 dark:text-green-500">${icon(Sparkles, "sm")}</span>`;

					return {
						content: html`
						<div class="space-y-3">
							<div class="flex items-center gap-2 text-sm text-muted-foreground">
								${statusIcon}
								<span>${i18n("Skills for domain")}</span>
								${domain ? DomainPill(domain) : ""}
							</div>
							<div class="flex flex-wrap gap-2">
								${skills.map((s) => SkillPill(s, true))}
							</div>
						</div>
					`,
						isCustom: false,
					};
				}

				case "create":
				case "rewrite": {
					// Show all skill fields (including library) - COLLAPSED BY DEFAULT
					// Skill data comes from result.details (full Skill object)
					const skillData = skill || params.data || {};
					const skillName = skillData.name;
					if (!skillName) {
						return {
							content: renderHeader(state, Sparkles, i18n("Processing skill...")),
							isCustom: false,
						};
					}

					const labelText =
						action === "create"
							? state === "complete"
								? i18n("Created skill")
								: i18n("Creating skill")
							: state === "complete"
								? i18n("Rewritten skill")
								: i18n("Rewriting skill");

					const contentRef = createRef<HTMLElement>();
					const chevronRef = createRef<HTMLElement>();

					return {
						content: html`
						<div>
							${renderCollapsibleHeader(state, Sparkles, renderHeaderWithPill(labelText, skillName, skillData), contentRef, chevronRef, false)}
							<div ${ref(contentRef)} class="overflow-hidden transition-all duration-200 ease-in-out max-h-0">
								${renderSkillFields(skillData, true)}
							</div>
						</div>
					`,
						isCustom: false,
					};
				}

				case "update": {
					// Show diffs for updated fields
					const skillName = params.name;
					if (!skillName) {
						return {
							content: renderHeader(state, Sparkles, i18n("Processing skill...")),
							isCustom: false,
						};
					}

					const labelText = state === "complete" ? i18n("Updated skill") : i18n("Updating skill");
					const contentRef = createRef<HTMLElement>();
					const chevronRef = createRef<HTMLElement>();

					const updates = params.updates || {};
					// Use the full skill from result.details if available, otherwise just the name
					const skillData = skill || { name: skillName };

					return {
						content: html`
						<div>
							${renderCollapsibleHeader(state, Sparkles, renderHeaderWithPill(labelText, skillName, skillData), contentRef, chevronRef, false)}
							<div ${ref(contentRef)} class="overflow-hidden transition-all duration-200 ease-in-out max-h-0 space-y-3">
								${
									updates.library
										? html`
										<div>
											<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Library")}</div>
											${Diff({ oldText: updates.library.old_string, newText: updates.library.new_string })}
										</div>
										`
										: ""
								}
								${
									updates.description
										? html`
										<div>
											<div class="text-sm font-medium text-muted-foreground mb-2">Description</div>
											${Diff({ oldText: updates.description.old_string, newText: updates.description.new_string })}
										</div>
										`
										: ""
								}
								${
									updates.examples
										? html`
										<div>
											<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Examples")}</div>
											${Diff({ oldText: updates.examples.old_string, newText: updates.examples.new_string })}
										</div>
										`
										: ""
								}
							</div>
						</div>
					`,
						isCustom: false,
					};
				}

				case "delete": {
					// Show "Deleted skill" with pill in header row
					const skillName = params.name;
					const statusIcon = html`<span class="inline-block text-green-600 dark:text-green-500">${icon(Sparkles, "sm")}</span>`;
					return {
						content: html`
						<div class="flex items-center gap-2 text-sm text-muted-foreground">
							${statusIcon}
							<span>${i18n("Deleted skill")}</span>
							${skillName ? SkillPill(skillName) : ""}
						</div>
					`,
						isCustom: false,
					};
				}

				default:
					return {
						content: renderHeader(state, Sparkles, result.content.find((c) => c.type === "text")?.text || ""),
						isCustom: false,
					};
			}
		}

		// Params only (streaming)
		if (params) {
			const { action, name, data } = params;

			switch (action) {
				case "create":
				case "rewrite": {
					// Show streaming skill fields as they come in
					const skillName = data?.name || name;
					if (!skillName) {
						const labels: Record<string, string> = {
							create: i18n("Creating skill"),
							rewrite: i18n("Rewriting skill"),
						};
						return {
							content: renderHeader(state, Sparkles, labels[action] || ""),
							isCustom: false,
						};
					}

					const labels: Record<string, string> = {
						create: i18n("Creating skill"),
						rewrite: i18n("Rewriting skill"),
					};
					const labelText = labels[action];

					const contentRef = createRef<HTMLElement>();
					const chevronRef = createRef<HTMLElement>();

					return {
						content: html`
						<div>
							${renderCollapsibleHeader(state, Sparkles, renderHeaderWithPill(labelText, skillName, data), contentRef, chevronRef, false)}
							<div ${ref(contentRef)} class="overflow-hidden transition-all duration-200 ease-in-out max-h-0">
								${data ? renderSkillFields(data, true) : ""}
							</div>
						</div>
					`,
						isCustom: false,
					};
				}
				case "update": {
					// Show streaming diffs as they come in
					const skillName = name;
					if (!skillName) {
						return {
							content: renderHeader(state, Sparkles, i18n("Updating skill")),
							isCustom: false,
						};
					}

					const labelText = i18n("Updating skill");
					const contentRef = createRef<HTMLElement>();
					const chevronRef = createRef<HTMLElement>();
					const updates = params.updates || {};
					const skillData = { name: skillName };

					return {
						content: html`
						<div>
							${renderCollapsibleHeader(state, Sparkles, renderHeaderWithPill(labelText, skillName, skillData), contentRef, chevronRef, false)}
							<div ${ref(contentRef)} class="overflow-hidden transition-all duration-200 ease-in-out max-h-0 space-y-3">
								${
									updates.library
										? html`
										<div>
											<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Library")}</div>
											${Diff({ oldText: updates.library.old_string, newText: updates.library.new_string })}
										</div>
										`
										: ""
								}
								${
									updates.description
										? html`
										<div>
											<div class="text-sm font-medium text-muted-foreground mb-2">Description</div>
											${Diff({ oldText: updates.description.old_string, newText: updates.description.new_string })}
										</div>
										`
										: ""
								}
								${
									updates.examples
										? html`
										<div>
											<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Examples")}</div>
											${Diff({ oldText: updates.examples.old_string, newText: updates.examples.new_string })}
										</div>
										`
										: ""
								}
							</div>
						</div>
					`,
						isCustom: false,
					};
				}
				default: {
					const skillName = name || data?.name;
					const labels: Record<string, string> = {
						get: i18n("Getting skill"),
						list: i18n("Listing skills"),
						delete: i18n("Deleting skill"),
					};
					const headerText = skillName
						? `${labels[action] || action} ${skillName}`
						: labels[action] || action || "";
					return {
						content: renderHeader(state, Sparkles, headerText),
						isCustom: false,
					};
				}
			}
		}

		// No params, no result
		return {
			content: renderHeader(state, Sparkles, i18n("Processing skill...")),
			isCustom: false,
		};
	},
};

export function registerSkillRenderer() {
	registerToolRenderer("skill", skillRenderer);
}
