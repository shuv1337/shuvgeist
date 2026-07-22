import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import type { AgentMessage } from "@shuv1337/pi-agent-core";
import type { AssistantMessage } from "@shuv1337/pi-ai";
import { Chart, type ChartConfiguration, registerables } from "chart.js";
import type { PropertyValues } from "lit";
import { html } from "lit";
import { DollarSign } from "lucide";

// Register Chart.js components
Chart.register(...registerables);

interface CostEntry {
	messageIndex: number;
	timestamp: number;
	timeDelta?: number; // Time since last assistant message in seconds
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	inputCost: number;
	outputCost: number;
	cacheReadCost: number;
	cacheWriteCost: number;
	totalCost: number;
	stopReason: string;
	errorMessage?: string;
	provider: string;
	model: string;
}

export class SessionCostDialog extends DialogBase {
	private messages: AgentMessage[] = [];
	private costEntries: CostEntry[] = [];
	private chart?: Chart;
	private static currentDialog?: SessionCostDialog;

	protected modalWidth = "min(1200px, 95vw)";
	protected modalHeight = "90vh";

	/**
	 * Open dialog to view session cost details.
	 * Creates dialog instance and appends to body.
	 */
	static open(messages: AgentMessage[]) {
		// If a dialog is already open, just return
		if (SessionCostDialog.currentDialog) {
			return;
		}

		const dialog = new SessionCostDialog();
		dialog.messages = messages;
		dialog.processCostData();
		dialog.open();
		dialog.requestUpdate();
		// Set static reference AFTER dialog is opened to avoid race condition with disconnectedCallback
		SessionCostDialog.currentDialog = dialog;
	}

	private processCostData() {
		let messageIndex = 0;
		const entries: CostEntry[] = [];
		let lastTimestamp: number | undefined;

		for (const msg of this.messages) {
			messageIndex++;

			// Only process assistant messages (they have usage/cost data)
			if (msg.role !== "assistant") continue;

			const assistantMsg = msg as AssistantMessage;

			// Calculate time delta from last assistant message
			const timeDelta = lastTimestamp ? (assistantMsg.timestamp - lastTimestamp) / 1000 : undefined;
			lastTimestamp = assistantMsg.timestamp;

			entries.push({
				messageIndex,
				timestamp: assistantMsg.timestamp,
				timeDelta,
				inputTokens: assistantMsg.usage.input,
				outputTokens: assistantMsg.usage.output,
				cacheReadTokens: assistantMsg.usage.cacheRead,
				cacheWriteTokens: assistantMsg.usage.cacheWrite,
				inputCost: assistantMsg.usage.cost.input,
				outputCost: assistantMsg.usage.cost.output,
				cacheReadCost: assistantMsg.usage.cost.cacheRead,
				cacheWriteCost: assistantMsg.usage.cost.cacheWrite,
				totalCost: assistantMsg.usage.cost.total,
				stopReason: assistantMsg.stopReason,
				errorMessage: assistantMsg.errorMessage,
				provider: assistantMsg.provider,
				model: assistantMsg.model,
			});
		}

		this.costEntries = entries;
	}

	protected override updated(_changedProperties: PropertyValues): void {
		super.updated?.(_changedProperties);

		// Render chart after DOM update
		if (!this.chart && this.costEntries.length > 0) {
			this.renderChart();
		}
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		// Clean up chart
		if (this.chart) {
			this.chart.destroy();
		}
		// Clear the static reference when dialog is closed
		if (SessionCostDialog.currentDialog === this) {
			SessionCostDialog.currentDialog = undefined;
		}
	}

	private renderChart() {
		const canvas = this.querySelector("#cost-chart") as HTMLCanvasElement | null;
		if (!canvas) return;

		// Get CSS variable colors for theming
		const styles = getComputedStyle(document.documentElement);
		const textColor = styles.getPropertyValue("--color-foreground").trim();
		const gridColor = styles.getPropertyValue("--color-border").trim();

		const config: ChartConfiguration = {
			type: "bar",
			data: {
				labels: this.costEntries.map((entry) => `#${entry.messageIndex}`),
				datasets: [
					{
						label: "Input Cost",
						data: this.costEntries.map((entry) => entry.inputCost),
						backgroundColor: "rgb(99, 102, 241)", // indigo
					},
					{
						label: "Output Cost",
						data: this.costEntries.map((entry) => entry.outputCost),
						backgroundColor: "rgb(34, 197, 94)", // green
					},
					{
						label: "Cache Read Cost",
						data: this.costEntries.map((entry) => entry.cacheReadCost),
						backgroundColor: "rgb(251, 146, 60)", // orange
					},
					{
						label: "Cache Write Cost",
						data: this.costEntries.map((entry) => entry.cacheWriteCost),
						backgroundColor: "rgb(168, 85, 247)", // purple
					},
				],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				interaction: {
					mode: "index",
					intersect: false,
				},
				plugins: {
					legend: {
						display: true,
						position: "bottom",
						labels: {
							color: textColor,
						},
					},
					tooltip: {
						callbacks: {
							label: (context) => {
								const label = context.dataset.label || "";
								const value = context.parsed.y;
								return `${label}: $${value?.toFixed(6) || 0}`;
							},
						},
					},
				},
				scales: {
					x: {
						stacked: true,
						ticks: {
							color: textColor,
						},
						grid: {
							color: gridColor,
						},
					},
					y: {
						stacked: true,
						beginAtZero: true,
						ticks: {
							color: textColor,
							callback: (value) => `$${value}`,
						},
						grid: {
							color: gridColor,
						},
					},
				},
			},
		};

		this.chart = new Chart(canvas, config);
	}

