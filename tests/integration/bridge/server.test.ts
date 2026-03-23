import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BridgeServer } from "../../../src/bridge/server.js";
import { BridgeDefaults, ErrorCodes } from "../../../src/bridge/protocol.js";
import { openRegisteredClient, readMessage, sendRequestAndReadResponse } from "../../helpers/ws-client.js";

async function getAvailablePort(): Promise<number> {
	const net = await import("node:net");
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("failed to resolve port"));
				return;
			}
			const { port } = address;
			server.close((err) => {
				if (err) reject(err);
				else resolve(port);
			});
		});
	});
}

describe("BridgeServer", () => {
	let server: BridgeServer;
	let port: number;
	let baseUrl: string;

	beforeEach(async () => {
		port = await getAvailablePort();
		baseUrl = `ws://127.0.0.1:${port}/ws`;
		server = new BridgeServer({ host: "127.0.0.1", port, token: "secret-token" });
		await server.start();
	});

	afterEach(async () => {
		await server.stop();
	});

	it("registers CLI and extension clients and exposes status", async () => {
		const extension = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 7,
			sessionId: "session-7",
			capabilities: ["status", "navigate"],
		});
		expect(extension.registerResult.ok).toBe(true);

		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "test-cli" });
		expect(cli.registerResult.ok).toBe(true);

		const status = await fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json());
		expect(status.extension).toMatchObject({ connected: true, windowId: 7, sessionId: "session-7" });
		expect(status.clients).toMatchObject({ cli: 1, extension: 1, total: 2 });

		extension.ws.close();
		cli.ws.close();
	});

	it("rejects invalid tokens and multiple active extension windows", async () => {
		const bad = new WebSocket(baseUrl);
		await new Promise<void>((resolve) => bad.once("open", resolve));
		bad.send(JSON.stringify({ type: "register", role: "cli", token: "wrong-token" }));
		await expect(readMessage(bad)).resolves.toEqual({ type: "register_result", ok: false, error: "Invalid token" });
		bad.close();

		const first = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 11,
			capabilities: ["status"],
		});
		const second = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 12,
			capabilities: ["status"],
		});
		expect(second.registerResult).toEqual({
			type: "register_result",
			ok: false,
			error: "Another extension target is already connected",
		});
		first.ws.close();
		second.ws.close();
	});

	it("replaces same-window reconnects and relays request responses", async () => {
		const extension = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 21,
			capabilities: ["status", "navigate"],
		});
		const reconnect = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 21,
			capabilities: ["status", "navigate"],
		});
		expect(reconnect.registerResult.ok).toBe(true);

		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "relay-cli" });
		const responsePromise = sendRequestAndReadResponse(cli.ws, { id: 99, method: "status" });
		const relayed = await readMessage<{ id: number; method: string }>(reconnect.ws);
		expect(relayed).toMatchObject({ id: 1, method: "status" });
		reconnect.ws.send(JSON.stringify({ id: relayed.id, result: { ok: true, ready: true } }));
		await expect(responsePromise).resolves.toEqual({ id: 99, result: { ok: true, ready: true } });

		extension.ws.close();
		reconnect.ws.close();
		cli.ws.close();
	});

	it("rejects invalid methods and disabled capabilities", async () => {
		const extension = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 31,
			capabilities: ["status"],
		});
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "cap-cli" });

		await expect(sendRequestAndReadResponse(cli.ws, { id: 1, method: "bogus", params: {} })).resolves.toEqual({
			id: 1,
			error: { code: ErrorCodes.INVALID_METHOD, message: "Unknown method: bogus" },
		});
		await expect(sendRequestAndReadResponse(cli.ws, { id: 2, method: "navigate", params: { url: "https://example.com" } })).resolves.toEqual({
			id: 2,
			error: {
				code: ErrorCodes.CAPABILITY_DISABLED,
				message: "Method 'navigate' is disabled on the active extension target",
			},
		});

		extension.ws.close();
		cli.ws.close();
	});

	it("cleans up pending requests and sends aborts on cli disconnect", async () => {
		const extension = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 41,
			capabilities: ["status", "session_inject"],
		});
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "disconnect-cli" });
		cli.ws.send(JSON.stringify({ id: 7, method: "status" }));
		const request = await readMessage<{ id: number; method: string }>(extension.ws);
		expect(request).toMatchObject({ id: 1, method: "status" });
		cli.ws.close();
		await expect(readMessage(extension.ws)).resolves.toEqual({ type: "abort", id: 1 });
		extension.ws.close();
	});

	it("enforces a single writer lease and releases it on session change", async () => {
		const extension = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 51,
			capabilities: ["session_inject", "session_set_model"],
		});
		const cliA = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "writer-a" });
		const cliB = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "writer-b" });

		const firstResponsePromise = sendRequestAndReadResponse(cliA.ws, {
			id: 10,
			method: "session_inject",
			params: { expectedSessionId: "session-a", role: "user", content: "hello" },
		});
		const forwarded = await readMessage<{ id: number; method: string }>(extension.ws);
		expect(forwarded).toMatchObject({ id: 1, method: "session_inject" });

		await expect(
			sendRequestAndReadResponse(cliB.ws, {
				id: 11,
				method: "session_set_model",
				params: { model: "anthropic/claude-sonnet-4-6" },
			}),
		).resolves.toEqual({
			id: 11,
			error: {
				code: ErrorCodes.WRITE_LOCKED,
				message: "Another CLI currently holds the session write lock",
			},
		});

		extension.ws.send(JSON.stringify({ id: forwarded.id, result: { ok: true } }));
		await expect(firstResponsePromise).resolves.toEqual({ id: 10, result: { ok: true } });

		extension.ws.send(
			JSON.stringify({
				type: "event",
				event: "session_changed",
				data: { sessionId: "session-b", persisted: true, title: "next", messageCount: 0, lastMessageIndex: -1 },
			}),
		);

		cliB.ws.send(
			JSON.stringify({
				id: 12,
				method: "session_set_model",
				params: { model: "anthropic/claude-sonnet-4-6" },
			}),
		);
		const secondForward = await readMessage<{ id: number; method: string }>(extension.ws);
		expect(secondForward).toMatchObject({ id: 2, method: "session_set_model" });
		extension.ws.send(JSON.stringify({ id: secondForward.id, result: { ok: true } }));
		let secondResponse = await readMessage(cliB.ws);
		if ((secondResponse as { type?: string }).type === "event") {
			secondResponse = await readMessage(cliB.ws);
		}
		expect(secondResponse).toEqual({ id: 12, result: { ok: true } });

		extension.ws.close();
		cliA.ws.close();
		cliB.ws.close();
	});
});
