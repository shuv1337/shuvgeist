import {
	formatWorkflowValidationErrors,
	validateWorkflowDefinition,
	WORKFLOW_MAX_LOOP_ITERATIONS,
	type WorkflowArgDefinition,
	type WorkflowAssertStep,
	type WorkflowCommandStep,
	type WorkflowDefinition,
	type WorkflowEachStep,
	type WorkflowOnErrorPolicy,
	type WorkflowRepeatStep,
	type WorkflowStep,
	type WorkflowTarget,
	type WorkflowWaitSpec,
} from "@shuvgeist/protocol/workflow-schema";

const EXACT_TOKEN_PATTERN = /^%\{([^}]+)\}$/;
const TOKEN_PATTERN = /%\{([^}]+)\}/g;
const DEFAULT_ALLOWED_METHODS = new Set<string>([
	"navigate",
	"repl",
	"screenshot",
	"eval",
	"page_snapshot",
	"page_assert",
	"locate_by_role",
	"locate_by_text",
	"locate_by_label",
	"ref_click",
	"ref_fill",
	"frame_list",
	"frame_tree",
	"network_start",
	"network_stop",
	"network_list",
	"network_clear",
	"network_stats",
	"network_get",
	"network_body",
	"network_curl",
	"device_emulate",
	"device_reset",
	"perf_metrics",
	"perf_trace_start",
	"perf_trace_stop",
	"record_start",
	"record_stop",
	"record_status",
]);
const DISALLOWED_METHODS = new Set<string>(["workflow_run", "workflow_validate", "select_element"]);
const TARGETABLE_METHODS = new Set<string>([
	"navigate",
	"repl",
	"screenshot",
	"eval",
	"page_snapshot",
	"page_assert",
	"locate_by_role",
	"locate_by_text",
	"locate_by_label",
	"ref_click",
	"ref_fill",
	"frame_list",
	"frame_tree",
	"network_start",
	"network_stop",
	"network_list",
	"network_clear",
	"network_stats",
	"network_get",
	"network_body",
	"network_curl",
	"device_emulate",
	"device_reset",
	"perf_metrics",
	"perf_trace_start",
	"perf_trace_stop",
	"record_start",
	"record_status",
]);
const UNRESOLVED_CAPTURE_SENTINEL = "__workflow_unresolved_capture__";

export type WorkflowDispatch = (
	method: string,
	params: Record<string, unknown> | undefined,
	signal?: AbortSignal,
) => Promise<unknown>;

export interface WorkflowEngineOptions {
	dispatch: WorkflowDispatch;
	allowedMethods?: ReadonlySet<string> | readonly string[];
	maxLoopIterations?: number;
	maxTotalStepExecutions?: number;
	maxRecordedSteps?: number;
	maxStepResultChars?: number;
	maxCaptureChars?: number;
}

export interface WorkflowRunOptions {
	args?: Record<string, unknown>;
	signal?: AbortSignal;
	dryRun?: boolean;
}

export type WorkflowStepStatus = "ok" | "error" | "aborted";

export interface WorkflowStepResult {
	path: string;
	type: "command" | "assert" | "repeat" | "each";
	status: WorkflowStepStatus;
	durationMs: number;
	method?: string;
	wait?: WorkflowWaitSpec;
	as?: string;
	iterations?: number;
	result?: unknown;
	error?: string;
}

export interface WorkflowWarning {
	path: string;
	code: "target_unpinned";
	message: string;
}

export interface WorkflowRunResult {
	ok: boolean;
	aborted: boolean;
	dryRun: boolean;
	name?: string;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	steps: WorkflowStepResult[];
	captured: Record<string, unknown>;
	errors: string[];
	warnings: WorkflowWarning[];
	truncation: {
		stepResults: number;
		captures: number;
	};
}

interface WorkflowExecutionState {
	executedSteps: number;
	steps: WorkflowStepResult[];
	errors: string[];
	warnings: WorkflowWarning[];
	truncation: {
		stepResults: number;
		captures: number;
	};
	captured: Record<string, unknown>;
}

interface WorkflowExecutionContext {
	variables: Record<string, unknown>;
	dryRun: boolean;
	defaultWait?: WorkflowWaitSpec;
	target: WorkflowTargetState;
}

