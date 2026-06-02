import { Store } from "@mariozechner/pi-web-ui/storage/store.js";
import type { StoreConfig } from "@mariozechner/pi-web-ui/storage/types.js";

export interface SkillMemory {
	id: string;
	skillName: string;
	sessionId?: string;
	createdAt: string;
	source: "planner-validator";
	note: string;
	toolName?: string;
	turn?: number;
}

export interface AddSkillMemoryInput {
	skillName: string;
	sessionId?: string;
	createdAt?: string;
	source?: SkillMemory["source"];
	note: string;
	toolName?: string;
	turn?: number;
}

export class MemoryStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: "memories",
			indices: [
				{ name: "skillName", keyPath: "skillName" },
				{ name: "createdAt", keyPath: "createdAt" },
				{ name: "skillSessionCreatedAt", keyPath: "skillSessionCreatedAt" },
			],
		};
	}

	async add(input: AddSkillMemoryInput): Promise<SkillMemory> {
		const createdAt = input.createdAt ?? new Date().toISOString();
		const memory: SkillMemory & { skillSessionCreatedAt: string } = {
			id: this.createId(input.skillName, input.sessionId, createdAt),
			skillName: input.skillName,
			sessionId: input.sessionId,
			createdAt,
			source: input.source ?? "planner-validator",
			note: input.note,
			toolName: input.toolName,
			turn: input.turn,
			skillSessionCreatedAt: this.createCompoundKey(input.skillName, input.sessionId, createdAt),
		};
		await this.getBackend().set("memories", memory.id, memory);
		return this.stripIndexField(memory);
	}

	async getForSkill(skillName: string, limit = 5): Promise<SkillMemory[]> {
		const keys = await this.getBackend().keys("memories", skillName + "\u0000");
		const memories = await Promise.all(keys.map((key) => this.getBackend().get<SkillMemory>("memories", key)));
		return memories
			.filter((memory): memory is SkillMemory => memory !== null)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, limit)
			.map((memory) => this.stripIndexField(memory));
	}

	private createId(skillName: string, sessionId: string | undefined, createdAt: string): string {
		return this.createCompoundKey(skillName, sessionId, createdAt);
	}

	private createCompoundKey(skillName: string, sessionId: string | undefined, createdAt: string): string {
		return [skillName, sessionId ?? "", createdAt].join("\u0000");
	}

	private stripIndexField(memory: SkillMemory & { skillSessionCreatedAt?: string }): SkillMemory {
		const { skillSessionCreatedAt: _skillSessionCreatedAt, ...record } = memory;
		return record;
	}
}
