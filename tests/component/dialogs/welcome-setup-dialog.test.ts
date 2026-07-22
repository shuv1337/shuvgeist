import { WelcomeSetupDialog } from "@shuvgeist/extension/dialogs/WelcomeSetupDialog";

describe("WelcomeSetupDialog", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("renders welcome copy and resolves when the free-tier button is clicked", async () => {
		const promise = WelcomeSetupDialog.show();
		await Promise.resolve();
		const dialog = document.querySelector("welcome-setup-dialog") as WelcomeSetupDialog;
		await dialog.updateComplete;
		expect(dialog).toBeTruthy();
		expect(dialog.textContent).toContain("Welcome to Shuvgeist");
		expect(dialog.textContent).toContain("bundled free tier");

		const button = Array.from(dialog.querySelectorAll("button")).find((element) =>
			element.textContent?.includes("Use free tier"),
		) as HTMLButtonElement;
		button.click();
		await expect(promise).resolves.toBe("free-tier");
		expect(document.querySelector("welcome-setup-dialog")).toBeNull();
	});

	it("resolves subscription-settings when the subscription button is clicked", async () => {
		const promise = WelcomeSetupDialog.show();
		await Promise.resolve();
		const dialog = document.querySelector("welcome-setup-dialog") as WelcomeSetupDialog;
		await dialog.updateComplete;

		const button = Array.from(dialog.querySelectorAll("button")).find((element) =>
			element.textContent?.includes("Log in with subscription"),
		) as HTMLButtonElement;
		button.click();
		await expect(promise).resolves.toBe("subscription-settings");
		expect(document.querySelector("welcome-setup-dialog")).toBeNull();
	});

	it("resolves provider-settings when the API-key button is clicked", async () => {
		const promise = WelcomeSetupDialog.show();
		await Promise.resolve();
		const dialog = document.querySelector("welcome-setup-dialog") as WelcomeSetupDialog;
		await dialog.updateComplete;

		const button = Array.from(dialog.querySelectorAll("button")).find((element) =>
			element.textContent?.includes("Bring API key"),
		) as HTMLButtonElement;
		button.click();
		await expect(promise).resolves.toBe("provider-settings");
		expect(document.querySelector("welcome-setup-dialog")).toBeNull();
	});
});
