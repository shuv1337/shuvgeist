import type { HandoffOverlayCommand } from "./handoff-runtime.js";
import { runHandoffOverlay } from "./handoff-runtime.js";

export function run(command: HandoffOverlayCommand): { installed: boolean } {
	return runHandoffOverlay(command);
}
