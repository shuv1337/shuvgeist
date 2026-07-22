export const SKILL_SNAPSHOT_VERSION = 1;
export const SKILL_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface BridgeSkillSnapshotSkill {
	name: string;
	domainPatterns: string[];
	appPatterns: string[];
	shortDescription: string;
	description: string;
	examples: string;
	library: string;
	lastUpdated: string;
}

export interface BridgeSkillSnapshot {
	version: number;
	generatedAt: string;
	skills: BridgeSkillSnapshotSkill[];
}

export interface BridgeSkillSnapshotStatus {
	state: "missing" | "fresh" | "stale" | "invalid";
	generatedAt?: string;
	ageMs?: number;
	skillCount?: number;
	message?: string;
}

/** Minimal extension-facing input needed to produce the bridge wire snapshot. */
export interface BridgeSkillSnapshotSource {
	name: string;
	domainPatterns?: readonly string[];
	appPatterns?: readonly string[];
	shortDescription: string;
	description: string;
	examples: string;
	library: string;
	lastUpdated: string;
}

export function createBridgeSkillSnapshot(
	skills: readonly BridgeSkillSnapshotSource[],
	now = new Date(),
): BridgeSkillSnapshot {
	return {
		version: SKILL_SNAPSHOT_VERSION,
		generatedAt: now.toISOString(),
		skills: skills.map((skill) => ({
			name: skill.name,
			domainPatterns: [...(skill.domainPatterns ?? [])],
			appPatterns: [...(skill.appPatterns ?? [])],
			shortDescription: skill.shortDescription,
			description: skill.description,
			examples: skill.examples,
			library: skill.library,
			lastUpdated: skill.lastUpdated,
		})),
	};
}

export function parseBridgeSkillSnapshot(value: unknown): BridgeSkillSnapshot {
	if (!value || typeof value !== "object") throw new Error("Skill snapshot must be an object.");
	const snapshot = value as Partial<BridgeSkillSnapshot>;
	if (snapshot.version !== SKILL_SNAPSHOT_VERSION) {
		throw new Error(`Unsupported skill snapshot version '${String(snapshot.version)}'.`);
	}
	if (typeof snapshot.generatedAt !== "string" || Number.isNaN(Date.parse(snapshot.generatedAt))) {
		throw new Error("Skill snapshot generatedAt is missing or invalid.");
	}
	if (!Array.isArray(snapshot.skills)) throw new Error("Skill snapshot skills must be an array.");
	return {
		version: snapshot.version,
		generatedAt: snapshot.generatedAt,
		skills: snapshot.skills.map(parseSnapshotSkill),
	};
}

export function getBridgeSkillSnapshotStatus(
	snapshot: BridgeSkillSnapshot | null,
	nowMs = Date.now(),
): BridgeSkillSnapshotStatus {
	if (!snapshot) return { state: "missing", message: "No bridge skill snapshot has been synced." };
	const generatedMs = Date.parse(snapshot.generatedAt);
	const ageMs = nowMs - generatedMs;
	return {
		state: ageMs > SKILL_SNAPSHOT_MAX_AGE_MS ? "stale" : "fresh",
		generatedAt: snapshot.generatedAt,
		ageMs,
		skillCount: snapshot.skills.length,
		message:
			ageMs > SKILL_SNAPSHOT_MAX_AGE_MS
				? "Bridge skill snapshot is stale; sync skills from the extension."
				: undefined,
	};
}

export function matchSnapshotSkillsForApp(
	snapshot: BridgeSkillSnapshot,
	appRefs: Array<string | undefined>,
): BridgeSkillSnapshotSkill[] {
	const refs = appRefs.filter((ref): ref is string => Boolean(ref?.trim())).map((ref) => ref.toLowerCase());
	if (refs.length === 0) return [];
	return snapshot.skills.filter((skill) => matchesAnyAppPattern(refs, skill.appPatterns));
}

function parseSnapshotSkill(value: unknown): BridgeSkillSnapshotSkill {
	if (!value || typeof value !== "object") throw new Error("Skill snapshot entry must be an object.");
	const skill = value as Partial<BridgeSkillSnapshotSkill>;
	if (typeof skill.name !== "string" || !skill.name.trim()) throw new Error("Skill snapshot entry missing name.");
	if (!Array.isArray(skill.domainPatterns)) throw new Error(`Skill '${skill.name}' missing domainPatterns array.`);
	if (!Array.isArray(skill.appPatterns)) throw new Error(`Skill '${skill.name}' missing appPatterns array.`);
	if (typeof skill.library !== "string") throw new Error(`Skill '${skill.name}' missing library.`);
	return {
		name: skill.name,
		domainPatterns: skill.domainPatterns.filter((pattern): pattern is string => typeof pattern === "string"),
		appPatterns: skill.appPatterns.filter((pattern): pattern is string => typeof pattern === "string"),
		shortDescription: typeof skill.shortDescription === "string" ? skill.shortDescription : "",
		description: typeof skill.description === "string" ? skill.description : "",
		examples: typeof skill.examples === "string" ? skill.examples : "",
		library: skill.library,
		lastUpdated: typeof skill.lastUpdated === "string" ? skill.lastUpdated : "",
	};
}

function matchesAnyAppPattern(appRefs: string[], patterns: string[]): boolean {
	return patterns.some((pattern) => {
		const normalized = pattern.toLowerCase().trim();
		if (!normalized) return false;
		return appRefs.some((appRef) => appRef === normalized || appRef.includes(normalized));
	});
}
