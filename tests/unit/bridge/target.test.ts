import {
	defaultTarget,
	formatTargetSpec,
	parseTargetSpec,
	requestTarget,
} from "../../../src/bridge/target.js";

describe("bridge targets", () => {
	it("defaults missing request targets to chrome", () => {
		expect(defaultTarget()).toEqual({ kind: "chrome-tab" });
		expect(requestTarget({})).toEqual({ kind: "chrome-tab" });
	});

	it("parses and formats chrome targets", () => {
		expect(parseTargetSpec("chrome:t1")).toEqual({ kind: "chrome-tab", tabRef: "t1" });
		expect(parseTargetSpec("chrome:42")).toEqual({ kind: "chrome-tab", tabId: 42 });
		expect(formatTargetSpec({ kind: "chrome-tab", tabId: 42 })).toBe("chrome:42");
		expect(formatTargetSpec({ kind: "chrome-tab", tabRef: "active" })).toBe("chrome:active");
	});

	it("parses and formats electron targets", () => {
		expect(parseTargetSpec("electron:vscode")).toEqual({
			kind: "electron-window",
			appRef: "vscode",
			windowRef: "w1",
		});
		expect(parseTargetSpec("electron:vscode:w2")).toEqual({
			kind: "electron-window",
			appRef: "vscode",
			windowRef: "w2",
		});
		expect(parseTargetSpec("electron:e1:w2")).toEqual({
			kind: "electron-window",
			sessionId: "e1",
			windowRef: "w2",
		});
		expect(parseTargetSpec("electron:e1/main")).toEqual({
			kind: "electron-window",
			sessionId: "e1",
			windowRef: "main",
		});
		expect(parseTargetSpec("electron-session:session-1")).toEqual({
			kind: "electron-window",
			sessionId: "session-1",
			windowRef: "w1",
		});
		expect(formatTargetSpec({ kind: "electron-window", appRef: "vscode", windowRef: "w2" })).toBe(
			"electron:vscode:w2",
		);
		expect(formatTargetSpec({ kind: "electron-window", sessionId: "session-1" })).toBe(
			"electron-session:session-1",
		);
	});

	it("rejects malformed target specs with teaching errors", () => {
		expect(() => parseTargetSpec("")).toThrow("target must not be empty");
		expect(() => parseTargetSpec("electron:")).toThrow("electron target must include an app id, alias, or session id");
		expect(() => parseTargetSpec("tab:1")).toThrow("target must start with");
	});
});
