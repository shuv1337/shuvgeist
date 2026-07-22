import { type Static, type TProperties, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { bridgeCli, type CliExposure, cliFlag, cliPositional, defineCliBinding, noCli } from "./cli-grammar.js";
import { workflowSchema } from "./workflow-schema.js";

export type BridgeCommandRoute = "extension" | "server-local";
export type BridgeCommandTargetKind = "chrome-tab" | "electron-window";
export type BridgeCommandTimeout = "request" | "slow" | "workflow" | "trace" | "none";

export interface BridgeCommandDefinition {
	method: string;
	capabilities: readonly string[];
	route: BridgeCommandRoute;
	targets: readonly BridgeCommandTargetKind[];
	cli: CliExposure;
	defaultTimeout: BridgeCommandTimeout;
	sensitive?: boolean;
	write?: boolean;
	params: TSchema;
	result: TSchema;
}

const noParamsSchema = Type.Object({}, { additionalProperties: false });
const jsonValueSchema = Type.Recursive((Self) =>
	Type.Union([
		Type.Null(),
		Type.Boolean(),
		Type.Number(),
		Type.String(),
		Type.Array(Self),
		Type.Record(Type.String(), Self),
	]),
);
const wireValueSchema = Type.Unsafe<unknown>(jsonValueSchema);
const jsonObjectSchema = Type.Record(Type.String(), jsonValueSchema);

const targetedBridgeParamProperties = {
	tabId: Type.Optional(Type.Integer({ minimum: 0 })),
	tabRef: Type.Optional(Type.String({ minLength: 1 })),
	windowId: Type.Optional(Type.Integer({ minimum: 0 })),
	frameId: Type.Optional(Type.Integer({ minimum: 0 })),
};

export const targetedBridgeParamsSchema = Type.Object(targetedBridgeParamProperties, {
	additionalProperties: false,
});

export const bridgeTargetSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("chrome-tab"),
			tabRef: Type.Optional(Type.String()),
			tabId: Type.Optional(Type.Number()),
			frameId: Type.Optional(Type.Number()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("electron-window"),
			appRef: Type.Optional(Type.String()),
			sessionId: Type.Optional(Type.String()),
			windowRef: Type.Optional(Type.String()),
			targetId: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
]);

/**
 * A target identity returned after dispatch has resolved a concrete page.
 * Request targets may be partial selectors; result targets never are.
 */
export const resolvedPageTargetSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("chrome-tab"),
			tabId: Type.Integer({ minimum: 0 }),
			frameId: Type.Optional(Type.Integer({ minimum: 0 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("electron-window"),
			sessionId: Type.String({ minLength: 1 }),
			windowRef: Type.String({ minLength: 1 }),
			targetId: Type.String({ minLength: 1 }),
			frameId: Type.Optional(Type.Integer({ minimum: 0 })),
		},
		{ additionalProperties: false },
	),
]);

const resolvedPageScopeResultProperties = {
	target: resolvedPageTargetSchema,
	navigationGeneration: Type.Integer({ minimum: 0 }),
	/** Chrome-only compatibility fields. New consumers should read target. */
	tabId: Type.Optional(Type.Integer({ minimum: 0 })),
	frameId: Type.Optional(Type.Integer({ minimum: 0 })),
};

