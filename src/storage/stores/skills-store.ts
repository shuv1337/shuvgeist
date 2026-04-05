import { Store } from "@mariozechner/pi-web-ui/storage/store.js";
import type { StoreConfig } from "@mariozechner/pi-web-ui/storage/types.js";
import { minimatch } from "minimatch";

export interface Skill {
	name: string;
	domainPatterns: string[];
	shortDescription: string;
	description: string;
	createdAt: string;
	lastUpdated: string;
	examples: string;
	library: string;
}

/**
 * Store for managing site skills.
 */
export class SkillsStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: "skills",
		};
	}

	async get(name: string): Promise<Skill | null> {
		return this.getBackend().get("skills", name);
	}

	async save(skill: Skill): Promise<void> {
		await this.getBackend().set("skills", skill.name, skill);
	}

	async delete(name: string): Promise<void> {
		await this.getBackend().delete("skills", name);
	}

	async list(currentUrl?: string): Promise<Skill[]> {
		const keys = await this.getBackend().keys("skills");
		const skills = await Promise.all(keys.map((key) => this.getBackend().get<Skill>("skills", key)));
		const validSkills = skills.filter((s): s is Skill => s !== null);

		if (currentUrl) {
			return validSkills.filter((skill) => this.matchesAnyPattern(currentUrl, skill.domainPatterns));
		}

		return validSkills;
	}

	async getForUrl(url: string): Promise<Skill[]> {
		return this.list(url);
	}

	// Alias methods for backward compatibility
	async getSkillsForUrl(url: string): Promise<Skill[]> {
		return this.getForUrl(url);
	}

	async getSkill(name: string): Promise<Skill | null> {
		return this.get(name);
	}

	async saveSkill(skill: Skill): Promise<void> {
		return this.save(skill);
	}

	async deleteSkill(name: string): Promise<void> {
		return this.delete(name);
	}

	async listSkills(currentUrl?: string): Promise<Skill[]> {
		return this.list(currentUrl);
	}

	/**
	 * Check if URL matches any of the domain patterns using glob matching.
	 */
	matchesAnyPattern(url: string, patterns: string[]): boolean {
		try {
			const urlObj = new URL(url);
			const hostname = urlObj.hostname;
			const path = urlObj.pathname;

			for (const pattern of patterns) {
				const parts = pattern.split("/");
				const domainPattern = parts[0];
				const pathPattern = parts.length > 1 ? `/${parts.slice(1).join("/")}` : "";

				const normalizedHostname = hostname.replace(/^www\./, "");
				const normalizedPattern = domainPattern.replace(/^www\./, "");

				const domainMatches = minimatch(normalizedHostname, normalizedPattern, {
					nocase: true,
				});

				if (!pathPattern || pathPattern === "/") {
					if (domainMatches) return true;
				} else {
					const pathMatches = minimatch(path, pathPattern, { nocase: true });
					if (domainMatches && pathMatches) return true;
				}
			}

			return false;
		} catch {
			return false;
		}
	}
}
