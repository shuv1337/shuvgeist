import { UserScriptsPermissionDialog } from "../../../src/dialogs/UserScriptsPermissionDialog.js";

const requestUserScriptsPermission = vi.fn();

vi.mock("../../../src/tools/repl/userscripts-helpers.js", () => ({
	requestUserScriptsPermission: () => requestUserScriptsPermission(),
}));

describe("UserScriptsPermissionDialog", () => {
	beforeEach(() => {
		requestUserScriptsPermission.mockReset();
		document.body.innerHTML = "";
	});

	it("renders copy and resolves false when dismissed", async () => {
		const promise = UserScriptsPermissionDialog.request();
		await Promise.resolve();
		const dialog = document.querySelector("userscripts-permission-dialog") as UserScriptsPermissionDialog;
		await dialog.updateComplete;
		expect(dialog).toBeTruthy();
		expect(dialog.textContent).toContain("JavaScript Execution Permission Required");
		expect(dialog.textContent).toContain("Why is this needed?");
		expect(dialog.textContent).toContain("Continue Anyway");

		(dialog.querySelector("button") as HTMLButtonElement).click();
		await expect(promise).resolves.toBe(false);
	});

	it("shows failure details and resolves true when permission is granted", async () => {
		requestUserScriptsPermission
			.mockResolvedValueOnce({ granted: false, message: "Need browser permission" })
			.mockResolvedValueOnce({ granted: true });

		const promise = UserScriptsPermissionDialog.request();
		await Promise.resolve();
		const dialog = document.querySelector("userscripts-permission-dialog") as UserScriptsPermissionDialog;
		await dialog.updateComplete;
		const buttons = dialog.querySelectorAll("button");
		const grantButton = buttons[1] as HTMLButtonElement;

		grantButton.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(dialog.textContent).toContain("Need browser permission");
		expect(dialog.textContent).toContain("Grant Permission");

		grantButton.click();
		await expect(promise).resolves.toBe(true);
	});
});
