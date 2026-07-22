import type { AgentMessage } from "@shuv1337/pi-agent-core";
import type { AgentInterface, MessageRenderer } from "@shuv1337/pi-web-ui";
import { registerMessageRenderer } from "@shuv1337/pi-web-ui";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import "../components/OrbAnimation.js";

export interface TutorialPrompt {
	label: string;
	prompt: string;
}

export interface WelcomeMessage {
	role: "welcome";
	tutorials: TutorialPrompt[];
}

declare module "@shuv1337/pi-agent-core" {
	interface CustomAgentMessages {
		welcome: WelcomeMessage;
	}
}

@customElement("welcome-message")
export class WelcomeMessageElement extends LitElement {
	@property({ type: Array }) tutorials!: TutorialPrompt[];
	@property({ attribute: false }) agentInterface!: AgentInterface;

	private taglineWords = ["automate", "write", "transform", "research", "scrape", "create"];
	private currentWordIndex = 0;
	private intervalId?: number;

	protected createRenderRoot() {
		return this;
	}

	override connectedCallback() {
		super.connectedCallback();
		// Rotate tagline word every 2 seconds
		this.intervalId = window.setInterval(() => {
			this.currentWordIndex = (this.currentWordIndex + 1) % this.taglineWords.length;
			this.requestUpdate();
		}, 2000);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		if (this.intervalId) {
			clearInterval(this.intervalId);
		}
	}

	private async selectTutorial(prompt: string) {
		// The authoritative remote transcript hides this renderer as soon as the
		// prompt adds a user/assistant message. Never mutate a local Agent clone.
		await this.agentInterface.sendMessage(prompt);
	}

	override render(): TemplateResult {
		return html`
			<div class="welcome-orb-container my-8 flex flex-col items-center justify-center">
				<!-- Title and tagline first -->
				<div class="text-center mb-8">
					<h1 class="welcome-brand-title text-5xl font-bold mb-4">Shuvgeist</h1>
					<p class="text-xl text-muted-foreground">
						Your clanker for the web to
						<span
							class="rotating-word inline-block min-w-[120px] text-left font-semibold text-foreground"
							key=${this.currentWordIndex}
							>${this.taglineWords[this.currentWordIndex]}</span
						>
					</p>
				</div>

				<!-- Three.js Orb Animation -->
				<div class="flex items-center justify-center -my-8 mb-4">
					<orb-animation></orb-animation>
				</div>

				<!-- Tutorial pills -->
				<div class="flex flex-wrap gap-3 justify-center max-w-lg px-6 mt-4">
					${this.tutorials.map(
						(tutorial, index) => html`
							<button
								class="tutorial-pill px-6 py-3 text-sm font-medium text-foreground rounded-full cursor-pointer"
								@click=${() => this.selectTutorial(tutorial.prompt)}
								style="animation-delay: ${index * 0.1}s;"
							>
								${tutorial.label}
							</button>
						`,
					)}
				</div>
			</div>
		`;
	}
}

export function createWelcomeRenderer(
	getMessages: () => readonly AgentMessage[],
	agentInterface: AgentInterface,
): MessageRenderer<WelcomeMessage> {
	return {
		render: (message) => {
			// Only show if no conversation started yet
			const hasConversation = getMessages().some((m) => m.role === "user" || m.role === "assistant");

			if (hasConversation) return html``;

			return html`<welcome-message
				.tutorials=${message.tutorials}
				.agentInterface=${agentInterface}
			></welcome-message>`;
		},
	};
}

export function registerWelcomeRenderer(getMessages: () => readonly AgentMessage[], agentInterface: AgentInterface) {
	registerMessageRenderer("welcome", createWelcomeRenderer(getMessages, agentInterface));
}

export function createWelcomeMessage(tutorials: TutorialPrompt[]): WelcomeMessage {
	return { role: "welcome", tutorials };
}
