# Storage Architecture

## Overview

Sitegeist uses a unified IndexedDB storage system with multiple object stores for different data types. The base storage infrastructure is defined in `@mariozechner/pi-web-ui` and extended in Sitegeist with additional stores for skills, memories, and prompts.

## Current Implementation

Single IndexedDB database `sitegeist-storage` with multiple object stores:

**Base stores** (from web-ui):
- `sessions` - Full session data (messages, model, thinking level)
- `sessions-metadata` - Lightweight session metadata (title, timestamps, usage)
- `settings` - Application settings (key-value pairs)
- `provider-keys` - API keys for LLM providers

**Extension stores** (Sitegeist-specific):
- `memories` - Session-scoped key-value pairs for agent memory
- `skills` - Skill definitions with library code
- `prompts` - User prompt templates

**Benefits**:
- **Quota**: ~10GB vs 10MB chrome.storage limit (60% disk on Chrome, 50% on Firefox)
- **Consistency**: Single API, unified transactions
- **Performance**: IndexedDB indices for efficient queries
- **Atomic operations**: Multi-store transactions
- **Extensibility**: Add stores without creating new databases

## Architecture

### StorageBackend Interface

Location: `pi-mono/packages/web-ui/src/storage/types.ts`

```typescript
export interface StorageBackend {
  // Basic operations
  get<T>(storeName: string, key: string): Promise<T | null>;
  set<T>(storeName: string, key: string, value: T): Promise<void>;
  delete(storeName: string, key: string): Promise<void>;
  keys(storeName: string, prefix?: string): Promise<string[]>;
  clear(storeName: string): Promise<void>;
  has(storeName: string, key: string): Promise<boolean>;

  // Index-based queries
  getAllFromIndex<T>(
    storeName: string,
    indexName: string,
    direction?: 'asc' | 'desc'
  ): Promise<T[]>;

  // Atomic transactions across stores
  transaction<T>(
    storeNames: string[],
    mode: 'readonly' | 'readwrite',
    operation: (tx: StorageTransaction) => Promise<T>
  ): Promise<T>;

  // Quota management
  getQuotaInfo(): Promise<{ usage: number; quota: number; percent: number }>;
  requestPersistence(): Promise<boolean>;
}
```

### IndexedDBStorageBackend

Location: `pi-mono/packages/web-ui/src/storage/backends/indexeddb-storage-backend.ts`

Implements the `StorageBackend` interface using IndexedDB APIs.

**Key features**:
- Configuration-driven object store creation
- Automatic index creation from config
- Lazy database initialization with `onupgradeneeded`
- Promisified IDBRequest API
- Efficient prefix queries with `IDBKeyRange`
- Index-based iteration with cursors

**Example usage**:
```typescript
const backend = new IndexedDBStorageBackend({
  dbName: 'sitegeist-storage',
  version: 1,
  stores: [
    {
      name: 'sessions',
      keyPath: 'id',
      indices: [{ name: 'lastModified', keyPath: 'lastModified' }]
    }
  ]
});
```

### Store Pattern

Location: `pi-mono/packages/web-ui/src/storage/store.ts`

Base class for all stores:

```typescript
export abstract class Store {
  private backend: StorageBackend | null = null;

  abstract getConfig(): StoreConfig;

  setBackend(backend: StorageBackend): void {
    this.backend = backend;
  }

  protected getBackend(): StorageBackend {
    if (!this.backend) {
      throw new Error(`Store ${this.constructor.name} not initialized`);
    }
    return this.backend;
  }
}
```

**Benefits**:
- Each store owns its schema configuration
- No circular dependencies
- Type-safe domain-specific methods
- Extensible via subclassing
- Testable with mocked backend

## Base Stores (web-ui)

### SettingsStore

Location: `pi-mono/packages/web-ui/src/storage/stores/settings-store.ts`

Simple key-value store for application settings.

```typescript
export class SettingsStore extends Store {
  getConfig(): StoreConfig {
    return { name: 'settings' };
  }

  async get<T>(key: string): Promise<T | null>
  async set<T>(key: string, value: T): Promise<void>
  async delete(key: string): Promise<void>
  async clear(): Promise<void>
}
```

### ProviderKeysStore

Location: `pi-mono/packages/web-ui/src/storage/stores/provider-keys-store.ts`

Stores API keys for LLM providers (Anthropic, OpenAI, etc).

```typescript
export class ProviderKeysStore extends Store {
  getConfig(): StoreConfig {
    return { name: 'provider-keys' };
  }

  async get(provider: string): Promise<string | null>
  async set(provider: string, apiKey: string): Promise<void>
  async delete(provider: string): Promise<void>
}
```

