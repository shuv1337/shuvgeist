# Prompts

## Overview

Prompts are centralized in two locations: Sitegeist-specific prompts and shared web-ui prompts. This document provides a map of where prompts live and how they compose together.

## Prompt Map

### Sitegeist Prompts ([src/prompts/tool-prompts.ts](../src/prompts/tool-prompts.ts))

1. **SYSTEM_PROMPT** (line 12)
   - Main agent system prompt defining identity, tone, tools, workflows
   - Used by: [src/sidepanel.ts](../src/sidepanel.ts) during agent initialization
   - ~158 lines covering: tone, available tools, execution contexts, tool selection guide, skills workflow, common workflows

2. **NATIVE_INPUT_EVENTS_DESCRIPTION** (line 164)
   - Runtime provider description for trusted browser events
   - Embedded in: BROWSER_JAVASCRIPT_DESCRIPTION
   - Functions: nativeClick, nativeType, nativePress, nativeKeyDown, nativeKeyUp

3. **BROWSER_JAVASCRIPT_DESCRIPTION** (line 208)
   - Tool description for browser_javascript
   - Used by: [src/tools/browser-javascript.ts](../src/tools/browser-javascript.ts)
   - Embeds: ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION (from web-ui), NATIVE_INPUT_EVENTS_DESCRIPTION

4. **NAVIGATE_TOOL_DESCRIPTION** (line 271)
   - Tool description for navigate
   - Used by: [src/tools/navigate.ts](../src/tools/navigate.ts)
   - Actions: navigate to URL, open in new tab, history back/forward, list tabs, switch tabs

5. **SKILL_TOOL_DESCRIPTION** (line 289)
   - Tool description for skill management
   - Used by: [src/tools/skill.ts](../src/tools/skill.ts)
   - ~150 lines covering: why skills matter, actions (get/list/create/update/patch/delete), domain patterns, testing workflow

### Web-UI Prompts ([pi-mono/packages/web-ui/src/prompts/tool-prompts.ts](../../pi-mono/packages/web-ui/src/prompts/tool-prompts.ts))

1. **JAVASCRIPT_REPL_DESCRIPTION** (line 10)
   - Tool description for sandboxed JavaScript REPL
   - Used by: javascript_repl tool in web-ui

2. **ARTIFACTS_BASE_DESCRIPTION** (line 63)
   - Tool description for artifacts (create/update/rewrite/get/delete/logs)
   - Used by: artifacts tool in web-ui

3. **ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION** (line 190)
   - Runtime provider for artifact API in executed code
   - Embedded in: BROWSER_JAVASCRIPT_DESCRIPTION (sitegeist), JAVASCRIPT_REPL_DESCRIPTION (web-ui), HTML artifacts
   - Functions: listArtifacts, getArtifact, createOrUpdateArtifact, deleteArtifact

4. **DOWNLOADABLE_FILE_RUNTIME_DESCRIPTION** (line 236)
   - Runtime provider for one-time file downloads
   - Embedded in: BROWSER_JAVASCRIPT_DESCRIPTION (sitegeist), JAVASCRIPT_REPL_DESCRIPTION (web-ui)
   - Function: returnDownloadableFile

5. **EXTRACT_DOCUMENT_DESCRIPTION** (line 257)
   - Tool description for document extraction (PDF, DOCX, XLSX, PPTX)
   - Used by: extract_document tool in web-ui

6. **ATTACHMENTS_RUNTIME_DESCRIPTION** (line 281)
   - Runtime provider for user attachments
   - Embedded in: JAVASCRIPT_REPL_DESCRIPTION (web-ui), HTML artifacts
   - Functions: listAttachments, readTextAttachment, readBinaryAttachment

7. **ARTIFACTS_HTML_SECTION** (line 133)
   - Additional guidance for HTML artifacts
   - Merged into: Complete artifacts description
   - Covers: CDN usage, background color requirement, responsive layout

8. **buildArtifactsDescription()** (line 174)
   - Function that composes complete artifacts tool description
   - Combines: ARTIFACTS_BASE_DESCRIPTION + provider docs + ARTIFACTS_HTML_SECTION

