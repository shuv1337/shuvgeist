import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { getAppStorage, SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Toast } from "../components/Toast.js";
import { getSampleTtsPhrase, listTtsVoices } from "../tts/service.js";
import {
	DEFAULT_KOKORO_VOICES,
	DEFAULT_TTS_SETTINGS,
	loadTtsSettings,
	normalizeTtsProvider,
	saveTtsSettings,
} from "../tts/settings.js";
import type { TtsSettingsSnapshot, TtsVoice } from "../tts/types.js";

@customElement("tts-tab")
export class TtsTab extends SettingsTab {
	@state() private loading = true;
	@state() private settings: TtsSettingsSnapshot = DEFAULT_TTS_SETTINGS;
	@state() private openaiKeyPresent = false;
	@state() private elevenLabsKeyPresent = false;
	@state() private voices: TtsVoice[] = DEFAULT_KOKORO_VOICES;
	@state() private voiceError = "";

	getTabName(): string {
		return "TTS";
	}

	override async connectedCallback() {
		super.connectedCallback();
		await this.reload();
	}

	private async reload() {
		const storage = getAppStorage();
		this.settings = await loadTtsSettings();
		this.openaiKeyPresent = Boolean(await storage.providerKeys.get("openai"));
		this.elevenLabsKeyPresent = Boolean(await storage.providerKeys.get("tts-elevenlabs"));
		await this.refreshVoices();
		this.loading = false;
		this.requestUpdate();
	}

	private async patchSettings(partial: Partial<TtsSettingsSnapshot>) {
		this.settings = await saveTtsSettings({
			...this.settings,
			...partial,
		});
		if (partial.provider || partial.kokoroBaseUrl || partial.kokoroModelId) {
			await this.refreshVoices();
		}
		this.requestUpdate();
	}

	private async refreshVoices() {
		try {
			const storage = getAppStorage();
			const openaiKey = await storage.providerKeys.get("openai");
			const elevenLabsKey = await storage.providerKeys.get("tts-elevenlabs");
			const kokoroKey = await storage.providerKeys.get("tts-kokoro");
			const voices = await listTtsVoices(this.settings.provider, this.settings, {
				openaiKey: typeof openaiKey === "string" ? openaiKey : undefined,
				elevenLabsKey: typeof elevenLabsKey === "string" ? elevenLabsKey : undefined,
				kokoroKey: typeof kokoroKey === "string" ? kokoroKey : undefined,
			});
			this.voices = voices.length > 0 ? voices : DEFAULT_KOKORO_VOICES;
			if (!this.voices.some((voice) => voice.id === this.settings.voiceId) && this.voices[0]) {
				const fallbackVoiceId = this.voices[0].id;
				this.settings = await saveTtsSettings({
					...this.settings,
					voiceId: fallbackVoiceId,
					...(this.settings.provider === "kokoro" ? { kokoroVoiceId: fallbackVoiceId } : {}),
					...(this.settings.provider === "openai" ? { openaiVoiceId: fallbackVoiceId } : {}),
					...(this.settings.provider === "elevenlabs" ? { elevenLabsVoiceId: fallbackVoiceId } : {}),
				});
			}
			this.voiceError = "";
		} catch (error) {
			this.voices = this.settings.provider === "kokoro" ? DEFAULT_KOKORO_VOICES : [];
			this.voiceError = error instanceof Error ? error.message : String(error);
		}
	}

	private async openOverlay() {
		const response = await chrome.runtime.sendMessage({
			type: "tts-open-overlay",
		});
		if (!response?.ok) {
			Toast.show(response?.error || "Failed to open TTS overlay", "error");
			return;
		}
		Toast.success("TTS overlay opened");
	}

	private async speakTestPhrase() {
		const response = await chrome.runtime.sendMessage({
			type: "tts-speak-test-phrase",
			text: getSampleTtsPhrase(),
		});
		if (!response?.ok) {
			Toast.show(response?.error || "Failed to speak test phrase", "error");
			return;
		}
		Toast.success("Playing test phrase");
	}

	private renderProviderKeyStatus(): TemplateResult {
		if (this.settings.provider === "openai") {
			return html`
				<div class="rounded-lg border border-border bg-muted/40 p-3 space-y-2">
					<div class="text-sm font-medium text-foreground">OpenAI key</div>
					<div class="text-xs text-muted-foreground">
						${
							this.openaiKeyPresent
								? 'Using the shared provider-keys["openai"] credential.'
								: "No shared OpenAI key found yet. Save it here so TTS and future OpenAI model usage share the same key."
						}
					</div>
					<provider-key-input provider="openai"></provider-key-input>
				</div>
			`;
		}
		if (this.settings.provider === "elevenlabs") {
			return html`
				<div class="rounded-lg border border-border bg-muted/40 p-3 space-y-2">
					<div class="text-sm font-medium text-foreground">ElevenLabs key</div>
					<div class="text-xs text-muted-foreground">
						${this.elevenLabsKeyPresent ? 'Configured via provider-keys["tts-elevenlabs"].' : "Required for ElevenLabs TTS."}
					</div>
					<provider-key-input provider="tts-elevenlabs"></provider-key-input>
				</div>
			`;
		}
		return html`
			<div class="rounded-lg border border-border bg-muted/40 p-3 space-y-2">
				<div class="text-sm font-medium text-foreground">Local Kokoro</div>
				<div class="text-xs text-muted-foreground">
					Kokoro uses the local OpenAI-compatible endpoint by default and does not require a key unless your local wrapper enforces auth.
				</div>
			</div>
		`;
	}

