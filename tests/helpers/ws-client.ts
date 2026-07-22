import { WebSocket, type RawData } from "ws";
import {
	BRIDGE_PROTOCOL_MIN_VERSION,
	BRIDGE_PROTOCOL_VERSION,
	type BridgeRequest,
	type BridgeResponse,
	type RegisterResult,
} from "@shuvgeist/protocol/protocol";

interface ResponseWaiter {
	reject(error: Error): void;
	resolve(response: BridgeResponse): void;
	timeout: ReturnType<typeof setTimeout>;
}

function rawDataText(data: RawData): string {
	const bytes = Array.isArray(data)
		? Buffer.concat(data)
		: data instanceof ArrayBuffer
			? Buffer.from(new Uint8Array(data))
			: Buffer.from(data);
	return bytes.toString("utf-8");
}

export class BridgeResponseInbox {
	readonly #buffered = new Map<number, BridgeResponse>();
	readonly #waiters = new Map<number, ResponseWaiter>();
	#disposed = false;
	#terminalError: Error | undefined;

	constructor(
		private readonly ws: WebSocket,
		private readonly defaultTimeoutMs = 15_000,
	) {
		ws.on("message", this.#handleMessage);
		ws.on("error", this.#handleError);
		ws.on("close", this.#handleClose);
	}

	send<T = BridgeResponse>(request: BridgeRequest, timeoutMs = this.defaultTimeoutMs): Promise<T> {
		const response = this.#waitFor(request.id, request.method, timeoutMs);
		try {
			this.ws.send(JSON.stringify(request));
		} catch (error) {
			this.#rejectWaiter(request.id, error instanceof Error ? error : new Error(String(error)));
		}
		return response as Promise<T>;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.ws.off("message", this.#handleMessage);
		this.ws.off("error", this.#handleError);
		this.ws.off("close", this.#handleClose);
		this.#buffered.clear();
		this.#fail(new Error("Bridge response inbox disposed"));
	}

	#waitFor(id: number, method: string, timeoutMs: number): Promise<BridgeResponse> {
		if (this.#terminalError) return Promise.reject(this.#terminalError);
		if (this.#disposed) return Promise.reject(new Error("Bridge response inbox is disposed"));
		const buffered = this.#buffered.get(id);
		if (buffered) {
			this.#buffered.delete(id);
			return Promise.resolve(buffered);
		}
		if (this.#waiters.has(id)) return Promise.reject(new Error(`Bridge request ${id} is already pending`));

		return new Promise<BridgeResponse>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#waiters.delete(id);
				reject(new Error(`Timed out waiting ${timeoutMs}ms for bridge ${method} response ${id}`));
			}, timeoutMs);
			this.#waiters.set(id, { resolve, reject, timeout });
		});
	}

	#rejectWaiter(id: number, error: Error): void {
		const waiter = this.#waiters.get(id);
		if (!waiter) return;
		this.#waiters.delete(id);
		clearTimeout(waiter.timeout);
		waiter.reject(error);
	}

	#fail(error: Error): void {
		this.#terminalError ??= error;
		for (const [id, waiter] of this.#waiters) {
			this.#waiters.delete(id);
			clearTimeout(waiter.timeout);
			waiter.reject(this.#terminalError);
		}
	}

	readonly #handleMessage = (data: RawData): void => {
		let message: unknown;
		try {
			message = JSON.parse(rawDataText(data)) as unknown;
		} catch (error) {
			this.#fail(new Error("Bridge sent malformed JSON", { cause: error }));
			return;
		}
		if (!message || typeof message !== "object" || Array.isArray(message)) return;
		const id = (message as { id?: unknown }).id;
		if (typeof id !== "number") return;
		const response = message as BridgeResponse;
		const waiter = this.#waiters.get(id);
		if (!waiter) {
			this.#buffered.set(id, response);
			return;
		}
		this.#waiters.delete(id);
		clearTimeout(waiter.timeout);
		waiter.resolve(response);
	};

	readonly #handleError = (error: Error): void => {
		this.#fail(error);
	};

	readonly #handleClose = (code: number, reason: Buffer): void => {
		this.#fail(new Error(`Bridge WebSocket closed (${code}): ${reason.toString("utf-8")}`));
	};
}

export async function openRegisteredClient(url: string, token: string, role: "cli" | "extension", extra: Record<string, unknown> = {}) {
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const registerResultPromise = readMessage<RegisterResult>(ws);
	ws.send(
		JSON.stringify({
			type: "register",
			role,
			token,
			protocolVersion: BRIDGE_PROTOCOL_VERSION,
			minProtocolVersion: BRIDGE_PROTOCOL_MIN_VERSION,
			appVersion: "test",
			...extra,
		}),
	);
	const registerResult = await registerResultPromise;
	return { ws, registerResult };
}

export async function readMessage<T = unknown>(ws: WebSocket): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const handleMessage = (data: Buffer | string) => {
			cleanup();
			resolve(JSON.parse(typeof data === "string" ? data : data.toString("utf-8")) as T);
		};
		const handleError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			ws.off("message", handleMessage);
			ws.off("error", handleError);
		};
		ws.on("message", handleMessage);
		ws.on("error", handleError);
	});
}

export async function sendRequestAndReadResponse(ws: WebSocket, request: unknown): Promise<BridgeResponse> {
	ws.send(JSON.stringify(request));
	return readMessage<BridgeResponse>(ws);
}
