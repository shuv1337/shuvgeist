/**
 * Installs the packaged Shuvgeist agent skill into the shared agent skills
 * directory (`~/.agents/skills/shuvgeist`) so coding agents discover it
 * automatically.
 *
 * The npm package ships `skills/shuvgeist/SKILL.md`, but npm only drops it
 * inside `node_modules/` — nothing copies it where agents look. The CLI syncs
 * it itself:
 *   - lazily on every run via {@link ensureSkillInstalled} (version-gated,
 *     silent, best-effort — never breaks a command), and
 *   - explicitly via `shuvgeist skill install` ({@link installSkill}).
 *
 * This is deliberately scriptless (no npm `postinstall` hook), so it works the
 * same under `npm install --ignore-scripts`, pnpm, and CI.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Injected by scripts/build-cli.mjs (esbuild `define`). Absent in unit tests.
declare const __SHUVGEIST_DEV_ROOT__: string;

const SKILL_NAME = "shuvgeist";
/** Marker file written into the target dir to track the installed version. */
const VERSION_STAMP_FILE = ".shuvgeist-skill-version";

export type SkillInstallAction = "installed" | "updated" | "unchanged" | "skipped";

export interface SkillInstallResult {
	action: SkillInstallAction;
	targetDir: string;
	installedVersion: string;
	previousVersion?: string;
	/** Set when action is "skipped". */
	reason?: string;
}

export interface InstallSkillParams {
	/** Version stamp to record (typically the CLI `VERSION`). */
	version: string;
	/** Override the packaged skill source dir (defaults to the resolved package copy). */
	sourceDir?: string;
	/** Override the install target (defaults to `~/.agents/skills/shuvgeist`). */
	targetDir?: string;
	/** Re-copy even when the recorded version already matches. */
	force?: boolean;
}

/** Candidate package roots that may contain `skills/shuvgeist/`, most reliable first. */
function candidatePackageRoots(): string[] {
	const roots: string[] = [];
	try {
		// The bundled CLI lives at <packageRoot>/dist-cli/shuvgeist.mjs, so the
		// package root is two levels up from this module's runtime location.
		const here = dirname(fileURLToPath(import.meta.url));
		roots.push(join(here, ".."));
		roots.push(join(here, "..", "..", ".."));
	} catch {
		// import.meta.url unavailable in some contexts — fall through to dev root.
	}
	if (typeof __SHUVGEIST_DEV_ROOT__ !== "undefined" && __SHUVGEIST_DEV_ROOT__) {
		roots.push(__SHUVGEIST_DEV_ROOT__);
	}
	return roots;
}

/** Resolve the packaged skill source dir (`skills/shuvgeist`), or undefined if not found. */
export function resolveSkillSourceDir(): string | undefined {
	for (const root of candidatePackageRoots()) {
		const candidate = join(root, "skills", SKILL_NAME);
		if (existsSync(join(candidate, "SKILL.md"))) return candidate;
	}
	return undefined;
}

/** The shared agent skills install target: `~/.agents/skills/shuvgeist`. */
export function resolveSkillTargetDir(): string {
	return join(homedir(), ".agents", "skills", SKILL_NAME);
}

function readStamp(targetDir: string): string | undefined {
	try {
		const stampPath = join(targetDir, VERSION_STAMP_FILE);
		if (!existsSync(stampPath)) return undefined;
		return readFileSync(stampPath, "utf-8").trim();
	} catch {
		return undefined;
	}
}

/**
 * Copy the packaged skill into the target dir when missing, stale, or forced.
 * Synchronous and cheap when already up to date (a single stat + small read).
 */
export function installSkill(params: InstallSkillParams): SkillInstallResult {
	const { version, force = false } = params;
	const targetDir = params.targetDir ?? resolveSkillTargetDir();
	const sourceDir = params.sourceDir ?? resolveSkillSourceDir();

	if (!sourceDir || !existsSync(join(sourceDir, "SKILL.md"))) {
		return {
			action: "skipped",
			targetDir,
			installedVersion: version,
			reason: "packaged skill source (skills/shuvgeist/SKILL.md) not found",
		};
	}

	const skillFile = join(targetDir, "SKILL.md");
	const existedBefore = existsSync(skillFile);
	const previousVersion = readStamp(targetDir);

	// "dev" builds always re-copy so local skill edits propagate immediately.
	const upToDate = existedBefore && previousVersion === version && version !== "dev";
	if (upToDate && !force) {
		return { action: "unchanged", targetDir, installedVersion: version, previousVersion };
	}

	mkdirSync(targetDir, { recursive: true });
	cpSync(sourceDir, targetDir, { recursive: true });
	writeFileSync(join(targetDir, VERSION_STAMP_FILE), version, "utf-8");

	return {
		action: existedBefore ? "updated" : "installed",
		targetDir,
		installedVersion: version,
		previousVersion,
	};
}

/**
 * Best-effort lazy sync called on every CLI run. Version-gated, silent, and
 * never throws — a skill-install failure must never break a CLI command.
 */
export function ensureSkillInstalled(version: string): SkillInstallResult | undefined {
	try {
		return installSkill({ version });
	} catch {
		return undefined;
	}
}
