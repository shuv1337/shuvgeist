// @vitest-environment happy-dom

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	createInjectedArtifactsPlugin,
	generateInjectedArtifactsModules,
	verifyInjectedArtifactsModules,
} from "../../../scripts/injected-artifacts.mjs";
import {
	PAGE_REF_ACTION_INJECTED_ARTIFACT,
	SNAPSHOT_INJECTED_ARTIFACT,
} from "@shuvgeist/driver/driver-artifacts-generated";
import {
	BROWSERJS_WRAPPER_INJECTED_ARTIFACT,
	ELEMENT_PICKER_INJECTED_ARTIFACT,
	PAGE_EXECUTION_INJECTED_ARTIFACT,
	REPL_OVERLAY_INJECTED_ARTIFACT,
} from "@shuvgeist/extension/injected/extension-artifacts.generated";
import {
	INJECTED_ARTIFACT_VERSION,
	type BrowserJsWrapperResult,
	type InjectedArtifactDescriptor,
	type PageExecutionInjectionResult,
	type PageRefActionInjectionRequest,
	type PageRefActionInjectionResult,
	type ReplOverlayAbortIntent,
} from "@shuvgeist/driver/injected-contracts";
import { buildInjectedArtifactInvocation } from "@shuvgeist/driver/injected-invocation";
import { buildBrowserJsWrapperFunctionCode } from "@shuvgeist/extension/tools/repl/userscripts-helpers";

const DRIVER_ARTIFACTS = [
	SNAPSHOT_INJECTED_ARTIFACT,
	PAGE_REF_ACTION_INJECTED_ARTIFACT,
] as const satisfies readonly InjectedArtifactDescriptor[];

const EXTENSION_ARTIFACTS = [
	BROWSERJS_WRAPPER_INJECTED_ARTIFACT,
	PAGE_EXECUTION_INJECTED_ARTIFACT,
	REPL_OVERLAY_INJECTED_ARTIFACT,
	ELEMENT_PICKER_INJECTED_ARTIFACT,
] as const satisfies readonly InjectedArtifactDescriptor[];

const ARTIFACTS = [...DRIVER_ARTIFACTS, ...EXTENSION_ARTIFACTS] as const;

function evaluateExpression<T>(source: string): T {
	return new Function(`return (${source});`)() as T;
}

