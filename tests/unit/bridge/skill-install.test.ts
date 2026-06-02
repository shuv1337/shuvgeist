import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSkill, resolveSkillTargetDir } from "../../../src/bridge/skill-install.js";

const STAMP = ".shuvgeist-skill-version";

describe("installSkill", () => {
	let root: string;
	let sourceDir: string;
	let targetDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "shuvgeist-skill-"));
		sourceDir = join(root, "src-skill");
		targetDir = join(root, "target", "shuvgeist");
		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(join(sourceDir, "SKILL.md"), "# Shuvgeist\nv1 body\n", "utf-8");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("installs the skill when the target is empty", () => {
		const result = installSkill({ version: "1.0.0", sourceDir, targetDir });
		expect(result.action).toBe("installed");
		expect(result.targetDir).toBe(targetDir);
		expect(readFileSync(join(targetDir, "SKILL.md"), "utf-8")).toContain("v1 body");
		expect(readFileSync(join(targetDir, STAMP), "utf-8").trim()).toBe("1.0.0");
	});

	it("is a no-op when the same version is already installed", () => {
		installSkill({ version: "1.0.0", sourceDir, targetDir });
		const result = installSkill({ version: "1.0.0", sourceDir, targetDir });
		expect(result.action).toBe("unchanged");
		expect(result.previousVersion).toBe("1.0.0");
	});

	it("updates and refreshes content when the version changes", () => {
		installSkill({ version: "1.0.0", sourceDir, targetDir });
		writeFileSync(join(sourceDir, "SKILL.md"), "# Shuvgeist\nv2 body\n", "utf-8");
		const result = installSkill({ version: "1.1.0", sourceDir, targetDir });
		expect(result.action).toBe("updated");
		expect(result.previousVersion).toBe("1.0.0");
		expect(readFileSync(join(targetDir, "SKILL.md"), "utf-8")).toContain("v2 body");
		expect(readFileSync(join(targetDir, STAMP), "utf-8").trim()).toBe("1.1.0");
	});

	it("re-copies when forced even if the version matches", () => {
		installSkill({ version: "1.0.0", sourceDir, targetDir });
		writeFileSync(join(targetDir, "SKILL.md"), "tampered", "utf-8");
		const result = installSkill({ version: "1.0.0", sourceDir, targetDir, force: true });
		expect(result.action).toBe("updated");
		expect(readFileSync(join(targetDir, "SKILL.md"), "utf-8")).toContain("v1 body");
	});

	it("always re-copies for dev builds", () => {
		expect(installSkill({ version: "dev", sourceDir, targetDir }).action).toBe("installed");
		expect(installSkill({ version: "dev", sourceDir, targetDir }).action).toBe("updated");
	});

	it("skips cleanly when the packaged source is missing", () => {
		const result = installSkill({ version: "1.0.0", sourceDir: join(root, "nope"), targetDir });
		expect(result.action).toBe("skipped");
		expect(result.reason).toBeDefined();
		expect(existsSync(targetDir)).toBe(false);
	});
});

describe("resolveSkillTargetDir", () => {
	it("targets ~/.agents/skills/shuvgeist", () => {
		expect(resolveSkillTargetDir().replace(/\\/g, "/")).toMatch(/\/\.agents\/skills\/shuvgeist$/);
	});
});
