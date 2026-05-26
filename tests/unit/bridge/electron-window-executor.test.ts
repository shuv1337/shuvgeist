import {
	captureElectronWindowScreenshot,
	evaluateElectronWindow,
	type ElectronPageCdpClient,
} from "../../../src/bridge/electron/window-executor.js";

function fakeClient(responses: unknown[]): ElectronPageCdpClient & { calls: Array<{ method: string; params?: unknown }> } {
	const calls: Array<{ method: string; params?: unknown }> = [];
	return {
		calls,
		async send(method: string, params?: Record<string, unknown>) {
			calls.push({ method, params });
			return responses.shift();
		},
		close: vi.fn(),
	};
}

describe("electron window executor", () => {
	it("evaluates JavaScript with injected skill library and serializes object results", async () => {
		const client = fakeClient([{ result: { value: { ok: true } } }]);

		await expect(
			evaluateElectronWindow(client, {
				code: "app.value()",
				skillLibrary: "window.app = {};\n",
				skillsSnapshotStatus: { state: "fresh" },
				includeSkillsSnapshot: true,
			}),
		).resolves.toEqual({
			output: "{\"ok\":true}",
			result: { ok: true },
			skillsSnapshot: { state: "fresh" },
		});
		expect(client.calls[0]).toMatchObject({
			method: "Runtime.evaluate",
			params: {
				expression: "window.app = {};\napp.value()",
				awaitPromise: true,
				returnByValue: true,
			},
		});
	});

	it("throws evaluation exception details", async () => {
		const client = fakeClient([{ exceptionDetails: { exception: { description: "boom" } } }]);

		await expect(evaluateElectronWindow(client, { code: "throw new Error()" })).rejects.toThrow("boom");
	});

	it("captures screenshots with viewport metadata and max-width scaling", async () => {
		const client = fakeClient([
			undefined,
			{ result: { value: { innerWidth: 800, innerHeight: 600, devicePixelRatio: 2 } } },
			{ data: "png-data" },
		]);

		await expect(captureElectronWindowScreenshot(client, 400)).resolves.toEqual({
			mimeType: "image/png",
			dataUrl: "data:image/png;base64,png-data",
			cssWidth: 800,
			cssHeight: 600,
			imageWidth: 400,
			imageHeight: 300,
			devicePixelRatio: 2,
			scale: 0.5,
		});
		expect(client.calls.map((call) => call.method)).toEqual([
			"Page.enable",
			"Runtime.evaluate",
			"Page.captureScreenshot",
		]);
	});
});