### SessionsStore

Location: `pi-mono/packages/web-ui/src/storage/stores/sessions-store.ts`

Manages chat sessions using two object stores for performance:
- `sessions` - Full session data (large, rarely listed)
- `sessions-metadata` - Lightweight metadata (for listing UI)

```typescript
export class SessionsStore extends Store {
  getConfig(): StoreConfig {
    return {
      name: 'sessions',
      keyPath: 'id',
      indices: [{ name: 'lastModified', keyPath: 'lastModified' }]
    };
  }

  static getMetadataConfig(): StoreConfig {
    return {
      name: 'sessions-metadata',
      keyPath: 'id',
      indices: [{ name: 'lastModified', keyPath: 'lastModified' }]
    };
  }

  // Atomic save to both stores
  async save(data: SessionData, metadata: SessionMetadata): Promise<void> {
    await this.getBackend().transaction(
      ['sessions', 'sessions-metadata'],
      'readwrite',
      async (tx) => {
        await tx.set('sessions', data.id, data);
        await tx.set('sessions-metadata', metadata.id, metadata);
      }
    );
  }

  // Efficient query using index
  async getAllMetadata(): Promise<SessionMetadata[]> {
    return this.getBackend().getAllFromIndex<SessionMetadata>(
      'sessions-metadata',
      'lastModified',
      'desc'
    );
  }

  async getLatestSessionId(): Promise<string | null> {
    const allMetadata = await this.getAllMetadata();
    return allMetadata[0]?.id || null;
  }
}
```

**Why two stores?**
- Session list UI needs fast metadata access (title, date, message count)
- Loading full session data (all messages, artifacts) is slow
- Separation allows efficient listing without loading full content

**Index usage**:
- `lastModified` index enables sorted queries via IndexedDB cursor
- Much faster than fetching all keys and sorting in JavaScript

## Extension Stores (Sitegeist)

### MemoriesStore

Location: `src/storage/stores/memories-store.ts`

Session-scoped key-value pairs for agent memory (see [memories.md](memories.md)).

```typescript
export class MemoriesStore extends Store {
  getConfig(): StoreConfig {
    return { name: 'memories' };
  }

  private makeKey(sessionId: string, key: string): string {
    return `${sessionId}_${key}`;
  }

  async get(sessionId: string, key: string): Promise<unknown | null>
  async set(sessionId: string, key: string, value: unknown): Promise<void>
  async delete(sessionId: string, key: string): Promise<void>

  // Efficient session-scoped listing using prefix queries
  async list(sessionId: string): Promise<string[]> {
    const prefix = `${sessionId}_`;
    const keys = await this.getBackend().keys('memories', prefix);
    return keys.map(k => k.slice(prefix.length));
  }
}
```

**Key format**: `${sessionId}_${key}`
- Enables efficient prefix queries with `IDBKeyRange.bound()`
- All memories for a session can be listed without full scan

### SkillsStore

Location: `src/storage/stores/skills-store.ts`

Stores skill definitions including library code.

```typescript
export class SkillsStore extends Store {
  getConfig(): StoreConfig {
    return { name: 'skills' };
  }

  async save(skill: Skill): Promise<void>
  async get(name: string): Promise<Skill | null>
  async delete(name: string): Promise<void>
  async list(): Promise<Skill[]>
}
```

**Key fields**:
- `name` - Unique skill identifier
- `domainPatterns` - URL patterns where skill applies
- `description` - What the skill does
- `library` - JavaScript code to inject
- `parameters` - Function parameters and types

### PromptsStore

Location: `src/storage/stores/prompts-store.ts`

User-defined prompt templates.

```typescript
export class PromptsStore extends Store {
  getConfig(): StoreConfig {
    return { name: 'prompts' };
  }

  async save(prompt: UserPrompt): Promise<void>
  async get(id: string): Promise<UserPrompt | null>
  async delete(id: string): Promise<void>
  async list(): Promise<UserPrompt[]>
}
```

## AppStorage Wiring

### Base AppStorage (web-ui)

Location: `pi-mono/packages/web-ui/src/storage/app-storage.ts`

```typescript
export class AppStorage {
  readonly backend: StorageBackend;
  readonly settings: SettingsStore;
  readonly providerKeys: ProviderKeysStore;
  readonly sessions: SessionsStore;

  constructor(
    settings: SettingsStore,
    providerKeys: ProviderKeysStore,
    sessions: SessionsStore,
    backend: StorageBackend
  ) {
    this.settings = settings;
    this.providerKeys = providerKeys;
    this.sessions = sessions;
    this.backend = backend;
  }
}

// Global singleton
export function getAppStorage(): AppStorage {
  if (!globalAppStorage) {
    throw new Error('AppStorage not initialized');
  }
  return globalAppStorage;
}

export function setAppStorage(storage: AppStorage): void {
  globalAppStorage = storage;
}
```

