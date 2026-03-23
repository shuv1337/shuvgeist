import { Toast } from "../../../src/components/Toast.js";

describe("Toast", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		document.body.innerHTML = "";
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows success toast and auto-dismisses after the configured duration", async () => {
		const toast = Toast.success("Saved successfully", 1000);
		await toast.updateComplete;
		expect(document.body.contains(toast)).toBe(true);
		expect(toast.textContent).toContain("Saved successfully");

		vi.advanceTimersByTime(1000);
		expect(toast.isExiting).toBe(true);
		vi.advanceTimersByTime(300);
		expect(document.body.contains(toast)).toBe(false);
	});

	it("dismisses immediately when the close button is clicked", async () => {
		const toast = Toast.error("Something failed", 0);
		await toast.updateComplete;
		const closeButton = toast.querySelector("button") as HTMLButtonElement;
		closeButton.click();
		expect(toast.isExiting).toBe(true);
		vi.advanceTimersByTime(300);
		expect(document.body.contains(toast)).toBe(false);
	});
});
