import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionsStore } from "@mariozechner/pi-web-ui/storage/stores/sessions-store.js";
import type { SessionData } from "@mariozechner/pi-web-ui/storage/types.js";

/**
 * Extended SessionsStore that migrates old tool result messages from output to content format.
 */
export class ShuvgeistSessionsStore extends SessionsStore {
	async loadSession(id: string): Promise<SessionData | null> {
		const session = await super.loadSession(id);
		if (session) {
			return this.migrateSession(session);
		}
		return session;
	}

	async get(id: string): Promise<SessionData | null> {
		const session = await super.get(id);
		if (session) {
			return this.migrateSession(session);
		}
		return session;
	}

	private migrateSession(session: SessionData): SessionData {
		return {
			...session,
			messages: this.migrateToolResultMessages(session.messages),
		};
	}

	private migrateToolResultMessages(messages: AgentMessage[]): AgentMessage[] {
		return messages.map((msg) => {
			if (msg.role === "toolResult" && "output" in msg && !msg.content) {
				// Old format detected - migrate it
				const { output, ...rest } = msg as any;
				return {
					...rest,
					content: [{ type: "text", text: output }],
				};
			}
			return msg;
		});
	}
}
