export interface ChromePortLike {
	name: string;
	postMessage: ReturnType<typeof vi.fn>;
	onMessage: { addListener: (listener: (msg: unknown) => void) => void };
	onDisconnect: { addListener: (listener: () => void) => void };
}

export function createChromeRuntimePortMock() {
	const messageListeners: Array<(msg: unknown) => void> = [];
	const disconnectListeners: Array<() => void> = [];

	const port: ChromePortLike = {
		name: "",
		postMessage: vi.fn(),
		onMessage: {
			addListener(listener) {
				messageListeners.push(listener);
			},
		},
		onDisconnect: {
			addListener(listener) {
				disconnectListeners.push(listener);
			},
		},
	};

	return {
		port,
		emitMessage(message: unknown) {
			for (const listener of messageListeners) listener(message);
		},
		emitDisconnect() {
			for (const listener of disconnectListeners) listener();
		},
	};
}
