import type { Attachment, MessageRenderer } from "@shuv1337/pi-web-ui";
import { registerMessageRenderer, type UserMessageWithAttachments } from "@shuv1337/pi-web-ui";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";

/**
 * Custom user message component for Shuvgeist with fancy pill styling.
 * Duplicates the web-ui UserMessage but with our custom styling.
 */
@customElement("shuvgeist-user-message")
export class ShuvgeistUserMessage extends LitElement {
	@property({ type: Object }) message!: UserMessageWithAttachments;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	override render() {
		const content =
			typeof this.message.content === "string"
				? this.message.content
				: (this.message.content.find((c) => c.type === "text") as { type: "text"; text: string } | undefined)
						?.text || "";

		return html`
			<div class="flex justify-start ml-4">
				<div class="user-message-container py-2 px-4 rounded-xl">
					<markdown-block .content=${content}></markdown-block>
					${
						this.message.attachments && this.message.attachments.length > 0
							? html`
								<div class="mt-3 flex flex-wrap gap-2">
									${this.message.attachments.map(
										(attachment: Attachment) =>
											html` <attachment-tile .attachment=${attachment}></attachment-tile> `,
									)}
								</div>
							`
							: ""
					}
				</div>
			</div>
		`;
	}
}

export function createUserMessageRenderer(): MessageRenderer<UserMessageWithAttachments> {
	return {
		render: (message) => {
			return html`<shuvgeist-user-message .message=${message}></shuvgeist-user-message>`;
		},
	};
}

export function registerUserMessageRenderer() {
	registerMessageRenderer("user", createUserMessageRenderer());
}