### SitegeistAppStorage (extension)

Location: `src/storage/app-storage.ts`

Extends base storage with Sitegeist-specific stores.

```typescript
export class SitegeistAppStorage extends AppStorage {
  readonly memories: MemoriesStore;
  readonly skills: SkillsStore;
  readonly prompts: PromptsStore;

  constructor() {
    // 1. Create all stores (no backend yet)
    const settings = new SettingsStore();
    const providerKeys = new ProviderKeysStore();
    const sessions = new SessionsStore();
    const memories = new MemoriesStore();
    const skills = new SkillsStore();
    const prompts = new PromptsStore();

    // 2. Gather configs from all stores
    const configs = [
      settings.getConfig(),
      SessionsStore.getMetadataConfig(),
      providerKeys.getConfig(),
      sessions.getConfig(),
      memories.getConfig(),
      skills.getConfig(),
      prompts.getConfig(),
    ];

    // 3. Create backend with all configs
    const backend = new IndexedDBStorageBackend({
      dbName: 'sitegeist-storage',
      version: 1,
      stores: configs,
    });

    // 4. Wire backend to all stores
    settings.setBackend(backend);
    providerKeys.setBackend(backend);
    sessions.setBackend(backend);
    memories.setBackend(backend);
    skills.setBackend(backend);
    prompts.setBackend(backend);

    // 5. Pass base stores to parent
    super(settings, providerKeys, sessions, backend);

    // 6. Store references to sitegeist-specific stores
    this.memories = memories;
    this.skills = skills;
    this.prompts = prompts;
  }
}

export function getSitegeistStorage(): SitegeistAppStorage {
  return getAppStorage() as SitegeistAppStorage;
}
```

**Initialization order**:
1. Create store instances (no backend)
2. Collect all store configs
3. Create IndexedDB backend with unified config
4. Wire backend to all stores
5. Call parent constructor
6. Store extension-specific references

**Why this order?**
- Backend needs all configs upfront for `onupgradeneeded`
- No circular dependencies
- Each store owns its schema
- Type-safe access to extension stores

## Usage Examples

### Saving a Session

```typescript
const storage = getAppStorage();

const sessionData: SessionData = {
  id: crypto.randomUUID(),
  title: 'My Session',
  model: getModel('anthropic', 'claude-sonnet-4'),
  thinkingLevel: 'off',
  messages: [...],
  createdAt: new Date().toISOString(),
  lastModified: new Date().toISOString(),
};

const metadata: SessionMetadata = {
  id: sessionData.id,
  title: sessionData.title,
  createdAt: sessionData.createdAt,
  lastModified: sessionData.lastModified,
  messageCount: sessionData.messages.length,
  usage: { input: 0, output: 0, ... },
  modelId: sessionData.model.id,
  thinkingLevel: sessionData.thinkingLevel,
  preview: '',
};

// Atomic save to both stores
await storage.sessions.save(sessionData, metadata);
```

### Loading Sessions (Sorted by Date)

```typescript
const storage = getAppStorage();

// Uses lastModified index - pre-sorted by database
const sessions = await storage.sessions.getAllMetadata();

// sessions is now sorted newest-first without any JS sorting!
```

### Working with Memories

```typescript
const storage = getSitegeistStorage();
const sessionId = 'abc-123';

// Store a memory
await storage.memories.set(sessionId, 'user_name', 'Alice');

// Retrieve a memory
const name = await storage.memories.get(sessionId, 'user_name');

// List all memories for session
const keys = await storage.memories.list(sessionId);
```

### Managing Skills

```typescript
const storage = getSitegeistStorage();

// Save a skill
await storage.skills.save({
  name: 'gmail-search',
  domainPatterns: ['mail.google.com'],
  description: 'Search Gmail messages',
  library: 'function searchGmail(query) { ... }',
  parameters: [{ name: 'query', type: 'string' }],
});

// Load skill by name
const skill = await storage.skills.get('gmail-search');

// List all skills
const allSkills = await storage.skills.list();
```

## Quota Management

### Checking Storage Usage

```typescript
const storage = getAppStorage();
const quota = await storage.backend.getQuotaInfo();

console.log(`Using ${quota.usage} bytes of ${quota.quota} bytes`);
console.log(`${quota.percent.toFixed(1)}% full`);

if (quota.percent > 80) {
  alert('Running out of storage!');
}
```

