import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieAccessPort, parseNetscapeCookieFile } from "@shuvgeist/server/cookie-access-port";

const fixture = [
	"# Netscape HTTP Cookie File",
	".example.test\tTRUE\t/\tTRUE\t1893456000\tsid\tsecret",
	"#HttpOnly_.example.test\tTRUE\t/account\tFALSE\t0\thttp\tonly",
	".other.test\tTRUE\t/\tTRUE\t1893456000\tignored\tvalue",
].join("\n");

describe("CookieAccessPort", () => {
	it("parses Netscape cookies into chrome.cookies.set payloads", () => {
		const cookies = parseNetscapeCookieFile(fixture);
		expect(cookies).toHaveLength(3);
		expect(cookies.slice(0, 2)).toMatchObject([
			{
				url: "https://example.test/",
				name: "sid",
				value: "secret",
				domain: ".example.test",
				secure: true,
				httpOnly: false,
				expirationDate: 1893456000,
			},
			{
				url: "http://example.test/account",
				name: "http",
				value: "only",
				httpOnly: true,
			},
		]);
	});

	it("requires explicit consent and filters to the requested site", () => {
		const dir = mkdtempSync(join(tmpdir(), "shuvgeist-cookies-"));
		const sourcePath = join(dir, "cookies.txt");
		writeFileSync(sourcePath, fixture);
		try {
			const port = new CookieAccessPort();
			expect(() =>
				port.planImport({ sourcePath, siteUrl: "https://app.example.test/settings", consent: false }),
			).toThrow("explicit per-site consent");
			expect(port.planImport({ sourcePath, siteUrl: "https://app.example.test/settings", consent: true }).cookies).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