export const navigateCloseTabFilterSchema = Type.Object(
	{
		titleIncludes: Type.Optional(Type.String()),
		titlePattern: Type.Optional(Type.String()),
		urlIncludes: Type.Optional(Type.String()),
		urlPattern: Type.Optional(Type.String()),
		windowId: Type.Optional(Type.Number()),
		includePinned: Type.Optional(Type.Boolean()),
		includeProtected: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const navigateParamsSchema = Type.Object(
	{
		url: Type.Optional(Type.String()),
		newTab: Type.Optional(Type.Boolean()),
		tabId: Type.Optional(Type.Number()),
		listTabs: Type.Optional(Type.Boolean()),
		switchToTab: Type.Optional(Type.Number()),
		closeTab: Type.Optional(Type.Number()),
		closeTabs: Type.Optional(Type.Array(Type.Number())),
		closeTabFilter: Type.Optional(navigateCloseTabFilterSchema),
		dryRun: Type.Optional(Type.Boolean()),
		requireMatch: Type.Optional(Type.Boolean()),
		listWindows: Type.Optional(Type.Boolean()),
		closeWindow: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

const replParamsSchema = Type.Object(
	{
		...targetedBridgeParamProperties,
		title: Type.String(),
		code: Type.String(),
	},
	{ additionalProperties: false },
);

const screenshotParamsSchema = Type.Object(
	{
		...targetedBridgeParamProperties,
		maxWidth: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

const evalParamsSchema = Type.Object(
	{
		...targetedBridgeParamProperties,
		code: Type.String(),
	},
	{ additionalProperties: false },
);

const cookiesParamsSchema = Type.Object({ url: Type.Optional(Type.String()) }, { additionalProperties: false });

const cookieSchema = Type.Object(
	{
		url: Type.String(),
		name: Type.String(),
		value: Type.String(),
		domain: Type.String(),
		path: Type.String(),
		secure: Type.Boolean(),
		httpOnly: Type.Boolean(),
		expirationDate: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

const cookieImportParamsSchema = Type.Object(
	{
		sourcePath: Type.String(),
		siteUrl: Type.String(),
		consent: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const cookieImportApplyParamsSchema = Type.Object(
	{ cookies: Type.Array(cookieSchema) },
	{ additionalProperties: false },
);

const selectElementParamsSchema = Type.Object(
	{ message: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);

const workflowRunParamsSchema = Type.Object(
	{
		workflow: workflowSchema,
		args: Type.Optional(Type.Record(Type.String(), jsonValueSchema)),
		dryRun: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const workflowValidateParamsSchema = Type.Object(
	{
		workflow: workflowSchema,
		args: Type.Optional(Type.Record(Type.String(), jsonValueSchema)),
	},
	{ additionalProperties: false },
);

const pageSnapshotParamsSchema = Type.Object(
	{
		...targetedBridgeParamProperties,
		maxEntries: Type.Optional(Type.Integer({ minimum: 1 })),
		includeHidden: Type.Optional(Type.Boolean()),
		query: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const snapshotReadParamsSchema = Type.Object(
	{
		id: Type.Optional(Type.String()),
		snapshotId: Type.Optional(Type.String()),
		tabId: Type.Optional(Type.Integer({ minimum: 0 })),
		frameId: Type.Optional(Type.Integer({ minimum: 0 })),
		limit: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

const pageAssertKindSchema = Type.Union([
	Type.Literal("expression"),
	Type.Literal("text"),
	Type.Literal("selector"),
	Type.Literal("role"),
	Type.Literal("label"),
	Type.Literal("url"),
]);

const pageAssertCommonProperties = {
	...targetedBridgeParamProperties,
	world: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("main")])),
	expression: Type.Optional(Type.String()),
	text: Type.Optional(Type.String()),
	selector: Type.Optional(Type.String()),
	role: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	label: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	urlPattern: Type.Optional(Type.String()),
	exact: Type.Optional(Type.Boolean()),
	visible: Type.Optional(Type.Boolean()),
	enabled: Type.Optional(Type.Boolean()),
	count: Type.Optional(Type.Integer({ minimum: 0 })),
	minCount: Type.Optional(Type.Integer({ minimum: 0 })),
	maxCount: Type.Optional(Type.Integer({ minimum: 0 })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 600_000 })),
	intervalMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })),
};

const pageAssertParamsSchema = Type.Union([
	Type.Object(
		{ ...pageAssertCommonProperties, kind: Type.Literal("expression"), expression: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...pageAssertCommonProperties, kind: Type.Literal("text"), text: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...pageAssertCommonProperties, kind: Type.Literal("selector"), selector: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...pageAssertCommonProperties,
			kind: Type.Literal("role"),
			role: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...pageAssertCommonProperties, kind: Type.Literal("label"), label: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...pageAssertCommonProperties, kind: Type.Literal("url"), url: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...pageAssertCommonProperties, kind: Type.Literal("url"), urlPattern: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
]);

const locateCommonProperties = {
	...targetedBridgeParamProperties,
	minScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
};

const locateByRoleParamsSchema = Type.Object(
	{ ...locateCommonProperties, role: Type.String(), name: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
const locateByTextParamsSchema = Type.Object(
	{ ...locateCommonProperties, text: Type.String() },
	{ additionalProperties: false },
);
const locateByLabelParamsSchema = Type.Object(
	{ ...locateCommonProperties, label: Type.String() },
	{ additionalProperties: false },
);

const refClickParamsSchema = Type.Object(
	{
		...targetedBridgeParamProperties,
		refId: Type.String(),
		native: Type.Optional(Type.Boolean()),
		trusted: Type.Optional(Type.Boolean()),
		waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 600_000 })),
	},
	{ additionalProperties: false },
);
const refFillParamsSchema = Type.Object(
	{
		...targetedBridgeParamProperties,
		refId: Type.String(),
		value: Type.String(),
		native: Type.Optional(Type.Boolean()),
		trusted: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const frameParamsSchema = Type.Object(
	{ tabId: Type.Optional(Type.Integer({ minimum: 0 })) },
	{ additionalProperties: false },
);
const networkStartParamsSchema = Type.Object(
	{
		tabId: Type.Optional(Type.Integer({ minimum: 0 })),
		maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
		maxBodyBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: 67_108_864 })),
	},
	{ additionalProperties: false },
);
const networkListParamsSchema = Type.Object(
	{
		tabId: Type.Optional(Type.Integer({ minimum: 0 })),
		limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
		search: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
const networkItemParamsSchema = Type.Object(
	{ tabId: Type.Optional(Type.Integer({ minimum: 0 })), requestId: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const networkCurlParamsSchema = Type.Object(
	{
		tabId: Type.Optional(Type.Integer({ minimum: 0 })),
		requestId: Type.String({ minLength: 1 }),
		includeSensitive: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const deviceEmulateParamsSchema = Type.Object(
	{
		tabId: Type.Optional(Type.Integer({ minimum: 0 })),
		preset: Type.Optional(Type.String({ minLength: 1 })),
		viewport: Type.Optional(
			Type.Object(
				{
					width: Type.Integer({ minimum: 1, maximum: 16_384 }),
					height: Type.Integer({ minimum: 1, maximum: 16_384 }),
					deviceScaleFactor: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 10 })),
					mobile: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
		),
		touch: Type.Optional(Type.Boolean()),
		userAgent: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
const tabOnlyParamsSchema = Type.Object(
	{ tabId: Type.Optional(Type.Integer({ minimum: 0 })) },
	{ additionalProperties: false },
);
const perfTraceStartParamsSchema = Type.Object(
	{
		tabId: Type.Optional(Type.Integer({ minimum: 0 })),
		autoStopMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
	},
	{ additionalProperties: false },
);

const recordStartParamsSchema = Type.Object(
	{
		...targetedBridgeParamProperties,
		maxDurationMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
		videoBitsPerSecond: Type.Optional(Type.Integer({ minimum: 1 })),
		mimeType: Type.Optional(Type.String()),
		fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
		quality: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
		maxWidth: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_384 })),
		maxHeight: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_384 })),
		everyNthFrame: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

const sessionHistoryParamsSchema = Type.Object(
	{
		last: Type.Optional(Type.Integer({ minimum: 0 })),
		afterMessageIndex: Type.Optional(Type.Integer({ minimum: -1 })),
	},
	{ additionalProperties: false },
);
const sessionInjectParamsSchema = Type.Object(
	{
		expectedSessionId: Type.String(),
		role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
		content: Type.String(),
		waitForIdle: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
const sessionNewParamsSchema = Type.Object({ model: Type.Optional(Type.String()) }, { additionalProperties: false });
const sessionSetModelParamsSchema = Type.Object(
	{ model: Type.String(), provider: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);

const appRefParamsSchema = Type.Object({ appRef: Type.String() }, { additionalProperties: false });
const optionalAppRefParamsSchema = Type.Object(
	{ appRef: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
const electronLaunchParamsSchema = Type.Object(
	{ appRef: Type.String(), inspectMain: Type.Optional(Type.Boolean()) },
	{ additionalProperties: false },
);
const electronAttachOptionalProperties = {
	appRef: Type.Optional(Type.String({ minLength: 1 })),
	pid: Type.Optional(Type.Integer({ minimum: 1 })),
	port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
	inspectPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
};
const electronAttachParamsSchema = Type.Union([
	Type.Object(
		{ ...electronAttachOptionalProperties, appRef: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...electronAttachOptionalProperties, pid: Type.Integer({ minimum: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...electronAttachOptionalProperties, port: Type.Integer({ minimum: 1, maximum: 65_535 }) },
		{ additionalProperties: false },
	),
]);
const sessionIdParamsSchema = Type.Object({ sessionId: Type.String() }, { additionalProperties: false });
const electronLabelParamsSchema = Type.Object(
	{ sessionId: Type.String(), windowRef: Type.String(), label: Type.String() },
	{ additionalProperties: false },
);
const electronIpcTapStartParamsSchema = Type.Object(
	{ sessionId: Type.String(), channel: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
function electronSourceRefSchema<T extends TProperties>(extra: T) {
	return Type.Union([
		Type.Object(
			{
				sourcePath: Type.String({ minLength: 1 }),
				appRef: Type.Optional(Type.String({ minLength: 1 })),
				...extra,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				sourcePath: Type.Optional(Type.String({ minLength: 1 })),
				appRef: Type.String({ minLength: 1 }),
				...extra,
			},
			{ additionalProperties: false },
		),
	]);
}

const electronSourceParamsSchema = electronSourceRefSchema({});
const electronSourceReadParamsSchema = electronSourceRefSchema({ filePath: Type.String({ minLength: 1 }) });
const electronSourceExtractParamsSchema = electronSourceRefSchema({
	destinationPath: Type.String({ minLength: 1 }),
});
const electronAutoAttachParamsSchema = Type.Object(
	{
		action: Type.Union([Type.Literal("status"), Type.Literal("install"), Type.Literal("uninstall")]),
		appRef: Type.String(),
	},
	{ additionalProperties: false },
);

const bridgeStatusResultSchema = Type.Object({
	ok: Type.Literal(true),
	ready: Type.Literal(true),
	windowId: Type.Optional(Type.Number()),
	sessionId: Type.Optional(Type.String()),
	capabilities: Type.Optional(Type.Array(Type.String())),
	activeTab: Type.Optional(
		Type.Object({
			url: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			tabId: Type.Optional(Type.Number()),
		}),
	),
});
const screenshotResultSchema = Type.Object({
	mimeType: Type.Union([Type.Literal("image/webp"), Type.Literal("image/png")]),
	dataUrl: Type.String(),
	imageWidth: Type.Number(),
	imageHeight: Type.Number(),
	cssWidth: Type.Number(),
	cssHeight: Type.Number(),
	devicePixelRatio: Type.Number(),
	scale: Type.Number(),
});
const replResultSchema = Type.Object({
	output: Type.String(),
	files: Type.Array(
		Type.Object({
			fileName: Type.String(),
			mimeType: Type.String(),
			size: Type.Number(),
			contentBase64: Type.String(),
		}),
	),
});
const cookieImportResultSchema = Type.Object({
	ok: Type.Literal(true),
	siteUrl: Type.String(),
	imported: Type.Number(),
	skipped: Type.Number(),
	errors: Type.Array(Type.String()),
});
const workflowValidateResultSchema = Type.Object({ ok: Type.Boolean(), errors: Type.Array(Type.String()) });
const sessionInjectResultSchema = Type.Object({
	ok: Type.Literal(true),
	sessionId: Type.String(),
	messageIndex: Type.Number(),
});
const sessionNewResultSchema = Type.Object({
	ok: Type.Literal(true),
	sessionId: Type.String(),
	model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
});
const sessionSetModelResultSchema = Type.Object({
	ok: Type.Literal(true),
	model: Type.Object({ provider: Type.String(), id: Type.String() }),
});

const stringMapSchema = Type.Record(Type.String(), Type.String());
const boundingBoxSchema = Type.Object({
	x: Type.Number(),
	y: Type.Number(),
	width: Type.Number(),
	height: Type.Number(),
});

const navigateResultSchema = Type.Object(
	{
		finalUrl: Type.Optional(Type.String()),
		title: Type.Optional(Type.String()),
		favicon: Type.Optional(Type.String()),
		tabId: Type.Optional(Type.Integer({ minimum: 0 })),
		skills: Type.Optional(
			Type.Array(
				Type.Object({
					name: Type.String(),
					shortDescription: Type.String(),
					fullDetails: Type.Optional(wireValueSchema),
				}),
			),
		),
		tabs: Type.Optional(
			Type.Array(
				Type.Object({
					id: Type.Integer({ minimum: 0 }),
					url: Type.String(),
					title: Type.String(),
					active: Type.Boolean(),
					favicon: Type.Optional(Type.String()),
					windowId: Type.Integer({ minimum: 0 }),
					index: Type.Integer({ minimum: 0 }),
					pinned: Type.Boolean(),
					status: Type.Optional(Type.String()),
				}),
			),
		),
		switchedToTab: Type.Optional(Type.Integer({ minimum: 0 })),
		windows: Type.Optional(
			Type.Array(
				Type.Object({
					id: Type.Integer({ minimum: 0 }),
					focused: Type.Boolean(),
					type: Type.Optional(Type.String()),
					tabCount: Type.Integer({ minimum: 0 }),
				}),
			),
		),
		closedTabIds: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
		closedWindowIds: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
		skipped: Type.Optional(
			Type.Array(
				Type.Object({
					tabId: Type.Optional(Type.Integer({ minimum: 0 })),
					windowId: Type.Optional(Type.Integer({ minimum: 0 })),
					reason: Type.String(),
					title: Type.Optional(Type.String()),
					url: Type.Optional(Type.String()),
				}),
			),
		),
		dryRun: Type.Optional(Type.Boolean()),
		ok: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const evalResultSchema = Type.Object({
	value: Type.Optional(wireValueSchema),
	output: Type.Optional(Type.String()),
	result: Type.Optional(wireValueSchema),
	skillsSnapshot: Type.Optional(
		Type.Object({
			state: Type.Union([
				Type.Literal("missing"),
				Type.Literal("fresh"),
				Type.Literal("stale"),
				Type.Literal("invalid"),
			]),
			generatedAt: Type.Optional(Type.String()),
			ageMs: Type.Optional(Type.Number({ minimum: 0 })),
			skillCount: Type.Optional(Type.Integer({ minimum: 0 })),
			message: Type.Optional(Type.String()),
		}),
	),
});
const browserCookieSchema = Type.Object({
	name: Type.String(),
	value: Type.String(),
	domain: Type.String(),
	path: Type.String(),
	secure: Type.Boolean(),
	httpOnly: Type.Boolean(),
	session: Type.Optional(Type.Boolean()),
	expirationDate: Type.Optional(Type.Number()),
	storeId: Type.Optional(Type.String()),
});
const cookiesResultSchema = Type.Object({ value: Type.Array(browserCookieSchema) });
const selectElementResultSchema = Type.Object({
	selector: Type.String(),
	xpath: Type.String(),
	html: Type.String(),
	tagName: Type.String(),
	attributes: stringMapSchema,
	text: Type.String(),
	boundingBox: boundingBoxSchema,
	computedStyles: stringMapSchema,
	parentChain: Type.Array(Type.String()),
});

const workflowRunResultSchema = Type.Object({
	ok: Type.Boolean(),
	aborted: Type.Boolean(),
	dryRun: Type.Boolean(),
	name: Type.Optional(Type.String()),
	startedAt: Type.String(),
	endedAt: Type.String(),
	durationMs: Type.Number({ minimum: 0 }),
	steps: Type.Array(
		Type.Object({
			path: Type.String(),
			type: Type.Union([
				Type.Literal("command"),
				Type.Literal("assert"),
				Type.Literal("repeat"),
				Type.Literal("each"),
			]),
			status: Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("aborted")]),
			durationMs: Type.Number({ minimum: 0 }),
			method: Type.Optional(Type.String()),
			as: Type.Optional(Type.String()),
			wait: Type.Optional(
				Type.Object({
					type: Type.Union([
						Type.Literal("navigation"),
						Type.Literal("dom_stable"),
						Type.Literal("network_quiet"),
					]),
					timeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
					quietMs: Type.Optional(Type.Number({ minimum: 0 })),
				}),
			),
			iterations: Type.Optional(Type.Integer({ minimum: 0 })),
			result: Type.Optional(wireValueSchema),
			error: Type.Optional(Type.String()),
		}),
	),
	captured: Type.Record(Type.String(), wireValueSchema),
	errors: Type.Array(Type.String()),
	warnings: Type.Array(
		Type.Object({ path: Type.String(), code: Type.Literal("target_unpinned"), message: Type.String() }),
	),
	truncation: Type.Object({
		stepResults: Type.Integer({ minimum: 0 }),
		captures: Type.Integer({ minimum: 0 }),
	}),
});

const pageAssertResultSchema = Type.Object({
	...resolvedPageScopeResultProperties,
	ok: Type.Boolean(),
	kind: pageAssertKindSchema,
	message: Type.String(),
	actual: Type.Optional(wireValueSchema),
	expected: Type.Optional(wireValueSchema),
	attempts: Type.Integer({ minimum: 0 }),
	durationMs: Type.Number({ minimum: 0 }),
	timeoutMs: Type.Number({ minimum: 0 }),
});

const snapshotEntrySchema = Type.Object({
	snapshotId: Type.String(),
	stableElementId: Type.Optional(Type.String()),
	/** Chrome-only compatibility fields. The enclosing result owns target identity. */
	tabId: Type.Optional(Type.Integer({ minimum: 0 })),
	frameId: Type.Optional(Type.Integer({ minimum: 0 })),
	tagName: Type.String(),
	role: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	text: Type.Optional(Type.String()),
	label: Type.Optional(Type.String()),
	attributes: stringMapSchema,
	selectorCandidates: Type.Array(Type.String()),
	ordinalPath: Type.Array(Type.Integer({ minimum: 0 })),
	boundingBox: boundingBoxSchema,
	interactive: Type.Boolean(),
	headingLevel: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
	landmark: Type.Optional(Type.String()),
});
const pageSnapshotResultSchema = Type.Object({
	...resolvedPageScopeResultProperties,
	query: Type.Optional(Type.String()),
	url: Type.String(),
	title: Type.String(),
	generatedAt: Type.Number(),
	totalCandidates: Type.Integer({ minimum: 0 }),
	truncated: Type.Boolean(),
	omissions: Type.Optional(
		Type.Object({
			total: Type.Integer({ minimum: 0 }),
			budgetOmitted: Type.Optional(Type.Integer({ minimum: 0 })),
			queryFiltered: Type.Optional(Type.Integer({ minimum: 0 })),
			byCategory: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
			byRegion: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
		}),
	),
	entries: Type.Array(snapshotEntrySchema),
});
const snapshotRecordSummarySchema = Type.Object({
	id: Type.String(),
	capturedAt: Type.String(),
	...resolvedPageScopeResultProperties,
	url: Type.String(),
	title: Type.String(),
	query: Type.Optional(Type.String()),
	entryCount: Type.Integer({ minimum: 0 }),
	totalCandidates: Type.Integer({ minimum: 0 }),
	truncated: Type.Boolean(),
});
const snapshotStoreResultSchema = Type.Object({ record: snapshotRecordSummarySchema });
const snapshotReadResultSchema = Type.Object({
	records: Type.Array(Type.Intersect([snapshotRecordSummarySchema, Type.Object({ raw: pageSnapshotResultSchema })])),
});
const snapshotLocatorMatchSchema = Type.Object({
	refId: Type.String(),
	score: Type.Number(),
	reasons: Type.Array(Type.String()),
	entry: snapshotEntrySchema,
});
const locateResultSchema = Type.Array(snapshotLocatorMatchSchema);

const refActionModeSchema = Type.Union([Type.Literal("dom"), Type.Literal("cdp-trusted")]);
const refActionKindSchema = Type.Union([Type.Literal("click"), Type.Literal("fill")]);
const refDiagnosticMatchSchema = Type.Object(
	{
		score: Type.Number(),
		reasons: Type.Array(Type.String()),
		stableElementId: Type.Optional(Type.String()),
		tagName: Type.String(),
		role: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
const refExecutionResultSchema = Type.Object(
	{
		kind: refActionKindSchema,
		strategy: Type.Optional(
			Type.Union([Type.Literal("stable-id"), Type.Literal("unique-selector"), Type.Literal("fresh-snapshot")]),
		),
		inputStrategy: Type.Optional(
			Type.Union([
				Type.Literal("value"),
				Type.Literal("select"),
				Type.Literal("contenteditable-range"),
				Type.Literal("contenteditable-exec-command"),
				Type.Literal("contenteditable-fallback"),
			]),
		),
		methods: Type.Optional(Type.Array(Type.String())),
		textLength: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{ additionalProperties: false },
);
const refActionFailureReasonSchema = Type.Union([
	Type.Literal("missing_ref"),
	Type.Literal("target_mismatch"),
	Type.Literal("frame_mismatch"),
	Type.Literal("not_found"),
	Type.Literal("ambiguous_match"),
	Type.Literal("low_confidence"),
	Type.Literal("stale_generation"),
	Type.Literal("target_changed"),
	Type.Literal("capability_denied"),
	Type.Literal("action_failed"),
	Type.Literal("beforeinput_canceled"),
	Type.Literal("aborted"),
]);
const refActionResultSchema = Type.Union([
	Type.Object(
		{
			...resolvedPageScopeResultProperties,
			ok: Type.Literal(true),
			refId: Type.String(),
			action: refActionKindSchema,
			mode: refActionModeSchema,
			native: Type.Optional(Type.Literal(true)),
			match: refDiagnosticMatchSchema,
			execution: refExecutionResultSchema,
			wait: Type.Optional(jsonObjectSchema),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...resolvedPageScopeResultProperties,
			ok: Type.Literal(false),
			refId: Type.String(),
			action: refActionKindSchema,
			mode: refActionModeSchema,
			reason: refActionFailureReasonSchema,
			message: Type.String(),
			candidates: Type.Optional(Type.Array(refDiagnosticMatchSchema)),
		},
		{ additionalProperties: false },
	),
]);
const frameDescriptorResultSchema = Type.Object({
	frameId: Type.Integer({ minimum: 0 }),
	parentFrameId: Type.Integer(),
	url: Type.String(),
	errorOccurred: Type.Optional(Type.Boolean()),
});
const frameTreeNodeResultSchema = Type.Recursive((Self) =>
	Type.Object({
		frameId: Type.Integer({ minimum: 0 }),
		parentFrameId: Type.Integer(),
		url: Type.String(),
		errorOccurred: Type.Optional(Type.Boolean()),
		depth: Type.Integer({ minimum: 0 }),
		path: Type.String(),
		children: Type.Array(Self),
	}),
);
const frameListResultSchema = Type.Array(frameDescriptorResultSchema);
const frameTreeResultSchema = Type.Object({
	roots: Type.Array(frameTreeNodeResultSchema),
	orphans: Type.Array(frameTreeNodeResultSchema),
});

const networkRequestResultSchema = Type.Object({
	id: Type.Optional(Type.String()),
	requestId: Type.String(),
	method: Type.String(),
	url: Type.String(),
	status: Type.Optional(Type.Number()),
	resourceType: Type.Optional(Type.String()),
	contentType: Type.Optional(Type.String()),
	startedAt: Type.Number(),
	endedAt: Type.Optional(Type.Number()),
	durationMs: Type.Optional(Type.Number({ minimum: 0 })),
	requestHeaders: Type.Optional(stringMapSchema),
	responseHeaders: Type.Optional(stringMapSchema),
	requestBody: Type.Optional(Type.String()),
	responseBody: Type.Optional(Type.String()),
	requestBodyTruncated: Type.Optional(Type.Boolean()),
	responseBodyTruncated: Type.Optional(Type.Boolean()),
	requestBodySize: Type.Optional(Type.Integer({ minimum: 0 })),
	responseBodySize: Type.Optional(Type.Integer({ minimum: 0 })),
	hasRequestBody: Type.Boolean(),
	hasResponseBody: Type.Boolean(),
});
const networkStatsResultSchema = Type.Object({
	...resolvedPageScopeResultProperties,
	active: Type.Boolean(),
	requestCount: Type.Integer({ minimum: 0 }),
	storedBodyBytes: Type.Integer({ minimum: 0 }),
	evictedRequests: Type.Integer({ minimum: 0 }),
});
const networkBodyResultSchema = Type.Object({
	...resolvedPageScopeResultProperties,
	requestId: Type.String(),
	requestBody: Type.Optional(Type.String()),
	responseBody: Type.Optional(Type.String()),
	requestBodyTruncated: Type.Boolean(),
	responseBodyTruncated: Type.Boolean(),
});
const networkCurlResultSchema = Type.Object({
	...resolvedPageScopeResultProperties,
	requestId: Type.String(),
	command: Type.String(),
	redactedHeaders: Type.Array(Type.String()),
});
const networkListResultSchema = Type.Object({
	...resolvedPageScopeResultProperties,
	requests: Type.Array(networkRequestResultSchema),
});
const networkGetResultSchema = Type.Object({
	...resolvedPageScopeResultProperties,
	request: networkRequestResultSchema,
});

const deviceEmulationResultSchema = Type.Object({
	ok: Type.Literal(true),
	tabId: Type.Integer({ minimum: 0 }),
	preset: Type.Optional(Type.String()),
	viewport: Type.Optional(
		Type.Object({
			width: Type.Integer({ minimum: 1 }),
			height: Type.Integer({ minimum: 1 }),
			deviceScaleFactor: Type.Optional(Type.Number()),
			mobile: Type.Optional(Type.Boolean()),
		}),
	),
	touch: Type.Optional(Type.Boolean()),
	userAgent: Type.Optional(Type.String()),
});
const deviceResetResultSchema = Type.Object({ ok: Type.Literal(true), tabId: Type.Integer({ minimum: 0 }) });
const perfMetricsResultSchema = Type.Object({
	...resolvedPageScopeResultProperties,
	metrics: Type.Array(Type.Object({ name: Type.String(), value: Type.Number() })),
});
const perfTraceStartResultSchema = Type.Object({
	ok: Type.Literal(true),
	tabId: Type.Integer({ minimum: 0 }),
	startedAt: Type.String(),
	categories: Type.Array(Type.String()),
});
const perfTraceStopResultSchema = Type.Object({
	ok: Type.Literal(true),
	tabId: Type.Integer({ minimum: 0 }),
	startedAt: Type.String(),
	endedAt: Type.String(),
	durationMs: Type.Number({ minimum: 0 }),
	eventCount: Type.Integer({ minimum: 0 }),
	traceEvents: Type.Array(wireValueSchema),
	truncated: Type.Boolean(),
	timedOut: Type.Boolean(),
	categories: Type.Array(Type.String()),
});

const recordOutcomeSchema = Type.Union([
	Type.Literal("stopped_user"),
	Type.Literal("stopped_max_duration"),
	Type.Literal("stopped_max_bytes"),
	Type.Literal("stopped_target_closed"),
	Type.Literal("stopped_error"),
]);
const recordStartResultSchema = Type.Object({
	...resolvedPageScopeResultProperties,
	ok: Type.Literal(true),
	recordingId: Type.String(),
	startedAt: Type.String(),
	mimeType: Type.String(),
	videoBitsPerSecond: Type.Optional(Type.Number({ minimum: 0 })),
	maxDurationMs: Type.Number({ minimum: 0 }),
});
const recordStopResultSchema = Type.Object({
	...resolvedPageScopeResultProperties,
	ok: Type.Literal(true),
	recordingId: Type.String(),
	startedAt: Type.String(),
	endedAt: Type.String(),
	durationMs: Type.Number({ minimum: 0 }),
	mimeType: Type.String(),
	/** Deprecated compatibility alias. When present it is the encoded output size. */
	sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
	sourceBytes: Type.Integer({ minimum: 0 }),
	encodedSizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
	chunkCount: Type.Optional(Type.Integer({ minimum: 0 })),
	frameCount: Type.Integer({ minimum: 0 }),
	outcome: recordOutcomeSchema,
	lastError: Type.Optional(Type.String()),
});
const recordStatusResultSchema = Type.Union([
	Type.Object({ ...resolvedPageScopeResultProperties, active: Type.Literal(false) }),
	Type.Object({
		...resolvedPageScopeResultProperties,
		active: Type.Literal(true),
		recordingId: Type.String(),
		startedAt: Type.String(),
		mimeType: Type.String(),
		durationMs: Type.Number({ minimum: 0 }),
		sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
		sourceBytes: Type.Integer({ minimum: 0 }),
		chunkCount: Type.Optional(Type.Integer({ minimum: 0 })),
		frameCount: Type.Integer({ minimum: 0 }),
		fps: Type.Optional(Type.Number({ minimum: 0 })),
		lastError: Type.Optional(Type.String()),
	}),
]);

const modelRefSchema = Type.Object({ provider: Type.String(), id: Type.String() });
const sessionWireAttachmentSchema = Type.Object({
	kind: Type.Union([Type.Literal("image"), Type.Literal("file")]),
	mimeType: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
});
const sessionWireMessageSchema = Type.Object({
	messageIndex: Type.Integer({ minimum: 0 }),
	role: Type.Union([
		Type.Literal("user"),
		Type.Literal("assistant"),
		Type.Literal("toolResult"),
		Type.Literal("navigation"),
	]),
	text: Type.String(),
	timestamp: Type.Optional(Type.Number()),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	toolCalls: Type.Optional(Type.Array(Type.Object({ name: Type.String(), argsSummary: Type.String() }))),
	toolName: Type.Optional(Type.String()),
	toolCallId: Type.Optional(Type.String()),
	isError: Type.Optional(Type.Boolean()),
	attachments: Type.Optional(Type.Array(sessionWireAttachmentSchema)),
});
const sessionHistoryResultSchema = Type.Object({
	sessionId: Type.Optional(Type.String()),
	persisted: Type.Boolean(),
	title: Type.String(),
	model: Type.Optional(modelRefSchema),
	isStreaming: Type.Boolean(),
	messageCount: Type.Integer({ minimum: 0 }),
	lastMessageIndex: Type.Integer({ minimum: -1 }),
	messages: Type.Array(sessionWireMessageSchema),
});
const sessionArtifactSchema = Type.Object({
	filename: Type.String(),
	content: Type.String(),
	createdAt: Type.String(),
	updatedAt: Type.String(),
});
const sessionArtifactsResultSchema = Type.Object({
	sessionId: Type.Optional(Type.String()),
	artifacts: Type.Array(sessionArtifactSchema),
});

const electronMainInspectorSchema = Type.Object({
	port: Type.Integer({ minimum: 1, maximum: 65_535 }),
	webSocketDebuggerUrl: Type.Optional(Type.String()),
	available: Type.Boolean(),
	browser: Type.Optional(Type.String()),
});
const electronWindowSummarySchema = Type.Object({
	ref: Type.String(),
	label: Type.Optional(Type.String()),
	type: Type.String(),
	title: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	isPrimary: Type.Boolean(),
	closed: Type.Optional(Type.Boolean()),
});
const electronWindowSchema = Type.Object({
	ref: Type.String(),
	targetId: Type.String(),
	label: Type.Optional(Type.String()),
	type: Type.String(),
	title: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	webSocketDebuggerUrl: Type.String(),
	isPrimary: Type.Boolean(),
	attachedAt: Type.String(),
	lastSeenAt: Type.String(),
	closed: Type.Optional(Type.Boolean()),
});
const electronSessionSummarySchema = Type.Object({
	id: Type.String(),
	appId: Type.Optional(Type.String()),
	appRef: Type.Optional(Type.String()),
	pid: Type.Optional(Type.Integer({ minimum: 1 })),
	port: Type.Integer({ minimum: 1, maximum: 65_535 }),
	browser: Type.Optional(Type.String()),
	mainInspector: Type.Optional(electronMainInspectorSchema),
	launched: Type.Boolean(),
	startedAt: Type.String(),
	windows: Type.Array(electronWindowSummarySchema),
});
const electronRegistryEntrySchema = Type.Object({
	id: Type.String(),
	aliases: Type.Array(Type.String()),
	displayName: Type.String(),
	path: Type.Optional(Type.String()),
	installed: Type.Boolean(),
	allowed: Type.Boolean(),
	singleInstance: Type.Union([Type.Literal("strict"), Type.Literal("tolerant"), Type.Literal("unknown")]),
	mainInspectSupported: Type.Boolean(),
	notes: Type.Optional(Type.String()),
});
const electronListResultSchema = Type.Object({
	apps: Type.Array(electronRegistryEntrySchema),
	sessions: Type.Array(electronSessionSummarySchema),
});
const electronAllowResultSchema = Type.Object({ ok: Type.Literal(true), appId: Type.String() });
const electronDetachResultSchema = Type.Object({ ok: Type.Boolean(), sessionId: Type.String() });
const electronWindowsResultSchema = Type.Object({ sessions: Type.Array(electronSessionSummarySchema) });
const electronLabelResultSchema = Type.Object({ ok: Type.Literal(true), window: electronWindowSchema });
const electronMainInfoResultSchema = Type.Object({
	windows: Type.Array(
		Type.Object({
			title: Type.Optional(Type.String()),
			url: Type.Optional(Type.String()),
			id: Type.Optional(Type.Integer()),
		}),
	),
	paths: Type.Object({
		appPath: Type.Optional(Type.String()),
		userData: Type.Optional(Type.String()),
		exe: Type.Optional(Type.String()),
		temp: Type.Optional(Type.String()),
	}),
	app: Type.Object({
		name: Type.Optional(Type.String()),
		version: Type.Optional(Type.String()),
		electronVersion: Type.Optional(Type.String()),
		chromeVersion: Type.Optional(Type.String()),
		nodeVersion: Type.Optional(Type.String()),
	}),
	crashDumps: Type.Object({ directory: Type.Optional(Type.String()), files: Type.Array(Type.String()) }),
});
const electronIpcTapResultSchema = Type.Object({
	id: Type.String(),
	channel: Type.Optional(Type.String()),
	startedAt: Type.String(),
	active: Type.Boolean(),
	warning: Type.String(),
});
const electronIpcTapStopResultSchema = Type.Object({
	ok: Type.Literal(true),
	stopped: Type.Integer({ minimum: 0 }),
	warning: Type.String(),
});
const electronMainNetworkStartResultSchema = Type.Object({
	id: Type.String(),
	startedAt: Type.String(),
	active: Type.Boolean(),
	source: Type.Literal("main"),
});
const electronMainNetworkStopResultSchema = Type.Object({
	ok: Type.Literal(true),
	stopped: Type.Integer({ minimum: 0 }),
	source: Type.Literal("main"),
});
const electronSourceLayoutResultSchema = Type.Object({
	kind: Type.Union([Type.Literal("asar"), Type.Literal("unpacked"), Type.Literal("unsupported")]),
	root: Type.String(),
	appPath: Type.Optional(Type.String()),
	asarPath: Type.Optional(Type.String()),
	unpackedPath: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
});
const electronSourceEntrySchema = Type.Object({
	path: Type.String(),
	type: Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("symlink")]),
	size: Type.Optional(Type.Integer({ minimum: 0 })),
	unpacked: Type.Optional(Type.Boolean()),
	link: Type.Optional(Type.String()),
});
const electronSourceListResultSchema = Type.Object({
	layout: electronSourceLayoutResultSchema,
	entries: Type.Array(electronSourceEntrySchema),
});
const electronSourceReadResultSchema = Type.Object({
	layout: electronSourceLayoutResultSchema,
	path: Type.String(),
	text: Type.String(),
});
const electronSourceExtractResultSchema = Type.Object({
	layout: electronSourceLayoutResultSchema,
	destinationPath: Type.String(),
	entries: Type.Array(electronSourceEntrySchema),
});
const electronDoctorCheckSchema = Type.Object({
	id: Type.String(),
	status: Type.Union([Type.Literal("pass"), Type.Literal("warn"), Type.Literal("fail")]),
	label: Type.String(),
	detail: Type.String(),
	fix: Type.Optional(Type.String()),
});
const electronDoctorResultSchema = Type.Object({
	ok: Type.Boolean(),
	summary: Type.String(),
	checks: Type.Array(electronDoctorCheckSchema),
	fixes: Type.Array(Type.String()),
	runningCdpApps: Type.Array(
		Type.Object({
			port: Type.Integer({ minimum: 1, maximum: 65_535 }),
			browser: Type.Optional(Type.String()),
			webSocketDebuggerUrl: Type.Optional(Type.String()),
		}),
	),
	text: Type.String(),
});
const electronAutoAttachResultSchema = Type.Object({
	ok: Type.Boolean(),
	supported: Type.Boolean(),
	action: Type.Union([Type.Literal("status"), Type.Literal("install"), Type.Literal("uninstall")]),
	appRef: Type.String(),
	appId: Type.Optional(Type.String()),
	path: Type.Optional(Type.String()),
	installed: Type.Boolean(),
	message: Type.String(),
	text: Type.String(),
});
const skillSnapshotStatusResultSchema = Type.Object({
	state: Type.Union([Type.Literal("missing"), Type.Literal("fresh"), Type.Literal("stale"), Type.Literal("invalid")]),
	generatedAt: Type.Optional(Type.String()),
	ageMs: Type.Optional(Type.Number({ minimum: 0 })),
	skillCount: Type.Optional(Type.Integer({ minimum: 0 })),
	message: Type.Optional(Type.String()),
});

const cliTargetFlags = [
	cliFlag("target"),
	cliFlag("tabId", { param: "tabId", parse: "integer" }),
	cliFlag("frameId", { param: "frameId", parse: "integer" }),
] as const;
const cliTabTargetFlags = [cliFlag("target"), cliFlag("tabId", { param: "tabId", parse: "integer" })] as const;
const cliAssertionFlags = [
	...cliTargetFlags,
	cliFlag("timeout", { input: "assertionTimeout", parse: "duration" }),
	cliFlag("interval", { param: "intervalMs", parse: "duration" }),
	cliFlag("exact", { param: "exact", parse: "boolean" }),
	cliFlag("visible", { param: "visible", parse: "boolean" }),
	cliFlag("enabled", { param: "enabled", parse: "boolean" }),
	cliFlag("count", { param: "count", parse: "integer" }),
	cliFlag("minCount", { param: "minCount", parse: "integer" }),
	cliFlag("maxCount", { param: "maxCount", parse: "integer" }),
	cliFlag("world", { param: "world" }),
	cliFlag("urlPattern", { param: "urlPattern" }),
] as const;

/**
 * Complete bridge-command definitions. This is the sole declaration site for
 * command identity, wire schemas, routing metadata, CLI families, and policy.
 * Every derived catalog, method union, validator, and planner coverage check
 * starts from this array.
 */
export const BridgeCommandDefinitions = [
	{
		method: "status",
		capabilities: ["status"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: noCli("shadowed-by-local-command"),
		defaultTimeout: "request",
		params: noParamsSchema,
		result: bridgeStatusResultSchema,
	},
	{
		method: "navigate",
		capabilities: ["navigate", "tabs"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "navigate",
				select: [],
				usage: "Usage: shuvgeist navigate <url> [--new-tab]",
				flags: [cliFlag("target"), cliFlag("newTab", { param: "newTab", parse: "boolean" })],
				positionals: [cliPositional("url", { source: "index", index: 0, param: "url", required: true })],
				codec: "generic",
			}),
			defineCliBinding({
				family: "tabs",
				select: ["list"],
				default: true,
				usage: "Usage: shuvgeist tabs [list]",
				flags: [cliFlag("target")],
				positionals: [],
				constants: { listTabs: true },
				codec: "generic",
			}),
			defineCliBinding({
				family: "tabs",
				select: ["close"],
				usage: "Usage: shuvgeist tabs close <tabId...> | filters [--yes|--dry-run]",
				flags: [
					cliFlag("target"),
					cliFlag("dryRun", { input: "dryRun" }),
					cliFlag("yes", { input: "yes" }),
					cliFlag("includePinned", { input: "includePinned" }),
					cliFlag("includeProtected", { input: "includeProtected" }),
					cliFlag("requireMatch", { input: "requireMatch" }),
					cliFlag("titleMatch", { input: "titleMatch" }),
					cliFlag("urlMatch", { input: "urlMatch" }),
					cliFlag("titlePattern", { input: "titlePattern" }),
					cliFlag("urlPattern", { input: "urlPattern" }),
					cliFlag("windowId", { input: "windowId", parse: "integer" }),
				],
				positionals: [
					cliPositional("tabIds", { source: "rest", index: 0, input: "tabIds", parse: "integer", join: "array" }),
				],
				codec: "tabs-close",
			}),
			defineCliBinding({
				family: "switch",
				select: [],
				usage: "Usage: shuvgeist switch <tabId>",
				flags: [cliFlag("target")],
				positionals: [
					cliPositional("tabId", {
						source: "index",
						index: 0,
						param: "switchToTab",
						parse: "integer",
						required: true,
					}),
				],
				codec: "generic",
			}),
			defineCliBinding({
				family: "windows",
				select: ["list"],
				default: true,
				usage: "Usage: shuvgeist windows [list]",
				flags: [cliFlag("target")],
				positionals: [],
				constants: { listWindows: true },
				codec: "generic",
			}),
			defineCliBinding({
				family: "windows",
				select: ["close"],
				usage: "Usage: shuvgeist windows close <windowId> [--yes|--dry-run]",
				flags: [
					cliFlag("target"),
					cliFlag("yes", { input: "yes" }),
					cliFlag("dryRun", { input: "dryRun" }),
					cliFlag("requireMatch", { input: "requireMatch" }),
				],
				positionals: [
					cliPositional("windowId", {
						source: "index",
						index: 0,
						input: "windowId",
						parse: "integer",
						required: true,
					}),
				],
				codec: "windows-close",
			}),
		),
		defaultTimeout: "request",
		params: navigateParamsSchema,
		result: navigateResultSchema,
	},
	{
		method: "repl",
		capabilities: ["repl"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "repl",
				select: [],
				usage: "Usage: shuvgeist repl <code> or shuvgeist repl -f <file.js>",
				flags: [...cliTargetFlags, cliFlag("file", { input: "file" }), cliFlag("writeFiles")],
				positionals: [cliPositional("code", { source: "rest", index: 0, input: "code", join: "space" })],
				codec: "repl",
				runner: "repl",
			}),
		),
		defaultTimeout: "slow",
		params: replParamsSchema,
		result: replResultSchema,
	},
	{
		method: "screenshot",
		capabilities: ["screenshot"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "screenshot",
				select: [],
				usage: "Usage: shuvgeist screenshot [--max-width N]",
				flags: [
					...cliTargetFlags,
					cliFlag("maxWidth", { param: "maxWidth", parse: "integer" }),
					cliFlag("out"),
					cliFlag("noViewportJson"),
				],
				positionals: [],
				codec: "generic",
				runner: "screenshot",
			}),
		),
		defaultTimeout: "slow",
		params: screenshotParamsSchema,
		result: screenshotResultSchema,
	},
	{
		method: "eval",
		capabilities: ["eval"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "eval",
				select: [],
				usage: "Usage: shuvgeist eval <code>",
				flags: [...cliTargetFlags],
				positionals: [
					cliPositional("code", { source: "rest", index: 0, param: "code", join: "space", required: true }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "slow",
		sensitive: true,
		params: evalParamsSchema,
		result: evalResultSchema,
	},
	{
		method: "cookies",
		capabilities: ["cookies"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "cookies",
				select: [],
				usage: "Usage: shuvgeist cookies",
				flags: [cliFlag("target")],
				positionals: [],
				codec: "generic",
				runner: "cookies",
			}),
		),
		defaultTimeout: "slow",
		sensitive: true,
		params: cookiesParamsSchema,
		result: cookiesResultSchema,
	},
	{
		method: "cookie_import",
		capabilities: ["cookie_import"],
		route: "server-local",
		targets: [],
		cli: noCli("server-internal"),
		defaultTimeout: "slow",
		sensitive: true,
		params: cookieImportParamsSchema,
		result: cookieImportResultSchema,
	},
	{
		method: "cookie_import_apply",
		capabilities: ["cookie_import_apply"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: noCli("extension-internal"),
		defaultTimeout: "slow",
		sensitive: true,
		params: cookieImportApplyParamsSchema,
		result: cookieImportResultSchema,
	},
	{
		method: "select_element",
		capabilities: ["select_element"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "select",
				select: [],
				usage: "Usage: shuvgeist select <message>",
				flags: [cliFlag("target")],
				positionals: [
					cliPositional("message", { source: "rest", index: 0, param: "message", join: "space", required: true }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "none",
		params: selectElementParamsSchema,
		result: selectElementResultSchema,
	},
	{
		method: "workflow_run",
		capabilities: ["workflow_run"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "workflow",
				select: ["run"],
				usage: "Usage: shuvgeist workflow run (--file file.json | --inline '{...}') [--arg key=value]",
				flags: [
					cliFlag("file", { input: "file" }),
					cliFlag("inline", { input: "inline" }),
					cliFlag("arg", { input: "arg" }),
					cliFlag("dryRun", { param: "dryRun", parse: "boolean" }),
				],
				positionals: [],
				codec: "workflow",
				runner: "workflow",
			}),
		),
		defaultTimeout: "workflow",
		params: workflowRunParamsSchema,
		result: workflowRunResultSchema,
	},
	{
		method: "workflow_validate",
		capabilities: ["workflow_validate"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "workflow",
				select: ["validate"],
				usage: "Usage: shuvgeist workflow validate (--file file.json | --inline '{...}') [--arg key=value]",
				flags: [
					cliFlag("file", { input: "file" }),
					cliFlag("inline", { input: "inline" }),
					cliFlag("arg", { input: "arg" }),
				],
				positionals: [],
				codec: "workflow",
				runner: "workflow",
			}),
		),
		defaultTimeout: "workflow",
		params: workflowValidateParamsSchema,
		result: workflowValidateResultSchema,
	},
	{
		method: "page_snapshot",
		capabilities: ["page_snapshot"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "snapshot",
				select: [],
				usage: "Usage: shuvgeist snapshot [--max-entries N] [--include-hidden]",
				flags: [
					...cliTargetFlags,
					cliFlag("maxEntries", { param: "maxEntries", parse: "integer" }),
					cliFlag("includeHidden", { param: "includeHidden", parse: "boolean" }),
				],
				positionals: [],
				codec: "generic",
			}),
		),
		defaultTimeout: "slow",
		params: pageSnapshotParamsSchema,
		result: pageSnapshotResultSchema,
	},
	{
		method: "snapshot_store",
		capabilities: ["snapshot_store"],
		route: "server-local",
		targets: [],
		cli: noCli("server-internal"),
		defaultTimeout: "slow",
		params: pageSnapshotParamsSchema,
		result: snapshotStoreResultSchema,
	},
	{
		method: "snapshot_read",
		capabilities: ["snapshot_read"],
		route: "server-local",
		targets: [],
		cli: noCli("server-internal"),
		defaultTimeout: "request",
		params: snapshotReadParamsSchema,
		result: snapshotReadResultSchema,
	},
	{
		method: "page_assert",
		capabilities: ["page_assert"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "assert",
				select: ["expr"],
				aliases: [["expression"]],
				usage: "Usage: shuvgeist assert expr <expression>",
				flags: [...cliAssertionFlags],
				positionals: [
					cliPositional("expression", {
						source: "rest",
						index: 0,
						param: "expression",
						join: "space",
						required: true,
					}),
				],
				constants: { kind: "expression" },
				codec: "assert",
				runner: "assert",
			}),
			defineCliBinding({
				family: "assert",
				select: ["text"],
				usage: "Usage: shuvgeist assert text <text>",
				flags: [...cliAssertionFlags],
				positionals: [
					cliPositional("text", { source: "rest", index: 0, param: "text", join: "space", required: true }),
				],
				constants: { kind: "text" },
				codec: "assert",
				runner: "assert",
			}),
			defineCliBinding({
				family: "assert",
				select: ["selector"],
				usage: "Usage: shuvgeist assert selector <selector>",
				flags: [...cliAssertionFlags],
				positionals: [
					cliPositional("selector", {
						source: "rest",
						index: 0,
						param: "selector",
						join: "space",
						required: true,
					}),
				],
				constants: { kind: "selector" },
				codec: "assert",
				runner: "assert",
			}),
			defineCliBinding({
				family: "assert",
				select: ["role"],
				usage: "Usage: shuvgeist assert role <role> [--name name]",
				flags: [...cliAssertionFlags, cliFlag("name", { param: "name" })],
				positionals: [
					cliPositional("role", { source: "rest", index: 0, param: "role", join: "space", required: true }),
				],
				constants: { kind: "role" },
				codec: "assert",
				runner: "assert",
			}),
			defineCliBinding({
				family: "assert",
				select: ["label"],
				usage: "Usage: shuvgeist assert label <label>",
				flags: [...cliAssertionFlags],
				positionals: [
					cliPositional("label", { source: "rest", index: 0, param: "label", join: "space", required: true }),
				],
				constants: { kind: "label" },
				codec: "assert",
				runner: "assert",
			}),
			defineCliBinding({
				family: "assert",
				select: ["url"],
				usage: "Usage: shuvgeist assert url <url> [--url-pattern regex]",
				flags: [...cliAssertionFlags],
				positionals: [cliPositional("url", { source: "rest", index: 0, param: "url", join: "space" })],
				constants: { kind: "url" },
				codec: "assert",
				runner: "assert",
			}),
		),
		defaultTimeout: "request",
		params: pageAssertParamsSchema,
		result: pageAssertResultSchema,
	},
	{
		method: "locate_by_role",
		capabilities: ["locate_by_role"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "locate",
				select: ["role"],
				usage: "Usage: shuvgeist locate role <role> [--name name]",
				flags: [
					...cliTargetFlags,
					cliFlag("limit", { param: "limit", parse: "integer" }),
					cliFlag("minScore", { param: "minScore", parse: "number" }),
					cliFlag("name", { param: "name" }),
				],
				positionals: [
					cliPositional("role", { source: "rest", index: 0, param: "role", join: "space", required: true }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: locateByRoleParamsSchema,
		result: locateResultSchema,
	},
	{
		method: "locate_by_text",
		capabilities: ["locate_by_text"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "locate",
				select: ["text"],
				usage: "Usage: shuvgeist locate text <text>",
				flags: [
					...cliTargetFlags,
					cliFlag("limit", { param: "limit", parse: "integer" }),
					cliFlag("minScore", { param: "minScore", parse: "number" }),
				],
				positionals: [
					cliPositional("text", { source: "rest", index: 0, param: "text", join: "space", required: true }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: locateByTextParamsSchema,
		result: locateResultSchema,
	},
	{
		method: "locate_by_label",
		capabilities: ["locate_by_label"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "locate",
				select: ["label"],
				usage: "Usage: shuvgeist locate label <label>",
				flags: [
					...cliTargetFlags,
					cliFlag("limit", { param: "limit", parse: "integer" }),
					cliFlag("minScore", { param: "minScore", parse: "number" }),
				],
				positionals: [
					cliPositional("label", { source: "rest", index: 0, param: "label", join: "space", required: true }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: locateByLabelParamsSchema,
		result: locateResultSchema,
	},
	{
		method: "ref_click",
		capabilities: ["ref_click"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "ref",
				select: ["click"],
				usage: "Usage: shuvgeist ref click <refId>",
				flags: [
					...cliTargetFlags,
					cliFlag("native", { param: "native", parse: "boolean" }),
					cliFlag("trusted", { param: "trusted", parse: "boolean" }),
					cliFlag("timeout", { param: "waitMs", parse: "duration" }),
				],
				positionals: [cliPositional("refId", { source: "index", index: 0, param: "refId", required: true })],
				codec: "ref-action",
			}),
		),
		defaultTimeout: "request",
		params: refClickParamsSchema,
		result: refActionResultSchema,
	},
	{
		method: "ref_fill",
		capabilities: ["ref_fill"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "ref",
				select: ["fill"],
				usage: "Usage: shuvgeist ref fill <refId> --value <text>",
				flags: [
					...cliTargetFlags,
					cliFlag("native", { param: "native", parse: "boolean" }),
					cliFlag("trusted", { param: "trusted", parse: "boolean" }),
					cliFlag("value", { param: "value" }),
				],
				positionals: [cliPositional("refId", { source: "index", index: 0, param: "refId", required: true })],
				codec: "ref-fill",
			}),
		),
		defaultTimeout: "request",
		params: refFillParamsSchema,
		result: refActionResultSchema,
	},
	{
		method: "frame_list",
		capabilities: ["frame_list"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "frame",
				select: ["list"],
				usage: "Usage: shuvgeist frame list [--tab-id N]",
				flags: [...cliTabTargetFlags],
				positionals: [],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: frameParamsSchema,
		result: frameListResultSchema,
	},
	{
		method: "frame_tree",
		capabilities: ["frame_tree"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "frame",
				select: ["tree"],
				usage: "Usage: shuvgeist frame tree [--tab-id N]",
				flags: [...cliTabTargetFlags],
				positionals: [],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: frameParamsSchema,
		result: frameTreeResultSchema,
	},
	{
		method: "network_start",
		capabilities: ["network_start"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "network",
				select: ["start"],
				usage: "Usage: shuvgeist network start",
				flags: [...cliTabTargetFlags],
				positionals: [],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: networkStartParamsSchema,
		result: networkStatsResultSchema,
	},
	{
		method: "network_stop",
		capabilities: ["network_stop"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "network",
				select: ["stop"],
				usage: "Usage: shuvgeist network stop",
				flags: [...cliTabTargetFlags],
				positionals: [],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: tabOnlyParamsSchema,
		result: networkStatsResultSchema,
	},
	{
		method: "network_list",
		capabilities: ["network_list"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "network",
				select: ["list"],
				usage: "Usage: shuvgeist network list [--limit N] [--search text]",
				flags: [
					...cliTabTargetFlags,
					cliFlag("limit", { param: "limit", parse: "integer" }),
					cliFlag("search", { param: "search" }),
				],
				positionals: [],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: networkListParamsSchema,
		result: networkListResultSchema,
	},
	{
		method: "network_clear",
		capabilities: ["network_clear"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "network",
				select: ["clear"],
				usage: "Usage: shuvgeist network clear",
				flags: [...cliTabTargetFlags],
				positionals: [],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: tabOnlyParamsSchema,
		result: networkStatsResultSchema,
	},
	{
		method: "network_stats",
		capabilities: ["network_stats"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "network",
				select: ["stats"],
				usage: "Usage: shuvgeist network stats",
				flags: [...cliTabTargetFlags],
				positionals: [],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: tabOnlyParamsSchema,
		result: networkStatsResultSchema,
	},
	{
		method: "network_get",
		capabilities: ["network_get"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "network",
				select: ["get"],
				usage: "Usage: shuvgeist network get <requestId>",
				flags: [...cliTabTargetFlags],
				positionals: [
					cliPositional("requestId", { source: "index", index: 0, param: "requestId", required: true }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		sensitive: true,
		params: networkItemParamsSchema,
		result: networkGetResultSchema,
	},
	{
		method: "network_body",
		capabilities: ["network_body"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "network",
				select: ["body"],
				usage: "Usage: shuvgeist network body <requestId>",
				flags: [...cliTabTargetFlags],
				positionals: [
					cliPositional("requestId", { source: "index", index: 0, param: "requestId", required: true }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		sensitive: true,
		params: networkItemParamsSchema,
		result: networkBodyResultSchema,
	},
	{
		method: "network_curl",
		capabilities: ["network_curl"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "network",
				select: ["curl"],
				usage: "Usage: shuvgeist network curl <requestId> [--include-sensitive]",
				flags: [...cliTabTargetFlags, cliFlag("includeSensitive", { param: "includeSensitive", parse: "boolean" })],
				positionals: [
					cliPositional("requestId", { source: "index", index: 0, param: "requestId", required: true }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		sensitive: true,
		params: networkCurlParamsSchema,
		result: networkCurlResultSchema,
	},
	{
		method: "device_emulate",
		capabilities: ["device_emulate"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "device",
				select: ["emulate"],
				usage: "Usage: shuvgeist device emulate [--preset name | --width N --height N]",
				flags: [
					...cliTabTargetFlags,
					cliFlag("preset", { param: "preset" }),
					cliFlag("width", { input: "width", parse: "integer" }),
					cliFlag("height", { input: "height", parse: "integer" }),
					cliFlag("dpr", { input: "dpr", parse: "number" }),
					cliFlag("mobile", { input: "mobile" }),
					cliFlag("touch", { param: "touch", parse: "boolean" }),
					cliFlag("userAgent", { param: "userAgent" }),
				],
				positionals: [],
				codec: "device-emulate",
			}),
		),
		defaultTimeout: "request",
		params: deviceEmulateParamsSchema,
		result: deviceEmulationResultSchema,
	},
	{
		method: "device_reset",
		capabilities: ["device_reset"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "device",
				select: ["reset"],
				usage: "Usage: shuvgeist device reset",
				flags: [...cliTabTargetFlags],
				positionals: [],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: tabOnlyParamsSchema,
		result: deviceResetResultSchema,
	},
	{
		method: "perf_metrics",
		capabilities: ["perf_metrics"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "perf",
				select: ["metrics"],
				usage: "Usage: shuvgeist perf metrics",
				flags: [...cliTabTargetFlags],
				positionals: [],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: tabOnlyParamsSchema,
		result: perfMetricsResultSchema,
	},
	{
		method: "perf_trace_start",
		capabilities: ["perf_trace_start"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "perf",
				select: ["trace-start"],
				usage: "Usage: shuvgeist perf trace-start [--auto-stop N]",
				flags: [...cliTabTargetFlags, cliFlag("autoStop", { param: "autoStopMs", parse: "integer" })],
				positionals: [],
				codec: "generic",
			}),
		),
		defaultTimeout: "trace",
		params: perfTraceStartParamsSchema,
		result: perfTraceStartResultSchema,
	},
	{
		method: "perf_trace_stop",
		capabilities: ["perf_trace_stop"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "perf",
				select: ["trace-stop"],
				usage: "Usage: shuvgeist perf trace-stop",
				flags: [...cliTabTargetFlags],
				positionals: [],
				codec: "generic",
			}),
		),
		defaultTimeout: "trace",
		params: tabOnlyParamsSchema,
		result: perfTraceStopResultSchema,
	},
	{
		method: "record_start",
		capabilities: ["record_start"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "record",
				select: ["start"],
				usage: "Usage: shuvgeist record start --out file.webm [recording options]",
				flags: [
					...cliTargetFlags,
					cliFlag("out", { input: "out" }),
					cliFlag("maxDuration", { input: "maxDuration" }),
					cliFlag("videoBitrate", { input: "videoBitrate" }),
					cliFlag("fps", { input: "fps" }),
					cliFlag("quality", { input: "quality" }),
					cliFlag("maxWidth", { input: "maxWidth" }),
					cliFlag("maxHeight", { input: "maxHeight" }),
					cliFlag("mimeType", { input: "mimeType" }),
				],
				positionals: [],
				codec: "record-start",
				runner: "record",
			}),
		),
		defaultTimeout: "none",
		sensitive: true,
		params: recordStartParamsSchema,
		result: recordStartResultSchema,
	},
	{
		method: "record_stop",
		capabilities: ["record_stop"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "record",
				select: ["stop"],
				usage: "Usage: shuvgeist record stop",
				flags: [...cliTargetFlags],
				positionals: [],
				codec: "generic",
				runner: "record",
			}),
		),
		defaultTimeout: "request",
		sensitive: true,
		params: targetedBridgeParamsSchema,
		result: recordStopResultSchema,
	},
	{
		method: "record_status",
		capabilities: ["record_status"],
		route: "extension",
		targets: ["chrome-tab", "electron-window"],
		cli: bridgeCli(
			defineCliBinding({
				family: "record",
				select: ["status"],
				usage: "Usage: shuvgeist record status",
				flags: [...cliTargetFlags],
				positionals: [],
				codec: "generic",
				runner: "record",
			}),
		),
		defaultTimeout: "request",
		sensitive: true,
		params: targetedBridgeParamsSchema,
		result: recordStatusResultSchema,
	},
	{
		method: "session_history",
		capabilities: ["session_history"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "session",
				select: [],
				usage: "Usage: shuvgeist session [--last N] [--follow]",
				flags: [cliFlag("last", { param: "last", parse: "integer" }), cliFlag("follow", { input: "follow" })],
				positionals: [],
				codec: "generic",
				runner: "session",
			}),
		),
		defaultTimeout: "request",
		params: sessionHistoryParamsSchema,
		result: sessionHistoryResultSchema,
	},
	{
		method: "session_inject",
		capabilities: ["session_inject"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "inject",
				select: [],
				usage: "Usage: shuvgeist inject <text> [--role user|assistant]",
				flags: [cliFlag("role", { input: "role" })],
				positionals: [
					cliPositional("text", { source: "rest", index: 0, input: "text", join: "space", required: true }),
				],
				codec: "generic",
				runner: "inject",
			}),
		),
		defaultTimeout: "request",
		write: true,
		params: sessionInjectParamsSchema,
		result: sessionInjectResultSchema,
	},
	{
		method: "session_new",
		capabilities: ["session_new"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "new-session",
				select: [],
				usage: "Usage: shuvgeist new-session [provider/model-id]",
				flags: [],
				positionals: [cliPositional("model", { source: "index", index: 0, param: "model" })],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		write: true,
		params: sessionNewParamsSchema,
		result: sessionNewResultSchema,
	},
	{
		method: "session_set_model",
		capabilities: ["session_set_model"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "set-model",
				select: [],
				usage: "Usage: shuvgeist set-model <provider/model-id>",
				flags: [],
				positionals: [cliPositional("model", { source: "index", index: 0, param: "model", required: true })],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		write: true,
		params: sessionSetModelParamsSchema,
		result: sessionSetModelResultSchema,
	},
	{
		method: "session_artifacts",
		capabilities: ["session_artifacts"],
		route: "extension",
		targets: ["chrome-tab"],
		cli: bridgeCli(
			defineCliBinding({
				family: "artifacts",
				select: [],
				usage: "Usage: shuvgeist artifacts",
				flags: [],
				positionals: [],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: noParamsSchema,
		result: sessionArtifactsResultSchema,
	},
	{
		method: "electron_list",
		capabilities: ["electron_list"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["list"],
				default: true,
				usage: "Usage: shuvgeist electron [list]",
				flags: [],
				positionals: [],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: noParamsSchema,
		result: electronListResultSchema,
	},
	{
		method: "electron_allow",
		capabilities: ["electron_allow"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["allow"],
				usage: "Usage: shuvgeist electron allow <app-id-or-alias>",
				flags: [],
				positionals: [cliPositional("appRef", { source: "index", index: 0, param: "appRef", required: true })],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: appRefParamsSchema,
		result: electronAllowResultSchema,
	},
	{
		method: "electron_launch",
		capabilities: ["electron_launch"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["launch"],
				usage: "Usage: shuvgeist electron launch <app-id-or-alias>",
				flags: [cliFlag("inspectMain", { param: "inspectMain", parse: "boolean" })],
				positionals: [cliPositional("appRef", { source: "index", index: 0, param: "appRef", required: true })],
				codec: "generic",
			}),
		),
		defaultTimeout: "slow",
		params: electronLaunchParamsSchema,
		result: electronSessionSummarySchema,
	},
	{
		method: "electron_attach",
		capabilities: ["electron_attach"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["attach"],
				usage: "Usage: shuvgeist electron attach [app] [--port N|--pid N]",
				flags: [
					cliFlag("port", { param: "port", parse: "integer" }),
					cliFlag("pid", { param: "pid", parse: "integer" }),
					cliFlag("inspectPort", { param: "inspectPort", parse: "integer" }),
				],
				positionals: [cliPositional("appRef", { source: "index", index: 0, param: "appRef" })],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: electronAttachParamsSchema,
		result: electronSessionSummarySchema,
	},
	{
		method: "electron_detach",
		capabilities: ["electron_detach"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["detach"],
				usage: "Usage: shuvgeist electron detach <session-id>",
				flags: [],
				positionals: [
					cliPositional("sessionId", { source: "index", index: 0, param: "sessionId", required: true }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: sessionIdParamsSchema,
		result: electronDetachResultSchema,
	},
	{
		method: "electron_windows",
		capabilities: ["electron_windows"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["windows"],
				usage: "Usage: shuvgeist electron windows [app]",
				flags: [],
				positionals: [cliPositional("appRef", { source: "index", index: 0, input: "appRef" })],
				codec: "electron-windows",
			}),
		),
		defaultTimeout: "request",
		params: noParamsSchema,
		result: electronWindowsResultSchema,
	},
	{
		method: "electron_label",
		capabilities: ["electron_label"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["label"],
				usage: "Usage: shuvgeist electron label <session-id> <window-ref> <label>",
				flags: [],
				positionals: [
					cliPositional("sessionId", { source: "index", index: 0, param: "sessionId", required: true }),
					cliPositional("windowRef", { source: "index", index: 1, param: "windowRef", required: true }),
					cliPositional("label", { source: "rest", index: 2, param: "label", join: "space", required: true }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: electronLabelParamsSchema,
		result: electronLabelResultSchema,
	},
	{
		method: "electron_main_info",
		capabilities: ["electron_main_info"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["main"],
				usage: "Usage: shuvgeist electron main <session-id>",
				flags: [],
				positionals: [
					cliPositional("sessionId", { source: "index", index: 0, param: "sessionId", required: true }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: sessionIdParamsSchema,
		result: electronMainInfoResultSchema,
	},
	{
		method: "electron_ipc_tap_start",
		capabilities: ["electron_ipc_tap_start"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["ipc", "tap"],
				usage: "Usage: shuvgeist electron ipc tap <session-id> [--channel filter]",
				flags: [cliFlag("channel", { param: "channel" })],
				positionals: [
					cliPositional("sessionId", { source: "index", index: 0, param: "sessionId", required: true }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: electronIpcTapStartParamsSchema,
		result: electronIpcTapResultSchema,
	},
	{
		method: "electron_ipc_tap_stop",
		capabilities: ["electron_ipc_tap_stop"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["ipc", "untap"],
				aliases: [["ipc", "stop"]],
				usage: "Usage: shuvgeist electron ipc untap <session-id>",
				flags: [],
				positionals: [
					cliPositional("sessionId", { source: "index", index: 0, param: "sessionId", required: true }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: sessionIdParamsSchema,
		result: electronIpcTapStopResultSchema,
	},
	{
		method: "electron_main_network_start",
		capabilities: ["electron_main_network_start"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["network-main", "start"],
				usage: "Usage: shuvgeist electron network-main start <session-id>",
				flags: [],
				positionals: [
					cliPositional("sessionId", { source: "index", index: 0, param: "sessionId", required: true }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: sessionIdParamsSchema,
		result: electronMainNetworkStartResultSchema,
	},
	{
		method: "electron_main_network_stop",
		capabilities: ["electron_main_network_stop"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["network-main", "stop"],
				usage: "Usage: shuvgeist electron network-main stop <session-id>",
				flags: [],
				positionals: [
					cliPositional("sessionId", { source: "index", index: 0, param: "sessionId", required: true }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: sessionIdParamsSchema,
		result: electronMainNetworkStopResultSchema,
	},
	{
		method: "electron_source_layout",
		capabilities: ["electron_source_layout"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["source", "layout"],
				usage: "Usage: shuvgeist electron source layout [app] [--source-path path]",
				flags: [cliFlag("sourcePath", { param: "sourcePath" })],
				positionals: [cliPositional("appRef", { source: "index", index: 0, param: "appRef" })],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: electronSourceParamsSchema,
		result: electronSourceLayoutResultSchema,
	},
	{
		method: "electron_source_list",
		capabilities: ["electron_source_list"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["source", "list"],
				usage: "Usage: shuvgeist electron source list [app] [--source-path path]",
				flags: [cliFlag("sourcePath", { param: "sourcePath" })],
				positionals: [cliPositional("appRef", { source: "index", index: 0, param: "appRef" })],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: electronSourceParamsSchema,
		result: electronSourceListResultSchema,
	},
	{
		method: "electron_source_read",
		capabilities: ["electron_source_read"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["source", "read"],
				usage: "Usage: shuvgeist electron source read <file> [app] --source-path <path>",
				flags: [cliFlag("sourcePath", { param: "sourcePath" })],
				positionals: [
					cliPositional("filePath", { source: "index", index: 0, param: "filePath", required: true }),
					cliPositional("appRef", { source: "index", index: 1, param: "appRef" }),
				],
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: electronSourceReadParamsSchema,
		result: electronSourceReadResultSchema,
	},
	{
		method: "electron_source_extract",
		capabilities: ["electron_source_extract"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["source", "extract"],
				usage: "Usage: shuvgeist electron source extract <destination> [app] --source-path <path>",
				flags: [cliFlag("sourcePath", { param: "sourcePath" }), cliFlag("extractTo", { input: "extractTo" })],
				positionals: [
					cliPositional("destinationPath", { source: "index", index: 0, input: "destinationPath" }),
					cliPositional("appRef", { source: "index", index: 1, param: "appRef" }),
				],
				codec: "electron-source-extract",
			}),
		),
		defaultTimeout: "slow",
		params: electronSourceExtractParamsSchema,
		result: electronSourceExtractResultSchema,
	},
	{
		method: "electron_doctor",
		capabilities: ["electron_doctor"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["doctor"],
				usage: "Usage: shuvgeist electron doctor [app]",
				flags: [],
				positionals: [cliPositional("appRef", { source: "index", index: 0, param: "appRef" })],
				codec: "generic",
			}),
		),
		defaultTimeout: "slow",
		params: optionalAppRefParamsSchema,
		result: electronDoctorResultSchema,
	},
	{
		method: "electron_auto_attach",
		capabilities: ["electron_auto_attach"],
		route: "server-local",
		targets: [],
		cli: bridgeCli(
			defineCliBinding({
				family: "electron",
				select: ["auto-attach", "status"],
				usage: "Usage: shuvgeist electron auto-attach status <app>",
				flags: [],
				positionals: [cliPositional("appRef", { source: "index", index: 0, param: "appRef", required: true })],
				constants: { action: "status" },
				codec: "generic",
			}),
			defineCliBinding({
				family: "electron",
				select: ["auto-attach", "install"],
				usage: "Usage: shuvgeist electron auto-attach install <app>",
				flags: [],
				positionals: [cliPositional("appRef", { source: "index", index: 0, param: "appRef", required: true })],
				constants: { action: "install" },
				codec: "generic",
			}),
			defineCliBinding({
				family: "electron",
				select: ["auto-attach", "uninstall"],
				usage: "Usage: shuvgeist electron auto-attach uninstall <app>",
				flags: [],
				positionals: [cliPositional("appRef", { source: "index", index: 0, param: "appRef", required: true })],
				constants: { action: "uninstall" },
				codec: "generic",
			}),
		),
		defaultTimeout: "request",
		params: electronAutoAttachParamsSchema,
		result: electronAutoAttachResultSchema,
	},
	{
		method: "skills_snapshot_status",
		capabilities: ["skills_snapshot_status"],
		route: "server-local",
		targets: [],
		cli: noCli("server-internal"),
		defaultTimeout: "request",
		params: noParamsSchema,
		result: skillSnapshotStatusResultSchema,
	},
] as const satisfies readonly BridgeCommandDefinition[];

export type BridgeSchemaMethod = (typeof BridgeCommandDefinitions)[number]["method"];
type BridgeCommandDefinitionFor<M extends BridgeSchemaMethod> = Extract<
	(typeof BridgeCommandDefinitions)[number],
	{ method: M }
>;
export type BridgeCommandSchemaMap = {
	[M in BridgeSchemaMethod]: Pick<BridgeCommandDefinitionFor<M>, "params" | "result">;
};

export const BridgeCommandSchemas = Object.fromEntries(
	BridgeCommandDefinitions.map(({ method, params, result }) => [method, { params, result }]),
) as BridgeCommandSchemaMap;

const BridgeCommandDefinitionByMethod = new Map<string, (typeof BridgeCommandDefinitions)[number]>(
	BridgeCommandDefinitions.map((definition) => [definition.method, definition]),
);

export type BridgeCommandParams<M extends BridgeSchemaMethod> = Static<BridgeCommandSchemaMap[M]["params"]>;
export type BridgeCommandResult<M extends BridgeSchemaMethod> = Static<BridgeCommandSchemaMap[M]["result"]>;
export type BridgeCommandParamsMap = { [M in BridgeSchemaMethod]: BridgeCommandParams<M> };
export type BridgeCommandResultMap = { [M in BridgeSchemaMethod]: BridgeCommandResult<M> };
export type BridgeCommandMethodForRoute<R extends BridgeCommandRoute> =
	(typeof BridgeCommandDefinitions)[number] extends infer Definition
		? Definition extends { method: infer Method extends BridgeSchemaMethod; route: R }
			? Method
			: never
		: never;
export type BridgeCommandMethodForTarget<Target extends BridgeCommandTargetKind> =
	(typeof BridgeCommandDefinitions)[number] extends infer Definition
		? Definition extends {
				method: infer Method extends BridgeSchemaMethod;
				targets: infer Targets extends readonly BridgeCommandTargetKind[];
			}
			? Target extends Targets[number]
				? Method
				: never
			: never
		: never;
export type ElectronTargetBridgeMethod = BridgeCommandMethodForTarget<"electron-window">;
export const ElectronTargetBridgeMethods = BridgeCommandDefinitions.filter((definition) =>
	(definition.targets as readonly BridgeCommandTargetKind[]).includes("electron-window"),
).map((definition) => definition.method) as ElectronTargetBridgeMethod[];
export type BridgeCommandHandler<M extends BridgeSchemaMethod, Context> = (
	context: Context,
	params: BridgeCommandParams<M>,
) => BridgeCommandResult<M> | Promise<BridgeCommandResult<M>>;
export type BridgeCommandHandlerRegistry<Methods extends BridgeSchemaMethod, Context> = {
	[M in Methods]: BridgeCommandHandler<M, Context>;
};
export type PartialBridgeCommandHandlerRegistry<Context> = {
	[M in BridgeSchemaMethod]?: BridgeCommandHandler<M, Context>;
};

export function defineBridgeCommandHandlerRegistry<Context>() {
	return <const Registry extends PartialBridgeCommandHandlerRegistry<Context>>(registry: Registry): Registry =>
		registry;
}
export type TargetedBridgeParams = Static<typeof targetedBridgeParamsSchema>;
export type ResolvedPageTarget = Static<typeof resolvedPageTargetSchema>;
export type NavigateCloseTabFilter = Static<typeof navigateCloseTabFilterSchema>;

export function isBridgeSchemaMethod(method: string): method is BridgeSchemaMethod {
	return BridgeCommandDefinitionByMethod.has(method);
}

export function getBridgeCommandDefinition(method: string): (typeof BridgeCommandDefinitions)[number] | undefined {
	return BridgeCommandDefinitionByMethod.get(method);
}

export interface BridgeCommandValidationError {
	path: string;
	message: string;
}

export type BridgeCommandValidation<T> = { ok: true; value: T } | { ok: false; errors: BridgeCommandValidationError[] };

export function formatBridgeCommandValidationErrors(errors: BridgeCommandValidationError[]): string {
	return errors.map((error) => `${error.path || "$"}: ${error.message}`).join("; ");
}

function validationErrors(schema: TSchema, value: unknown): BridgeCommandValidationError[] {
	return [...Value.Errors(schema, value)].map((error) => ({ path: error.path, message: error.message }));
}

export function validateBridgeCommandParams<M extends BridgeSchemaMethod>(
	method: M,
	value: unknown,
): BridgeCommandValidation<BridgeCommandParams<M>> {
	const schema = BridgeCommandSchemas[method].params;
	const candidate = value === undefined && Value.Check(schema, {}) ? {} : value;
	if (!Value.Check(schema, candidate)) {
		return { ok: false, errors: validationErrors(schema, candidate) };
	}
	if (
		(method === "ref_click" || method === "ref_fill") &&
		typeof candidate === "object" &&
		candidate !== null &&
		(candidate as { native?: unknown }).native === true &&
		(candidate as { trusted?: unknown }).trusted === true
	) {
		return {
			ok: false,
			errors: [{ path: "/trusted", message: "--native and --trusted/--cdp-input are mutually exclusive" }],
		};
	}
	return { ok: true, value: candidate as BridgeCommandParams<M> };
}

export function validateBridgeCommandResult<M extends BridgeSchemaMethod>(
	method: M,
	value: unknown,
): BridgeCommandValidation<BridgeCommandResult<M>> {
	const schema = BridgeCommandSchemas[method].result;
	return Value.Check(schema, value)
		? { ok: true, value: value as BridgeCommandResult<M> }
		: { ok: false, errors: validationErrors(schema, value) };
}
