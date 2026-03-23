import { WebSocket } from "ws";
import type { BridgeResponse, RegisterResult } from "../../src/bridge/protocol.js";

export async function openRegisteredClient(url: string, token: string, role: "cli" | "extension", extra: Record<string, unknown> = {}) {
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	ws.send(JSON.stringify({ type: "register", role, token, ...extra }));
	const registerResult = await readMessage<RegisterResult>(ws);
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
