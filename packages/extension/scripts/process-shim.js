// Minimal process shim for browser environment
// Key property: process.browser = true tells libraries like @lmstudio/sdk to use browser-compatible code paths
const processShim = {
	browser: true,
	env: {},
	cwd: () => "/",
	platform: "browser",
	version: "",
	versions: {},
	argv: [],
	pid: 0,
	title: "browser",
	nextTick: (fn, ...args) => Promise.resolve().then(() => fn(...args)),
	stderr: {},
	stdout: {},
	stdin: {},
};

export default processShim;
export const process = processShim;
