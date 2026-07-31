/** CLI-side ffmpeg process adapter for recording output. */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";

import { jpegDimensions, mjpegMatroskaFrame, mjpegMatroskaHeader } from "./mjpeg-matroska.js";

export interface FfmpegEncoderStartOptions {
	outPath: string;
	fps: number;
	mimeType?: string;
	videoBitsPerSecond?: number;
}

export interface FfmpegEncoderFinishResult {
	encodedSizeBytes: number;
	frameCount: number;
	sourceFrameCount: number;
	encodedFrameCount: number;
	coalescedFrameCount: number;
	droppedFrameCount: number;
}

const DEFAULT_VIDEO_BITRATE = 2_500_000;

export type FfmpegProcessFactory = (args: string[]) => ChildProcessWithoutNullStreams;

function spawnFfmpeg(args: string[]): ChildProcessWithoutNullStreams {
	return spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
}

export function assertFfmpegAvailable(): void {
	const result = spawnSync("ffmpeg", ["-version"], { timeout: 3000, encoding: "utf-8" });
	if (result.error || result.status !== 0) {
		throw new Error(
			"shuvgeist record requires ffmpeg for debugger screencast encoding. Install ffmpeg or add it to PATH.",
		);
	}
}

function codecForMimeType(mimeType?: string): string {
	const normalized = (mimeType || "video/webm;codecs=vp9").toLowerCase();
	if (normalized.includes("vp8")) return "libvpx";
	return "libvpx-vp9";
}

function bitrateString(videoBitsPerSecond?: number): string {
	return String(videoBitsPerSecond && videoBitsPerSecond > 0 ? Math.trunc(videoBitsPerSecond) : DEFAULT_VIDEO_BITRATE);
}

export class FfmpegWebmEncoder {
	private process?: ChildProcessWithoutNullStreams;
	private stderr = "";
	private outPath = "";
	private fps = 12;
	private intervalMs = 1000 / 12;
	private firstCapturedAtMs?: number;
	private pendingFrame?: { data: Buffer; frameNumber: number };
	private sourceFrameCount = 0;
	private encodedFrameCount = 0;
	private coalescedFrameCount = 0;
	private droppedFrameCount = 0;
	private headerWritten = false;
	private started = false;
	private finished = false;

	constructor(private readonly processFactory: FfmpegProcessFactory = spawnFfmpeg) {}

