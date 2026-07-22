# Prompts Architecture

## Overview

This document describes the current architecture of prompts, tool descriptions, and runtime provider descriptions. Use this as a reference for understanding how prompts work and as a guide for adding new tools or modifying existing ones.

**Current State**: All runtime providers and tool descriptions have been optimized following consistent patterns. Total agent setup uses ~7,555 tokens (42% reduction from original ~13,034 tokens).

## Core Concepts

### 1. Tools
Tools are capabilities that the LLM can invoke. Each tool has:
- **Name**: Identifier (e.g., `browser_repl`, `artifacts`)
- **Label**: Human-readable name
- **Parameters**: JSON schema defining inputs
- **Description**: Instructions for the LLM on when and how to use the tool
- **Execute**: Function that runs when the tool is called

### 2. Runtime Providers
Runtime providers inject special functions into sandboxed execution environments. Each provider implements the `SandboxRuntimeProvider` interface with:
- **getData()**: Returns data to inject into `window` scope
- **getRuntime()**: Returns a function that will be stringified and executed in the sandbox to define helper functions
- **handleMessage()**: Optional bidirectional communication handler
- **getDescription()**: Returns documentation describing what functions this provider makes available

### 3. Tool Descriptions with Provider Injection
Tool descriptions are **template functions** that accept an array of runtime provider descriptions and inject them into the appropriate location:

```typescript
export const TOOL_DESCRIPTION = (runtimeProviderDescriptions: string[]) => `
# Tool Name

## When to Use
...

## Available Functions
${runtimeProviderDescriptions.join("\n\n")}
`;
```

The descriptions from runtime providers are **dynamically injected** so the LLM knows what functions are available in that tool's execution context.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Agent Initialization                     │
│                      (sidepanel.ts:304-349)                     │
└──────────────────────┬──────────────────────────────────────────┘
                       │
           ┌───────────┴──────────┐
           │                      │
           ▼                      ▼
    ┌──────────┐          ┌──────────────┐
    │  Tools   │          │  Runtime     │
    │          │          │  Providers   │
    └──────────┘          └──────────────┘
           │                      │
           │                      │
    ┌──────┴──────────────────────┴──────┐
    │                                     │
    ▼                                     ▼
┌────────────────┐              ┌──────────────────┐
│ Tool           │              │ Provider         │
│ Description    │◄─────────────│ getDescription() │
│ (template fn)  │   injected   │                  │
└────────────────┘              └──────────────────┘
```

## Current Prompts

### Web-UI Prompts
**File**: `/Users/shuv1337/workspaces/pi-mono/packages/web-ui/src/prompts/prompts.ts`

Shared prompts and runtime provider descriptions:

**Tool Descriptions** (template functions accepting `runtimeProviderDescriptions: string[]`):
- `JAVASCRIPT_REPL_TOOL_DESCRIPTION` - Generic JavaScript REPL tool
- `ARTIFACTS_TOOL_DESCRIPTION` - Artifacts management (create/update/rewrite/get/delete/htmlArtifactLogs)

**Runtime Provider Descriptions**:
- `ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RW` - Read-write artifact functions: `listArtifacts()`, `getArtifact()`, `createOrUpdateArtifact()`, `deleteArtifact()`
- `ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO` - Read-only artifact access (for HTML artifacts)
- `ATTACHMENTS_RUNTIME_DESCRIPTION` - User attachment access: `listAttachments()`, `readTextAttachment()`, `readBinaryAttachment()`
- `EXTRACT_DOCUMENT_DESCRIPTION` - Extract text from PDF/DOCX/XLSX/PPTX

### Shuvgeist Prompts
**File**: `packages/extension/src/prompts/prompts.ts`

Shuvgeist-specific prompts:

**System Prompt**:
- `SYSTEM_PROMPT` - Main agent identity, tone, workflows

**Tool Descriptions**:
- `REPL_TOOL_DESCRIPTION(runtimeProviderDescriptions)` - REPL with browserjs()/navigate()
- `SKILL_TOOL_DESCRIPTION` - Skill management (get/list/create/update/rewrite/delete)
- `NAVIGATE_TOOL_DESCRIPTION` - Navigate to URLs in tabs
- `ASK_USER_WHICH_ELEMENT_DESCRIPTION` - Element picker

**Runtime Provider Descriptions**:
- `BROWSERJS_RUNTIME_DESCRIPTION` - `browserjs()` for page context execution
- `NAVIGATE_RUNTIME_DESCRIPTION` - `navigate()` helper function (available in REPL code, not in functions passed to browserjs())
- `NATIVE_INPUT_EVENTS_DESCRIPTION` - Trusted events: `nativeClick()`, `nativeType()`, `nativePress()`, `nativeKeyDown()`, `nativeKeyUp()`

## Implementation Details

### How Runtime Providers Work

#### 1. Provider Implementation
Example from `ArtifactsRuntimeProvider.ts`:

```typescript
export class ArtifactsRuntimeProvider implements SandboxRuntimeProvider {
    getData(): Record<string, any> {
        // Data to inject into window scope
        return { artifacts: snapshot };
    }

