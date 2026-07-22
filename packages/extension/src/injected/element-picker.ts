import type { ElementInfo, ElementPickerCommand } from "@shuvgeist/driver/injected-contracts";
import { createElementPickerOverlay } from "./element-picker-runtime.js";

export async function run(command: ElementPickerCommand): Promise<ElementInfo | null | undefined> {
	if (command.action === "cancel") {
		window.dispatchEvent(new CustomEvent("shuvgeist-element-cancel"));
		return;
	}
	return createElementPickerOverlay(command.message);
}