interface ExecuteStepsResult {
	aborted: boolean;
	halted: boolean;
}

interface WorkflowTargetState {
	mode: "active" | "new-tab" | "pinned-tab";
	tabId?: number;
	frameId?: number;
}

export class WorkflowEngine {
	private readonly dispatch: WorkflowDispatch;
	private readonly allowedMethods: ReadonlySet<string>;
	private readonly maxLoopIterations: number;
	private readonly maxTotalStepExecutions: number;
	private readonly maxRecordedSteps: number;
	private readonly maxStepResultChars: number;
	private readonly maxCaptureChars: number;

	constructor(options: WorkflowEngineOptions) {
		this.dispatch = options.dispatch;
		this.allowedMethods =
			options.allowedMethods instanceof Set
				? options.allowedMethods
				: new Set(options.allowedMethods ?? DEFAULT_ALLOWED_METHODS);
		this.maxLoopIterations = options.maxLoopIterations ?? WORKFLOW_MAX_LOOP_ITERATIONS;
		this.maxTotalStepExecutions = options.maxTotalStepExecutions ?? 500;
		this.maxRecordedSteps = options.maxRecordedSteps ?? 500;
		this.maxStepResultChars = options.maxStepResultChars ?? 12_000;
		this.maxCaptureChars = options.maxCaptureChars ?? 16_000;
	}

	async run(workflowInput: unknown, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
		const startedAtMs = Date.now();
		const startedAt = new Date(startedAtMs).toISOString();
		const dryRun = options.dryRun ?? false;
		const validation = this.prepareWorkflow(workflowInput, options.args);

		if (!validation.ok) {
			const endedAtMs = Date.now();
			return {
				ok: false,
				aborted: false,
				dryRun,
				startedAt,
				endedAt: new Date(endedAtMs).toISOString(),
				durationMs: endedAtMs - startedAtMs,
				steps: [],
				captured: {},
				errors: validation.errors,
				warnings: [],
				truncation: { stepResults: 0, captures: 0 },
			};
		}

		const state: WorkflowExecutionState = {
			executedSteps: 0,
			steps: [],
			errors: [],
			warnings: [],
			truncation: { stepResults: 0, captures: 0 },
			captured: {},
		};
		const context: WorkflowExecutionContext = {
			variables: validation.variables,
			dryRun,
			defaultWait: validation.workflow.defaultWait,
			target: createTargetState(validation.workflow.target),
		};

		let aborted = false;
		let halted = false;

		try {
			const outcome = await this.executeSteps(validation.workflow.steps, context, state, options.signal, "");
			aborted = outcome.aborted;
			halted = outcome.halted;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			state.errors.push(message);
			halted = true;
		}

		const endedAtMs = Date.now();
		return {
			ok: !aborted && !halted && state.errors.length === 0,
			aborted,
			dryRun,
			name: validation.workflow.name,
			startedAt,
			endedAt: new Date(endedAtMs).toISOString(),
			durationMs: endedAtMs - startedAtMs,
			steps: state.steps,
			captured: state.captured,
			errors: state.errors,
			warnings: state.warnings,
			truncation: state.truncation,
		};
	}

	async validate(workflowInput: unknown, args?: Record<string, unknown>): Promise<{ ok: boolean; errors: string[] }> {
		const result = await this.run(workflowInput, { args, dryRun: true });
		return {
			ok: result.ok,
			errors: result.errors,
		};
	}

	private prepareWorkflow(
		workflowInput: unknown,
		providedArgs?: Record<string, unknown>,
	): { ok: true; workflow: WorkflowDefinition; variables: Record<string, unknown> } | { ok: false; errors: string[] } {
		const validation = validateWorkflowDefinition(workflowInput);
		if (!validation.ok) {
			return { ok: false, errors: formatWorkflowValidationErrors(validation.errors) };
		}

		const variables = this.resolveInitialVariables(validation.value.args ?? {}, providedArgs ?? {});
		if (!variables.ok) {
			return { ok: false, errors: variables.errors };
		}
		if (validation.value.target?.mode === "pinned-tab" && typeof validation.value.target.tabId !== "number") {
			return { ok: false, errors: ["Workflow target mode pinned-tab requires target.tabId"] };
		}

		return { ok: true, workflow: validation.value, variables: variables.values };
	}