### Requesting Persistent Storage

```typescript
const storage = getAppStorage();

// Prevents browser from evicting data
const granted = await storage.backend.requestPersistence();

if (granted) {
  console.log('Storage will not be evicted');
} else {
  console.log('User denied persistence request');
}
```

**Note**: Chrome/Edge grant persistence automatically for installed extensions.

## Debug Tools

### Dumping Session Metadata

Console function available in sidepanel:

```javascript
// In sidepanel console
const sessions = await dumpSessionMetadata();

// Outputs table with:
// - id
// - title
// - lastModified (sorted!)
// - createdAt
// - messageCount
```

### Inspecting IndexedDB

Chrome DevTools → Application → IndexedDB → `sitegeist-storage`

- View all object stores
- Inspect indices
- Query data manually
- Check index usage

## Performance Considerations

### When to Use Indices

**Good use cases**:
- Sorting large datasets (sessions by date)
- Range queries (sessions between dates)
- Frequent lookups on non-primary key

**Bad use cases**:
- Small datasets (<100 items)
- Single-item lookups by primary key
- Write-heavy workloads (indices slow down writes)

### Session Metadata Separation

Loading session list with full data:
```
❌ Slow: 1000 sessions × 100KB each = 100MB to transfer
```

Loading session list with metadata only:
```
✅ Fast: 1000 sessions × 1KB each = 1MB to transfer
```

### Prefix Queries vs Full Scan

Getting all memories for a session:

```typescript
// ❌ Slow: Full scan
const allKeys = await backend.keys('memories');
const sessionKeys = allKeys.filter(k => k.startsWith(`${sessionId}_`));

// ✅ Fast: Prefix query with IDBKeyRange
const keys = await backend.keys('memories', `${sessionId}_`);
```

## Future Extensions

### Additional Indices

Add to `sessions-metadata`:
```typescript
{ name: 'createdAt', keyPath: 'createdAt' }
{ name: 'messageCount', keyPath: 'messageCount' }
```

Enables queries like:
- Sessions created this week
- Sessions with >50 messages

### Compound Indices

```typescript
{ name: 'modelAndDate', keyPath: ['modelId', 'lastModified'] }
```

Query all Claude Sonnet sessions sorted by date.

### Remote Sync Backend

```typescript
export class RemoteSyncBackend implements StorageBackend {
  async get(storeName: string, key: string) {
    // Fetch from local IndexedDB first
    // Sync with remote API in background
  }

  async set(storeName: string, key: string, value: T) {
    // Save to local IndexedDB immediately
    // Queue remote sync
  }
}
```

### Export/Import

```typescript
export class DataExporter {
  async exportAll(): Promise<ExportData> {
    const data: ExportData = {};
    for (const storeName of storeNames) {
      data[storeName] = await backend.getAllFromIndex(
        storeName,
        'id',
        'asc'
      );
    }
    return data;
  }

  async importAll(data: ExportData): Promise<void> {
    // Validate schema
    // Import with transactions
  }
}
```

## Related Files

### Core Storage (web-ui)
- [types.ts](../../pi-mono/packages/web-ui/src/storage/types.ts) - Interfaces and types
- [store.ts](../../pi-mono/packages/web-ui/src/storage/store.ts) - Base Store class
- [app-storage.ts](../../pi-mono/packages/web-ui/src/storage/app-storage.ts) - Base AppStorage
- [backends/indexeddb-storage-backend.ts](../../pi-mono/packages/web-ui/src/storage/backends/indexeddb-storage-backend.ts) - IndexedDB implementation

### Store Implementations (web-ui)
- [stores/settings-store.ts](../../pi-mono/packages/web-ui/src/storage/stores/settings-store.ts)
- [stores/provider-keys-store.ts](../../pi-mono/packages/web-ui/src/storage/stores/provider-keys-store.ts)
- [stores/sessions-store.ts](../../pi-mono/packages/web-ui/src/storage/stores/sessions-store.ts)

### Extension Storage (sitegeist)
- [app-storage.ts](../src/storage/app-storage.ts) - SitegeistAppStorage
- [stores/memories-store.ts](../src/storage/stores/memories-store.ts)
- [stores/skills-store.ts](../src/storage/stores/skills-store.ts)
- [stores/prompts-store.ts](../src/storage/stores/prompts-store.ts)

### Related Docs
- [memories.md](memories.md) - Agent memory system using MemoriesStore
- [prompts.md](prompts.md) - Prompt templates system
