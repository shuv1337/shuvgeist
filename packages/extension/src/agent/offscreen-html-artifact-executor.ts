import { SandboxIframe } from "@shuv1337/pi-web-ui/components/SandboxedIframe.js";
import type {
	OffscreenArtifactLog,
	OffscreenHtmlArtifactExecutionRequest,
	OffscreenHtmlArtifactExecutionResult,
	OffscreenHtmlArtifactExecutor,
} from "./offscreen-tool-environment.js";

function withCompletionSignal(html: string): string {
	const completion = "<script>if (window.complete) window.complete();</script>";
	return html.includes("</html>") ? html.replace("</html>", `${completion}</html>`) : `${html}${completion}`;
}

function normalizeLogs(
	logs: readonly { type: string; text: string }[],
	error?: { message: string; stack: string },
): OffscreenArtifactLog[] {
	const normalized = logs.map((log): OffscreenArtifactLog => {
		const type = log.type === "error" || log.type === "warn" || log.type === "info" ? log.type : "log";
		return { type, text: log.text };
	});
	if (error && !normalized.some((log) => log.type === "error" && log.text === error.message)) {
		normalized.push({ type: "error", text: error.message });
	}
	return normalized;
}

/** Executes HTML artifacts in the persistent offscreen document, independent of panel rendering. */
export class SandboxOffscreenHtmlArtifactExecutor implements OffscreenHtmlArtifactExecutor {
	private sequence = 0;

	async execute(request: OffscreenHtmlArtifactExecutionRequest): Promise<OffscreenHtmlArtifactExecutionResult> {
		if (request.signal.aborted) {
			const error = new Error("HTML artifact execution was aborted");
			error.name = "AbortError";
			throw error;
		}
		const sandbox = new SandboxIframe();
		sandbox.style.display = "none";
		if (request.sandboxUrlProvider) sandbox.sandboxUrlProvider = request.sandboxUrlProvider;
		document.body.append(sandbox);
		const sandboxId = `offscreen-artifact-${request.windowId}-${request.sessionId}-${this.sequence++}`;
		try {
			const result = await sandbox.execute(
				sandboxId,
				withCompletionSignal(request.artifact.content),
				request.providers,
				[],
				request.signal,
				true,
			);
			return { logs: normalizeLogs(result.console, result.success ? undefined : result.error) };
		} finally {
			sandbox.remove();
		}
	}
}