    getRuntime(): (sandboxId: string) => void {
        // This function is stringified and executed in sandbox
        return (_sandboxId: string) => {
            (window as any).listArtifacts = async () => { ... };
            (window as any).getArtifact = async (filename: string) => { ... };
            // etc.
        };
    }

    handleMessage(message: any, respond: (response: any) => void) {
        // Handle bidirectional communication
    }

    getDescription(): string {
        return ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION;
    }
}
```

#### 2. Tool Registration with Provider Injection
Example from `artifacts.ts:242-254`:

```typescript
public get tool(): AgentTool<typeof artifactsParamsSchema, undefined> {
    const self = this;
    return {
        label: "Artifacts",
        name: "artifacts",
        get description() {
            // Dynamically get provider descriptions
            const runtimeProviderDescriptions =
                self.runtimeProvidersFactory?.()
                    .map((d) => d.getDescription())
                    .filter((d) => d.trim().length > 0) || [];
            // Inject into template
            return ARTIFACTS_TOOL_DESCRIPTION(runtimeProviderDescriptions);
        },
        parameters: artifactsParamsSchema,
        execute: async (...) => { ... }
    };
}
```

The `description` property is a **getter** that:
1. Calls `runtimeProvidersFactory()` to get all providers
2. Maps each provider to its `getDescription()` output
3. Filters out empty descriptions
4. Passes array to the template function

#### 3. Provider Composition in Sidepanel
Example from `sidepanel.ts:320-332`:

```typescript
replTool.runtimeProvidersFactory = () => {
    // Providers available in page context via browserjs()
    const pageProviders = [
        ...runtimeProvidersFactory(), // attachments + artifacts from ChatPanel
        new NativeInputEventsRuntimeProvider(), // trusted browser events
    ];

    return [
        ...pageProviders, // Available in REPL context too
        new BrowserJsRuntimeProvider(pageProviders), // Page context orchestration
        new NavigateRuntimeProvider(navigateTool), // Navigation helper
    ];
};
```

This composition ensures:
- Base providers (attachments, artifacts) are available everywhere
- Page-specific providers (native input events) are available via `browserjs()`
- REPL-specific providers (browserjs, navigate) are available in REPL context

### How Descriptions Flow Through the System

```
1. Provider defines getDescription()
   └─> Returns description string

2. Tool's runtimeProvidersFactory() returns provider instances
   └─> Called when tool.description getter is accessed

3. Tool description getter collects descriptions
   └─> Calls getDescription() on each provider
   └─> Filters empty strings
   └─> Passes array to template function

4. Template function injects descriptions
   └─> Uses ${runtimeProviderDescriptions.join("\n\n")}
   └─> Returns complete tool description

5. Agent uses tool description
   └─> Tool description sent to LLM with prompt
   └─> LLM knows what functions are available
```

## Runtime Provider Descriptions Pattern

All provider descriptions must follow this optimized pattern:

```markdown
### Provider Name

Brief one-sentence summary of what these functions provide.

#### When to Use
- Bullet point describing use case
- Another use case

#### Do NOT Use For (optional - only include if critical)
- Negative case that would cause serious issues

#### Functions
- functionName(params) - Brief description, returns type
- anotherFunction(params) - Brief description, returns type

#### Example
Complete workflow example showing typical usage:
\`\`\`javascript
const data = await someFunction();
await anotherFunction(data);
\`\`\`
```

**Key requirements**:
- Start with `###` heading for provider name
- Add one-sentence summary immediately after heading
- Use `####` subheadings for: "When to Use", "Functions", "Example"
- List functions with parameter and return type info ONLY (no inline examples - save tokens)
- End with complete workflow example in code block showing real usage
- Keep "Do NOT Use For" section minimal or omit if not critical
- Keep descriptions minimal (token efficiency is critical)

## Tool Description Pattern

All tool descriptions must follow this optimized pattern:

```markdown
# Tool Name

Brief one-sentence summary of what the tool does.

## When to Use
- Use case 1 (prioritize most common use case first)
- Use case 2
- Use case 3

## Environment (for execution tools like REPL)
- What execution context
- What APIs are available
- What libraries can be imported

## Input
Show concrete examples of how to call the tool:
- { action: "create", filename: "notes.md", content: "..." } - Brief description
- { action: "update", filename: "notes.md", old_str: "...", new_str: "..." } - Brief description
- { action: "get", filename: "data.json" } - Brief description

## Returns
What the tool returns (success status, content, errors, etc.)

## Helper Functions (Automatically Available)

These functions are injected into the execution environment and available globally:

${runtimeProviderDescriptions.join("\n\n")}
```

