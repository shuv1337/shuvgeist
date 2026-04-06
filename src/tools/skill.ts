import type { AgentTool } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import { SKILL_TOOL_DESCRIPTION } from "../prompts/prompts.js";
import { getShuvgeistStorage } from "../storage/app-storage.js";
import type { Skill } from "../storage/stores/skills-store.js";
import { defaultSkills } from "./default-skills.js";
import { resolveTabTarget } from "./helpers/browser-target.js";

const getSkills = () => getShuvgeistStorage().skills;
let skillToolWindowId: number | undefined;

export function setSkillToolWindowId(windowId?: number): void {
	skillToolWindowId = windowId;
}

// Initialize default skills on first run
export async function initializeDefaultSkills() {
	const skillsRepo = getSkills();
	for (const skill of defaultSkills) {
		const existing = await skillsRepo.getSkill(skill.name);
		if (!existing) {
			await skillsRepo.saveSkill(skill);
		}
	}
}

// Get sandbox URL for CSP-compliant code validation
const getSandboxUrl = () => {
	return chrome.runtime.getURL("sandbox.html");
};

/**
 * Check if library code contains navigation attempts.
 * Returns { hasNavigation: false } or { hasNavigation: true, warning: string }
 */
function checkForNavigation(code: string): { hasNavigation: boolean; warning?: string } {
	// Library code runs inside browserjs() - ANY navigation will break execution
	// Navigation must be done in the REPL script using navigate() before calling browserjs()
	const navigationPatterns = [
		/window\.location\s*=/, // window.location = ...
		/window\.location\.\w+\s*=/, // window.location.href = ..., window.location.pathname = ...
		/window\.location\.(assign|replace|reload)\s*\(/, // window.location.assign(...), replace(...), reload()
		/\blocation\s*=/, // location = ...
		/\blocation\.\w+\s*=/, // location.href = ..., location.pathname = ...
		/\blocation\.(assign|replace|reload)\s*\(/, // location.assign(...), replace(...), reload()
		/\bnavigate\s*\(/, // navigate(...)
		/history\.(pushState|replaceState)\s*\(/, // history.pushState/replaceState
	];

	for (const pattern of navigationPatterns) {
		if (pattern.test(code)) {
			return {
				hasNavigation: true,
				warning:
					"Library code must NOT contain navigation logic. Library code runs inside browserjs() which breaks execution on navigation. Navigation must be performed in the REPL script by calling navigate() BEFORE calling browserjs().",
			};
		}
	}

	return { hasNavigation: false };
}

/**
 * Validate JavaScript syntax using sandboxed iframe (CSP-compliant).
 * Returns { valid: true } or { valid: false, error: string }
 */
async function validateJavaScriptSyntax(code: string): Promise<{ valid: boolean; error?: string }> {
	// First check for navigation attempts
	const navCheck = checkForNavigation(code);
	if (navCheck.hasNavigation) {
		return { valid: false, error: navCheck.warning };
	}

	// Dynamically import SandboxIframe to avoid DOM deps at module load time
	const { SandboxIframe } = await import("@mariozechner/pi-web-ui");

	const sandbox = new SandboxIframe();
	sandbox.sandboxUrlProvider = getSandboxUrl;
	sandbox.style.display = "none";
	document.body.appendChild(sandbox);

	try {
		const result = await sandbox.execute(`syntax-check-${Date.now()}`, code, []);
		sandbox.remove();

		if (!result.success && result.error) {
			return { valid: false, error: result.error.message };
		}

		return { valid: true };
	} catch (error: unknown) {
		sandbox.remove();
		return { valid: false, error: (error as Error).message || "Unknown error" };
	}
}

// IMPORTANT: Use StringEnum for Google API compatibility (NOT Type.Union!)
const skillParamsSchema = Type.Object({
	action: StringEnum(["get", "list", "create", "rewrite", "update", "delete"], {
		description: "Action to perform",
	}),
	name: Type.Optional(Type.String({ description: "Skill name (required for get/rewrite/update/delete)" })),
	url: Type.Optional(
		Type.String({
			description: "URL to filter skills by domain (optional for list action, defaults to current tab URL)",
		}),
	),
	includeLibraryCode: Type.Optional(
		Type.Boolean({
			description:
				"Use with 'get' action to include full library code in output (only necessary if you want to make changes to the library code of a skill)",
		}),
	),
	data: Type.Optional(
		Type.Object({
			name: Type.String({ description: "Unique skill name" }),
			domainPatterns: Type.Array(Type.String(), {
				description:
					"Array of glob patterns (e.g., ['youtube.com', 'youtu.be'] or ['github.com', 'github.com/*/issues']). Include short URLs and domain variations!",
			}),
			shortDescription: Type.String({
				description: "Brief one-line plain text description",
			}),
			description: Type.String({
				description: "Full markdown description (include gotchas/limitations, use markdown formatting)",
			}),
			examples: Type.String({
				description: "Plain JavaScript code examples (will be rendered in code block)",
			}),
			library: Type.String({ description: "JavaScript code to inject" }),
		}),
	),
	updates: Type.Optional(
		Type.Object({
			name: Type.Optional(
				Type.Object({
					old_string: Type.String({
						description: "String to find in skill name",
					}),
					new_string: Type.String({ description: "String to replace it with" }),
				}),
			),
			shortDescription: Type.Optional(
				Type.Object({
					old_string: Type.String({
						description: "String to find in short description",
					}),
					new_string: Type.String({ description: "String to replace it with" }),
				}),
			),
			domainPatterns: Type.Optional(
				Type.Object({
					old_string: Type.String({
						description: "String to find in domain patterns (searches across all patterns)",
					}),
					new_string: Type.String({ description: "String to replace it with" }),
				}),
			),
			library: Type.Optional(
				Type.Object({
					old_string: Type.String({
						description: "String to find in library code",
					}),
					new_string: Type.String({ description: "String to replace it with" }),
				}),
			),
			description: Type.Optional(
				Type.Object({
					old_string: Type.String({
						description: "String to find in description",
					}),
					new_string: Type.String({ description: "String to replace it with" }),
				}),
			),
			examples: Type.Optional(
				Type.Object({
					old_string: Type.String({
						description: "String to find in examples",
					}),
					new_string: Type.String({ description: "String to replace it with" }),
				}),
			),
		}),
	),
});

export type SkillParams = Static<typeof skillParamsSchema>;

export const skillTool: AgentTool<typeof skillParamsSchema, any> = {
	label: "Skill Management",
	name: "skill",
	description: SKILL_TOOL_DESCRIPTION,
	parameters: skillParamsSchema,
	execute: async (_toolCallId: string, args: SkillParams) => {
		const skillsRepo = getSkills();
		const { tab } = await resolveTabTarget({ windowId: skillToolWindowId });
		const currentUrl = tab?.url || "";

		switch (args.action) {
			case "get": {
				if (!args.name) {
					throw new Error("Missing 'name' parameter for get action.");
				}

				const skill = await skillsRepo.getSkill(args.name);
				if (!skill) {
					// Return list of available skills for current domain
					const available = await skillsRepo.listSkills(currentUrl);
					if (available.length === 0) {
						throw new Error(`Skill '${args.name}' not found. No skills available for current domain.`);
					}
					const list = available.map((s) => `${s.name}: ${s.shortDescription}`).join("\n");
					throw new Error(`Skill '${args.name}' not found. Available skills:\n${list}`);
				}

				// Build output based on includeLibraryCode flag
				const domainsStr = skill.domainPatterns.join(", ");
				let llmOutput = `${skill.name} (${domainsStr})\n${skill.description}\n\nExamples:\n${skill.examples}`;

				// Only include library code if explicitly requested
				if (args.includeLibraryCode) {
					llmOutput += `\n\nLibrary:\n${skill.library}`;
				}

				return {
					content: [{ type: "text", text: llmOutput }],
					details: skill,
				};
			}

			case "list": {
				// Determine which URL to use for filtering
				// args.url === undefined -> use current tab URL (default)
				// args.url === "" -> list ALL skills (no filtering)
				// args.url === "https://..." -> use specified URL
				const filterUrl = args.url === undefined ? currentUrl : args.url === "" ? undefined : args.url;

				const skillList = await skillsRepo.listSkills(filterUrl);
				if (skillList.length === 0) {
					const msg = filterUrl ? "No skills found for specified domain." : "No skills found.";
					return { content: [{ type: "text", text: msg }], details: { skills: [] } };
				}

				// Token-efficient list for LLM: name: short description
				const llmOutput = skillList.map((s) => `${s.name}: ${s.shortDescription}`).join("\n");
				return {
					content: [{ type: "text", text: llmOutput }],
					details: { skills: skillList },
				};
			}

			case "create": {
				if (!args.data) {
					throw new Error("Missing 'data' parameter for create.");
				}

				// Check if already exists
				const existing = await skillsRepo.getSkill(args.data.name);
				if (existing) {
					throw new Error(`Skill '${args.data.name}' already exists. Use update action to modify.`);
				}

				const now = new Date().toISOString();
				const newSkill: Skill = {
					name: args.data.name,
					domainPatterns: args.data.domainPatterns,
					shortDescription: args.data.shortDescription,
					description: args.data.description,
					createdAt: now,
					lastUpdated: now,
					examples: args.data.examples,
					library: args.data.library,
				};

				// Validate final library code before saving
				const validation = await validateJavaScriptSyntax(newSkill.library);
				if (!validation.valid) {
					throw new Error(validation.error);
				}

				await skillsRepo.saveSkill(newSkill);

				return {
					content: [{ type: "text", text: `Skill '${args.data.name}' created.` }],
					details: newSkill,
				};
			}

			case "rewrite": {
				if (!args.name) {
					throw new Error("Missing 'name' parameter for rewrite.");
				}
				if (!args.data) {
					throw new Error("Missing 'data' parameter for rewrite.");
				}

				const existing = await skillsRepo.getSkill(args.name);
				if (!existing) {
					throw new Error(`Skill '${args.name}' not found. Use create action.`);
				}

				// Check if name is being changed
				const newName = args.data.name;
				if (newName && newName !== existing.name) {
					const existingWithNewName = await skillsRepo.getSkill(newName);
					if (existingWithNewName) {
						throw new Error(`Rewrite failed: Skill with name '${newName}' already exists.`);
					}
				}

				// Merge with existing (rewrite provided fields)
				const updated: Skill = {
					...existing,
					...args.data,
					name: newName || existing.name, // Allow name change
					createdAt: existing.createdAt, // Keep original creation date
					lastUpdated: new Date().toISOString(),
				};

				// Validate final library code before saving
				const validation = await validateJavaScriptSyntax(updated.library);
				if (!validation.valid) {
					throw new Error(validation.error);
				}

				// If name changed, delete old and save with new name
				if (newName && newName !== existing.name) {
					await skillsRepo.deleteSkill(args.name);
				}
				await skillsRepo.saveSkill(updated);

				return {
					content: [{ type: "text", text: `Skill '${args.name}' rewritten.` }],
					details: updated,
				};
			}

			case "update": {
				if (!args.name) {
					throw new Error("Missing 'name' parameter for update.");
				}
				if (!args.updates) {
					throw new Error("Missing 'updates' parameter for update.");
				}

				const existing = await skillsRepo.getSkill(args.name);
				if (!existing) {
					throw new Error(`Skill '${args.name}' not found. Use create action.`);
				}

				// Apply updates to each field
				const updated: Skill = { ...existing };
				let newName: string | undefined;

				if (args.updates.name) {
					const { old_string, new_string } = args.updates.name;
					if (!updated.name.includes(old_string)) {
						throw new Error("Update failed: old_string not found in name field.");
					}
					newName = updated.name.replace(old_string, new_string);
					// Check if new name already exists
					const existingWithNewName = await skillsRepo.getSkill(newName);
					if (existingWithNewName) {
						throw new Error(`Update failed: Skill with name '${newName}' already exists.`);
					}
					updated.name = newName;
				}

				if (args.updates.shortDescription) {
					const { old_string, new_string } = args.updates.shortDescription;
					if (!updated.shortDescription.includes(old_string)) {
						throw new Error("Update failed: old_string not found in shortDescription field.");
					}
					updated.shortDescription = updated.shortDescription.replace(old_string, new_string);
				}

				if (args.updates.domainPatterns) {
					const { old_string, new_string } = args.updates.domainPatterns;
					updated.domainPatterns = updated.domainPatterns.map((pattern) =>
						pattern.replace(old_string, new_string),
					);
				}

				if (args.updates.library) {
					const { old_string, new_string } = args.updates.library;
					if (!updated.library.includes(old_string)) {
						throw new Error("Update failed: old_string not found in library field.");
					}
					updated.library = updated.library.replace(old_string, new_string);

					// Validate updated library syntax
					const validation = await validateJavaScriptSyntax(updated.library);
					if (!validation.valid) {
						throw new Error(`Update failed: Syntax error in updated library: ${validation.error}`);
					}
				}

				if (args.updates.description) {
					const { old_string, new_string } = args.updates.description;
					if (!updated.description.includes(old_string)) {
						throw new Error("Update failed: old_string not found in description field.");
					}
					updated.description = updated.description.replace(old_string, new_string);
				}

				if (args.updates.examples) {
					const { old_string, new_string } = args.updates.examples;
					if (!updated.examples.includes(old_string)) {
						throw new Error("Update failed: old_string not found in examples field.");
					}
					updated.examples = updated.examples.replace(old_string, new_string);
				}

				updated.lastUpdated = new Date().toISOString();

				// Validate final library code before saving
				const finalValidation = await validateJavaScriptSyntax(updated.library);
				if (!finalValidation.valid) {
					throw new Error(finalValidation.error);
				}

				// If name changed, delete old and save with new name
				if (newName) {
					await skillsRepo.deleteSkill(args.name);
				}
				await skillsRepo.saveSkill(updated);

				return {
					content: [{ type: "text", text: `Skill '${args.name}' updated.` }],
					details: updated,
				};
			}

			case "delete": {
				if (!args.name) {
					throw new Error("Missing 'name' parameter for delete.");
				}

				const existing = await skillsRepo.getSkill(args.name);
				if (!existing) {
					return {
						content: [{ type: "text", text: `Skill '${args.name}' not found.` }],
						details: {},
					};
				}

				await skillsRepo.deleteSkill(args.name);
				return {
					content: [{ type: "text", text: `Skill '${args.name}' deleted.` }],
					details: { name: args.name },
				};
			}

			default:
				throw new Error(`Unknown action: ${(args as any).action}`);
		}
	},
};

// Renderer result types
export interface SkillResultDetails {
	skills?: Skill[];
	name?: string;
	domainPatterns?: string[];
	shortDescription?: string;
	description?: string;
	examples?: string;
	library?: string;
}
