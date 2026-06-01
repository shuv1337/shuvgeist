import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("background bridge focus isolation", () => {
	it("keeps bridge clients keyed by window instead of replacing a focus-owned singleton", () => {
		const source = readFileSync(join(process.cwd(), "src/background.ts"), "utf-8");

		expect(source).toContain("const bridgeWindowSessions = new Map<number, BridgeWindowSession>();");
		expect(source).toContain("bridgeWindowSessions.get(windowId)");
		expect(source).toContain("clients owned by other windows");
		expect(source).not.toContain("lastConnectedWindowId");
	});
});
