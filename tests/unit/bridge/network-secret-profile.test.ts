import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileNetworkSecretProfile } from "@shuvgeist/server/network-secret-profile";

describe("FileNetworkSecretProfile", () => {
	it("atomically persists mode-0600 slots and updates a stable credential slot", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shuvgeist-secret-profile-"));
		const path = join(directory, "nested", "network-secrets.json");
		const profile = new FileNetworkSecretProfile(path);
		profile.put({
			slot: "0123456789abcdef",
			placeholder: "{{shuvgeist-secret:0123456789abcdef}}",
			source: "request.header.authorization",
			kind: "header",
			value: "Bearer first",
		});
		profile.put({
			slot: "0123456789abcdef",
			placeholder: "{{shuvgeist-secret:0123456789abcdef}}",
			source: "request.header.authorization",
			kind: "header",
			value: "Bearer rotated",
		});
		await profile.flush();

		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
		expect(await profile.readSlot("0123456789abcdef")).toMatchObject({ value: "Bearer rotated" });
		const contents = await readFile(path, "utf8");
		expect(contents).toContain("Bearer rotated");
		expect(contents).not.toContain("Bearer first");
	});
});
