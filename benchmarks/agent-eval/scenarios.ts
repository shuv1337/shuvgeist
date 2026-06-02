export interface AgentEvalScenario {
	id: string;
	title: string;
	startUrl: string;
	instruction: string;
	validator: {
		kind: "text" | "url" | "state";
		expected: string;
	};
	baselineTokenBudget: number;
	driftEvery?: number;
}

export const AGENT_EVAL_SCENARIOS: AgentEvalScenario[] = [
	{
		id: "settings-bridge-status",
		title: "Open settings and verify bridge status",
		startUrl: "shuvgeist://sidepanel",
		instruction: "Open Settings, switch to CLI Bridge, and confirm the bridge status is visible.",
		validator: { kind: "text", expected: "Status" },
		baselineTokenBudget: 1600,
	},
	{
		id: "semantic-form-fill",
		title: "Fill a labeled form by semantic refs",
		startUrl: "fixture://semantic-form",
		instruction: "Find the email field by label, fill it with test@example.com, and submit the form.",
		validator: { kind: "state", expected: "submitted:test@example.com" },
		baselineTokenBudget: 2200,
		driftEvery: 4,
	},
	{
		id: "navigation-recovery",
		title: "Recover after navigation invalidates refs",
		startUrl: "fixture://navigation",
		instruction: "Navigate to the details view, re-observe after navigation, and click Continue.",
		validator: { kind: "url", expected: "fixture://navigation/details/continue" },
		baselineTokenBudget: 2600,
		driftEvery: 3,
	},
];
