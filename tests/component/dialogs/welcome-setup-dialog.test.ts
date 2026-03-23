import { WelcomeSetupDialog } from "../../../src/dialogs/WelcomeSetupDialog.js";

describe("WelcomeSetupDialog", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("renders welcome copy and resolves when the provider setup button is clicked", async () => {
		const promise = WelcomeSetupDialog.show();
		await Promise.resolve();
		const dialog = document.querySelector("welcome-setup-dialog") as WelcomeSetupDialog;
		await dialog.updateComplete;
		expect(dialog).toBeTruthy();
		expect(dialog.textContent).toContain("Welcome to Shuvgeist");
		expect(dialog.textContent).toContain("connect at least one AI provider");

		const button = Array.from(dialog.querySelectorAll("button")).find((element) =>
			element.textContent?.includes("Set up provider"),
		) as HTMLButtonElement;
		button.click();
		await expect(promise).resolves.toBeUndefined();
		expect(document.querySelector("welcome-setup-dialog")).toBeNull();
	});
});
