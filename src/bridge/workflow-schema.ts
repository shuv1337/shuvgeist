import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const WORKFLOW_MAX_LOOP_ITERATIONS = 100;
export const WORKFLOW_MAX_STEPS = 1_000;

const workflowOnErrorSchema = Type.Union([Type.Literal("stop"), Type.Literal("continue")], {
	description: "Step error policy: stop workflow or continue to the next step",
});

const workflowWaitTypeSchema = Type.Union(
	[Type.Literal("navigation"), Type.Literal("dom_stable"), Type.Literal("network_quiet")],
	{
		description: "Wait strategy to apply after a step",
	},
);

const workflowTargetModeSchema = Type.Union(
	[Type.Literal("active"), Type.Literal("new-tab"), Type.Literal("pinned-tab")],
	{
		description: "Workflow target mode",
	},
);

export const workflowTargetSchema = Type.Object(
	{
		mode: workflowTargetModeSchema,
		tabId: Type.Optional(Type.Integer({ minimum: 0 })),
		frameId: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{
		additionalProperties: false,
		description: "Target strategy for targetable workflow steps",
	},
);

export const workflowWaitSchema = Type.Object(
	{
		type: workflowWaitTypeSchema,
		timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
		quietMs: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{
		additionalProperties: false,
		description: "Wait configuration carried in workflow data",
	},
);

export const workflowArgDefinitionSchema = Type.Object(
	{
		description: Type.Optional(Type.String()),
		required: Type.Optional(Type.Boolean()),
		default: Type.Optional(Type.Unknown()),
	},
	{
		additionalProperties: false,
	},
);

const workflowCommandStepSchema = Type.Object(
	{
		id: Type.Optional(Type.String({ minLength: 1 })),
		method: Type.String({ minLength: 1 }),
		params: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Unknown())),
		as: Type.Optional(Type.String({ minLength: 1 })),
		wait: Type.Optional(workflowWaitSchema),
		onError: Type.Optional(workflowOnErrorSchema),
	},
	{
		additionalProperties: false,
	},
);

const workflowAssertStepSchema = Type.Object(
	{
		id: Type.Optional(Type.String({ minLength: 1 })),
		assert: Type.Record(Type.String({ minLength: 1 }), Type.Unknown()),
		as: Type.Optional(Type.String({ minLength: 1 })),
		wait: Type.Optional(workflowWaitSchema),
		onError: Type.Optional(workflowOnErrorSchema),
	},
	{
		additionalProperties: false,
	},
);

export const workflowStepSchema = Type.Recursive((Self) =>
	Type.Union(
		[
			workflowCommandStepSchema,
			workflowAssertStepSchema,
			Type.Object(
				{
					id: Type.Optional(Type.String({ minLength: 1 })),
					repeat: Type.Integer({ minimum: 1, maximum: WORKFLOW_MAX_LOOP_ITERATIONS }),
					steps: Type.Array(Self, { minItems: 1, maxItems: WORKFLOW_MAX_STEPS }),
					onError: Type.Optional(workflowOnErrorSchema),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					id: Type.Optional(Type.String({ minLength: 1 })),
					each: Type.String({ minLength: 1, description: "Array source expression, commonly %{myArray}" }),
					item: Type.Optional(Type.String({ minLength: 1 })),
					index: Type.Optional(Type.String({ minLength: 1 })),
					steps: Type.Array(Self, { minItems: 1, maxItems: WORKFLOW_MAX_STEPS }),
					onError: Type.Optional(workflowOnErrorSchema),
				},
				{ additionalProperties: false },
			),
		],
		{
			description: "Workflow command step or loop step",
		},
	),
);

export const workflowSchema = Type.Object(
	{
		name: Type.Optional(Type.String({ minLength: 1 })),
		args: Type.Optional(Type.Record(Type.String({ minLength: 1 }), workflowArgDefinitionSchema)),
		target: Type.Optional(workflowTargetSchema),
		defaultWait: Type.Optional(workflowWaitSchema),
		steps: Type.Array(workflowStepSchema, { minItems: 1, maxItems: WORKFLOW_MAX_STEPS }),
	},
	{
		additionalProperties: false,
	},
);

export type WorkflowOnErrorPolicy = Static<typeof workflowOnErrorSchema>;
export type WorkflowTarget = Static<typeof workflowTargetSchema>;
export type WorkflowWaitSpec = Static<typeof workflowWaitSchema>;
export type WorkflowArgDefinition = Static<typeof workflowArgDefinitionSchema>;
export type WorkflowCommandStep = Static<typeof workflowCommandStepSchema>;
export type WorkflowAssertStep = Static<typeof workflowAssertStepSchema>;
export type WorkflowRepeatStep = {
	id?: string;
	repeat: number;
	steps: WorkflowStep[];
	onError?: WorkflowOnErrorPolicy;
};
export type WorkflowEachStep = {
	id?: string;
	each: string;
	item?: string;
	index?: string;
	steps: WorkflowStep[];
	onError?: WorkflowOnErrorPolicy;
};
export type WorkflowStep = WorkflowCommandStep | WorkflowAssertStep | WorkflowRepeatStep | WorkflowEachStep;
export type WorkflowDefinition = Static<typeof workflowSchema>;

export interface WorkflowValidationError {
	path: string;
	message: string;
}

export type WorkflowValidationResult =
	| {
			ok: true;
			value: WorkflowDefinition;
	  }
	| {
			ok: false;
			errors: WorkflowValidationError[];
	  };

function formatErrorPath(path: string): string {
	if (!path) {
		return "$";
	}
	return `$${path.replaceAll("/", ".")}`;
}

export function validateWorkflowDefinition(input: unknown): WorkflowValidationResult {
	if (Value.Check(workflowSchema, input)) {
		return { ok: true, value: input as WorkflowDefinition };
	}
	const errors: WorkflowValidationError[] = [];
	for (const error of Value.Errors(workflowSchema, input)) {
		errors.push({
			path: formatErrorPath(error.path),
			message: error.message,
		});
	}
	return { ok: false, errors };
}

export function formatWorkflowValidationErrors(errors: WorkflowValidationError[]): string[] {
	return errors.map((error) => `${error.path}: ${error.message}`);
}
