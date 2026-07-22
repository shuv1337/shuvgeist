import type { ReplOverlayCommand } from "@shuvgeist/driver/injected-contracts";
import { removeReplOverlay, showReplOverlay } from "../tools/repl/overlay-content.js";

export function run(command: ReplOverlayCommand): void {
	if (command.action === "show") {
		showReplOverlay(command.taskName, command.abortIntent);
		return;
	}
	removeReplOverlay();
}
