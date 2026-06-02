import type { CdpSession } from "../../tools/helpers/cdp-session.js";

export interface TrustedInputPoint {
	x: number;
	y: number;
}

export interface TrustedInputActionOptions {
	signal?: AbortSignal;
}

export interface TrustedInputClickResult {
	ok: true;
	point: TrustedInputPoint;
	methods: ["Input.dispatchMouseEvent", "Input.dispatchMouseEvent"];
}

export class TrustedInputProvider {
	constructor(private readonly cdp: CdpSession) {}

	async click(point: TrustedInputPoint, options: TrustedInputActionOptions = {}): Promise<TrustedInputClickResult> {
		throwIfAborted(options.signal);
		validatePoint(point);
		await this.cdp.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: point.x,
			y: point.y,
			button: "left",
			clickCount: 1,
		});
		throwIfAborted(options.signal);
		await this.cdp.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: point.x,
			y: point.y,
			button: "left",
			clickCount: 1,
		});
		return {
			ok: true,
			point,
			methods: ["Input.dispatchMouseEvent", "Input.dispatchMouseEvent"],
		};
	}
}

function validatePoint(point: TrustedInputPoint): void {
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
		throw new Error("Trusted input point must be finite coordinates");
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Trusted input operation aborted");
}
