import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { runtimeClientRouteKey, sameRuntimeTarget } from "@shuvgeist/extension/agent/runtime-identity";
import { ArtifactHydrationQueue } from "@shuvgeist/extension/sidepanel/artifact-hydration-queue";
import { detachRemotePresentation, selectRemoteDescriptor } from "@shuvgeist/extension/sidepanel/remote-session-policy";
import type { AgentRuntimeConnectionDescriptor } from "@shuvgeist/extension/bridge/internal-messages";

const sidepanelPath = join(process.cwd(), "packages/extension/src/sidepanel.ts");
const welcomePath = join(process.cwd(), "packages/extension/src/messages/WelcomeMessage.ts");
const facadePath = join(process.cwd(), "packages/extension/src/agent/remote-agent-facade.ts");
const remoteClientPath = join(process.cwd(), "packages/extension/src/agent/remote-session-client.ts");
const sidepanelSourceText = readFileSync(sidepanelPath, "utf-8");
const welcomeSourceText = readFileSync(welcomePath, "utf-8");
const facadeSourceText = readFileSync(facadePath, "utf-8");
const remoteClientSourceText = readFileSync(remoteClientPath, "utf-8");
const sidepanelSourceFile = ts.createSourceFile(
	sidepanelPath,
	sidepanelSourceText,
	ts.ScriptTarget.Latest,
	true,
	ts.ScriptKind.TS,
);

function requireNode<T>(node: T | undefined, label: string): T {
	if (!node) throw new Error(`Missing expected sidepanel wiring node: ${label}`);
	return node;
}

function findFunction(name: string): ts.FunctionDeclaration {
	return requireNode(
		sidepanelSourceFile.statements.find(
			(statement): statement is ts.FunctionDeclaration =>
				ts.isFunctionDeclaration(statement) && statement.name?.text === name,
		),
		name,
	);
}

function functionText(name: string): string {
	return findFunction(name).getText(sidepanelSourceFile);
}

function expectInOrder(source: string, snippets: readonly string[]): void {
	let offset = -1;
	for (const snippet of snippets) {
		const next = source.indexOf(snippet, offset + 1);
		expect(next, `Expected ${JSON.stringify(snippet)} after offset ${offset}`).toBeGreaterThan(offset);
		offset = next;
	}
}

