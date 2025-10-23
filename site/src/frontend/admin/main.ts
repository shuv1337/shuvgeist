import { SidebarItem } from "@mariozechner/mini-lit/dist/Sidebar.js";
import type { Commands, Route } from "@vaadin/router";
import { Router } from "@vaadin/router";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import "@mariozechner/mini-lit/dist/Sidebar.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Dialog } from "@mariozechner/mini-lit/dist/Dialog.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, render } from "lit";
import { createApiClient } from "../api-client.js";

// Import pages
import "./pages/signups.js";

const api = createApiClient("/api");

// Show setup dialog
async function showSetupDialog(): Promise<void> {
	return new Promise((resolve) => {
		let password = "";
		let error = "";
		let loading = false;

		const renderDialog = () => {
			const dialogContent = Dialog({
				isOpen: true,
				onClose: () => {}, // Prevent closing
				width: "400px",
				children: html`
          <div class="p-6 space-y-4">
            <div class="space-y-2">
              <h2 class="text-xl font-bold">Setup Sitegeist Admin</h2>
              <p class="text-sm text-muted-foreground">
                Welcome! Please set a password to secure the admin panel.
              </p>
            </div>

            ${Input({
					type: "password",
					label: "Password",
					placeholder: "Enter password",
					value: password,
					error: error,
					disabled: loading,
					onInput: (e: Event) => {
						password = (e.target as HTMLInputElement).value;
						error = "";
						renderDialog();
					},
					onKeyDown: (e: KeyboardEvent) => {
						if (e.key === "Enter" && password.trim()) {
							handleSetup();
						}
					},
				})}

            ${Button({
					variant: "default",
					className: "w-full",
					disabled: loading || !password.trim(),
					loading: loading,
					children: loading ? "Setting up..." : "Setup",
					onClick: handleSetup,
				})}
          </div>
        `,
			});

			render(dialogContent, document.body);
		};

		const handleSetup = async () => {
			if (!password.trim()) {
				error = "Password cannot be empty";
				renderDialog();
				return;
			}

			loading = true;
			renderDialog();

			try {
				await api.setup({ password });
				// Cookie is set automatically by server
				// Clear dialog
				render(html``, document.body);
				resolve();
			} catch (err) {
				loading = false;
				error = (err as Error).message;
				renderDialog();
			}
		};

		renderDialog();
	});
}

// Show login dialog
async function showLoginDialog(): Promise<void> {
	return new Promise((resolve) => {
		let password = "";
		let error = "";
		let loading = false;

		const renderDialog = () => {
			const dialogContent = Dialog({
				isOpen: true,
				onClose: () => {}, // Prevent closing
				width: "400px",
				children: html`
          <div class="p-6 space-y-4">
            <div class="space-y-2">
              <h2 class="text-xl font-bold">Login to Sitegeist Admin</h2>
              <p class="text-sm text-muted-foreground">Enter your password to continue.</p>
            </div>

            ${Input({
					type: "password",
					label: "Password",
					placeholder: "Enter password",
					value: password,
					error: error,
					disabled: loading,
					onInput: (e: Event) => {
						password = (e.target as HTMLInputElement).value;
						error = "";
						renderDialog();
					},
					onKeyDown: (e: KeyboardEvent) => {
						if (e.key === "Enter" && password.trim()) {
							handleLogin();
						}
					},
				})}

            ${Button({
					variant: "default",
					className: "w-full",
					disabled: loading || !password.trim(),
					loading: loading,
					children: loading ? "Logging in..." : "Login",
					onClick: handleLogin,
				})}
          </div>
        `,
			});

			render(dialogContent, document.body);
		};

		const handleLogin = async () => {
			if (!password.trim()) {
				error = "Password cannot be empty";
				renderDialog();
				return;
			}

			loading = true;
			renderDialog();

			try {
				await api.login({ password });
				// Cookie is set automatically by server
				// Clear dialog
				render(html``, document.body);
				resolve();
			} catch (err) {
				loading = false;
				error = (err as Error).message;
				renderDialog();
			}
		};

		renderDialog();
	});
}

// Auth guard - check before every route
async function authGuard(context: { pathname: string }, commands: Commands) {
	console.log("[Auth Guard] Starting auth check for:", context.pathname);

	// Hide sidebar during auth
	const sidebar = document.querySelector("mini-sidebar") as HTMLElement;
	if (sidebar) sidebar.style.display = "none";

	// Check if setup is needed
	const status = await api.status();
	console.log("[Auth Guard] Status:", status);

	if (status.setupRequired) {
		console.log("[Auth Guard] Setup required, showing setup dialog");
		// Show setup dialog
		await showSetupDialog();
		console.log("[Auth Guard] Setup complete, redirecting to:", context.pathname);
		// Show sidebar after auth
		if (sidebar) sidebar.style.display = "";
		return commands.redirect(context.pathname);
	}

	// Check if we have a valid auth cookie by trying to access a protected endpoint
	try {
		console.log("[Auth Guard] Checking auth cookie...");
		await api.listSignups(); // Protected endpoint - will fail if no valid cookie
		console.log("[Auth Guard] Auth cookie valid, continuing to route");
	} catch (err) {
		console.log("[Auth Guard] No valid cookie, showing login dialog:", err);
		// No valid cookie, show login dialog
		await showLoginDialog();
		console.log("[Auth Guard] Login complete, redirecting to:", context.pathname);
		// Show sidebar after auth
		if (sidebar) sidebar.style.display = "";
		return commands.redirect(context.pathname);
	}

	// Show sidebar after auth
	if (sidebar) sidebar.style.display = "";
	console.log("[Auth Guard] Auth check complete, allowing route");
	return undefined; // Continue to route
}

// Setup router
const outlet = document.getElementById("outlet");
if (!outlet) {
	throw new Error("Outlet element not found");
}

const router = new Router(outlet);

const routes: Route[] = [
	{
		path: "/admin",
		action: authGuard,
		component: "page-signups",
	},
	{
		path: "/admin/(.*)",
		action: async (context, commands) => {
			await authGuard(context, commands);
			return commands.redirect("/admin");
		},
	},
];

router.setRoutes(routes);

// Setup sidebar
const sidebarContent = html`
	${SidebarItem({ href: "/admin", children: "Signups" })}
`;

const sidebarLogo = html` <h1 class="text-xl font-bold">Sitegeist</h1> `;

const sidebar = document.querySelector("mini-sidebar") as HTMLElement & {
	logo: unknown;
	content: unknown;
	breakpoint: string;
};
if (sidebar) {
	sidebar.logo = sidebarLogo;
	sidebar.content = sidebarContent;
	sidebar.breakpoint = "md";
}