	private resolveInitialVariables(
		argDefinitions: Record<string, WorkflowArgDefinition>,
		providedArgs: Record<string, unknown>,
	): { ok: true; values: Record<string, unknown> } | { ok: false; errors: string[] } {
		const values: Record<string, unknown> = {};
		const errors: string[] = [];

		for (const [name, definition] of Object.entries(argDefinitions)) {
			if (Object.hasOwn(providedArgs, name)) {
				values[name] = providedArgs[name];
				continue;
			}
			if (Object.hasOwn(definition, "default")) {
				values[name] = definition.default;
				continue;
			}
			if (definition.required) {
				errors.push(`Missing required workflow arg: ${name}`);
			}
		}

		for (const [name, value] of Object.entries(providedArgs)) {
			if (!Object.hasOwn(values, name)) {
				values[name] = value;
			}
		}

		if (errors.length > 0) {
			return { ok: false, errors };
		}

		return { ok: true, values };
	}

	private async executeSteps(
		steps: WorkflowStep[],
		context: WorkflowExecutionContext,
		state: WorkflowExecutionState,
		signal: AbortSignal | undefined,
		pathPrefix: string,
	): Promise<ExecuteStepsResult> {
		for (let index = 0; index < steps.length; index++) {
			if (signal?.aborted) {
				return { aborted: true, halted: false };
			}

			const stepPath = pathPrefix ? `${pathPrefix}.${index}` : String(index);
			const outcome = await this.executeStep(steps[index], context, state, signal, stepPath);
			if (outcome.aborted) {
				return { aborted: true, halted: false };
			}
			if (outcome.halted) {
				return { aborted: false, halted: true };
			}
		}

		return { aborted: false, halted: false };
	}

	private async executeStep(
		step: WorkflowStep,
		context: WorkflowExecutionContext,
		state: WorkflowExecutionState,
		signal: AbortSignal | undefined,
		path: string,
	): Promise<ExecuteStepsResult> {
		state.executedSteps += 1;
		if (state.executedSteps > this.maxTotalStepExecutions) {
			throw new Error(
				`Workflow exceeded execution ceiling of ${this.maxTotalStepExecutions} step nodes. ` +
					"Lower loop counts or split the workflow.",
			);
		}

		if (isCommandStep(step)) {
			return this.executeCommandStep(step, context, state, signal, path);
		}
		if (isAssertStep(step)) {
			return this.executeAssertStep(step, context, state, signal, path);
		}
		if (isRepeatStep(step)) {
			return this.executeRepeatStep(step, context, state, signal, path);
		}
		return this.executeEachStep(step, context, state, signal, path);
	}

