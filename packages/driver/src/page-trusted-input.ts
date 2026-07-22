import type { CdpSession } from "./cdp-session.js";
import type { PageInputPoint, PageTrustedInputResult } from "./page-driver-results.js";

export interface PageTrustedClickOptions {
	button?: "left" | "middle" | "right";
	clickCount?: number;
	assertScope?: () => void | Promise<void>;
	signal?: AbortSignal;
}

export interface PageTrustedFillOptions {
	selectAllModifier?: "Control" | "Meta";
	assertScope?: () => void | Promise<void>;
	signal?: AbortSignal;
}

export interface PageTrustedInputDriver {
	click(point: PageInputPoint, options?: PageTrustedClickOptions): Promise<PageTrustedInputResult>;
	fill(point: PageInputPoint, text: string, options?: PageTrustedFillOptions): Promise<PageTrustedInputResult>;
}

export interface PageTrustedInputDriverOptions {
	selectAllModifier?: "Control" | "Meta";
}

class CdpPageTrustedInputDriver implements PageTrustedInputDriver {
	private operationNumber = 0;

	constructor(
		private readonly cdp: CdpSession,
		private readonly defaultSelectAllModifier: "Control" | "Meta",
	) {}

	async click(point: PageInputPoint, options: PageTrustedClickOptions = {}): Promise<PageTrustedInputResult> {
		return this.withSession("click", options.signal, async () => {
			const methods: string[] = [];
			await this.dispatchClick(point, options, methods);
			await assertOperationActive(options);
			return { ok: true, kind: "click", point: { ...point }, methods };
		});
	}

	async fill(
		point: PageInputPoint,
		text: string,
		options: PageTrustedFillOptions = {},
	): Promise<PageTrustedInputResult> {
		return this.withSession("fill", options.signal, async () => {
			const methods: string[] = [];
			await this.dispatchClick(point, options, methods);
			await assertOperationActive(options);
			const modifier = options.selectAllModifier ?? this.defaultSelectAllModifier;
			const modifierValue = modifier === "Meta" ? 4 : 2;
			let modifierAttempted = false;
			try {
				modifierAttempted = true;
				await this.dispatchKey(modifier, "keyDown", modifierValue, methods, options);
				await this.dispatchKey("a", "keyDown", modifierValue, methods, options);
				await this.dispatchKey("a", "keyUp", modifierValue, methods, options);
			} finally {
				if (modifierAttempted) await this.dispatchKey(modifier, "keyUp", 0, methods);
			}
			await assertOperationActive(options);
			await this.dispatchKey("Backspace", "keyDown", 0, methods, options);
			await this.dispatchKey("Backspace", "keyUp", 0, methods, options);
			if (text) {
				await this.checkedSend("Input.insertText", { text }, methods, options);
			}
			await assertOperationActive(options);
			return {
				ok: true,
				kind: "fill",
				point: { ...point },
				methods,
				textLength: text.length,
			};
		});
	}

	private async dispatchClick(
		point: PageInputPoint,
		options: PageTrustedClickOptions,
		methods: string[],
	): Promise<void> {
		validatePoint(point);
		const button = options.button ?? "left";
		const clickCount = normalizeClickCount(options.clickCount);
		await this.checkedSend(
			"Input.dispatchMouseEvent",
			{
				type: "mouseMoved",
				x: point.x,
				y: point.y,
				button: "none",
			},
			methods,
			options,
		);
		await assertOperationActive(options);
		await this.cdp.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: point.x,
			y: point.y,
			button,
			clickCount,
		});
		methods.push("Input.dispatchMouseEvent");
		try {
			await assertOperationActive(options);
		} finally {
			// Cleanup must not be blocked by an abort or scope mismatch after the
			// corresponding press has reached the renderer.
			await this.cdp.send("Input.dispatchMouseEvent", {
				type: "mouseReleased",
				x: point.x,
				y: point.y,
				button,
				clickCount,
			});
			methods.push("Input.dispatchMouseEvent");
		}
		await assertOperationActive(options);
	}

	private async dispatchKey(
		key: "Control" | "Meta" | "Backspace" | "a",
		type: "keyDown" | "keyUp",
		modifiers: number,
		methods: string[],
		options?: PageTrustedFillOptions,
	): Promise<void> {
		const keyInfo = KEY_INFO[key];
		const params = {
			type,
			key: keyInfo.key,
			code: keyInfo.code,
			windowsVirtualKeyCode: keyInfo.keyCode,
			nativeVirtualKeyCode: keyInfo.keyCode,
			modifiers,
		};
		if (options) {
			await this.checkedSend("Input.dispatchKeyEvent", params, methods, options);
			return;
		}
		await this.cdp.send("Input.dispatchKeyEvent", params);
		methods.push("Input.dispatchKeyEvent");
	}

	private async checkedSend(
		method: string,
		params: Record<string, unknown>,
		methods: string[],
		options: Pick<PageTrustedClickOptions, "assertScope" | "signal">,
	): Promise<void> {
		await assertOperationActive(options);
		await this.cdp.send(method, params);
		methods.push(method);
		await assertOperationActive(options);
	}

	private async withSession<T>(
		operation: "click" | "fill",
		signal: AbortSignal | undefined,
		run: () => Promise<T>,
	): Promise<T> {
		throwIfAborted(signal);
		const owner = `page-trusted-input:${operation}:${++this.operationNumber}`;
		await this.cdp.acquire(owner);
		try {
			throwIfAborted(signal);
			return await run();
		} finally {
			await this.cdp.release(owner);
		}
	}
}

const KEY_INFO = {
	Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
	Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
	Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
	a: { key: "a", code: "KeyA", keyCode: 65 },
} as const;

export function createPageTrustedInputDriver(
	cdp: CdpSession,
	options: PageTrustedInputDriverOptions = {},
): PageTrustedInputDriver {
	return new CdpPageTrustedInputDriver(
		cdp,
		options.selectAllModifier ?? selectAllModifierForPlatform(runtimePlatform()),
	);
}

export function selectAllModifierForPlatform(platform: string): "Control" | "Meta" {
	return /^(darwin|mac)/i.test(platform.trim()) ? "Meta" : "Control";
}

function runtimePlatform(): string {
	const runtime = globalThis as typeof globalThis & {
		process?: { platform?: string };
		navigator?: { platform?: string };
	};
	return runtime.process?.platform ?? runtime.navigator?.platform ?? "";
}

function validatePoint(point: PageInputPoint): void {
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
		throw new Error(`Trusted input point must be finite, got x=${point.x}, y=${point.y}`);
	}
}

function normalizeClickCount(value: number | undefined): number {
	if (value === undefined) return 1;
	if (!Number.isSafeInteger(value) || value < 1 || value > 3) {
		throw new Error("Trusted input clickCount must be an integer from 1 to 3");
	}
	return value;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Page trusted input operation aborted");
}

async function assertOperationActive(options: Pick<PageTrustedClickOptions, "assertScope" | "signal">): Promise<void> {
	throwIfAborted(options.signal);
	await options.assertScope?.();
	throwIfAborted(options.signal);
}
