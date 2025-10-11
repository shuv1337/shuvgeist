import {
	DialogBase,
	DialogContent,
	DialogHeader,
	html,
	i18n,
} from "@mariozechner/mini-lit";
import { type SessionMetadata, formatUsage } from "@mariozechner/pi-web-ui";
import { customElement, state } from "lit/decorators.js";
import { getAppStorage } from "@mariozechner/pi-web-ui";
import { getPort } from "../sidepanel.js";

// Cross-browser API compatibility
// @ts-expect-error - browser global exists in Firefox, chrome in Chrome
const browserAPI = globalThis.browser || globalThis.chrome;

@customElement("sitegeist-session-list-dialog")
export class SitegeistSessionListDialog extends DialogBase {
	@state() private sessions: SessionMetadata[] = [];
	@state() private loading = true;
	@state() private sessionLocks: Record<string, number> = {}; // sessionId -> windowId
	@state() private currentWindowId: number | undefined;

	private onSelectCallback?: (sessionId: string) => void;
	private onDeleteCallback?: (sessionId: string) => void;
	private deletedSessions = new Set<string>();
	private closedViaSelection = false;

	protected modalWidth = "min(600px, 90vw)";
	protected modalHeight = "min(700px, 90vh)";

	static async open(
		onSelect: (sessionId: string) => void,
		onDelete?: (sessionId: string) => void,
	) {
		const dialog = new SitegeistSessionListDialog();
		dialog.onSelectCallback = onSelect;
		dialog.onDeleteCallback = onDelete;
		dialog.open();
		await dialog.loadSessionsAndLocks();
	}

	private async loadSessionsAndLocks() {
		this.loading = true;
		try {
			// Get current window ID
			const currentWindow = await browserAPI.windows.getCurrent();
			this.currentWindowId = currentWindow.id;

			// Load sessions (already sorted by lastModified index)
			const storage = getAppStorage();
			this.sessions = await storage.sessions.getAllMetadata();

			// Get lock information from background via port
			const port = getPort();
			const lockResponse = await new Promise<{ locks: Record<string, number> }>((resolve) => {
				const listener = (msg: any) => {
					if (msg.type === "lockedSessions") {
						port.onMessage.removeListener(listener);
						resolve(msg);
					}
				};
				port.onMessage.addListener(listener);
				port.postMessage({ type: "getLockedSessions" });
			});
			this.sessionLocks = lockResponse?.locks || {};
		} catch (err) {
			console.error("Failed to load sessions:", err);
			this.sessions = [];
			this.sessionLocks = {};
		} finally {
			this.loading = false;
		}
	}

	private async handleDelete(sessionId: string, event: Event) {
		event.stopPropagation();

		if (!confirm(i18n("Delete this session?"))) {
			return;
		}

		try {
			const storage = getAppStorage();
			if (!storage.sessions) return;

			await storage.sessions.deleteSession(sessionId);
			await this.loadSessionsAndLocks();

			// Track deleted session
			this.deletedSessions.add(sessionId);
		} catch (err) {
			console.error("Failed to delete session:", err);
		}
	}

	override close() {
		super.close();

		// Only notify about deleted sessions if dialog wasn't closed via selection
		if (
			!this.closedViaSelection &&
			this.onDeleteCallback &&
			this.deletedSessions.size > 0
		) {
			for (const sessionId of this.deletedSessions) {
				this.onDeleteCallback(sessionId);
			}
		}
	}

	private handleSelect(sessionId: string) {
		this.closedViaSelection = true;
		if (this.onSelectCallback) {
			this.onSelectCallback(sessionId);
		}
		this.close();
	}

	private formatDate(isoString: string): string {
		const date = new Date(isoString);
		const now = new Date();
		const diff = now.getTime() - date.getTime();
		const days = Math.floor(diff / (1000 * 60 * 60 * 24));

		if (days === 0) {
			return i18n("Today");
		}
		if (days === 1) {
			return i18n("Yesterday");
		}
		if (days < 7) {
			return i18n("{days} days ago").replace("{days}", days.toString());
		}
		return date.toLocaleDateString();
	}

	private isSessionLocked(sessionId: string): boolean {
		const lockWindowId = this.sessionLocks[sessionId];
		return (
			lockWindowId !== undefined && lockWindowId !== this.currentWindowId
		);
	}

	private isCurrentSession(sessionId: string): boolean {
		const lockWindowId = this.sessionLocks[sessionId];
		return (
			lockWindowId !== undefined && lockWindowId === this.currentWindowId
		);
	}

	protected override renderContent() {
		return html`
			${DialogContent({
				className: "h-full flex flex-col",
				children: html`
					${DialogHeader({
						title: i18n("Sessions"),
						description: i18n("Load a previous conversation"),
					})}

					<div class="flex-1 overflow-y-auto mt-4 space-y-2">
						${
							this.loading
								? html`<div class="text-center py-8 text-muted-foreground">${i18n("Loading...")}</div>`
								: this.sessions.length === 0
									? html`<div class="text-center py-8 text-muted-foreground">${i18n("No sessions yet")}</div>`
									: this.sessions.map((session) => {
											const isLocked = this.isSessionLocked(session.id);
											const isCurrent = this.isCurrentSession(session.id);
											return html`
											<div
												class="group flex items-start gap-3 p-3 rounded-lg border border-border ${
													isLocked
														? "opacity-50 cursor-not-allowed"
														: "hover:bg-secondary/50 cursor-pointer"
												} ${isCurrent ? "bg-secondary/30" : ""} transition-colors"
												@click=${() => !isLocked && this.handleSelect(session.id)}
											>
												<div class="flex-1 min-w-0">
													<div class="flex items-center gap-2">
														<div class="font-medium text-sm text-foreground truncate">${session.title}</div>
														${
															isCurrent
																? html`<span class="px-1.5 py-0.5 text-xs rounded bg-primary/20 text-primary font-medium">
																	${i18n("Current")}
																</span>`
																: isLocked
																	? html`<span class="px-1.5 py-0.5 text-xs rounded bg-destructive/20 text-destructive font-medium">
																		${i18n("Locked")}
																	</span>`
																	: ""
														}
													</div>
													<div class="text-xs text-muted-foreground mt-1">${this.formatDate(session.lastModified)}</div>
													<div class="text-xs text-muted-foreground mt-1">
														${session.messageCount} ${i18n("messages")} · ${formatUsage(session.usage)}
													</div>
												</div>
												<button
													class="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 text-destructive transition-opacity"
													@click=${(e: Event) => this.handleDelete(session.id, e)}
													title=${i18n("Delete")}
												>
													<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
														<path d="M3 6h18"></path>
														<path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
														<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
													</svg>
												</button>
											</div>
										`;
										})
						}
					</div>
				`,
			})}
		`;
	}
}
