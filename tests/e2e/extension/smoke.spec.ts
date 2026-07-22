import { expect, test } from "@playwright/test";
import { sidepanelDocumentNonce } from "@shuvgeist/extension/agent/sidepanel-context-identity";
import {
	enableExtensionUserScripts,
	launchExtensionContext,
	openRealExtensionSidePanel,
	waitForExtensionSidePanelRuntime,
} from "../fixtures/extension.js";

test.describe("extension smoke", () => {
	test("service worker and sidepanel boot", async () => {
		const extension = await launchExtensionContext();
		try {
			expect(extension.serviceWorker.url()).toContain(extension.extensionId);
			const worker = await enableExtensionUserScripts(extension.context, extension.extensionId);
			const opened = await openRealExtensionSidePanel(extension.context, extension.extensionId, worker);
			const panelUrl = new URL(opened.panel.documentUrl);
			expect(opened.panel.contextId).not.toBe("");
			expect(opened.panel.documentId).not.toBe("");
			expect(opened.panel.documentOrigin).toBe(`chrome-extension://${extension.extensionId}`);
			expect(panelUrl.protocol).toBe("chrome-extension:");
			expect(panelUrl.host).toBe(extension.extensionId);
			expect(panelUrl.pathname).toBe("/sidepanel.html");
			expect(sidepanelDocumentNonce(panelUrl.href)).toBeDefined();
			expect(opened.descriptor).toMatchObject({
				clientId: "sidepanel",
				windowId: opened.windowId,
				target: { kind: "chrome-tab", tabRef: `window:${opened.windowId}` },
			});
			const runtime = await waitForExtensionSidePanelRuntime(
				extension.context,
				opened.panel,
				opened.descriptor.sessionId,
			);
			expect(runtime).toEqual({
				artifactsListed: true,
				readyState: "complete",
				sessionId: opened.descriptor.sessionId,
				title: "Shuvgeist",
			});
		} finally {
			await extension.close();
		}
	});
});