	protected override renderContent() {
		if (this.costEntries.length === 0) {
			return html`
				<div class="flex flex-col h-full items-center justify-center p-6">
					<p class="text-muted-foreground">No cost data available for this session.</p>
				</div>
			`;
		}

		const totalCost = this.costEntries.reduce((sum, entry) => sum + entry.totalCost, 0);
		const totalInputTokens = this.costEntries.reduce((sum, entry) => sum + entry.inputTokens, 0);
		const totalOutputTokens = this.costEntries.reduce((sum, entry) => sum + entry.outputTokens, 0);
		const totalCacheReadTokens = this.costEntries.reduce((sum, entry) => sum + entry.cacheReadTokens, 0);
		const totalCacheWriteTokens = this.costEntries.reduce((sum, entry) => sum + entry.cacheWriteTokens, 0);

		return html`
			<div class="flex flex-col h-full overflow-hidden">
				<!-- Header -->
				<div class="p-6 flex-shrink-0 border-b border-border">
					<div class="pr-8">
						<h2 class="text-lg font-semibold text-foreground mb-2 flex items-center gap-2">
							${icon(DollarSign, "sm")} Session Cost Analysis
						</h2>
						<p class="text-sm text-muted-foreground">
							Analyzing ${this.costEntries.length} assistant message${this.costEntries.length > 1 ? "s" : ""}
						</p>
					</div>
				</div>

				<!-- Content -->
				<div class="flex-1 overflow-y-auto px-6 pb-6">
					<div class="mt-4 flex flex-col gap-4">
						<!-- Summary Cards -->
						<div class="grid grid-cols-4 gap-4">
							<div class="p-3 rounded-lg border border-border bg-background">
								<div class="text-xs text-muted-foreground mb-1">Total Cost</div>
								<div class="text-xl font-bold text-foreground">$${totalCost.toFixed(6)}</div>
							</div>
							<div class="p-3 rounded-lg border border-border bg-background">
								<div class="text-xs text-muted-foreground mb-1">Input Tokens</div>
								<div class="text-xl font-bold text-foreground">${totalInputTokens.toLocaleString()}</div>
							</div>
							<div class="p-3 rounded-lg border border-border bg-background">
								<div class="text-xs text-muted-foreground mb-1">Output Tokens</div>
								<div class="text-xl font-bold text-foreground">${totalOutputTokens.toLocaleString()}</div>
							</div>
							<div class="p-3 rounded-lg border border-border bg-background">
								<div class="text-xs text-muted-foreground mb-1">Cache Tokens</div>
								<div class="text-xl font-bold text-foreground">
									${(totalCacheReadTokens + totalCacheWriteTokens).toLocaleString()}
								</div>
							</div>
						</div>

						<!-- Chart -->
						<div class="p-4 rounded-lg border border-border bg-background">
							<h3 class="text-sm font-medium mb-4">Cost Evolution</h3>
							<div style="height: 250px">
								<canvas id="cost-chart"></canvas>
							</div>
						</div>

						<!-- Data Table -->
						<div class="rounded-lg border border-border bg-background overflow-hidden">
							<div class="overflow-x-auto">
								<table class="w-full text-xs">
									<thead class="bg-secondary/20 border-b border-border">
										<tr>
											<th class="px-3 py-2 text-left font-medium text-foreground">Message #</th>
											<th class="px-3 py-2 text-right font-medium text-foreground">Time (s)</th>
											<th class="px-3 py-2 text-right font-medium text-foreground">Input Tokens</th>
											<th class="px-3 py-2 text-right font-medium text-foreground">Output Tokens</th>
											<th class="px-3 py-2 text-right font-medium text-foreground">Cache Read</th>
											<th class="px-3 py-2 text-right font-medium text-foreground">Cache Write</th>
											<th class="px-3 py-2 text-right font-medium text-foreground">Input Cost</th>
											<th class="px-3 py-2 text-right font-medium text-foreground">Output Cost</th>
											<th class="px-3 py-2 text-right font-medium text-foreground">Cache Read Cost</th>
											<th class="px-3 py-2 text-right font-medium text-foreground">Cache Write Cost</th>
											<th class="px-3 py-2 text-right font-medium text-foreground">Total Cost</th>
											<th class="px-3 py-2 text-left font-medium text-foreground">Stop Reason</th>
											<th class="px-3 py-2 text-left font-medium text-foreground">Model</th>
										</tr>
									</thead>
									<tbody>
										${this.costEntries.map(
											(entry, index) => html`
												<tr
													class="${index % 2 === 0 ? "bg-background" : "bg-secondary/5"} hover:bg-secondary/10 ${
														entry.stopReason === "error" || entry.stopReason === "aborted"
															? "bg-destructive/10"
															: ""
													}"
												>
													<td class="px-3 py-2 text-foreground font-medium">${entry.messageIndex}</td>
													<td class="px-3 py-2 text-right text-muted-foreground">
														${entry.timeDelta !== undefined ? `+${entry.timeDelta.toFixed(1)}s` : "-"}
													</td>
													<td class="px-3 py-2 text-right text-muted-foreground">
														${entry.inputTokens.toLocaleString()}
													</td>
													<td class="px-3 py-2 text-right text-muted-foreground">
														${entry.outputTokens.toLocaleString()}
													</td>
													<td class="px-3 py-2 text-right text-muted-foreground">
														${entry.cacheReadTokens.toLocaleString()}
													</td>
													<td class="px-3 py-2 text-right text-muted-foreground">
														${entry.cacheWriteTokens.toLocaleString()}
													</td>
													<td class="px-3 py-2 text-right text-muted-foreground">
														$${entry.inputCost.toFixed(6)}
													</td>
													<td class="px-3 py-2 text-right text-muted-foreground">
														$${entry.outputCost.toFixed(6)}
													</td>
													<td class="px-3 py-2 text-right text-muted-foreground">
														$${entry.cacheReadCost.toFixed(6)}
													</td>
													<td class="px-3 py-2 text-right text-muted-foreground">
														$${entry.cacheWriteCost.toFixed(6)}
													</td>
													<td class="px-3 py-2 text-right font-semibold text-foreground">
														$${entry.totalCost.toFixed(6)}
													</td>
													<td class="px-3 py-2 text-muted-foreground">
														<span
															class="inline-block px-2 py-0.5 rounded text-[10px] font-medium ${
																entry.stopReason === "stop"
																	? "bg-green-500/20 text-green-700 dark:text-green-300"
																	: entry.stopReason === "toolUse"
																		? "bg-blue-500/20 text-blue-700 dark:text-blue-300"
																		: entry.stopReason === "length"
																			? "bg-yellow-500/20 text-yellow-700 dark:text-yellow-300"
																			: "bg-red-500/20 text-red-700 dark:text-red-300"
															}"
														>
															${entry.stopReason}
														</span>
														${
															entry.errorMessage
																? html`<div class="text-[10px] text-destructive mt-1">${entry.errorMessage}</div>`
																: ""
														}
													</td>
													<td class="px-3 py-2 text-muted-foreground text-[10px]">
														${entry.provider}:${entry.model}
													</td>
												</tr>
											`,
										)}
									</tbody>
									<tfoot class="bg-secondary/30 border-t-2 border-border">
										<tr>
											<td class="px-3 py-2 text-foreground font-semibold">TOTALS</td>
											<td class="px-3 py-2"></td>
											<td class="px-3 py-2 text-right font-semibold text-foreground">
												${totalInputTokens.toLocaleString()}
											</td>
											<td class="px-3 py-2 text-right font-semibold text-foreground">
												${totalOutputTokens.toLocaleString()}
											</td>
											<td class="px-3 py-2 text-right font-semibold text-foreground">
												${totalCacheReadTokens.toLocaleString()}
											</td>
											<td class="px-3 py-2 text-right font-semibold text-foreground">
												${totalCacheWriteTokens.toLocaleString()}
											</td>
											<td class="px-3 py-2 text-right font-semibold text-foreground">
												$${this.costEntries.reduce((sum, e) => sum + e.inputCost, 0).toFixed(6)}
											</td>
											<td class="px-3 py-2 text-right font-semibold text-foreground">
												$${this.costEntries.reduce((sum, e) => sum + e.outputCost, 0).toFixed(6)}
											</td>
											<td class="px-3 py-2 text-right font-semibold text-foreground">
												$${this.costEntries.reduce((sum, e) => sum + e.cacheReadCost, 0).toFixed(6)}
											</td>
											<td class="px-3 py-2 text-right font-semibold text-foreground">
												$${this.costEntries.reduce((sum, e) => sum + e.cacheWriteCost, 0).toFixed(6)}
											</td>
											<td class="px-3 py-2 text-right font-bold text-foreground">$${totalCost.toFixed(6)}</td>
											<td class="px-3 py-2"></td>
											<td class="px-3 py-2"></td>
										</tr>
									</tfoot>
								</table>
							</div>
						</div>
					</div>
				</div>
			</div>
		`;
	}
}

customElements.define("session-cost-dialog", SessionCostDialog);
