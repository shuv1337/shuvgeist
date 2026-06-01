import { browserMessageTransformer } from "../../../src/messages/message-transformer.js";
import type { NavigationMessage } from "../../../src/messages/NavigationMessage.js";

describe("browserMessageTransformer", () => {
	it("serializes navigation snapshots into browser context text", async () => {
		const nav: NavigationMessage = {
			role: "navigation",
			url: "https://example.test/settings",
			title: "Settings",
			tabId: 7,
			skillsOutput: "No skills matched.",
			snapshot: {
				tabId: 7,
				frameId: 0,
				url: "https://example.test/settings",
				title: "Settings",
				generatedAt: 123,
				totalCandidates: 2,
				truncated: false,
				entries: [
					{
						snapshotId: "e1",
						stableElementId: "button-save",
						tabId: 7,
						frameId: 0,
						tagName: "button",
						role: "button",
						name: "Save",
						text: "Save",
						label: "Save changes",
						attributes: { id: "save" },
						selectorCandidates: ["#save", "button:nth-of-type(1)"],
						ordinalPath: [0],
						boundingBox: { x: 10, y: 20, width: 80, height: 30 },
						interactive: true,
					},
				],
			},
		};

		const [message] = await browserMessageTransformer([nav]);

		expect(message.role).toBe("user");
		expect(message.content).toContain('<page-snapshot tab-id="7" frame-id="0"');
		expect(message.content).toContain('returned="1"');
		expect(message.content).toContain(
			'ref=e1 stable=button-save role=button tag=button interactive=true bbox=10,20,80x30 name="Save"',
		);
		expect(message.content).toContain("<skills>\nNo skills matched.\n</skills>");
	});
});
