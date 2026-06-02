import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

const sidepanelPath = join(process.cwd(), "src/sidepanel.ts");
const runtimePath = join(process.cwd(), "src/agent/runtime.ts");
const sidepanelSourceText = readFileSync(sidepanelPath, "utf-8");
const runtimeSourceText = readFileSync(runtimePath, "utf-8");
const sidepanelSourceFile = ts.createSourceFile(
	sidepanelPath,
	sidepanelSourceText,
	ts.ScriptTarget.Latest,
	true,
	ts.ScriptKind.TS,
);
const runtimeSourceFile = ts.createSourceFile(runtimePath, runtimeSourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function requireNode<T>(node: T | undefined, label: string): T {
	if (!node) throw new Error("Missing expected sidepanel agent wiring node: " + label);
	return node;
}

function findDescendant<T extends ts.Node>(
	node: ts.Node,
	predicate: (candidate: ts.Node) => candidate is T,
): T | undefined {
	let match: T | undefined;
	const visit = (child: ts.Node) => {
		if (match) return;
		if (predicate(child)) {
			match = child;
			return;
		}
		ts.forEachChild(child, visit);
	};
	ts.forEachChild(node, visit);
	return match;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	return undefined;
}

function propertyAssignment(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
	return object.properties.find(
		(property): property is ts.PropertyAssignment =>
			ts.isPropertyAssignment(property) && propertyNameText(property.name) === name,
	);
}

function propertyInitializerText(sourceFile: ts.SourceFile, object: ts.ObjectLiteralExpression, name: string): string {
	return requireNode(propertyAssignment(object, name), name).initializer.getText(sourceFile);
}

function findVariableDeclaration(scope: ts.Node, name: string): ts.VariableDeclaration | undefined {
	return findDescendant(
		scope,
		(candidate): candidate is ts.VariableDeclaration =>
			ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === name,
	);
}

function findFunctionDeclaration(scope: ts.Node, name: string): ts.FunctionDeclaration | undefined {
	return findDescendant(
		scope,
		(candidate): candidate is ts.FunctionDeclaration => ts.isFunctionDeclaration(candidate) && candidate.name?.text === name,
	);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current)) {
		current = current.expression;
	}
	return current;
}

function identifierName(sourceFile: ts.SourceFile, expression: ts.Expression): string {
	const unwrapped = unwrapExpression(expression);
	return ts.isIdentifier(unwrapped) ? unwrapped.text : unwrapped.getText(sourceFile);
}

function objectLiteralFromExpression(expression: ts.Expression | undefined, label: string): ts.ObjectLiteralExpression {
	const unwrapped = unwrapExpression(requireNode(expression, label));
	if (!ts.isObjectLiteralExpression(unwrapped)) throw new Error("Expected object literal for " + label);
	return unwrapped;
}

