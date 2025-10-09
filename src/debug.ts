import { Button, icon } from "@mariozechner/mini-lit";
import { html, render } from "lit";
import { ArrowLeft } from "lucide";

const renderDebugPage = () => {
	const debugHtml = html`
		<div class="w-full h-full flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
				${Button({
					variant: "ghost",
					size: "sm",
					children: icon(ArrowLeft, "sm"),
					onClick: () => {
						window.location.href = "./sidepanel.html";
					},
					title: "Back to chat",
				})}
				<span class="text-sm font-semibold">Debug</span>
			</div>

			<!-- Debug content -->
			<div class="flex-1 overflow-auto p-4">
				<p class="text-muted-foreground">Debug page - empty for now</p>
			</div>
		</div>
	`;

	render(debugHtml, document.body);
};

// Keyboard shortcut to go back
window.addEventListener("keydown", (e) => {
	if ((e.metaKey || e.ctrlKey) && e.key === "u") {
		e.preventDefault();
		window.location.href = "./sidepanel.html";
	}
});

renderDebugPage();