	render(): TemplateResult {
		if (this.loading) {
			return html`<div class="text-sm text-muted-foreground">Loading TTS settings…</div>`;
		}

		return html`
			<div class="flex flex-col gap-4">
				<div class="space-y-1">
					<h3 class="text-lg font-semibold text-foreground">Text to Speech</h3>
					<p class="text-sm text-muted-foreground">
						Open an on-page overlay, choose a provider, and optionally arm click-to-speak for the current tab.
					</p>
				</div>

				<label class="flex items-center gap-3 cursor-pointer">
					<input
						type="checkbox"
						class="w-4 h-4 rounded border-border accent-primary"
						.checked=${this.settings.enabled}
						@change=${(event: Event) => this.patchSettings({ enabled: (event.target as HTMLInputElement).checked })}
					/>
					<span class="text-sm font-medium text-foreground">Enable TTS</span>
				</label>

				<div class="grid gap-4 md:grid-cols-2">
					<div class="space-y-1">
						<label class="text-xs font-medium text-muted-foreground">Provider</label>
						<select
							class="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground"
							.value=${this.settings.provider}
							@change=${async (event: Event) => {
								const provider = normalizeTtsProvider((event.target as HTMLSelectElement).value);
								await this.patchSettings({
									provider,
									voiceId:
										provider === "kokoro"
											? this.settings.kokoroVoiceId
											: provider === "openai"
												? this.settings.openaiVoiceId
												: this.settings.elevenLabsVoiceId,
								});
							}}
						>
							<option value="kokoro">Kokoro</option>
							<option value="openai">OpenAI</option>
							<option value="elevenlabs">ElevenLabs</option>
						</select>
					</div>
					<div class="space-y-1">
						<label class="text-xs font-medium text-muted-foreground">Voice</label>
						<select
							class="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground"
							.value=${this.settings.voiceId}
							@change=${(event: Event) => this.patchSettings({ voiceId: (event.target as HTMLSelectElement).value })}
						>
							${this.voices.map(
								(voice) =>
									html`<option value=${voice.id} ?selected=${voice.id === this.settings.voiceId}>${voice.label}</option>`,
							)}
						</select>
						${this.voiceError ? html`<p class="text-xs text-red-400">${this.voiceError}</p>` : ""}
					</div>
				</div>

				<div class="grid gap-4 md:grid-cols-2">
					<div class="space-y-1">
						<label class="text-xs font-medium text-muted-foreground">Speed</label>
						<input
							type="number"
							min="0.25"
							max="4"
							step="0.05"
							class="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground"
							.value=${String(this.settings.speed)}
							@change=${(event: Event) =>
								this.patchSettings({ speed: Number((event.target as HTMLInputElement).value) || 1 })}
						/>
					</div>
					<label class="flex items-center gap-3 cursor-pointer">
						<input
							type="checkbox"
							class="w-4 h-4 rounded border-border accent-primary"
							.checked=${this.settings.clickModeDefault}
							@change=${(event: Event) =>
								this.patchSettings({ clickModeDefault: (event.target as HTMLInputElement).checked })}
						/>
						<span class="text-sm font-medium text-foreground">Arm click-to-speak by default</span>
					</label>
				</div>

				${
					this.settings.provider === "kokoro"
						? html`
						<div class="grid gap-4 md:grid-cols-2">
							<div class="space-y-1">
								<label class="text-xs font-medium text-muted-foreground">Kokoro base URL</label>
								<input
									type="text"
									class="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground"
									.value=${this.settings.kokoroBaseUrl}
									@change=${(event: Event) =>
										this.patchSettings({ kokoroBaseUrl: (event.target as HTMLInputElement).value })}
								/>
							</div>
							<div class="space-y-1">
								<label class="text-xs font-medium text-muted-foreground">Kokoro model</label>
								<input
									type="text"
									class="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground"
									.value=${this.settings.kokoroModelId}
									@change=${(event: Event) =>
										this.patchSettings({ kokoroModelId: (event.target as HTMLInputElement).value })}
								/>
							</div>
						</div>
					`
						: ""
				}

				${this.renderProviderKeyStatus()}

				<div class="flex flex-wrap gap-2">
					${Button({
						children: "Open overlay on current page",
						onClick: () => this.openOverlay(),
						disabled: !this.settings.enabled,
					})}
					${Button({
						children: "Speak test phrase",
						variant: "secondary",
						onClick: () => this.speakTestPhrase(),
						disabled: !this.settings.enabled,
					})}
					${Button({
						children: "Refresh voices",
						variant: "ghost",
						onClick: async () => {
							await this.refreshVoices();
							this.requestUpdate();
						},
					})}
				</div>
			</div>
		`;
	}
}