**Key requirements**:
- Use `#` for main heading, `##` for sections
- Start with brief one-sentence summary (NOT a separate ## Purpose section)
- Include "When to Use" section with prioritized use cases
- **## Input section shows CONCRETE EXAMPLES** of parameters, not abstract descriptions
- Include "## Returns" section describing output
- Remove verbose "## Output" and "## Important Notes" sections - integrate into other sections
- End with "Helper Functions (Automatically Available)" for runtime provider injection (if applicable)
- Keep minimal (token efficiency is critical)

**Action Naming Conventions**:
For tools that manipulate content (artifacts, skills), use consistent action names:
- **update**: String replacement for targeted edits (`old_string` → `new_string`) - PREFERRED for token efficiency
- **rewrite**: Full replacement of entire fields - LAST RESORT when update won't work
- **create**: Create new items
- **get**: Retrieve items
- **delete**: Delete items
- **list**: List available items


## Guidelines for Adding/Modifying Prompts

### When Adding a New Tool

1. **Choose the right location**:
   - Shared/reusable tools → `/Users/shuv1337/workspaces/pi-mono/packages/web-ui/src/prompts/prompts.ts`
   - Shuvgeist-specific tools → `packages/extension/src/prompts/prompts.ts`

2. **Follow the tool description pattern** (see above)

3. **If the tool uses runtime providers**:
   - Make description a template function: `(runtimeProviderDescriptions: string[]) => string`
   - End with "## Helper Functions (Automatically Available)" section
   - Inject providers: `${runtimeProviderDescriptions.join("\n\n")}`

4. **Implement the tool**:
   - If using providers, make `description` a getter that calls `runtimeProvidersFactory()`
   - See Implementation Details section for examples

### When Adding a Runtime Provider

1. **Implement the provider class**:
   - Implement `SandboxRuntimeProvider` interface
   - Define `getData()`, `getRuntime()`, optional `handleMessage()`
   - Define `getDescription()` returning your provider description

2. **Write the provider description** following the pattern above

3. **Register the provider** in tool's `runtimeProvidersFactory`

### When Modifying Existing Prompts

1. **Follow existing patterns** - use same header structure, action names, formatting
2. **Keep token efficiency in mind**:
   - Remove redundant examples (one complete workflow example is better than many inline examples)
   - Use concrete examples in ## Input rather than abstract descriptions
   - Minimize "Do NOT Use For" sections - only include critical negative cases
3. **Use consistent action naming**:
   - `update` for string replacement (preferred)
   - `rewrite` for full replacement (last resort)
   - `create`, `get`, `delete`, `list` where applicable

### Writing Style

- **Be explicit**: "ALWAYS use X", "NEVER use Y"
- **Use active voice**: "Click the button" not "The button should be clicked"
- **Give concrete examples with code**
- **State consequences**: "If you do X, Y will happen"
- **Avoid "you should" or "it's recommended"** - be direct

### Testing Changes

After updating prompts:
1. Run `./check.sh` to verify no TypeScript errors
2. Test with actual agent - does it follow instructions?
3. Check edge cases - does it handle errors correctly?
4. Verify terminology is consistent across all prompts

## References

### Key Files

**Interfaces**:
- `/Users/shuv1337/workspaces/pi-mono/packages/web-ui/src/components/sandbox/SandboxRuntimeProvider.ts` - Provider interface

**Prompt Definitions**:
- `/Users/shuv1337/workspaces/pi-mono/packages/web-ui/src/prompts/prompts.ts` - Shared prompts and providers
- `packages/extension/src/prompts/prompts.ts` - Shuvgeist-specific prompts

**Provider Implementations**:
- `/Users/shuv1337/workspaces/pi-mono/packages/web-ui/src/components/sandbox/ArtifactsRuntimeProvider.ts` - Artifacts provider
- `packages/extension/src/tools/NativeInputEventsRuntimeProvider.ts` - Native events provider
- `packages/extension/src/tools/repl/runtime-providers.ts` - BrowserJs and Navigate providers

**Tool Implementations**:
- `/Users/shuv1337/workspaces/pi-mono/packages/web-ui/src/tools/artifacts/artifacts.ts` - Artifacts tool
- `packages/extension/src/tools/repl/repl.ts` - REPL tool

**Integration**:
- `packages/extension/src/sidepanel.ts` - Tool and provider composition

### Related Documentation
- `docs/tool-renderers.md` - How tool invocations are rendered in UI
- `docs/storage.md` - Storage architecture
- `docs/skills.md` - Skill system (auto-inject libraries into browserjs)