describe("sidepanel createAgent wiring", () => {
	const createAgentDeclaration = requireNode(findVariableDeclaration(sidepanelSourceFile, "createAgent"), "createAgent");
	const createAgent = requireNode(createAgentDeclaration.initializer, "createAgent initializer");
	if (!ts.isArrowFunction(createAgent)) throw new Error("Expected createAgent to be an arrow function");

	it("keeps the current Agent runtime defaults and hook pass-throughs", () => {
		const defaultStateFactory = requireNode(
			findFunctionDeclaration(runtimeSourceFile, "createDefaultInitialState"),
			"createDefaultInitialState",
		);
		const defaultStateReturn = requireNode(
			findDescendant(
				defaultStateFactory,
				(candidate): candidate is ts.ReturnStatement => ts.isReturnStatement(candidate),
			),
			"default state return",
		);
		const defaultState = objectLiteralFromExpression(defaultStateReturn.expression, "default state expression");
		expect(propertyInitializerText(runtimeSourceFile, defaultState, "systemPrompt")).toBe("options.systemPrompt");
		expect(propertyInitializerText(runtimeSourceFile, defaultState, "model")).toBe("options.model");
		expect(propertyInitializerText(runtimeSourceFile, defaultState, "thinkingLevel")).toBe(
			"options.thinkingLevel ?? DEFAULT_AGENT_THINKING_LEVEL",
		);
		for (const propertyName of ["messages", "tools"]) {
			const initializer = requireNode(propertyAssignment(defaultState, propertyName), propertyName).initializer;
			if (!ts.isArrayLiteralExpression(initializer)) throw new Error("Expected " + propertyName + " to be an array");
			expect(initializer.elements).toHaveLength(0);
		}

		const runtimeFactory = requireNode(findFunctionDeclaration(runtimeSourceFile, "createAgentRuntime"), "createAgentRuntime");
		const agentNew = requireNode(
			findDescendant(
				runtimeFactory,
				(candidate): candidate is ts.NewExpression =>
					ts.isNewExpression(candidate) && candidate.expression.getText(runtimeSourceFile) === "Agent",
			),
			"new Agent",
		);
		const agentOptions = objectLiteralFromExpression(agentNew.arguments?.[0], "Agent options");
		expect(propertyInitializerText(runtimeSourceFile, agentOptions, "initialState")).toBe("initialState");
		expect(propertyInitializerText(runtimeSourceFile, agentOptions, "convertToLlm")).toBe("options.convertToLlm");
		expect(propertyInitializerText(runtimeSourceFile, agentOptions, "toolExecution")).toBe(
			'options.toolExecution ?? "sequential"',
		);
		expect(propertyInitializerText(runtimeSourceFile, agentOptions, "streamFn")).toBe("options.streamFn");
		expect(propertyInitializerText(runtimeSourceFile, agentOptions, "getApiKey")).toBe("options.getApiKey");
		for (const hook of ["transformContext", "beforeToolCall", "afterToolCall", "shouldStopAfterTurn"]) {
			expect(propertyInitializerText(runtimeSourceFile, agentOptions, hook)).toContain("options." + hook);
		}
		expect(propertyInitializerText(runtimeSourceFile, agentOptions, "prepareNextTurn")).toBe("options.prepareNextTurn");
	});

	it("keeps the current sidepanel Agent factory wiring", () => {
		const runtimeCall = requireNode(
			findDescendant(
				createAgent,
				(candidate): candidate is ts.CallExpression =>
					ts.isCallExpression(candidate) && candidate.expression.getText(sidepanelSourceFile) === "createAgentRuntime",
			),
			"createAgentRuntime call",
		);
		const runtimeOptions = objectLiteralFromExpression(runtimeCall.arguments[0], "createAgentRuntime options");
		expect(propertyInitializerText(sidepanelSourceFile, runtimeOptions, "initialState")).toBe("normalizedInitialState");
		expect(propertyInitializerText(sidepanelSourceFile, runtimeOptions, "systemPrompt")).toBe("SYSTEM_PROMPT");
		expect(propertyInitializerText(sidepanelSourceFile, runtimeOptions, "model")).toBe("runtimeModel");
		expect(propertyInitializerText(sidepanelSourceFile, runtimeOptions, "thinkingLevel")).toBe(
			"options.thinkingLevel ?? DEFAULT_AGENT_THINKING_LEVEL",
		);
		expect(propertyInitializerText(sidepanelSourceFile, runtimeOptions, "convertToLlm")).toBe("browserMessageTransformer");
		expect(propertyInitializerText(sidepanelSourceFile, runtimeOptions, "toolExecution")).toBe('"sequential"');
		expect(propertyInitializerText(sidepanelSourceFile, runtimeOptions, "streamFn")).toContain("createStreamFn");
		expect(propertyInitializerText(sidepanelSourceFile, runtimeOptions, "getApiKey")).toContain(
			"getApiKeyForProvider(provider)",
		);
		for (const hook of [
			"transformContext",
			"beforeToolCall",
			"afterToolCall",
			"shouldStopAfterTurn",
			"prepareNextTurn",
		]) {
			expect(propertyInitializerText(sidepanelSourceFile, runtimeOptions, hook)).toBe("options." + hook);
		}
	});

	it("keeps the current sidepanel tools list and debugger-mode conditional", () => {
		const toolsFactoryProperty = requireNode(
			findDescendant(
				createAgent,
				(candidate): candidate is ts.PropertyAssignment =>
					ts.isPropertyAssignment(candidate) && propertyNameText(candidate.name) === "toolsFactory",
			),
			"toolsFactory",
		);
		const toolsFactory = unwrapExpression(toolsFactoryProperty.initializer);
		if (!ts.isArrowFunction(toolsFactory)) throw new Error("Expected toolsFactory arrow function");

		const toolsDeclaration = requireNode(findVariableDeclaration(toolsFactory, "tools"), "tools declaration");
		const toolsInitializer = requireNode(toolsDeclaration.initializer, "tools initializer");
		if (!ts.isArrayLiteralExpression(toolsInitializer)) throw new Error("Expected tools array");
		expect(toolsInitializer.elements.map((element) => identifierName(sidepanelSourceFile, element))).toEqual([
			"navigateTool",
			"selectElementTool",
			"replTool",
			"skillTool",
			"extractDocumentTool",
			"pageSnapshotTool",
			"extractImageTool",
		]);

		const debuggerIf = requireNode(
			findDescendant(
				toolsFactory,
				(candidate): candidate is ts.IfStatement =>
					ts.isIfStatement(candidate) && candidate.expression.getText(sidepanelSourceFile) === "debuggerModeEnabled",
			),
			"debugger conditional",
		);
		expect(findVariableDeclaration(debuggerIf, "debuggerTool")).toBeDefined();
		const pushCall = requireNode(
			findDescendant(
				debuggerIf,
				(candidate): candidate is ts.CallExpression =>
					ts.isCallExpression(candidate) && candidate.expression.getText(sidepanelSourceFile) === "tools.push",
			),
			"debugger tool push",
		);
		expect(identifierName(sidepanelSourceFile, requireNode(pushCall.arguments[0], "debugger push arg"))).toBe(
			"debuggerTool",
		);
	});
});
