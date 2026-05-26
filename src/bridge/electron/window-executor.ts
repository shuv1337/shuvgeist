import type { BridgeScreenshotResult } from "../protocol.js";
import type { BridgeSkillSnapshotStatus } from "../skill-snapshot.js";

export interface ElectronPageCdpClient {
	send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
	close(): void;
}

export interface ElectronEvaluateOptions {
	code: string;
	skillLibrary?: string;
	skillsSnapshotStatus?: BridgeSkillSnapshotStatus;
	includeSkillsSnapshot?: boolean;
}

export async function evaluateElectronWindow(client: ElectronPageCdpClient, options: ElectronEvaluateOptions) {
	const response = await client.send<{
		result?: { type?: string; value?: unknown; description?: string };
		exceptionDetails?: { text?: string; exception?: { description?: string } };
	}>("Runtime.evaluate", {
		expression: (options.skillLibrary ?? "") + options.code,
		awaitPromise: true,
		returnByValue: true,
	});
	if (response.exceptionDetails) {
		throw new Error(
			response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Evaluation failed",
		);
	}
	const value = response.result?.value ?? response.result?.description ?? null;
	return {
		output: typeof value === "string" ? value : JSON.stringify(value),
		result: value,
		skillsSnapshot: options.includeSkillsSnapshot ? options.skillsSnapshotStatus : undefined,
	};
}

export async function captureElectronWindowScreenshot(
	client: ElectronPageCdpClient,
	maxWidth?: number,
): Promise<BridgeScreenshotResult> {
	await client.send("Page.enable");
	const viewport = await client.send<{
		result?: {
			value?: { innerWidth?: number; innerHeight?: number; devicePixelRatio?: number };
		};
	}>("Runtime.evaluate", {
		expression: "({ innerWidth, innerHeight, devicePixelRatio })",
		returnByValue: true,
	});
	const cssWidth = viewport.result?.value?.innerWidth ?? 0;
	const cssHeight = viewport.result?.value?.innerHeight ?? 0;
	const devicePixelRatio = viewport.result?.value?.devicePixelRatio ?? 1;
	const capture = await client.send<{ data: string }>("Page.captureScreenshot", {
		format: "png",
		captureBeyondViewport: false,
	});
	const imageWidth = maxWidth && cssWidth > maxWidth ? maxWidth : Math.round(cssWidth * devicePixelRatio);
	const imageHeight = Math.round(cssHeight * (imageWidth / Math.max(cssWidth, 1)));
	return {
		mimeType: "image/png",
		dataUrl: "data:image/png;base64," + capture.data,
		cssWidth,
		cssHeight,
		imageWidth,
		imageHeight,
		devicePixelRatio,
		scale: cssWidth > 0 ? imageWidth / cssWidth : 1,
	};
}
