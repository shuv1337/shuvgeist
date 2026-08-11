# Chrome and Edge Tab-Group Identity and Lifecycle

Research date: 2026-08-10  
Issue: [#81](https://github.com/shuv1337/shuvgeist/issues/81)

## Executive summary

Chrome's extension APIs expose tab groups as live browser objects, not durable extension-owned entities. `chrome.tabs.group()` creates or joins a group and returns a numeric group ID; `chrome.tabGroups.query()` and the tab-group events expose current state. The only documented identity guarantee is that a group ID is unique **within a browser session**. Tab IDs have the same scope. Neither ID is a durable key across browser restart or session restore.[1][2]

There is no API for claiming, naming an owner of, or attaching extension-private metadata to a browser tab group. A product that "claims" groups must therefore maintain its own durable logical identity and reconcile that identity against current browser state. Group title, color, window, position, and tab membership are mutable observations, not stable identity fields.

The event stream is a change notification mechanism, not an ordered transaction log:

- Group creation, visual updates, within-window moves, and removal have dedicated `chrome.tabGroups` events.[1]
- Tab membership changes are reported through `chrome.tabs.onUpdated` with `changeInfo.groupId`; a newly created tab may initially lack its eventual group membership.[2]
- A cross-window group move does not emit `tabGroups.onMoved`. Chrome documents it as removal from one window and creation in another. Its tabs also participate in the tab detach/attach event model.[1][2]
- Empty groups are deleted and emit `tabGroups.onRemoved`.[1][2]
- No cited API contract specifies relative ordering among group events, tab events, promise resolution, browser startup, or session restore. Consumers must tolerate duplicates, missing intermediate state, and any permitted interleaving by reconciling from `tabGroups.query()` and `tabs.query()`.

Microsoft documents `tabGroups` as a supported Manifest V3 Chromium extension API on desktop Edge. That supports using the same API surface, but it is not an Edge-specific promise that undocumented Chromium implementation details or event ordering will remain identical.[3]

## Guarantee versus observation

### Documented API guarantees

- `TabGroup.id` is a number unique within a browser session.[1]
- `tabs.Tab.id` is also unique within a browser session.[2]
- `tabs.group()` returns the ID of the group it creates or modifies. Passing `groupId` adds tabs to an existing group; omitting it creates a group.[2]
- `tabGroups.move()` can move a whole group within its window or to another normal window.[1]
- `tabGroups.onMoved` is only for moves within one window. Between windows, the group is reported as removed from one window and created in another.[1]
- `tabs.onMoved` is only for moves within one window; cross-window tab movement uses `tabs.onDetached` and `tabs.onAttached`.[2]
- `tabs.onUpdated` can include the tab's new `groupId`, and Chrome specifically directs consumers there when a created tab's eventual group membership is not yet set.[2]
- Removing the last tab from a group deletes the group; `tabGroups.onRemoved` covers direct closure and automatic zero-tab removal.[1][2]
- Incognito access requires user approval. In spanning mode, incognito events reach the shared extension process with an incognito marker. In split mode, regular and incognito extension processes see only their own context and cannot communicate directly.[4][5]
- Manifest V3 service-worker globals are lost when the worker stops. Event listeners must be registered synchronously at top level, and durable state must be stored outside globals.[6][7]

### Current Chromium implementation observations

These observations explain current behavior but are not extension API contracts.

- Internally, Chromium represents a tab-group identity as a token-backed `TabGroupId`, then exposes a session-scoped integer through the extension layer.[8][9]
- Current whole-group cross-window movement detaches the group from one tab strip and inserts it into another. The event router deliberately surfaces the destination as group creation (and currently synthesizes an update after insertion) rather than a cross-window move event.[9][10]
- Current session restore does **not** reuse restored local group IDs. It builds a map from each stored group ID to `TabGroupId::GenerateNew()` and applies the new ID to restored tabs and metadata.[11]
- Chromium can separately reconnect a restored local group to a browser-managed saved/synced-group GUID. That internal GUID is not exposed by `chrome.tabGroups`, so an extension cannot use it as its durable group identity.[11]

Consequences:

- A live whole-group move may appear to preserve an internal identity in the current Chromium build, but extensions must model the documented remove/create boundary and must not depend on equal numeric IDs or a particular event sequence.
- Browser session restore may recreate equivalent tabs, membership, title, color, and collapsed state, but the extension-visible local group ID must be treated as new.

## Lifecycle and event matrix

`Guaranteed` below means documented by the public extension API. `Observed` means current Chromium source behavior only.

| Transition | Identity result | Documented notifications / query result | Required consumer behavior |
|---|---|---|---|
| Create a new group with `tabs.group({tabIds})` | New session-scoped numeric group ID returned | `tabGroups.onCreated`; affected tabs become queryable with the group ID and membership changes can appear in `tabs.onUpdated` | Persist the browser ID only as a live binding; assign a separate durable logical ID if the product owns the concept |
| Add tabs to an existing group | Existing live group ID supplied to `tabs.group()` | Membership changes are represented by each tab's `groupId`, including `tabs.onUpdated` | Re-read all tabs for the group; do not infer final membership from one event |
| Claim an existing browser group | No browser-level ownership or claim operation exists | `tabGroups.query()` and `tabs.query({groupId})` expose current state | Record an extension-owned logical binding after explicit or deterministic matching; handle ambiguity instead of silently claiming |
| Observe a group | ID is valid only for the current browser session and while the group exists | `onCreated`, `onUpdated`, `onMoved`, `onRemoved`, plus tab events | Register listeners synchronously, then reconcile a current snapshot; treat events as invalidation hints |
| Move a tab within the same window | Tab ID remains the live tab's ID; membership may stay or change depending on the move | `tabs.onMoved` reports the directly moved tab; `tabs.onUpdated.groupId` reports membership changes | Re-query the affected window/group because one move event does not describe all tabs shifted in response |
| Move a tab between windows | Same live tab is detached and attached; a group cannot span windows | `tabs.onDetached`, `tabs.onAttached`, and membership updates as applicable | Correlate by live tab ID only within the browser session; reconcile source and destination windows |
| Move a whole group within one window | Same live group | `tabGroups.onMoved`; individual tab move events also fire | Re-query position; do not derive the final index solely from event order |
| Move a whole group between windows | Public contract is removal in source plus creation in destination, not a move event | `tabGroups.onRemoved` and `tabGroups.onCreated`; tab detach/attach events also apply | Correlate by the operation result and a fresh snapshot, not by presumed ID equality or event ordering |
| Browser session restore / restart | Restored group must be treated as a new local binding; IDs are session-scoped | Public API gives no durable-ID or event-replay guarantee; current state is queryable after startup | Reconcile stored logical groups to the restored snapshot; never look up a pre-restart numeric ID as identity |
| Extension service-worker restart | Browser IDs remain live if the browser session and groups remain, but worker memory is gone | Incoming extension events can wake the worker; `runtime.onStartup` fires when the profile starts | Restore extension state from storage and query current groups/tabs before applying changes |
| Last tab leaves or is closed | Group ceases to exist | `tabGroups.onRemoved`; `tabs.ungroup()` explicitly says empty groups are deleted | Remove the live binding; retain only product history if intentional and never keep issuing calls with the dead ID |
| Group is explicitly closed/deleted | Group ceases to exist | `tabGroups.onRemoved` includes the removed group's last exposed details | Treat removal as terminal for that live binding; a later similar group is a new candidate requiring reconciliation |
| Regular/incognito boundary | Separate profile contexts; tabs/groups cannot be moved across profiles | Access and event visibility depend on incognito permission and spanning/split mode | Include profile context in every logical binding; never match or move groups across regular/incognito boundaries |

## Recommended product model

### Identity

Use two layers:

```text
LogicalGroup {
  logicalId: UUID                  // extension-owned, durable
  profileScope: regular|incognito  // never merge these scopes
  policy: managed|observed
  lastKnownFingerprint: ...        // evidence for reconciliation, not identity
}

LiveBinding {
  logicalId: UUID
  browserSessionNonce: UUID
  browserGroupId: number
  windowId: number
  observedAt: timestamp
}
```

Generate `browserSessionNonce` in extension storage intended for the current browser run, or invalidate all live bindings during startup reconciliation. Do not serialize a numeric `groupId` and later assume it still identifies the same logical group.

### Reconciliation

1. Register all `tabGroups`, `tabs`, `windows`, and runtime listeners synchronously at service-worker module evaluation.
2. Load durable logical records from storage.
3. Query `tabGroups.query({})` and the relevant tabs to construct one authoritative current snapshot.
4. Validate every stored live binding against the snapshot. Discard absent bindings.
5. Match unbound logical groups using product-owned evidence. Prefer explicit user confirmation or extension-controlled tab markers. Treat title, color, URL set, order, and window as weighted evidence only because each is mutable or non-unique.
6. If zero candidates match, mark the logical group missing. If multiple candidates match, surface ambiguity; do not claim one arbitrarily.
7. Process later events as reasons to reconcile the smallest affected scope, coalescing bursts. Do not encode correctness in event ordering.

This model also closes service-worker race windows: if a worker was asleep, terminated, or started after browser restoration had already produced intermediate events, the query snapshot recovers the final observable state.

### Operation correlation

For extension-initiated operations, keep a short-lived operation record containing the logical ID, source snapshot, requested destination, and affected tab IDs. After the API promise resolves, query the affected windows and commit the resulting live binding. Events may accelerate that reconciliation but should not be required to complete it.

For user-initiated cross-window moves, debounce the remove/create/detach/attach burst and compare fresh source and destination snapshots. A transient `onRemoved` must not immediately delete the durable logical record if a matching destination candidate can still be established, but the old live binding is invalid as soon as removal is observed.

## Edge portability

Microsoft's current support table lists `tabGroups` for Manifest V3 on desktop Edge and points to the Chrome API reference.[3] The portable contract is therefore the documented Chromium extension API surface. Keep Chromium-source observations behind tests and feature-neutral reconciliation; do not branch on browser brand or claim Edge-specific ordering without a Microsoft source that documents it.

## Decision questions

1. Does Shuvgeist need durable logical groups across full browser restart, or only reliable bindings during one browser session?
2. Is claiming always an explicit user action, or may Shuvgeist automatically reclaim a restored group from a fingerprint? If automatic, what ambiguity threshold is acceptable?
3. May Shuvgeist add an extension-controlled marker tab or other durable evidence, or must matching rely only on user-visible group and tab properties?
4. On `tabGroups.onRemoved`, should a managed logical group become "missing and recoverable," be recreated automatically, or be deleted from Shuvgeist?
5. Should incognito groups be unsupported, modeled as separate ephemeral logical groups, or supported with an explicit no-persistence policy?
6. Is preserving browser-managed saved/synced tab groups in scope? The extension API exposes only the current local group, not Chrome's internal saved-group GUID.

## Sources

1. Google Chrome Extensions, [`chrome.tabGroups`](https://developer.chrome.com/docs/extensions/reference/api/tabGroups).
2. Google Chrome Extensions, [`chrome.tabs`](https://developer.chrome.com/docs/extensions/reference/api/tabs).
3. Microsoft Edge, [Supported APIs for Microsoft Edge extensions](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support).
4. Google Chrome Extensions, [Declare permissions: allow access to incognito pages](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions#allow-access).
5. Google Chrome Extensions, [Manifest: incognito](https://developer.chrome.com/docs/extensions/reference/manifest/incognito).
6. Google Chrome Extensions, [The extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
7. Google Chrome Extensions, [Events in service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events).
8. Chromium source, [`components/tab_groups/tab_group_id.h`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/tab_groups/tab_group_id.h).
9. Chromium source, [`chrome/browser/extensions/api/tab_groups/tab_groups_api.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/tab_groups/tab_groups_api.cc).
10. Chromium source, [`chrome/browser/extensions/api/tab_groups/tab_groups_event_router.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/tab_groups/tab_groups_event_router.cc).
11. Chromium source, [`chrome/browser/sessions/session_restore.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/sessions/session_restore.cc), especially `RestoreTab`, `RestoreTabGroupMetadata`, and the `new_group_ids` mapping.

## Proposed issue resolution comment

Research complete: Chrome/Edge expose tab groups as live, browser-session-scoped objects, not durable extension-owned identities. Numeric tab and group IDs cannot identify a logical group across browser restart/session restore. Cross-window whole-group moves are documented as group removal plus creation, not `tabGroups.onMoved`; tab membership changes are observed through `tabs.onUpdated`, and empty groups are removed. MV3 worker restarts require synchronous listener registration plus storage-backed snapshot reconciliation. Current Chromium implementation details, including live internal group transfer and restore-time ID remapping, are separated from the portable API contract in the report.

Recommended direction: assign Shuvgeist-owned logical IDs, keep numeric IDs only as validated live bindings, reconcile from `tabGroups.query()`/`tabs.query()` at startup and worker wake, treat events as invalidation hints rather than an ordered log, and keep regular/incognito profile scopes separate.

Decisions needed are listed in the report: restart durability, explicit versus automatic claiming, allowed marker evidence, deletion policy, incognito support, and saved/synced-group scope.

Full findings: `docs/research/chrome-tab-group-identity-lifecycle.md`
