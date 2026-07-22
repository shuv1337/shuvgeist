import { readFileSync } from "node:fs";
import { join } from "node:path";

const backgroundSource = readFileSync(join(process.cwd(), "packages/extension/src/background.ts"), "utf8");

describe("background SIDE_PANEL window authority wiring", () => {
	it("binds onOpened authority and exposes the two-phase continuation handshake", () => {
		expect(backgroundSource).toContain("new SidepanelWindowAuthority({");
		expect(backgroundSource).toContain("chrome.sidePanel.onOpened?.addListener");
		expect(backgroundSource).toContain("agentRuntimeSidepanelTrackingRegistry.revokeWindow(info.windowId)");
		expect(backgroundSource).toContain("agentRuntimeCoordinator.revokeWindowPorts(info.windowId)");
		expect(backgroundSource).toContain("sidepanelWindowAuthority.observeOpened(info)");
		expect(backgroundSource).toContain("message.type === SIDEPANEL_WINDOW_PREPARE_MESSAGE_TYPE");
		expect(backgroundSource).toContain(".prepareWindow(message, _sender)");
		expect(backgroundSource).toContain("message.type === SIDEPANEL_WINDOW_CONFIRM_MESSAGE_TYPE");
		expect(backgroundSource).toContain(".confirmWindow(message, _sender)");
	});

	it("revokes the prior presentation lease before returning prepared material", () => {
		const prepareStart = backgroundSource.indexOf("message.type === SIDEPANEL_WINDOW_PREPARE_MESSAGE_TYPE");
		const prepareEnd = backgroundSource.indexOf(
			"message.type === SIDEPANEL_WINDOW_CONFIRM_MESSAGE_TYPE",
			prepareStart,
		);
		const prepareSource = backgroundSource.slice(prepareStart, prepareEnd);
		const revokeTracking = prepareSource.indexOf("agentRuntimeSidepanelTrackingRegistry.revokeWindow(response.windowId)");
		const revokeRuntime = prepareSource.indexOf("agentRuntimeCoordinator.revokeWindowPorts(response.windowId)");
		const sendResponse = prepareSource.indexOf("sendResponse(response)");
		expect(revokeTracking).toBeGreaterThan(-1);
		expect(revokeRuntime).toBeGreaterThan(revokeTracking);
		expect(sendResponse).toBeGreaterThan(revokeRuntime);
	});

	it("admits runtime ports only through a current authority lease", () => {
		const optionsStart = backgroundSource.indexOf("function agentRuntimePortAuthenticationOptions()");
		const optionsEnd = backgroundSource.indexOf("function acceptSidepanelTrackingPort", optionsStart);
		const optionsSource = backgroundSource.slice(optionsStart, optionsEnd);
		expect(optionsSource).toContain(
			"sidepanelWindowAuthority.resolveActiveLease(documentNonce, material, documentId)",
		);
		expect(optionsSource).toContain("sidepanelWindowAuthority.isLeaseCurrent(lease)");
		expect(optionsSource).not.toContain("sidepanelTrackingRegistry:");
	});

	it("requires v2 session-backed authority and releases browser-window ownership", () => {
		expect(backgroundSource).toContain('const SIDEPANEL_WINDOW_AUTHORITY_STORAGE_KEY = "shuvgeist.sidepanelWindowAuthority.v2"');
		expect(backgroundSource).toContain('throw new Error("chrome.storage.session is unavailable for sidepanel authority")');
		expect(backgroundSource).toContain("agentRuntimeSidepanelTrackingRegistry.revokeWindow(windowId)");
		expect(backgroundSource).toContain("agentRuntimeCoordinator.revokeWindowPorts(windowId)");
		expect(backgroundSource).toContain("sidepanelWindowAuthority.releaseWindow(windowId)");
	});

	it("serializes presentation state changes and fences them by registry and authority lease", () => {
		expect(backgroundSource).toContain("const sidepanelPresentationTails = new Map<number, Promise<void>>()");
		expect(backgroundSource).toContain("serializeSidepanelPresentation(windowId, async () => {");
		expect(backgroundSource).toContain("agentRuntimeSidepanelTrackingRegistry.isCurrent(port, lease)");
		expect(backgroundSource).toContain("await sidepanelWindowAuthority.isLeaseCurrent(lease)");
	});
});