describe("sidepanel remote Agent wiring", () => {
	it("uses only the remote transport, client, and facade for ChatPanel", () => {
		expect(sidepanelSourceText).toContain('import { ChromeRuntimeSessionTransport }');
		expect(sidepanelSourceText).toContain('import { RemoteSessionClient }');
		expect(sidepanelSourceText).toContain('import { asPiWebUiAgent, RemoteAgentFacade }');
		expect(sidepanelSourceText.match(/asPiWebUiAgent\(/g)).toHaveLength(1);
		expect(sidepanelSourceText).toContain("await chatPanel.setAgent(asPiWebUiAgent(binding.facade)");
		expect(sidepanelSourceText).toContain("toolsFactory: () => []");

		for (const forbidden of [
			"createAgentRuntime",
			"createStreamFn",
			"new Agent(",
			"new NavigateTool(",
			"new ReplTool(",
			"new SkillTool(",
			"bridge-session-command",
			"bridge-repl-execute",
			"bridge-screenshot",
			"abort-repl",
			"capturePageSnapshot(",
		]) {
			expect(sidepanelSourceText).not.toContain(forbidden);
		}
	});

	it("uses a stable window-scoped client and target with UUID request identities", () => {
		const descriptor = functionText("buildConnectionDescriptor");
		const binding = functionText("createRemoteBinding");
		expect(sidepanelSourceText).toContain('const SIDEPANEL_AGENT_CLIENT_ID = "sidepanel"');
		expect(functionText("sidepanelTarget")).toContain('tabRef: `window:${windowId}`');
		expect(functionText("descriptorRegistryKey")).toContain(
			"runtimeClientRouteKey(SIDEPANEL_AGENT_CLIENT_ID, windowId)",
		);
		expect(descriptor).toContain("clientId: SIDEPANEL_AGENT_CLIENT_ID");
		expect(descriptor).toContain("windowId: currentWindowId");
		expect(binding).toContain("createRequestId: () => crypto.randomUUID()");
		expect(binding).toContain("createExecutionId: () => crypto.randomUUID()");
		expect(runtimeClientRouteKey("sidepanel", 9)).toBe('["sidepanel",9]');
		expect(
			sameRuntimeTarget(
				{ kind: "chrome-tab", tabRef: "window:9", frameId: 0 },
				{ frameId: 0, tabRef: "window:9", kind: "chrome-tab" },
			),
		).toBe(true);
	});

	it("persists and confirms authoritative SIDE_PANEL capability before opening either port", () => {
		const bootstrap = functionText("bootstrapSidepanelDocumentIdentity");
		const init = functionText("initApp");
		expectInOrder(init, [
			"currentDocumentNonce = bootstrapSidepanelDocumentIdentity()",
			"const storedCapability = readStoredSidepanelCapability()",
			"const storedProof: SidepanelCapabilityMaterial | undefined = storedCapability",
			"pendingIdentity = await prepareSidepanelWindowIdentity(",
			'storeSidepanelCapability("pending", pendingMaterial)',
			"const identity = await confirmSidepanelWindowIdentity(",
			'storeSidepanelCapability("active", {',
			"currentWindowId = identity.windowId",
			"port.initialize(",
		]);
		expect(bootstrap).toContain("window.history.replaceState(window.history.state, \"\", plan.url)");
		expect(bootstrap).toContain("return plan.nonce");
		expect(bootstrap).not.toContain("location.replace");
		expect(bootstrap).not.toContain("sessionStorage");
		expect(init).toContain("chrome.runtime.sendMessage(message)");
		expect(init).toContain("continuationToken: storedCapability.continuationToken");
		expect(init).toContain("transactionId: storedCapability.transactionId");
		expect(init).toContain("leaseId: storedCapability.leaseId");
		expect(init).toContain("currentContinuationToken");
		expect(init).toContain("currentTransactionId");
		expect(init).toContain("currentLeaseId");
		expect(init).not.toContain("windowId: identity.windowId");
		expect(init).not.toContain("getLastFocused");
		expect(init).not.toContain("windows.getCurrent");
		expect(functionText("createRemoteBinding")).toContain("documentNonce: currentDocumentNonce");
		expect(functionText("createRemoteBinding")).toContain("continuationToken: currentContinuationToken");
		expect(functionText("createRemoteBinding")).toContain("transactionId: currentTransactionId");
		expect(functionText("createRemoteBinding")).toContain("leaseId: currentLeaseId");
	});

	it("subscribes before connect and waits for the first snapshot before mounting ChatPanel", () => {
		const connect = functionText("connectRemoteSession");
		expectInOrder(connect, [
			"agentUnsubscribe = binding.facade.subscribe(",
			"stateUnsubscribe = binding.facade.subscribeState(",
			"await binding.client.connect()",
			"await chatPanel.setAgent(asPiWebUiAgent(binding.facade)",
			"chatPanel.agentInterface.requestUpdate()",
		]);
	});

	it("reuses the exact accepted descriptor and hydrates artifacts serially", () => {
		const connect = functionText("connectRemoteSession");
		const hydrate = functionText("queueArtifactHydration");
		expect(connect).toContain("const selection = selectRemoteDescriptor(desired, accepted)");
		expect(hydrate).toContain("artifactHydrationQueue.enqueue(");
		expect(hydrate).toContain('facade.client.executeArtifacts({ action: "list" })');
		expect(hydrate).toContain("chatPanel.artifactsPanel.reconstructFromMessages");
	});

	it("serializes hydration and retries an unchanged signature after failure", async () => {
		const queue = new ArtifactHydrationQueue();
		const order: string[] = [];
		let releaseFirst = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let markFirstStarted = () => {};
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const first = queue.enqueue("first", async () => {
			order.push("first:start");
			markFirstStarted();
			await firstGate;
			order.push("first:end");
		});
		const second = queue.enqueue("second", async () => {
			order.push("second:start");
			order.push("second:end");
		});
		await firstStarted;
		expect(order).toEqual(["first:start"]);
		releaseFirst();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);

		let attempts = 0;
		const hydrate = async () => {
			attempts++;
			if (attempts === 1) throw new Error("transient");
		};
		await expect(queue.enqueue("retryable", hydrate)).rejects.toThrow("transient");
		await expect(queue.enqueue("retryable", hydrate)).resolves.toBeUndefined();
		expect(attempts).toBe(2);
	});

	it("detaches presentation on panel close but releases sessions only when switching", () => {
		const dispose = functionText("disposeRemotePresentation");
		const release = functionText("releaseCurrentSessionForSwitch");
		expect(sidepanelSourceText).toContain(
			'window.addEventListener("pagehide", disposeRemotePresentation)',
		);
		expect(sidepanelSourceText).toContain(
			'window.addEventListener("beforeunload", disposeRemotePresentation)',
		);
		expect(dispose).toContain("detachRemotePresentation(resources)");
		expect(dispose).not.toContain("release(");
		expect(dispose).not.toContain("abort(");
		expectInOrder(release, [
			'await remoteClient.release({ force: true, reason: "session-switch" })',
			"disposeRemotePresentation()",
		]);
	});

	it("preserves exact reopen descriptors, isolates windows, and makes panel detach presentation-only", () => {
		const desired: AgentRuntimeConnectionDescriptor = {
			clientId: "sidepanel",
			windowId: 9,
			sessionId: "session-a",
			target: { kind: "chrome-tab", tabRef: "window:9", frameId: 0 },
			mode: "load",
			systemPrompt: "desired",
		};
		const accepted: AgentRuntimeConnectionDescriptor = {
			...desired,
			target: { frameId: 0, tabRef: "window:9", kind: "chrome-tab" },
			mode: "create",
			systemPrompt: "accepted",
		};
		expect(selectRemoteDescriptor(desired, accepted)).toEqual({ descriptor: accepted });

		const otherWindow: AgentRuntimeConnectionDescriptor = {
			...accepted,
			windowId: 10,
			target: { kind: "chrome-tab", tabRef: "window:10", frameId: 0 },
		};
		expect(selectRemoteDescriptor(desired, otherWindow)).toEqual({
			descriptor: desired,
			staleAccepted: otherWindow,
		});
		expect(runtimeClientRouteKey("sidepanel", 9)).not.toBe(runtimeClientRouteKey("sidepanel", 10));

		const calls: string[] = [];
		const facade = {
			dispose: () => calls.push("facade:dispose"),
			abort: () => calls.push("facade:abort"),
			release: () => calls.push("facade:release"),
		};
		detachRemotePresentation({
			agentUnsubscribe: () => calls.push("agent:unsubscribe"),
			stateUnsubscribe: () => calls.push("state:unsubscribe"),
			facade,
			transport: { dispose: () => calls.push("transport:dispose") },
		});
		expect(calls).toEqual([
			"agent:unsubscribe",
			"state:unsubscribe",
			"facade:dispose",
			"transport:dispose",
		]);
	});

	it("acquires the lock and opens the authenticated runtime before publishing the fresh session URL", () => {
		expectInOrder(functionText("startFreshRemoteSession"), [
			"const sessionId = crypto.randomUUID()",
			"await acquireSessionLock(sessionId)",
			"currentSessionId = sessionId",
			"await connectRemoteSession(",
			"updateUrl(sessionId)",
		]);
	});

	it("keeps navigation out of the view and routes element inspection through the remote runtime", () => {
		const connect = functionText("connectRemoteSession");
		const inspect = functionText("onInspectElementClick");
		expect(connect).toContain("await binding.facade.setModel(");
		expect(inspect).toContain('client.executePageOperation("select-element"');
		expect(sidepanelSourceText).not.toContain("pickElement(");
		expect(sidepanelSourceText).not.toContain("captureNavigationSnapshot");
		expect(sidepanelSourceText).not.toContain("onBeforeSend:");
		expect(sidepanelSourceText).not.toContain("chrome.tabs.onUpdated.addListener");
		expect(sidepanelSourceText).not.toContain("chrome.tabs.onActivated.addListener");
		expect(sidepanelSourceText).not.toMatch(/\.state\.(?:messages|model|thinkingLevel|tools)\s*=/);
		expect(facadeSourceText).toContain("return this.client.state as unknown as AgentState");
		expect(remoteClientSourceText).toMatch(
			/set thinkingLevel\(value: RuntimeThinkingLevel\)[\s\S]*?this\.setThinkingLevel\(value\)/,
		);
	});
});

describe("welcome message remote transcript behavior", () => {
	it("submits a tutorial once without mutating an Agent state clone", () => {
		expect(welcomeSourceText.match(/agentInterface\.sendMessage\(prompt\)/g)).toHaveLength(1);
		expect(welcomeSourceText).not.toMatch(/\.state\.messages/);
		expect(welcomeSourceText).not.toContain("this.message");
	});

	it("hides from the authoritative transcript after either conversation role arrives", () => {
		expect(welcomeSourceText).toContain("getMessages: () => readonly AgentMessage[]");
		expect(welcomeSourceText).toContain(
			'getMessages().some((m) => m.role === "user" || m.role === "assistant")',
		);
		expect(sidepanelSourceText).toContain(
			"registerWelcomeRenderer(() => binding.facade.state.messages, chatPanel.agentInterface)",
		);
	});
});
