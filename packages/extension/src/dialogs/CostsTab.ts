import { Select, type SelectOption } from "@mariozechner/mini-lit/dist/Select.js";
import { SettingsTab } from "@shuv1337/pi-web-ui";
import { Chart, type ChartConfiguration, registerables } from "chart.js";
import { html, type PropertyValues } from "lit";
import { getShuvgeistStorage } from "../storage/app-storage.js";

// Register Chart.js components
Chart.register(...registerables);

export class CostsTab extends SettingsTab {
	label = "Costs";
	private dateRange: "today" | "week" | "30days" | "90days" | "alltime" = "30days";
	private totalCost = 0;
	private loading = true;
	private lineChart?: Chart;
	private providerChart?: Chart;
	private byProvider: Record<string, number> = {};
	private byModel: Record<string, number> = {};

	getTabName(): string {
		return this.label;
	}

	async connectedCallback() {
		super.connectedCallback();
		await this.loadCosts();
	}

	protected updated(_changedProperties: PropertyValues): void {
		super.updated?.(_changedProperties);
		// Render charts after DOM update
		if (!this.lineChart && !this.loading) {
			this.renderCharts();
		}
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		// Clean up charts
		if (this.lineChart) {
			this.lineChart.destroy();
		}
		if (this.providerChart) {
			this.providerChart.destroy();
		}
	}

	async handleDateRangeChange(newRange: "today" | "week" | "30days" | "90days" | "alltime") {
		this.dateRange = newRange;
		this.loading = true;
		this.requestUpdate();

		// Destroy existing charts
		if (this.lineChart) {
			this.lineChart.destroy();
			this.lineChart = undefined;
		}
		if (this.providerChart) {
			this.providerChart.destroy();
			this.providerChart = undefined;
		}

		await this.loadCosts();
		// Charts will be re-rendered via updated() lifecycle
	}

	async loadCosts() {
		const storage = getShuvgeistStorage();

		try {
			const now = new Date();
			const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

			// Calculate date range based on selection
			let startDate: Date;
			switch (this.dateRange) {
				case "today":
					startDate = today;
					break;
				case "week":
					startDate = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
					break;
				case "30days":
					startDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
					break;
				case "90days":
					startDate = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
					break;
				case "alltime":
					startDate = new Date(0); // Unix epoch
					break;
			}

			// Fetch costs for the selected date range
			const costs = await storage.costs.getCostsByDateRange(startDate, now);
			this.totalCost = costs.reduce((sum, e) => sum + e.total, 0);

			// Calculate provider and model breakdowns for the date range
			this.byProvider = {};
			this.byModel = {};
			for (const day of costs) {
				for (const [provider, models] of Object.entries(day.byProvider)) {
					const providerTotal = Object.values(models).reduce((sum, cost) => sum + cost, 0);
					this.byProvider[provider] = (this.byProvider[provider] || 0) + providerTotal;

					for (const [modelId, cost] of Object.entries(models)) {
						const key = `${provider}:${modelId}`;
						this.byModel[key] = (this.byModel[key] || 0) + cost;
					}
				}
			}
		} catch (err) {
			console.error("Failed to load costs:", err);
		} finally {
			this.loading = false;
			this.requestUpdate();
		}
	}