describe("generated injected artifacts", () => {
	beforeEach(() => {
		document.head.innerHTML = "";
		document.body.innerHTML = "";
		delete (window as Window & { __completionCallbacks?: unknown }).__completionCallbacks;
	});

	it("matches a fresh deterministic in-memory generation", async () => {
		const generated = await generateInjectedArtifactsModules();
		const checkedInDriver = readFileSync(
			resolve(process.cwd(), "packages/driver/src/injected/driver-artifacts.generated.ts"),
			"utf8",
		);
		const checkedInExtension = readFileSync(
			resolve(process.cwd(), "packages/extension/src/injected/extension-artifacts.generated.ts"),
			"utf8",
		);

		expect(generated.driver.contents).toBe(checkedInDriver);
		expect(generated.extension.contents).toBe(checkedInExtension);
		expect(checkedInDriver).toContain("SNAPSHOT_INJECTED_ARTIFACT");
		expect(checkedInDriver).not.toContain("REPL_OVERLAY_INJECTED_ARTIFACT");
		expect(checkedInExtension).toContain("REPL_OVERLAY_INJECTED_ARTIFACT");
		expect(checkedInExtension).not.toContain("SNAPSHOT_INJECTED_ARTIFACT");
		await expect(verifyInjectedArtifactsModules()).resolves.toEqual(generated);
		expect(generated.watchFiles).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/src\/injected\/snapshot\.ts$/),
				expect.stringMatching(/src\/injected\/browserjs-wrapper\.ts$/),
				expect.stringMatching(/src\/injected\/page-execution\.ts$/),
				expect.stringMatching(/src\/injected\/page-ref-action\.ts$/),
				expect.stringMatching(/src\/injected\/repl-overlay\.ts$/),
				expect.stringMatching(/src\/injected\/element-picker\.ts$/),
			]),
		);
	});

	it("regenerates through the build plugin and registers transitive watch inputs", async () => {
		const onLoad = vi.fn();
		createInjectedArtifactsPlugin().setup({ onLoad } as never);
		expect(onLoad).toHaveBeenCalledOnce();
		const [options, load] = onLoad.mock.calls[0] as [
			{ filter: RegExp },
			(args: { path: string }) => Promise<{ contents: string; loader: string; watchFiles: string[] }>,
		];
		const driverPath = resolve(process.cwd(), "packages/driver/src/injected/driver-artifacts.generated.ts");
		const extensionPath = resolve(process.cwd(), "packages/extension/src/injected/extension-artifacts.generated.ts");
		expect(options.filter.test(driverPath)).toBe(true);
		expect(options.filter.test(extensionPath)).toBe(true);

		const loadedDriver = await load({ path: driverPath });
		expect(loadedDriver.loader).toBe("ts");
		expect(loadedDriver.contents).toBe(readFileSync(driverPath, "utf8"));
		expect(loadedDriver.watchFiles).toEqual(
			expect.arrayContaining([expect.stringMatching(/src\/injected\/snapshot\.ts$/)]),
		);
		expect(loadedDriver.watchFiles).not.toEqual(
			expect.arrayContaining([expect.stringMatching(/src\/injected\/repl-overlay\.ts$/)]),
		);

		const loadedExtension = await load({ path: extensionPath });
		expect(loadedExtension.loader).toBe("ts");
		expect(loadedExtension.contents).toBe(readFileSync(extensionPath, "utf8"));
		expect(loadedExtension.watchFiles).toEqual(
			expect.arrayContaining([expect.stringMatching(/src\/injected\/repl-overlay\.ts$/)]),
		);
		expect(loadedExtension.watchFiles).not.toEqual(
			expect.arrayContaining([expect.stringMatching(/src\/injected\/snapshot\.ts$/)]),
		);
	});

	it("keeps the static page-ref runtime byte-identical to its driver descriptor", async () => {
		const generated = await generateInjectedArtifactsModules();
		const staticRuntime = readFileSync(resolve(process.cwd(), "static/page-ref-action-runtime.js"), "utf8");

		expect(staticRuntime).toBe(PAGE_REF_ACTION_INJECTED_ARTIFACT.source);
		expect(staticRuntime).toBe(generated.pageRefActionRuntimeContents);
		expect(createHash("sha256").update(staticRuntime).digest("hex").slice(0, 16)).toBe(
			PAGE_REF_ACTION_INJECTED_ARTIFACT.contentHash,
		);
	});

	it("emits self-contained, versioned descriptors with content-derived hashes", () => {
		expect(new Set(ARTIFACTS.map((artifact) => artifact.globalName)).size).toBe(ARTIFACTS.length);

		for (const artifact of ARTIFACTS) {
			expect(artifact).toEqual({
				version: INJECTED_ARTIFACT_VERSION,
				globalName: expect.stringMatching(/^__SHUVGEIST_INJECTED_[A-Z_]+__$/),
				contentHash: expect.stringMatching(/^[a-f0-9]{16}$/),
				source: expect.any(String),
			});
			expect(artifact.source).toContain(`var ${artifact.globalName}=`);
			expect(artifact.source).not.toMatch(/\b__name\s*\(/);
			expect(createHash("sha256").update(artifact.source).digest("hex").slice(0, 16)).toBe(
				artifact.contentHash,
			);
			expect(() => new Function(artifact.source)).not.toThrow();
		}
	});

	it("preserves BrowserJS setup bindings in the user function lexical scope under raw evaluation", async () => {
		const wrapperSource = buildBrowserJsWrapperFunctionCode({
			setupCode: "const secret = 7; const multiply = (value) => value * 3;",
			userCode: "(value) => multiply(value) + secret",
			args: [5],
			timeoutMs: 1_000,
		});
		const run = evaluateExpression<() => Promise<BrowserJsWrapperResult>>(wrapperSource);

		await expect(run()).resolves.toEqual({ success: true, lastValue: 22 });
	});

	it("returns the BrowserJS error envelope under raw evaluation", async () => {
		const wrapperSource = buildBrowserJsWrapperFunctionCode({
			setupCode: "const prefix = 'compiled';",
			userCode: "() => { throw new Error(`${prefix} failure`); }",
			args: [],
			timeoutMs: 1_000,
		});
		const run = evaluateExpression<() => Promise<BrowserJsWrapperResult>>(wrapperSource);

		const result = await run();

		expect(result).toMatchObject({ success: false, error: "compiled failure" });
		expect(result.success).toBe(false);
		if (!result.success) expect(result.stack).toContain("compiled failure");
	});

	it("captures page console output and return values through the compiled execution wrapper", async () => {
		const expression = buildInjectedArtifactInvocation(PAGE_EXECUTION_INJECTED_ARTIFACT, [
			JSON.stringify({ args: [2, 3], includeConsole: true }),
			'(left, right) => { console.log("sum", { left, right }); return left + right; }',
		]);
		const originalLog = console.log;
		console.log = vi.fn();

		try {
			const result = await evaluateExpression<Promise<PageExecutionInjectionResult>>(expression);

			expect(result).toEqual({
				success: true,
				value: 5,
				console: [{ type: "log", text: 'sum {"left":2,"right":3}' }],
			});
		} finally {
			console.log = originalLog;
		}
	});

	it("resolves and performs a ref action through the compiled page artifact", async () => {
		document.body.innerHTML =
			'<button class="shared" data-shuvgeist-stable-id="search-action">Search</button>';
		const button = document.querySelector("button");
		if (!(button instanceof HTMLButtonElement)) throw new Error("Missing button fixture");
		const clicked = vi.fn();
		button.addEventListener("click", clicked);
		const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 10,
			y: 20,
			width: 100,
			height: 30,
			left: 10,
			top: 20,
			right: 110,
			bottom: 50,
			toJSON: () => ({}),
		});
		const request: PageRefActionInjectionRequest = {
			operation: "dom-action",
			frameId: 0,
			snapshotIdPrefix: "compiled",
			storedEntry: {
				snapshotId: "stored",
				stableElementId: "search-action",
				frameId: 0,
				tagName: "button",
				role: "button",
				name: "Search",
				text: "Search",
				attributes: {},
				selectorCandidates: ["button.shared"],
				ordinalPath: [0],
				boundingBox: { x: 10, y: 20, width: 100, height: 30 },
				interactive: true,
			},
			action: { kind: "click" },
		};
		const expression = buildInjectedArtifactInvocation(PAGE_REF_ACTION_INJECTED_ARTIFACT, [
			JSON.stringify(request),
		]);

		try {
			const result = await evaluateExpression<Promise<PageRefActionInjectionResult>>(expression);
			expect(result).toMatchObject({
				ok: true,
				operation: "dom-action",
				execution: { strategy: "fresh-snapshot" },
			});
			expect(clicked).toHaveBeenCalledOnce();
		} finally {
			rect.mockRestore();
		}
	});

	it("shows and removes the REPL overlay through its compiled command ABI", async () => {
		const abortIntent: ReplOverlayAbortIntent = {
			clientId: "sidepanel",
			windowId: 7,
			sessionId: "session-7",
			target: { kind: "chrome-tab", tabRef: "window:7" },
			executionId: "execution-7",
			targetRequestId: "request-7",
			reason: "test-stop",
		};
		const sendMessage = vi.fn().mockResolvedValue({ ok: true });
		const previousChrome = globalThis.chrome;
		Object.defineProperty(globalThis, "chrome", {
			configurable: true,
			writable: true,
			value: { runtime: { sendMessage } },
		});
		const showExpression = buildInjectedArtifactInvocation(REPL_OVERLAY_INJECTED_ARTIFACT, [
			JSON.stringify({ action: "show", taskName: "Compile artifacts", abortIntent }),
		]);
		try {
			await evaluateExpression<Promise<void>>(showExpression);
			const overlay = document.getElementById("shuvgeist-repl-overlay");
			expect(overlay).not.toBeNull();
			expect(overlay?.textContent).toContain("Compile artifacts");
			const stop = overlay?.querySelector("button");
			expect(stop).not.toBeNull();
			stop?.click();
			await vi.waitFor(() =>
				expect(sendMessage).toHaveBeenCalledWith({ type: "agent-runtime-abort-intent", intent: abortIntent }),
			);
			expect(document.getElementById("shuvgeist-repl-overlay")).toBeNull();

			await evaluateExpression<Promise<void>>(showExpression);
			const removeExpression = buildInjectedArtifactInvocation(REPL_OVERLAY_INJECTED_ARTIFACT, [
				JSON.stringify({ action: "remove" }),
			]);
			await evaluateExpression<Promise<void>>(removeExpression);
			expect(document.getElementById("shuvgeist-repl-overlay")).toBeNull();
		} finally {
			Object.defineProperty(globalThis, "chrome", {
				configurable: true,
				writable: true,
				value: previousChrome,
			});
		}
	});

	it("starts and cancels the element picker through its compiled command ABI", async () => {
		const pickExpression = buildInjectedArtifactInvocation(ELEMENT_PICKER_INJECTED_ARTIFACT, [
			JSON.stringify({ action: "pick", message: "Choose a target" }),
		]);
		const pickResult = evaluateExpression<Promise<unknown>>(pickExpression);

		expect(document.getElementById("shuvgeist-element-picker")).not.toBeNull();
		expect(document.body.textContent).toContain("Choose a target");
		expect((window as Window & { __shuvgeistElementPicker?: boolean }).__shuvgeistElementPicker).toBe(true);

		const cancelExpression = buildInjectedArtifactInvocation(ELEMENT_PICKER_INJECTED_ARTIFACT, [
			JSON.stringify({ action: "cancel" }),
		]);
		await evaluateExpression<Promise<void>>(cancelExpression);

		await expect(pickResult).resolves.toBeNull();
		expect(document.getElementById("shuvgeist-element-picker")).toBeNull();
		expect(document.body.textContent).not.toContain("Choose a target");
		expect((window as Window & { __shuvgeistElementPicker?: boolean }).__shuvgeistElementPicker).toBeUndefined();
	});
});