	private async executeCommandStep(
		step: WorkflowCommandStep,
		context: WorkflowExecutionContext,
		state: WorkflowExecutionState,
		signal: AbortSignal | undefined,
		path: string,
	): Promise<ExecuteStepsResult> {
		const started = Date.now();
		const wait = step.wait ?? context.defaultWait;
		const policy: WorkflowOnErrorPolicy = step.onError ?? "stop";

		if (DISALLOWED_METHODS.has(step.method) || step.method === "workflow_run" || step.method.startsWith("session_")) {
			const message = `Step ${path} uses disallowed workflow method: ${step.method}`;
			this.recordStep(
				state,
				{
					path,
					type: "command",
					status: "error",
					durationMs: Date.now() - started,
					method: step.method,
					wait,
					as: step.as,
					error: message,
				},
				policy === "stop",
			);
			return { aborted: false, halted: policy === "stop" };
		}

		if (!this.allowedMethods.has(step.method)) {
			const message = `Step ${path} method '${step.method}' is not allowed in workflow mode`;
			this.recordStep(
				state,
				{
					path,
					type: "command",
					status: "error",
					durationMs: Date.now() - started,
					method: step.method,
					wait,
					as: step.as,
					error: message,
				},
				policy === "stop",
			);
			return { aborted: false, halted: policy === "stop" };
		}

		let resolvedParams: Record<string, unknown> | undefined;
		try {
			resolvedParams = isRecord(step.params)
				? (this.substituteValue(step.params, context.variables, context.dryRun, path) as Record<string, unknown>)
				: undefined;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.recordStep(
				state,
				{
					path,
					type: "command",
					status: "error",
					durationMs: Date.now() - started,
					method: step.method,
					wait,
					as: step.as,
					error: message,
				},
				policy === "stop",
			);
			return { aborted: false, halted: policy === "stop" };
		}

		try {
			const targetParams = this.applyTargetToParams(step.method, resolvedParams, context, state, path);
			const result = context.dryRun ? { dryRun: true } : await this.dispatch(step.method, targetParams, signal);
			this.updatePinnedTargetFromResult(step.method, result, context);
			const boundedResult = this.boundValue(result, this.maxStepResultChars);

			if (step.as) {
				context.variables[step.as] = context.dryRun ? UNRESOLVED_CAPTURE_SENTINEL : result;
				const boundedCapture = this.boundValue(result, this.maxCaptureChars);
				if (Object.keys(state.captured).length < this.maxRecordedSteps) {
					state.captured[step.as] = boundedCapture;
				} else {
					state.truncation.captures += 1;
				}
			}

			this.recordStep(state, {
				path,
				type: "command",
				status: "ok",
				durationMs: Date.now() - started,
				method: step.method,
				wait,
				as: step.as,
				result: boundedResult,
			});
			return { aborted: false, halted: false };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = isAbortError(error, signal);
			this.recordStep(
				state,
				{
					path,
					type: "command",
					status: aborted ? "aborted" : "error",
					durationMs: Date.now() - started,
					method: step.method,
					wait,
					as: step.as,
					error: message,
				},
				!aborted && policy === "stop",
			);
			if (aborted) {
				return { aborted: true, halted: false };
			}
			return { aborted: false, halted: policy === "stop" };
		}
	}

