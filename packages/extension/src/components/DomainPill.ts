import { html, type TemplateResult } from "lit";
import { getFaviconUrl } from "../utils/favicon.js";

export function DomainPill(domain: string): TemplateResult {
	return html`
		<div class="inline-flex items-center gap-2 px-2 py-1 text-xs bg-muted/50 border border-border rounded">
			<img src=${getFaviconUrl(domain, 16)} width="16" height="16" alt="" />
			<code class="text-muted-foreground">${domain}</code>
		</div>
	`;
}
