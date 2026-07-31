/**
 * Minimal streaming Matroska writer for timestamped MJPEG frames.
 *
 * Adapted from anomalyco/browser-control under the MIT License.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Format references:
 * - https://www.matroska.org/technical/elements.html
 * - https://www.rfc-editor.org/rfc/rfc8794
 */

const ebml = Buffer.from("1A45DFA3", "hex");
const ebmlVersion = Buffer.from("4286", "hex");
const ebmlReadVersion = Buffer.from("42F7", "hex");
const ebmlMaxIdLength = Buffer.from("42F2", "hex");
const ebmlMaxSizeLength = Buffer.from("42F3", "hex");
const docType = Buffer.from("4282", "hex");
const docTypeVersion = Buffer.from("4287", "hex");
const docTypeReadVersion = Buffer.from("4285", "hex");
const segment = Buffer.from("18538067", "hex");
const info = Buffer.from("1549A966", "hex");
const timestampScale = Buffer.from("2AD7B1", "hex");
const muxingApp = Buffer.from("4D80", "hex");
const writingApp = Buffer.from("5741", "hex");
const tracks = Buffer.from("1654AE6B", "hex");
const trackEntry = Buffer.from("AE", "hex");
const trackNumber = Buffer.from("D7", "hex");
const trackUid = Buffer.from("73C5", "hex");
const trackType = Buffer.from("83", "hex");
const flagLacing = Buffer.from("9C", "hex");
const codecId = Buffer.from("86", "hex");
const video = Buffer.from("E0", "hex");
const pixelWidth = Buffer.from("B0", "hex");
const pixelHeight = Buffer.from("BA", "hex");
const cluster = Buffer.from("1F43B675", "hex");
const timestamp = Buffer.from("E7", "hex");
const blockGroup = Buffer.from("A0", "hex");
const block = Buffer.from("A1", "hex");
const blockDuration = Buffer.from("9B", "hex");
const unknownSize = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

const jpegStartOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export interface JpegDimensions {
	width: number;
	height: number;
}

function assertSafeUnsignedInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative safe integer`);
	}
}

function variableInteger(value: number): Buffer {
	assertSafeUnsignedInteger(value, "EBML variable integer");
	let length = 1;
	while (value >= 2 ** (7 * length) - 1) {
		length += 1;
		if (length > 8) throw new Error("EBML variable integer is too large");
	}
	const buffer = Buffer.alloc(length);
	let remaining = value;
	for (let index = length - 1; index >= 0; index -= 1) {
		buffer[index] = remaining & 0xff;
		remaining = Math.floor(remaining / 256);
	}
	buffer[0] = (buffer[0] ?? 0) | (1 << (8 - length));
	return buffer;
}

function unsignedInteger(value: number): Buffer {
	assertSafeUnsignedInteger(value, "EBML unsigned integer");
	if (value === 0) return Buffer.from([0]);
	const bytes: number[] = [];
	let remaining = value;
	while (remaining > 0) {
		bytes.unshift(remaining & 0xff);
		remaining = Math.floor(remaining / 256);
	}
	return Buffer.from(bytes);
}

function element(id: Buffer, payload: Buffer): Buffer {
	return Buffer.concat([id, variableInteger(payload.length), payload]);
}

export function jpegDimensions(frame: Buffer): JpegDimensions {
	if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8) {
		throw new Error("Recording frame is not a JPEG image");
	}

	let offset = 2;
	while (offset + 1 < frame.length) {
		if (frame[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		while (offset < frame.length && frame[offset] === 0xff) offset += 1;
		if (offset >= frame.length) break;

		const marker = frame[offset] ?? 0;
		offset += 1;
		if (marker === 0xd9 || marker === 0xda) break;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (offset + 1 >= frame.length) break;

		const segmentLength = frame.readUInt16BE(offset);
		if (segmentLength < 2 || offset + segmentLength > frame.length) {
			throw new Error("Recording frame has a malformed JPEG segment");
		}
		if (jpegStartOfFrameMarkers.has(marker)) {
			if (segmentLength < 7) throw new Error("Recording frame has a malformed JPEG size segment");
			const height = frame.readUInt16BE(offset + 3);
			const width = frame.readUInt16BE(offset + 5);
			if (width < 1 || height < 1) throw new Error("Recording frame has invalid JPEG dimensions");
			return { width, height };
		}
		offset += segmentLength;
	}

	throw new Error("Recording frame does not contain JPEG dimensions");
}

export function mjpegMatroskaHeader(width: number, height: number): Buffer {
	assertSafeUnsignedInteger(width, "JPEG width");
	assertSafeUnsignedInteger(height, "JPEG height");
	if (width < 1 || height < 1) throw new Error("JPEG dimensions must be positive");

	const ebmlHeader = element(
		ebml,
		Buffer.concat([
			element(ebmlVersion, unsignedInteger(1)),
			element(ebmlReadVersion, unsignedInteger(1)),
			element(ebmlMaxIdLength, unsignedInteger(4)),
			element(ebmlMaxSizeLength, unsignedInteger(8)),
			element(docType, Buffer.from("matroska")),
			element(docTypeVersion, unsignedInteger(4)),
			element(docTypeReadVersion, unsignedInteger(2)),
		]),
	);
	const streamInfo = element(
		info,
		Buffer.concat([
			element(timestampScale, unsignedInteger(1_000_000)),
			element(muxingApp, Buffer.from("shuvgeist")),
			element(writingApp, Buffer.from("shuvgeist")),
		]),
	);
	const track = element(
		trackEntry,
		Buffer.concat([
			element(trackNumber, unsignedInteger(1)),
			element(trackUid, unsignedInteger(1)),
			element(trackType, unsignedInteger(1)),
			element(flagLacing, unsignedInteger(0)),
			element(codecId, Buffer.from("V_MJPEG")),
			element(
				video,
				Buffer.concat([element(pixelWidth, unsignedInteger(width)), element(pixelHeight, unsignedInteger(height))]),
			),
		]),
	);
	return Buffer.concat([ebmlHeader, segment, unknownSize, streamInfo, element(tracks, track)]);
}

export function mjpegMatroskaFrame(
	timestampMs: number,
	durationMs: number,
	frameLength: number,
): {
	header: Buffer;
	trailer: Buffer;
} {
	assertSafeUnsignedInteger(timestampMs, "Frame timestamp");
	assertSafeUnsignedInteger(durationMs, "Frame duration");
	assertSafeUnsignedInteger(frameLength, "Frame length");

	const blockHeader = Buffer.concat([
		block,
		variableInteger(4 + frameLength),
		variableInteger(1),
		Buffer.from([0x00, 0x00]),
		Buffer.from([0x00]),
	]);
	const clusterTimestamp = element(timestamp, unsignedInteger(timestampMs));
	const duration = element(blockDuration, unsignedInteger(Math.max(1, durationMs)));
	const groupHeader = Buffer.concat([
		blockGroup,
		variableInteger(blockHeader.length + frameLength + duration.length),
		blockHeader,
	]);
	return {
		header: Buffer.concat([
			cluster,
			variableInteger(clusterTimestamp.length + groupHeader.length + frameLength + duration.length),
			clusterTimestamp,
			groupHeader,
		]),
		trailer: duration,
	};
}