	private async executeAssertStep(
		step: WorkflowAssertStep,
		context: WorkflowExecutionContext,
		state: WorkflowExecutionState,
		signal: AbortSignal | undefined,
		path: string,
	): Promise<ExecuteStepsResult> {
		const started = Date.now();
		const wait = step.wait ?? context.defaultWait;
		const policy: WorkflowOnErrorPolicy = step.onError ?? "stop";
		let resolvedParams: Record<string, unknown>;
		try {
			resolvedParams = this.substituteValue(step.assert, context.variables, context.dryRun, path) as Record<
				string,
				unknown
			>;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.recordStep(
				state,
				{
					path,
					type: "assert",
					status: "error",
					durationMs: Date.now() - started,
					method: "page_assert",
					wait,
					as: step.as,
					error: message,
				},
				policy === "stop",
			);
			return { aborted: false, halted: policy === "stop" };
		}

		try {
			const targetParams = this.applyTargetToParams("page_assert", resolvedParams, context, state, path);
			const result = context.dryRun
				? { dryRun: true, ok: true }
				: await this.dispatch("page_assert", targetParams, signal);
			const boundedResult = this.boundValue(result, this.maxStepResultChars);
			if (step.as) {
				context.variables[step.as] = context.dryRun ? UNRESOLVED_CAPTURE_SENTINEL : result;
				const boundedCapture = this.boundValue(result, this.maxCaptureChars);
				if (Object.keys(state.captured).length < this.maxRecordedSteps) {
					state.captured[step.as] = boundedCapture;
				} else {
					state.truncation.captures += 1;
				}
			}
			const assertionOk = context.dryRun || assertionResultOk(result);
			this.recordStep(
				state,
				{
					path,
					type: "assert",
					status: assertionOk ? "ok" : "error",
					durationMs: Date.now() - started,
					method: "page_assert",
					wait,
					as: step.as,
					result: boundedResult,
					error: assertionOk ? undefined : assertionResultMessage(result),
				},
				!assertionOk && policy === "stop",
			);
			return { aborted: false, halted: !assertionOk && policy === "stop" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = isAbortError(error, signal);
			this.recordStep(
				state,
				{
					path,
					type: "assert",
					status: aborted ? "aborted" : "error",
					durationMs: Date.now() - started,
					method: "page_assert",
					wait,
					as: step.as,
					error: message,
				},
				!aborted && policy === "stop",
			);
			if (aborted) return { aborted: true, halted: false };
			return { aborted: false, halted: policy === "stop" };
		}
	}

	private async executeRepeatStep(
		step: WorkflowRepeatStep,
		context: WorkflowExecutionContext,
		state: WorkflowExecutionState,
		signal: AbortSignal | undefined,
		path: string,
	): Promise<ExecuteStepsResult> {
		const started = Date.now();
		const policy: WorkflowOnErrorPolicy = step.onError ?? "stop";
		const repeatCount = step.repeat;

		if (repeatCount > this.maxLoopIterations) {
			const message = `Step ${path} repeat count ${repeatCount} exceeds loop ceiling ${this.maxLoopIterations}`;
			this.recordStep(
				state,
				{
					path,
					type: "repeat",
					status: "error",
					durationMs: Date.now() - started,
					iterations: repeatCount,
					error: message,
				},
				policy === "stop",
			);
			return { aborted: false, halted: policy === "stop" };
		}

		for (let i = 0; i < repeatCount; i++) {
			if (signal?.aborted) {
				this.recordStep(state, {
					path,
					type: "repeat",
					status: "aborted",
					durationMs: Date.now() - started,
					iterations: i,
					error: "Workflow aborted",
				});
				return { aborted: true, halted: false };
			}
			const outcome = await this.executeSteps(step.steps, context, state, signal, `${path}.repeat${i}`);
			if (outcome.aborted) {
				this.recordStep(state, {
					path,
					type: "repeat",
					status: "aborted",
					durationMs: Date.now() - started,
					iterations: i + 1,
					error: "Workflow aborted",
				});
				return { aborted: true, halted: false };
			}
			if (outcome.halted) {
				this.recordStep(
					state,
					{
						path,
						type: "repeat",
						status: "error",
						durationMs: Date.now() - started,
						iterations: i + 1,
						error: `Iteration ${i + 1} failed`,
					},
					policy === "stop",
				);
				return { aborted: false, halted: policy === "stop" };
			}
		}

		this.recordStep(state, {
			path,
			type: "repeat",
			status: "ok",
			durationMs: Date.now() - started,
			iterations: repeatCount,
		});
		return { aborted: false, halted: false };
	}

	private async executeEachStep(
		step: WorkflowEachStep,
		context: WorkflowExecutionContext,
		state: WorkflowExecutionState,
		signal: AbortSignal | undefined,
		path: string,
	): Promise<ExecuteStepsResult> {
		const started = Date.now();
		const policy: WorkflowOnErrorPolicy = step.onError ?? "stop";

		let sourceValue: unknown;
		try {
			sourceValue = this.resolveEachSource(step.each, context.variables, context.dryRun, path);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.recordStep(
				state,
				{
					path,
					type: "each",
					status: "error",
					durationMs: Date.now() - started,
					error: message,
				},
				policy === "stop",
			);
			return { aborted: false, halted: policy === "stop" };
		}

		let items: unknown[];
		if (sourceValue === UNRESOLVED_CAPTURE_SENTINEL && context.dryRun) {
			items = [UNRESOLVED_CAPTURE_SENTINEL];
		} else if (Array.isArray(sourceValue)) {
			items = sourceValue;
		} else {
			const message = `Step ${path} each source must resolve to an array`;
			this.recordStep(
				state,
				{
					path,
					type: "each",
					status: "error",
					durationMs: Date.now() - started,
					error: message,
				},
				policy === "stop",
			);
			return { aborted: false, halted: policy === "stop" };
		}

		if (items.length > this.maxLoopIterations) {
			const message = `Step ${path} has ${items.length} loop items, above the ceiling ${this.maxLoopIterations}`;
			this.recordStep(
				state,
				{
					path,
					type: "each",
					status: "error",
					durationMs: Date.now() - started,
					iterations: items.length,
					error: message,
				},
				policy === "stop",
			);
			return { aborted: false, halted: policy === "stop" };
		}

		const itemName = step.item ?? "item";
		const indexName = step.index ?? "index";

		for (let i = 0; i < items.length; i++) {
			if (signal?.aborted) {
				this.recordStep(state, {
					path,
					type: "each",
					status: "aborted",
					durationMs: Date.now() - started,
					iterations: i,
					error: "Workflow aborted",
				});
				return { aborted: true, halted: false };
			}
			const iterationContext: WorkflowExecutionContext = {
				...context,
				variables: {
					...context.variables,
					[itemName]: items[i],
					[indexName]: i,
				},
			};
			const outcome = await this.executeSteps(step.steps, iterationContext, state, signal, `${path}.each${i}`);
			if (outcome.aborted) {
				this.recordStep(state, {
					path,
					type: "each",
					status: "aborted",
					durationMs: Date.now() - started,
					iterations: i + 1,
					error: "Workflow aborted",
				});
				return { aborted: true, halted: false };
			}
			if (outcome.halted) {
				this.recordStep(
					state,
					{
						path,
						type: "each",
						status: "error",
						durationMs: Date.now() - started,
						iterations: i + 1,
						error: `Iteration ${i + 1} failed`,
					},
					policy === "stop",
				);
				return { aborted: false, halted: policy === "stop" };
			}
		}

		this.recordStep(state, {
			path,
			type: "each",
			status: "ok",
			durationMs: Date.now() - started,
			iterations: items.length,
		});
		return { aborted: false, halted: false };
	}

	private resolveEachSource(
		expression: string,
		variables: Record<string, unknown>,
		dryRun: boolean,
		path: string,
	): unknown {
		const exact = matchExactToken(expression);
		if (exact) {
			const resolved = resolveVariable(exact, variables);
			if (!resolved.found) {
				throw new Error(`Step ${path} references missing variable '${exact}'`);
			}
			return resolved.value;
		}
		const direct = resolveVariable(expression, variables);
		if (direct.found) {
			return direct.value;
		}
		if (dryRun) {
			return UNRESOLVED_CAPTURE_SENTINEL;
		}
		throw new Error(`Step ${path} references missing loop source '${expression}'`);
	}

	private substituteValue(value: unknown, variables: Record<string, unknown>, dryRun: boolean, path: string): unknown {
		if (typeof value === "string") {
			const exact = matchExactToken(value);
			if (exact) {
				const resolved = resolveVariable(exact, variables);
				if (!resolved.found) {
					throw new Error(`Step ${path} references missing variable '${exact}'`);
				}
				return resolved.value;
			}
			if (!value.includes("%{")) {
				return value;
			}
			TOKEN_PATTERN.lastIndex = 0;
			return value.replaceAll(TOKEN_PATTERN, (_match, variableName: string) => {
				const resolved = resolveVariable(variableName, variables);
				if (!resolved.found) {
					if (dryRun) {
						throw new Error(`Step ${path} references missing variable '${variableName}'`);
					}
					throw new Error(`Step ${path} references missing variable '${variableName}'`);
				}
				return stringifyInterpolationValue(resolved.value);
			});
		}

		if (Array.isArray(value)) {
			return value.map((entry) => this.substituteValue(entry, variables, dryRun, path));
		}

		if (isRecord(value)) {
			const output: Record<string, unknown> = {};
			for (const [key, entry] of Object.entries(value)) {
				output[key] = this.substituteValue(entry, variables, dryRun, path);
			}
			return output;
		}

		return value;
	}

	private boundValue(value: unknown, maxChars: number): unknown {
		if (typeof value === "string") {
			if (value.length <= maxChars) {
				return value;
			}
			return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`;
		}

		const normalized = normalizeWireValue(value);
		const serialized = JSON.stringify(normalized) ?? "null";
		if (serialized.length <= maxChars) {
			return normalized;
		}
		return {
			truncated: true,
			originalLength: serialized.length,
			preview: serialized.slice(0, maxChars),
		};
	}

	private recordStep(state: WorkflowExecutionState, step: WorkflowStepResult, isError = false): void {
		if (state.steps.length < this.maxRecordedSteps) {
			state.steps.push(step);
		} else {
			state.truncation.stepResults += 1;
		}
		if (isError || step.status === "error") {
			const message = step.error ? `[${step.path}] ${step.error}` : `[${step.path}] step failed`;
			state.errors.push(message);
		}
	}

	private applyTargetToParams(
		method: string,
		params: Record<string, unknown> | undefined,
		context: WorkflowExecutionContext,
		state: WorkflowExecutionState,
		path: string,
	): Record<string, unknown> | undefined {
		if (!TARGETABLE_METHODS.has(method) || context.target.mode === "active") {
			return params;
		}

		const nextParams = { ...(params ?? {}) };
		const hasTabId = Object.hasOwn(nextParams, "tabId");
		const hasFrameId = Object.hasOwn(nextParams, "frameId");

		if (context.target.mode === "new-tab" && typeof context.target.tabId !== "number") {
			if (method === "navigate" && !hasTabId) {
				nextParams.newTab = nextParams.newTab !== false;
				return nextParams;
			}
			state.warnings.push({
				path,
				code: "target_unpinned",
				message: `Step ${path} uses targetable method '${method}' before new-tab target pinning has a tabId`,
			});
			return params;
		}

		if (!hasTabId && typeof context.target.tabId === "number") {
			nextParams.tabId = context.target.tabId;
		}
		if (method !== "navigate" && !hasFrameId && typeof context.target.frameId === "number") {
			nextParams.frameId = context.target.frameId;
		}

		return nextParams;
	}

	private updatePinnedTargetFromResult(method: string, result: unknown, context: WorkflowExecutionContext): void {
		if (method !== "navigate" || context.target.mode !== "new-tab" || typeof context.target.tabId === "number") {
			return;
		}
		if (!isRecord(result) || typeof result.tabId !== "number") {
			return;
		}
		context.target.tabId = result.tabId;
		if (typeof result.frameId === "number") {
			context.target.frameId = result.frameId;
		}
	}
}

function isCommandStep(step: WorkflowStep): step is WorkflowCommandStep {
	return Object.hasOwn(step, "method");
}

function isAssertStep(step: WorkflowStep): step is WorkflowAssertStep {
	return Object.hasOwn(step, "assert");
}

function isRepeatStep(step: WorkflowStep): step is WorkflowRepeatStep {
	return Object.hasOwn(step, "repeat");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createTargetState(target: WorkflowTarget | undefined): WorkflowTargetState {
	if (!target) {
		return { mode: "active" };
	}
	return {
		mode: target.mode,
		tabId: target.tabId,
		frameId: target.frameId,
	};
}

function matchExactToken(value: string): string | undefined {
	const match = value.match(EXACT_TOKEN_PATTERN);
	return match?.[1];
}

function resolveVariable(path: string, variables: Record<string, unknown>): { found: boolean; value?: unknown } {
	const trimmed = path.trim();
	if (!trimmed) {
		return { found: false };
	}
	const segments = trimmed.split(".");
	let current: unknown = variables;
	for (const segment of segments) {
		if (Array.isArray(current)) {
			const index = Number.parseInt(segment, 10);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) {
				return { found: false };
			}
			current = current[index];
			continue;
		}
		if (!isRecord(current) || !Object.hasOwn(current, segment)) {
			return { found: false };
		}
		current = current[segment];
	}
	return { found: true, value: current };
}

function stringifyInterpolationValue(value: unknown): string {
	if (value === UNRESOLVED_CAPTURE_SENTINEL) {
		return "[unresolved-capture]";
	}
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	return safeSerialize(value);
}

function safeSerialize(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function normalizeWireValue(value: unknown): unknown {
	try {
		const serialized = JSON.stringify(value, (_key, entry: unknown) =>
			typeof entry === "bigint" ? entry.toString() : entry,
		);
		return serialized === undefined ? null : (JSON.parse(serialized) as unknown);
	} catch {
		// Cyclic and otherwise non-serializable tool results cannot cross the
		// bridge boundary. Preserve a deterministic diagnostic string instead.
		return String(value);
	}
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) {
		return true;
	}
	if (!(error instanceof Error)) {
		return false;
	}
	const message = error.message.toLowerCase();
	return message.includes("abort");
}

function assertionResultOk(result: unknown): boolean {
	return isRecord(result) && result.ok === true;
}

function assertionResultMessage(result: unknown): string {
	if (isRecord(result) && typeof result.message === "string") {
		return result.message;
	}
	return "Workflow assertion failed";
}
