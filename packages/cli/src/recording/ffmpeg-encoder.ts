/** CLI-side ffmpeg process adapter for recording output. */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";

export interface FfmpegEncoderStartOptions {
	outPath: string;
	fps: number;
	mimeType?: string;
	videoBitsPerSecond?: number;
}

export interface FfmpegEncoderFinishResult {
	encodedSizeBytes: number;
	frameCount: number;
}

const DEFAULT_VIDEO_BITRATE = 2_500_000;

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
	private nextFrameAtMs = 0;
	private lastFrame?: Buffer;
	private writtenFrameCount = 0;
	private started = false;
	private finished = false;

	start(options: FfmpegEncoderStartOptions): void {
		if (this.started) throw new Error("ffmpeg encoder already started");
		this.outPath = options.outPath;
		this.fps = options.fps;
		this.intervalMs = 1000 / options.fps;
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"image2pipe",
			"-framerate",
			String(options.fps),
			"-vcodec",
			"mjpeg",
			"-i",
			"pipe:0",
			"-an",
			"-c:v",
			codecForMimeType(options.mimeType),
			"-b:v",
			bitrateString(options.videoBitsPerSecond),
			"-pix_fmt",
			"yuv420p",
			options.outPath,
		];
		const child = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
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
		if (!this.lastFrame) {
			this.lastFrame = Buffer.from(frame);
			this.nextFrameAtMs = capturedAtMs + this.intervalMs;
			await this.writeFrame(frame);
			return;
		}
		while (this.nextFrameAtMs + this.intervalMs <= capturedAtMs) {
			await this.writeFrame(this.lastFrame);
			this.nextFrameAtMs += this.intervalMs;
		}
		this.lastFrame = Buffer.from(frame);
		await this.writeFrame(frame);
		this.nextFrameAtMs = Math.max(this.nextFrameAtMs + this.intervalMs, capturedAtMs + this.intervalMs);
	}

	async finish(endedAtMs: number): Promise<FfmpegEncoderFinishResult> {
		if (!this.process || this.finished) throw new Error("ffmpeg encoder is not active");
		this.finished = true;
		if (!this.lastFrame) {
			this.process.stdin.destroy();
			this.process.kill("SIGTERM");
			throw new Error("Recording produced no frames");
		}
		while (this.nextFrameAtMs <= endedAtMs) {
			await this.writeFrame(this.lastFrame);
			this.nextFrameAtMs += this.intervalMs;
		}
		this.process.stdin.end();
		await this.waitForExit();
		const stats = await stat(this.outPath);
		return { encodedSizeBytes: stats.size, frameCount: this.writtenFrameCount };
	}

	abort(): void {
		if (!this.process || this.finished) return;
		this.finished = true;
		this.process.stdin.destroy();
		this.process.kill("SIGTERM");
	}

	private async writeFrame(frame: Buffer): Promise<void> {
		if (!this.process) throw new Error("ffmpeg encoder is not active");
		this.writtenFrameCount += 1;
		if (this.process.stdin.write(frame)) return;
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
