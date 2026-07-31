import { type ChildProcessWithoutNullStreams, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { FfmpegWebmEncoder } from "shuvgeist/recording/ffmpeg-encoder";
import {
	jpegDimensions,
	mjpegMatroskaFrame,
	mjpegMatroskaHeader,
} from "../../../packages/cli/src/recording/mjpeg-matroska";

function syntheticJpeg(width: number, height: number): Buffer {
	return Buffer.from([
		0xff,
		0xd8,
		0xff,
		0xe0,
		0x00,
		0x04,
		0x00,
		0x00,
		0xff,
		0xc0,
		0x00,
		0x0b,
		0x08,
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
		0x01,
		0x01,
		0x11,
		0x00,
		0xff,
		0xd9,
	]);
}

function ffmpegJpeg(color: string): Buffer {
	const result = spawnSync(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			`color=c=${color}:s=16x16:d=0.04`,
			"-frames:v",
			"1",
			"-f",
			"image2pipe",
			"-vcodec",
			"mjpeg",
			"pipe:1",
		],
		{ maxBuffer: 1024 * 1024 },
	);
	if (result.error || result.status !== 0 || !(result.stdout instanceof Buffer)) {
		throw result.error ?? new Error(result.stderr.toString("utf8"));
	}
	return result.stdout;
}

describe("timestamped MJPEG Matroska encoding", () => {
	it("extracts JPEG dimensions and rejects malformed images", () => {
		expect(jpegDimensions(syntheticJpeg(640, 360))).toEqual({ width: 640, height: 360 });
		expect(() => jpegDimensions(Buffer.from("not-jpeg"))).toThrow("not a JPEG");
		expect(() => jpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toThrow("does not contain");
	});

	it("builds a streaming Matroska header and bounded frame envelope", () => {
		const header = mjpegMatroskaHeader(640, 360);
		expect(header.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
		expect(header.includes(Buffer.from("matroska"))).toBe(true);
		expect(header.includes(Buffer.from("V_MJPEG"))).toBe(true);

		const frame = mjpegMatroskaFrame(250, 100, 512);
		expect(frame.header.subarray(0, 4).toString("hex")).toBe("1f43b675");
		expect(frame.trailer.subarray(0, 1).toString("hex")).toBe("9b");
		expect(() => mjpegMatroskaFrame(-1, 1, 1)).toThrow("non-negative safe integer");
	});

	it("waits for encoder input backpressure before accepting the next source frame", async () => {
		const stdin = new PassThrough({ highWaterMark: 1 });
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const child = Object.assign(new EventEmitter(), {
			stdin,
			stdout,
			stderr,
			kill: () => true,
		}) as unknown as ChildProcessWithoutNullStreams;
		stdin.resume();
		let drainCount = 0;
		stdin.on("drain", () => {
			drainCount += 1;
		});

		const encoder = new FfmpegWebmEncoder(() => child);
		encoder.start({ outPath: "/unused.webm", fps: 10 });
		await encoder.pushFrame(syntheticJpeg(16, 16), 1_000);
		await encoder.pushFrame(syntheticJpeg(16, 16), 1_200);
		expect(drainCount).toBeGreaterThan(0);
		encoder.abort();
	});

	it.skipIf(spawnSync("ffmpeg", ["-version"]).status !== 0)(
		"coalesces same-slot frames, drops out-of-order frames, and produces valid WebM",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "shuvgeist-ffmpeg-"));
			const outPath = join(directory, "recording.webm");
			try {
				const encoder = new FfmpegWebmEncoder();
				encoder.start({ outPath, fps: 10 });
				await encoder.pushFrame(ffmpegJpeg("red"), 1_000);
				await encoder.pushFrame(ffmpegJpeg("blue"), 1_050);
				await encoder.pushFrame(ffmpegJpeg("green"), 1_200);
				await encoder.pushFrame(ffmpegJpeg("white"), 1_100);
				const result = await encoder.finish(1_400);

				expect(result).toMatchObject({
					frameCount: 4,
					sourceFrameCount: 4,
					encodedFrameCount: 2,
					coalescedFrameCount: 1,
					droppedFrameCount: 1,
				});
				expect(result.encodedSizeBytes).toBeGreaterThan(0);
				expect((await stat(outPath)).size).toBe(result.encodedSizeBytes);
				expect((await readFile(outPath)).subarray(0, 4).toString("hex")).toBe("1a45dfa3");

				const probe = spawnSync(
					"ffprobe",
					["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", outPath],
					{ encoding: "utf8" },
				);
				expect(probe.status, probe.stderr).toBe(0);
				expect(Number.parseFloat(probe.stdout.trim())).toBeCloseTo(0.4, 1);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(spawnSync("ffmpeg", ["-version"]).status !== 0)(
		"fails empty recordings and rejects work after abort",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "shuvgeist-ffmpeg-abort-"));
			try {
				const empty = new FfmpegWebmEncoder();
				empty.start({ outPath: join(directory, "empty.webm"), fps: 12 });
				await expect(empty.finish(1_000)).rejects.toThrow("no frames");

				const aborted = new FfmpegWebmEncoder();
				aborted.start({ outPath: join(directory, "aborted.webm"), fps: 12 });
				aborted.abort();
				await expect(aborted.pushFrame(ffmpegJpeg("black"), 1_000)).rejects.toThrow("not active");
				await expect(aborted.finish(1_100)).rejects.toThrow("not active");
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
});
