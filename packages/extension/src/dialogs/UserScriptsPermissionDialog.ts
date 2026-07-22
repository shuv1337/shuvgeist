import { i18n } from "@mariozechner/mini-lit";
import { customElement } from "lit/decorators.js";
import { requestUserScriptsPermission } from "../tools/repl/userscripts-helpers.js";
import { PermissionDialog } from "./PermissionDialog.js";

@customElement("userscripts-permission-dialog")
export class UserScriptsPermissionDialog extends PermissionDialog {
	/**
	 * Request userScripts permission.
	 * Returns true if permission granted, false otherwise.
	 */
	static async request(): Promise<boolean> {
		const dialog = new UserScriptsPermissionDialog();
		return dialog.requestPermission(() => requestUserScriptsPermission());
	}

	protected header() {
		return {
			title: i18n("JavaScript Execution Permission Required"),
			description: i18n("This extension needs permission to execute JavaScript code on web pages"),
		};
	}

	protected why(): string {
		return i18n(
			"The JavaScript REPL tool allows the AI to read and interact with web pages on your behalf. This requires the userScripts permission to execute code safely and securely.",
		);
	}

	protected what(): string[] {
		return [
			i18n("The AI can read and modify web page content when you ask it to"),
			i18n("Code runs in an isolated environment with security safeguards"),
			i18n("Network access is blocked to prevent data exfiltration"),
			i18n("You can revoke this permission at any time in browser settings"),
		];
	}
}
