import { describe, expect, it } from "vitest";
import {
	clampReadableText,
	findWordPosition,
	getEffectiveTtsCharLimit,
	normalizeReadableText,
	textsEquivalent,
} from "../../../src/tts/text-normalization.js";

describe("text-normalization", () => {
	describe("normalizeReadableText", () => {
		it("collapses multiple spaces into single space", () => {
			expect(normalizeReadableText("hello    world")).toBe("hello world");
			expect(normalizeReadableText("a  b   c    d")).toBe("a b c d");
		});

		it("collapses tabs and newlines into single space", () => {
			expect(normalizeReadableText("hello\tworld")).toBe("hello world");
			expect(normalizeReadableText("hello\n\nworld")).toBe("hello world");
			expect(normalizeReadableText("line1\r\nline2")).toBe("line1 line2");
		});

		it("trims leading and trailing whitespace", () => {
			expect(normalizeReadableText("  hello world  ")).toBe("hello world");
			expect(normalizeReadableText("\t\nhello\n\t")).toBe("hello");
		});

		it("handles empty strings", () => {
			expect(normalizeReadableText("")).toBe("");
			expect(normalizeReadableText("   ")).toBe("");
		});
	});

	describe("clampReadableText", () => {
		it("returns full text when under limit", () => {
			const result = clampReadableText("hello world", 100);
			expect(result.text).toBe("hello world");
			expect(result.truncated).toBe(false);
		});

		it("truncates text when over limit", () => {
			const result = clampReadableText("hello world this is a test", 10);
			expect(result.text.length).toBeLessThanOrEqual(10);
			expect(result.truncated).toBe(true);
		});

		it("normalizes before clamping", () => {
			const result = clampReadableText("hello    world    test", 15);
			// Normalized: "hello world test" (16 chars), clamped to 15
			expect(result.text).toBe("hello world tes");
			expect(result.truncated).toBe(true);
		});

		it("trims trailing space after truncation", () => {
			const result = clampReadableText("hello world test", 11);
			expect(result.text.endsWith(" ")).toBe(false);
		});
	});

	describe("getEffectiveTtsCharLimit", () => {
		it("returns base limit for all providers in non-streaming mode", () => {
			const baseLimit = 3000;
			expect(getEffectiveTtsCharLimit("kokoro", "page-target", false, baseLimit)).toBe(baseLimit);
			expect(getEffectiveTtsCharLimit("openai", "page-target", false, baseLimit)).toBe(baseLimit);
			expect(getEffectiveTtsCharLimit("elevenlabs", "page-target", false, baseLimit)).toBe(baseLimit);
		});

		it("returns base limit for raw-text mode", () => {
			const baseLimit = 3000;
			expect(getEffectiveTtsCharLimit("kokoro", "raw-text", false, baseLimit)).toBe(baseLimit);
			expect(getEffectiveTtsCharLimit("kokoro", "raw-text", true, baseLimit)).toBe(baseLimit);
		});
	});

	describe("textsEquivalent", () => {
		it("returns true for equivalent texts", () => {
			expect(textsEquivalent("hello world", "hello world")).toBe(true);
			expect(textsEquivalent("hello  world", "hello world")).toBe(true);
			expect(textsEquivalent("  hello world  ", "hello world")).toBe(true);
		});

		it("returns false for different texts", () => {
			expect(textsEquivalent("hello world", "hello there")).toBe(false);
			expect(textsEquivalent("hello", "hello world")).toBe(false);
		});
	});

	describe("findWordPosition", () => {
		it("finds word at beginning", () => {
			expect(findWordPosition("hello world test", "hello")).toBe(0);
		});

		it("finds word in middle", () => {
			expect(findWordPosition("hello world test", "world")).toBe(6);
		});

		it("finds word at end", () => {
			expect(findWordPosition("hello world test", "test")).toBe(12);
		});

		it("is case insensitive", () => {
			expect(findWordPosition("Hello World TEST", "world")).toBe(6);
		});

		it("respects start index", () => {
			expect(findWordPosition("hello hello hello", "hello", 1)).toBe(6);
		});

		it("returns -1 when word not found", () => {
			expect(findWordPosition("hello world", "missing")).toBe(-1);
		});
	});
});
