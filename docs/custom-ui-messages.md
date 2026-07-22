# Custom UI Messages

## Overview

Custom message types enable specialized UI elements in the chat with flexible LLM transformation. Messages can be UI-only, transformed for the LLM, or passed through as-is.

## Core Concepts

### Message Types

**AppMessage**: Union of all message types (standard + custom)
```typescript
type BaseMessage = AssistantMessage | UserMessage | ToolResultMessage | ArtifactMessage;

export interface CustomMessages {
  // Apps extend via declaration merging
}

export type AppMessage = BaseMessage | CustomMessages[keyof CustomMessages];
```

**Extending**: Add custom types via declaration merging
```typescript
declare module "@mariozechner/pi-web-ui" {
  interface CustomMessages {
    welcome: WelcomeMessage;
    navigation: NavigationMessage;
  }
}
```

### Message Lifecycle

```
User Action
    ↓
Create AppMessage
    ↓
agent.appendMessage()
    ↓
    ├─→ UI: renderMessage() → Custom Renderer → Display
    └─→ LLM: messageTransformer() → Transform/Filter → LLM
```

## Implementation

### 1. Define Message Type

```typescript
export interface NavigationMessage {
  role: "navigation";
  url: string;
  title: string;
  favicon?: string;
}

declare module "@mariozechner/pi-web-ui" {
  interface CustomMessages {
    navigation: NavigationMessage;
  }
}
```

### 2. Create Custom Element

```typescript
@customElement("navigation-message")
class NavigationMessageElement extends LitElement {
  @property() url!: string;
  @property() title!: string;

  protected createRenderRoot() {
    return this; // Light DOM for shared styles
  }

  override render() {
    return html`
      <div class="my-2">
        <button
          class="inline-flex items-center gap-2 px-3 py-2 bg-card border rounded-lg"
          @click=${() => chrome.tabs.create({ url: this.url })}
        >
          <img src="${this.favicon}" class="w-4 h-4" />
          <span>${this.title}</span>
        </button>
      </div>
    `;
  }
}
```

### 3. Create Renderer

**Simple (no agent access)**:
```typescript
const navigationRenderer: MessageRenderer<NavigationMessage> = {
  render: (msg) => html`<navigation-message
    .url=${msg.url}
    .title=${msg.title}
    .favicon=${msg.favicon}>
  </navigation-message>`,
};
```

**With agent access (conditional rendering)**:
```typescript
function createNavigationRenderer(agent: Agent): MessageRenderer<NavigationMessage> {
  return {
    render: (msg) => {
      const messageCount = agent.state.messages.length;
      return html`<navigation-message
        .url=${msg.url}
        .messageCount=${messageCount}>
      </navigation-message>`;
    },
  };
}
```

### 4. Register Renderer

```typescript
import { registerMessageRenderer } from "@mariozechner/pi-web-ui";

registerMessageRenderer("navigation", navigationRenderer);
```

### 5. Transform for LLM

**Filter (UI-only)**:
```typescript
if (m.role === "welcome") continue; // Don't send to LLM
```

**Transform (modify for LLM)**:
```typescript
if (m.role === "navigation") {
  transformed.push({
    role: "user",
    content: `<browser-context>Navigated to ${nav.url}</browser-context>`,
  } as Message);
}
```

**Pass-through (send as-is)**:
```typescript
if (m.role === "user" || m.role === "assistant") {
  const { attachments, ...rest } = m as any;
  transformed.push(rest as Message);
}
```

## Patterns

### UI-Only Message (Welcome Screen)

Never sent to LLM:

```typescript
export interface WelcomeMessage {
  role: "welcome";
  tutorials: Array<{ label: string; prompt: string }>;
}

// Renderer with conditional display
function createWelcomeRenderer(agent: Agent): MessageRenderer<WelcomeMessage> {
  return {
    render: (message) => {
      // Hide if conversation started
      const hasConversation = agent.state.messages.some(
        m => (m.role === "user" || m.role === "assistant") && m !== message
      );

      if (hasConversation) return html``;

      return html`<welcome-message .tutorials=${message.tutorials}></welcome-message>`;
    },
  };
}

// Transformer filters it out
if (m.role === "welcome") continue;
```

### Transformed Message (Navigation)

UI shows clickable pill, LLM receives context:

```typescript
// UI renderer
const renderer = {
  render: (msg) => html`<navigation-message .url=${msg.url} .title=${msg.title} />`,
};

// Transformer converts to user message
if (m.role === "navigation") {
  const skills = await skillsStore.getSkillsForUrl(m.url);
  const skillsInfo = skills.length > 0
    ? `\n\nSkills: ${skills.map(s => s.name).join(", ")}`
    : "";

  transformed.push({
    role: "user",
    content: `<browser-context>Navigated to ${m.url}${skillsInfo}</browser-context>`,
  });
}
```

## Event-Based Actions

Custom elements dispatch DOM events for actions:

```typescript
// In custom element
private selectTutorial(prompt: string) {
  this.dispatchEvent(
    new CustomEvent("tutorial-selected", {
      detail: { prompt },
      bubbles: true,
      composed: true,
    })
  );
}

// In app initialization
document.addEventListener("tutorial-selected", (e: CustomEvent) => {
  // Remove welcome message
  agent.replaceMessages(agent.state.messages.filter(m => m.role !== "welcome"));

  // Send tutorial prompt
  agentInterface.sendMessage(e.detail.prompt);
});
```

## Best Practices

### ✅ DO
- Store minimal data in messages (they persist in session storage)
- Use factory pattern for renderers needing agent state
- Use DOM events for actions requiring `agentInterface`
- Filter UI-only messages in transformer
- Load async data in `connectedCallback()`
- Make transformer async if needed

### ❌ DON'T
- Store callbacks in messages (won't persist)
- Send custom roles directly to LLM (won't understand)
- Access agent from custom elements (no injection)
- Forget to register renderers before messages appear

## Files

**Core:**
- `pi-mono/packages/web-ui/src/components/Messages.ts` - Message types
- `pi-mono/packages/web-ui/src/components/MessageList.ts` - Rendering
- `pi-mono/packages/web-ui/src/components/message-renderer-registry.ts` - Registration
- `pi-mono/packages/web-ui/src/agent/agent.ts` - Transformation

**Examples:**
- `shuvgeist/packages/extension/src/messages/NavigationMessage.ts` - Navigation message
- `shuvgeist/packages/extension/src/messages/WelcomeMessage.ts` - UI-only message
- `shuvgeist/packages/extension/src/messages/message-transformer.ts` - Message transformation
- `shuvgeist/packages/extension/src/sidepanel.ts` - Presentation setup and event handling