## Prompt Composition

### Browser JavaScript Tool
```
BROWSER_JAVASCRIPT_DESCRIPTION
├── ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION (web-ui)
└── NATIVE_INPUT_EVENTS_DESCRIPTION (sitegeist)
```

### JavaScript REPL Tool
```
JAVASCRIPT_REPL_DESCRIPTION (web-ui)
├── ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION (web-ui)
├── DOWNLOADABLE_FILE_RUNTIME_DESCRIPTION (web-ui)
└── ATTACHMENTS_RUNTIME_DESCRIPTION (web-ui)
```

### Artifacts Tool
```
buildArtifactsDescription()
├── ARTIFACTS_BASE_DESCRIPTION (web-ui)
├── ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION (web-ui)
├── ARTIFACTS_HTML_SECTION (web-ui)
└── ATTACHMENTS_RUNTIME_DESCRIPTION (web-ui)
```

## Prompt Writing Guidelines

### Structure

**DO:**
- Start with one-line summary
- Use clear headers (##, ###)
- Group related information
- Put critical rules at the end with CRITICAL/IMPORTANT prefix
- Include concrete examples

**DON'T:**
- Write walls of text
- Bury important rules in paragraphs
- Use vague language
- Forget examples

### Language

**DO:**
- Be explicit: "ALWAYS use X", "NEVER use Y"
- Use active voice: "Click the button" not "The button should be clicked"
- Give concrete examples: Show actual code/scenarios
- Use formatting: Bold, lists, code blocks
- State consequences: "If you do X, Y will happen"

**DON'T:**
- Use passive voice
- Say "you should" or "it's recommended" - be direct
- Use technical jargon without explanation
- Write long sentences

### Examples

**DO:**
```typescript
// Good: Specific example with context
CRITICAL - Navigation:
NEVER use window.location or history methods in browser_javascript.
ALWAYS use the navigate tool for ALL navigation.
Reason: Navigation breaks execution context.

Example:
❌ window.location.href = "https://example.com"
✅ Use navigate tool: { url: "https://example.com" }
```

**DON'T:**
```typescript
// Bad: Vague instruction without explanation
Note: You should probably use the navigate tool for navigation
instead of doing it yourself when possible.
```

### Testing

After updating prompts:
1. Edit the prompt file
2. Run `./check.sh` to verify no TypeScript errors
3. Test with actual agent - does it follow the instructions?
4. Check edge cases - does it handle errors correctly?
5. Verify terminology is consistent across all prompts

### Common Patterns

**Tool Description Template:**
```typescript
export const TOOL_DESCRIPTION = `Brief one-line summary.

Environment: Where code runs, what it has access to

Parameters:
- param1: description with type and constraints
- param2: description

Output:
- How to return data
- Format expectations

Examples:
- Concrete use case 1
- Concrete use case 2

CRITICAL: Non-negotiable rules with consequences
`;
```

**System Prompt Section:**
```typescript
## Section Title

Brief explanation of what this covers.

Key points:
- Specific instruction 1
- Specific instruction 2

Examples:
- Concrete example with code

CRITICAL: Non-negotiable behaviors
```

## Anti-Patterns to Avoid

1. **Repeating yourself** - Say it once clearly, not 5 times in different ways
2. **Long explanations before the rule** - Put the rule first, then explain why
3. **"Please" and "try to"** - Use imperatives: "DO this", not "Please try to do this"
4. **Describing what the code does** - Show what the USER should see/do
5. **Nested instructions** - Keep hierarchy flat, avoid sub-sub-points
6. **Hypotheticals** - Use concrete examples, not "you might want to..."
7. **Apologetic language** - "Unfortunately X won't work" → "X doesn't work. Use Y instead."

## Files

**Sitegeist:**
- [src/prompts/tool-prompts.ts](../src/prompts/tool-prompts.ts) - All Sitegeist-specific prompts

**Web-UI:**
- [pi-mono/packages/web-ui/src/prompts/tool-prompts.ts](../../pi-mono/packages/web-ui/src/prompts/tool-prompts.ts) - Shared tool prompts and runtime providers