	start(options: FfmpegEncoderStartOptions): void {
		if (this.started) throw new Error("ffmpeg encoder already started");
		if (!Number.isFinite(options.fps) || options.fps <= 0) {
			throw new Error("ffmpeg encoder fps must be a positive finite number");
		}
		this.outPath = options.outPath;
		this.fps = options.fps;
		this.intervalMs = 1000 / options.fps;
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"matroska",
			"-fpsprobesize",
			"0",
			"-probesize",
			"32",
			"-analyzeduration",
			"0",
			"-i",
			"pipe:0",
			"-an",
			"-r",
			String(options.fps),
			"-fps_mode",
			"cfr",
			"-c:v",
			codecForMimeType(options.mimeType),
			"-b:v",
			bitrateString(options.videoBitsPerSecond),
			"-pix_fmt",
			"yuv420p",
			options.outPath,
		];
		const child = this.processFactory(args);
		child.stdout.resume();
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			this.stderr += chunk;
		});
		this.process = child;
		this.started = true;
	}

	async pushFrame(frame: Buffer, capturedAtMs: number): Promise<void> {
		if (!this.process || this.finished) throw new Error("ffmpeg encoder is not active");
		if (!Number.isFinite(capturedAtMs)) throw new Error("Recording frame timestamp must be finite");
		this.sourceFrameCount += 1;
		if (this.firstCapturedAtMs === undefined) {
			this.firstCapturedAtMs = capturedAtMs;
			this.pendingFrame = { data: Buffer.from(frame), frameNumber: 0 };
			return;
		}

		const frameNumber = Math.floor((capturedAtMs - this.firstCapturedAtMs) / this.intervalMs);
		if (frameNumber < 0 || (this.pendingFrame && frameNumber < this.pendingFrame.frameNumber)) {
			this.droppedFrameCount += 1;
			return;
		}
		if (!this.pendingFrame) {
			this.pendingFrame = { data: Buffer.from(frame), frameNumber };
			return;
		}
		if (frameNumber === this.pendingFrame.frameNumber) {
			this.pendingFrame = { data: Buffer.from(frame), frameNumber };
			this.coalescedFrameCount += 1;
			return;
		}

		await this.writePendingFrame(frameNumber);
		this.pendingFrame = { data: Buffer.from(frame), frameNumber };
	}

	async finish(endedAtMs: number): Promise<FfmpegEncoderFinishResult> {
		if (!this.process || this.finished) throw new Error("ffmpeg encoder is not active");
		this.finished = true;
		if (!this.pendingFrame || this.firstCapturedAtMs === undefined) {
			this.process.stdin.destroy();
			this.process.kill("SIGTERM");
			throw new Error("Recording produced no frames");
		}
		try {
			const elapsedMs = Math.max(0, endedAtMs - this.firstCapturedAtMs);
			const endFrameNumber = Math.max(this.pendingFrame.frameNumber + 1, Math.round(elapsedMs / this.intervalMs));
			await this.writePendingFrame(endFrameNumber);
			this.process.stdin.end();
			await this.waitForExit();
			const stats = await stat(this.outPath);
			return {
				encodedSizeBytes: stats.size,
				frameCount: endFrameNumber,
				sourceFrameCount: this.sourceFrameCount,
				encodedFrameCount: this.encodedFrameCount,
				coalescedFrameCount: this.coalescedFrameCount,
				droppedFrameCount: this.droppedFrameCount,
			};
		} catch (error) {
			this.process.stdin.destroy();
			this.process.kill("SIGTERM");
			throw error;
		}
	}

	abort(): void {
		if (!this.process || this.finished) return;
		this.finished = true;
		this.process.stdin.destroy();
		this.process.kill("SIGTERM");
	}

	private async writePendingFrame(endFrameNumber: number): Promise<void> {
		if (!this.pendingFrame) throw new Error("ffmpeg encoder has no pending frame");
		if (endFrameNumber <= this.pendingFrame.frameNumber) {
			throw new Error("ffmpeg encoder frame duration must be positive");
		}
		if (!this.headerWritten) {
			const dimensions = jpegDimensions(this.pendingFrame.data);
			await this.writeChunk(mjpegMatroskaHeader(dimensions.width, dimensions.height));
			this.headerWritten = true;
		}
		const timestampMs = Math.max(0, Math.round(this.pendingFrame.frameNumber * this.intervalMs));
		const durationMs = Math.max(1, Math.round((endFrameNumber - this.pendingFrame.frameNumber) * this.intervalMs));
		const envelope = mjpegMatroskaFrame(timestampMs, durationMs, this.pendingFrame.data.length);
		await this.writeChunk(envelope.header);
		await this.writeChunk(this.pendingFrame.data);
		await this.writeChunk(envelope.trailer);
		this.encodedFrameCount += 1;
	}

	private async writeChunk(chunk: Buffer): Promise<void> {
		if (!this.process) throw new Error("ffmpeg encoder is not active");
		if (this.process.stdin.write(chunk)) return;
		await new Promise<void>((resolve, reject) => {
			const onDrain = () => {
				cleanup();
				resolve();
			};
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};
			const cleanup = () => {
				this.process?.stdin.off("drain", onDrain);
				this.process?.stdin.off("error", onError);
			};
			this.process?.stdin.once("drain", onDrain);
			this.process?.stdin.once("error", onError);
		});
	}

	private async waitForExit(): Promise<void> {
		if (!this.process) return;
		const process = this.process;
		const code = await new Promise<number | null>((resolve, reject) => {
			process.once("error", reject);
			process.once("close", resolve);
		});
		if (code !== 0) {
			throw new Error(`ffmpeg failed with exit code ${code}: ${this.stderr.trim() || "no stderr"}`);
		}
	}
}