	async renderCharts() {
		const storage = getShuvgeistStorage();

		try {
			// Get CSS variable colors for theming
			const styles = getComputedStyle(document.documentElement);
			const textColor = styles.getPropertyValue("--color-foreground").trim();
			const gridColor = styles.getPropertyValue("--color-border").trim();

			// Get daily costs based on selected date range
			const now = new Date();
			const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			let startDate: Date;
			switch (this.dateRange) {
				case "today":
					startDate = today;
					break;
				case "week":
					startDate = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
					break;
				case "30days":
					startDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
					break;
				case "90days":
					startDate = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
					break;
				case "alltime":
					startDate = new Date(0);
					break;
			}

			const costs = await storage.costs.getCostsByDateRange(startDate, now);
			const dailyCosts = costs.reverse(); // Chronological order (oldest to newest)

			// Stacked bar chart: daily costs by provider/model
			const lineCanvas = this.querySelector("#line-chart") as HTMLCanvasElement | null;
			if (lineCanvas) {
				// Collect all unique provider:model combinations across all days
				const modelKeys = new Set<string>();
				for (const day of dailyCosts) {
					for (const [provider, models] of Object.entries(day.byProvider)) {
						for (const modelId of Object.keys(models)) {
							modelKeys.add(`${provider}:${modelId}`);
						}
					}
				}

				// Color palette for different models
				const colors = [
					"rgb(99, 102, 241)", // indigo
					"rgb(244, 63, 94)", // rose
					"rgb(34, 197, 94)", // green
					"rgb(251, 146, 60)", // orange
					"rgb(168, 85, 247)", // purple
					"rgb(14, 165, 233)", // sky
					"rgb(234, 179, 8)", // yellow
					"rgb(236, 72, 153)", // pink
				];

				// Create dataset for each model
				const datasets = Array.from(modelKeys).map((modelKey, index) => {
					const [provider, modelId] = modelKey.split(":");
					return {
						label: modelKey,
						data: dailyCosts.map((day) => day.byProvider[provider]?.[modelId] || 0),
						backgroundColor: colors[index % colors.length],
					};
				});

				const lineConfig: ChartConfiguration = {
					type: "bar",
					data: {
						labels: dailyCosts.map((d) => {
							const date = new Date(d.date);
							return `${date.getMonth() + 1}/${date.getDate()}`;
						}),
						datasets,
					},
					options: {
						responsive: true,
						maintainAspectRatio: false,
						plugins: {
							legend: {
								display: true,
								position: "bottom",
								labels: {
									color: textColor,
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
				this.lineChart = new Chart(lineCanvas, lineConfig);
			}

			// Doughnut chart: provider breakdown
			const providerCanvas = this.querySelector("#provider-chart") as HTMLCanvasElement | null;
			if (providerCanvas && Object.keys(this.byProvider).length > 0) {
				const providerConfig: ChartConfiguration = {
					type: "doughnut",
					data: {
						labels: Object.keys(this.byProvider),
						datasets: [
							{
								data: Object.values(this.byProvider),
								backgroundColor: [
									"rgb(99, 102, 241)", // indigo
									"rgb(244, 63, 94)", // rose
									"rgb(34, 197, 94)", // green
									"rgb(251, 146, 60)", // orange
									"rgb(168, 85, 247)", // purple
									"rgb(14, 165, 233)", // sky
								],
								borderWidth: 0,
							},
						],
					},
					options: {
						responsive: true,
						maintainAspectRatio: false,
						plugins: {
							legend: {
								position: "bottom",
								labels: {
									color: textColor,
								},
							},
						},
					},
				};
				this.providerChart = new Chart(providerCanvas, providerConfig);
			}
		} catch (err) {
			console.error("Failed to render charts:", err);
		}
	}

	render() {
		if (this.loading) {
			return html`<div class="text-center py-8 text-muted-foreground">Loading...</div>`;
		}

		// Sort models by cost (descending)
		const sortedModels = Object.entries(this.byModel).sort((a, b) => b[1] - a[1]);

		// Date range labels
		const dateRangeLabels = {
			today: "Today",
			week: "Last 7 Days",
			"30days": "Last 30 Days",
			"90days": "Last 90 Days",
			alltime: "All Time",
		};

		// Date range options for Select component
		const dateRangeOptions: SelectOption[] = [
			{ value: "today", label: "Today" },
			{ value: "week", label: "Last 7 Days" },
			{ value: "30days", label: "Last 30 Days" },
			{ value: "90days", label: "Last 90 Days" },
			{ value: "alltime", label: "All Time" },
		];

		return html`
			<div class="space-y-6">
				<!-- Date Range Selector -->
				<div class="flex items-center gap-4">
					<label class="text-sm font-medium text-foreground">Date Range:</label>
					${Select({
						value: this.dateRange,
						options: dateRangeOptions,
						onChange: (value) => {
							this.handleDateRangeChange(value as typeof this.dateRange);
						},
						size: "md",
					})}
				</div>

				<!-- Summary Card -->
				<div class="p-4 rounded-lg border border-border bg-background">
					<div class="text-sm text-muted-foreground">${dateRangeLabels[this.dateRange]}</div>
					<div class="text-2xl font-bold text-foreground">$${this.totalCost.toFixed(4)}</div>
				</div>

				<!-- Stacked Bar Chart -->
				<div class="p-4 rounded-lg border border-border bg-background">
					<h3 class="text-sm font-medium mb-4">Daily Costs by Model</h3>
					<div style="height: min(400px, 40vh)">
						<canvas id="line-chart"></canvas>
					</div>
				</div>

				<!-- Charts Row -->
				<div class="grid grid-cols-2 gap-4">
					<!-- Provider Breakdown -->
					<div class="p-4 rounded-lg border border-border bg-background">
						<h3 class="text-sm font-medium mb-4">By Provider</h3>
						${
							Object.keys(this.byProvider).length > 0
								? html`
										<div style="height: 200px">
											<canvas id="provider-chart"></canvas>
										</div>
									`
								: html`<div class="text-center py-8 text-muted-foreground text-sm">No cost data yet</div>`
						}
					</div>

					<!-- Model Breakdown Table -->
					<div class="p-4 rounded-lg border border-border bg-background">
						<h3 class="text-sm font-medium mb-4">By Model</h3>
						${
							sortedModels.length > 0
								? html`
										<div class="space-y-2 max-h-[200px] overflow-y-auto">
											${sortedModels.map(
												([modelKey, cost]) => html`
													<div class="flex justify-between items-center text-sm">
														<span class="text-foreground truncate" title="${modelKey}">${modelKey}</span>
														<span class="font-semibold text-foreground ml-2">$${cost.toFixed(4)}</span>
													</div>
												`,
											)}
										</div>
									`
								: html`<div class="text-center py-8 text-muted-foreground text-sm">No cost data yet</div>`
						}
					</div>
				</div>

				<!-- Info note -->
				<div class="text-xs text-muted-foreground p-3 rounded-lg border border-border bg-secondary/20">
					<strong>Note:</strong> Costs are tracked independently from sessions. Deleting sessions will not affect cost
					history. Aborted requests may not capture full token usage.
				</div>
			</div>
		`;
	}
}

customElements.define("costs-tab", CostsTab);
