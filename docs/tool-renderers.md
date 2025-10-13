# Tool Renderers

## Overview

Tool renderers customize how tool invocations and their results appear in the chat interface. Each tool can provide a renderer that controls both the visual presentation and layout structure.

## Architecture

### ToolRenderResult Interface

```typescript
interface ToolRenderResult {
  content: TemplateResult;
  isCustom: boolean;
}
```

- **`content`**: Lit template to render
- **`isCustom`**:
  - `true` - No card wrapper, renderer controls everything
  - `false` - Wrap content in default card border

### ToolRenderer Interface

```typescript
interface ToolRenderer<TParams = any, TDetails = any> {
  render(
    params: TParams | undefined,
    result: ToolResultMessage<TDetails> | undefined,
    isStreaming?: boolean
  ): ToolRenderResult;
}
```

Receives:
- **`params`**: Tool input parameters (may be partial during streaming)
- **`result`**: Tool execution result (undefined until complete)
- **`isStreaming`**: Whether tool is currently executing

## Rendering States

Renderers should handle all execution states:

1. **No params yet**: Tool call initiated but parameters not received
2. **Params streaming**: Partial parameters being received
3. **Params complete**: Full parameters received, execution pending
4. **Executing**: Tool running (params available, no result)
5. **Complete**: Execution finished with result
6. **Error**: Execution failed with error

## Implementation

### Registration

```typescript
import { registerToolRenderer } from "@mariozechner/pi-web-ui";

registerToolRenderer("tool_name", toolRenderer);
```

### Example: Default Card Wrapper

```typescript
const myRenderer: ToolRenderer<MyParams, MyResult> = {
  render(params, result, isStreaming) {
    if (result) {
      return {
        content: html`<div class="result">${result.output}</div>`,
        isCustom: false, // Wrap in card
      };
    }

    return {
      content: html`<div class="loading">Executing...</div>`,
      isCustom: false,
    };
  }
};
```

### Example: Custom Rendering (No Card)

```typescript
const navigateRenderer: ToolRenderer<NavigateParams, NavigateResult> = {
  render(params, result) {
    if (result && !result.isError) {
      return {
        content: html`
          <div class="my-2">
            <button class="inline-flex items-center gap-2 px-3 py-2 text-sm bg-card border rounded-lg">
              <img src="${result.details.favicon}" class="w-4 h-4" />
              <span>${result.details.title}</span>
            </button>
          </div>
        `,
        isCustom: true, // No card wrapper
      };
    }

    return {
      content: html`<div class="my-2">Navigating...</div>`,
      isCustom: true,
    };
  }
};
```

## Built-in Renderers

**web-ui Package:**
- `bash` - Command execution with console output (BashRenderer)
- `javascript_repl` - Sandboxed JavaScript REPL with console output
- `extract_document` - Document extraction from web pages
- `artifacts` - File artifact management (ArtifactsToolRenderer)

**sitegeist Extension:**
- `browser_javascript` - Page JavaScript execution with collapsible code
- `skill` - Skill management operations (list, get, create, update, delete, patch)
- `navigate` - Page navigation with favicon display
- `debugger` - Browser debugger tool

## Best Practices

### Visual Consistency
- Use Tailwind utility classes from theme
- Follow spacing patterns: `my-2` for vertical, `gap-2` for flex
- Use semantic colors: `text-card-foreground`, `bg-card`, `border-border`

### State Handling
```typescript
render(params, result, isStreaming) {
  // Loading state
  if (!result && params) {
    return { content: html`<div>Loading...</div>`, isCustom: false };
  }

  // Error state
  if (result?.isError) {
    return { content: html`<div class="text-destructive">${result.output}</div>`, isCustom: false };
  }

  // Success state
  if (result) {
    return { content: html`<div>${result.output}</div>`, isCustom: false };
  }

  // Waiting state
  return { content: html`<div>Waiting...</div>`, isCustom: false };
}
```

### Custom Rendering Guidelines
Use `isCustom: true` when:
- Tool needs precise positioning (e.g., inline pills, navigation UI)
- Card border would disrupt visual flow
- Implementing custom container styling

Use `isCustom: false` when:
- Tool displays standard content (logs, text, code)
- Card border provides useful visual separation
- Using default tool message styling

## Files

**Core:**
- `pi-mono/packages/web-ui/src/tools/types.ts` - Interfaces
- `pi-mono/packages/web-ui/src/tools/renderer-registry.ts` - Registration
- `pi-mono/packages/web-ui/src/components/Messages.ts` - Rendering logic

**Renderers:**
- `pi-mono/packages/web-ui/src/tools/renderers/` - Built-in renderers
- `sitegeist/src/tools/` - Extension-specific renderers
