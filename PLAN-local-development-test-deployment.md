# Plan: Local Development Test Deployment

## Objective

Create a repeatable local test deployment workflow for Sitegeist so we can validate the browser extension in a production-like state before release, without depending on the full long-running dev watcher stack.

This plan covers:
- the current project architecture and dev flow
- gaps in the existing local testing story
- a proposed local test deployment workflow
- concrete implementation tasks for adding a stable local deployment path

This is a planning document only. No implementation is included here.

## Review Summary

### What this project is

Sitegeist is a Chrome/Edge side panel extension that embeds an AI assistant into the browser and can navigate pages, run tools, extract data, and operate with multiple model providers.

There is also a separate `site/` subproject for the marketing/install website.

### Primary code areas

#### Extension app
- `src/sidepanel.ts` — main extension entry point, app bootstrap, settings, model selection, session handling
- `src/background.ts` — service worker for sidepanel open/close behavior, locks, relay messaging
- `src/tools/` — browser automation and assistant tools
- `src/dialogs/` — settings, onboarding, session dialogs
- `src/storage/app-storage.ts` — IndexedDB wiring for extension persistence
- `static/manifest.chrome.json` — extension manifest
- `scripts/build.mjs` — extension bundling and asset copy into `dist-chrome/`
- `scripts/dev-server.mjs` — WebSocket-based hot-reload helper for development

#### Marketing/install site
- `site/src/frontend/` — static marketing pages
- `site/infra/vite.config.ts` — Vite config for local frontend serving/build
- `site/run.sh` — local dev/build/deploy helper for site

### Current dev workflow

#### Extension development
- `./dev.sh` starts:
  - `../mini-lit` TS watcher
  - `../pi-mono` TS watcher
  - Sitegeist extension watcher
  - site frontend dev server
- Extension watcher writes to `dist-chrome/`
- Developer manually loads `dist-chrome/` via `chrome://extensions`
- `src/utils/live-reload.ts` reconnects to `ws://localhost:8765` and reloads the extension when files change

#### Checks
- `./check.sh` runs `npm run check`
- root `package.json` check includes formatting, TS checks, and `site` checks

#### Production/release path today
- Extension release is GitHub-release oriented via `./release.sh`
- Site deployment is remote-only via `cd site && ./run.sh deploy`

## Important Findings

### 1. The extension already has a strong dev-watch workflow

The project is optimized for active development with hot-reload and unpacked extension loading.

That is good for coding, but it is not the same as a stable local test deployment.

### 2. There is no explicit "local test deployment" workflow today

There is no documented or scripted flow for:
- producing a clean local extension artifact
- launching a production-like validation environment
- separating active dev mode from stable test mode
- defining a smoke-test checklist for local deployment validation

### 3. The website docs are stale relative to the current `site/` tree

`site/README.md` describes a backend, Docker flow, and files such as:
- `site/src/backend/server.ts`
- `site/tsconfig.backend.json`
- `site/infra/docker-compose.yml`
- `site/infra/Dockerfile.backend`

But in the current repo state:
- `site/src/backend/` does not exist
- `site/tsconfig.backend.json` does not exist
- `site/src/` contains only frontend files
- `site/run.sh` currently supports only `dev`, `build`, and `deploy`

This mismatch creates risk for anyone trying to stand up a local test environment based on docs alone.

### 4. The extension is the real local deployment target

For local validation, the meaningful deployable artifact is:
- `dist-chrome/` for the extension

The `site/` project is a secondary static frontend and should have its own simpler local preview path.

### 5. Sibling dependency assumptions need to be explicit in test deployment planning

The extension depends on:
- `../mini-lit`
- `../pi-mono`

These are linked via `file:` dependencies and are part of the effective local runtime.

A local test deployment plan must define whether it supports:
- watch-mode development with sibling repos present
- stable test builds using already-built sibling artifacts
- both

## Goal State

We should support two distinct local workflows:

### A. Active development mode
Purpose: fast iteration while coding.

Characteristics:
- uses `./dev.sh`
- hot reload enabled
- unpacked extension loaded from `dist-chrome/`
- site available via local Vite dev server

### B. Local test deployment mode
Purpose: production-like validation before release or bug triage.

Characteristics:
- clean rebuild
- no watch processes required after build
- extension loaded from a fresh `dist-chrome/` artifact
- optional local static preview of the marketing site
- documented smoke test checklist
- deterministic steps for other contributors

## Proposed Local Test Deployment Strategy

## Scope

### In scope
- local extension build and validation workflow
- local static site preview workflow
- documentation updates
- optional helper script(s) for reproducible local test deployment
- smoke-test checklist

### Out of scope
- publishing to Chrome Web Store
- changing the user-facing release flow
- remote server deployment changes
- CI/CD redesign

## Proposed workflow

### 1. Clean local extension test deployment

Recommended command flow:

```bash
npm install
./check.sh
npm run build
```

Result:
- fresh `dist-chrome/` produced
- developer loads `dist-chrome/` through `chrome://extensions`
- extension runs without depending on the watch server

### 2. Local marketing site preview

Recommended command flow:

```bash
cd site
npm install
./run.sh build
npx vite preview --config infra/vite.config.ts --host 0.0.0.0 --port 4173
```

Result:
- local preview of the built static site on a stable preview port
- closer to actual deployment than `vite dev`

### 3. Document a test matrix

Minimum local test deployment matrix:
- extension loads successfully in Chrome/Edge
- side panel opens from toolbar
- side panel opens via keyboard shortcut
- first-run provider setup works
- session creation and persistence works
- at least one provider-backed model can send a message
- browser navigation tool can operate on a test page
- reload/update flow works by rebuilding and clicking reload in `chrome://extensions`
- site homepage renders correctly in preview mode
- install page renders correctly in preview mode

## Implementation Plan

## Phase 1: Clarify and document the current reality

### 1.1 Update root README with explicit local test deployment section
- [ ] Add a new section: `Local test deployment`
- [ ] Distinguish it from `Development`
- [ ] Document exact steps for building and loading `dist-chrome/`
- [ ] Document that this mode does not require `./dev.sh`
- [ ] Document how to reload the unpacked extension after rebuilding

### 1.2 Fix `site/README.md` so it matches the actual project
- [ ] Remove or rewrite outdated backend and Docker references if they are no longer intentional
- [ ] Update project structure to match current `site/src/frontend/*`
- [ ] Document `dev`, `build`, and local preview separately
- [ ] Document remote deploy as a separate step

### 1.3 Add a short testing checklist doc
- [ ] Create `docs/local-test-deployment.md`
- [ ] Include prerequisites, commands, expected outputs, and smoke checks
- [ ] Include Chrome extension permissions/setup reminders:
  - [ ] enable Developer mode
  - [ ] load unpacked from `dist-chrome/`
  - [ ] allow user scripts
  - [ ] allow file URLs if required

## Phase 2: Add a stable local preview command surface

### 2.1 Add a root script for local extension test build
- [ ] Add a script in root `package.json`, e.g. `testdeploy:extension`
- [ ] Make it run:
  - [ ] clean build
  - [ ] validation checks or documented precondition to run `./check.sh`
  - [ ] `npm run build`
- [ ] Keep it non-interactive and short-lived

### 2.2 Add a local site preview command in `site/package.json`
- [ ] Add `preview` script using Vite preview with explicit host/port
- [ ] Add optional `testdeploy:site` script that runs build then preview
- [ ] Ensure commands terminate normally or are clearly documented as long-running preview commands

### 2.3 Optionally add a small wrapper script for local test deployment docs
- [ ] Add `scripts/local-test-deploy.md` or `scripts/local-test-deploy.sh` guidance wrapper
- [ ] Prefer a short-lived setup script over a long-running orchestration script
- [ ] Do not replace `./dev.sh`; keep the workflows separate

## Phase 3: Define validation for a production-like extension test

### 3.1 Build artifact validation
- [ ] Confirm `dist-chrome/manifest.json` is generated from `static/manifest.chrome.json`
- [ ] Confirm sidepanel, background, and static assets exist in `dist-chrome/`
- [ ] Confirm PDF worker is copied into `dist-chrome/pdfjs-dist/build/`

### 3.2 Browser validation checklist
- [ ] Load unpacked extension from `dist-chrome/`
- [ ] Verify extension icon appears
- [ ] Verify toolbar click opens sidepanel
- [ ] Verify keyboard shortcut toggles sidepanel
- [ ] Verify settings dialog opens
- [ ] Verify provider configuration persists across reload
- [ ] Verify a saved session can be restored

### 3.3 Functional smoke tests
- [ ] Send a basic prompt using one configured provider
- [ ] Use at least one browser tool on a known-safe page
- [ ] Verify document extraction path on a simple public file or page
- [ ] Verify proxy settings can be opened and saved
- [ ] Verify live-reload code does not block runtime when dev server is absent

### 3.4 Site smoke tests
- [ ] Preview built site locally
- [ ] Open `/`
- [ ] Open `/install.html`
- [ ] Verify asset paths resolve in preview mode
- [ ] Verify videos/images fail gracefully if any external assets are unavailable

## Phase 4: Remove documentation drift and ambiguity

### 4.1 Resolve the `site/README.md` architecture mismatch
- [ ] Decide whether the backend/Docker workflow is intentionally removed or temporarily missing
- [ ] If removed, delete stale references entirely
- [ ] If intended to return, clearly mark the README as transitional and split current vs planned architecture

### 4.2 Make the root README explicit about the two modes
- [ ] Add a section comparing:
  - [ ] `./dev.sh` for live coding
  - [ ] `npm run build` + load unpacked for test deployment
- [ ] Explain when each mode should be used

### 4.3 Add troubleshooting notes
- [ ] Missing sibling repos (`../mini-lit`, `../pi-mono`)
- [ ] Extension not updating until manual reload
- [ ] Chrome permissions not enabled
- [ ] local WebSocket dev server absent in test mode is expected
- [ ] provider CORS/proxy issues in local testing

## Deliverables

### Documentation deliverables
- [ ] `README.md` updated with local test deployment section
- [ ] `site/README.md` corrected
- [ ] `docs/local-test-deployment.md` added

### Command/script deliverables
- [ ] root `package.json` script for extension test deployment
- [ ] `site/package.json` preview script
- [ ] optional helper wrapper if it improves repeatability without adding complexity

### Validation deliverables
- [ ] documented smoke test checklist
- [ ] one recommended browser/version baseline for local testing

## Suggested command design

### Root `package.json`
- [ ] Add something like:

```json
{
  "scripts": {
    "testdeploy:extension": "npm run build"
  }
}
```

Potential variant if we want checks included:

```json
{
  "scripts": {
    "testdeploy:extension": "npm run check && npm run build"
  }
}
```

Note: if check time is high, keep `./check.sh` as a required pre-step in docs rather than always coupling it.

### `site/package.json`
- [ ] Add something like:

```json
{
  "scripts": {
    "preview": "vite preview --config infra/vite.config.ts --host 0.0.0.0 --port 4173",
    "testdeploy": "npm run build && npm run preview"
  }
}
```

## Recommended smoke test scenario

### Extension
- [ ] Build with `npm run build`
- [ ] Load `dist-chrome/` as unpacked extension
- [ ] Open a normal webpage
- [ ] Launch Sitegeist sidepanel
- [ ] Configure one provider
- [ ] Send one prompt
- [ ] Trigger one browser action
- [ ] Reload the extension and confirm settings/session persistence

### Site
- [ ] Build site
- [ ] Run preview server
- [ ] Verify homepage
- [ ] Verify install page
- [ ] Verify responsive layout at desktop and mobile widths

## Risks and constraints

### Linked sibling repos
- [ ] Local setup depends on `../mini-lit` and `../pi-mono`
- [ ] If these are absent or stale, build/test deployment can fail or behave inconsistently

### Unpacked extension testing is semi-manual by nature
- [ ] Browser loading still requires manual action in `chrome://extensions`
- [ ] This is acceptable, but should be clearly documented as part of the workflow

### Documentation drift is currently the biggest operational risk
- [ ] Contributors may attempt nonexistent site backend workflows
- [ ] Test deployment instructions must reflect the repo as it exists now

## Acceptance Criteria

- [ ] A contributor can build and locally test the extension without guessing steps
- [ ] A contributor can preview the built marketing site locally
- [ ] The project clearly distinguishes dev-watch mode from test deployment mode
- [ ] README and site docs match the actual codebase
- [ ] Local test deployment instructions are repeatable on a clean machine with required sibling repos present

## File References

### Extension
- `README.md`
- `package.json`
- `check.sh`
- `dev.sh`
- `scripts/build.mjs`
- `scripts/dev-server.mjs`
- `src/sidepanel.ts`
- `src/background.ts`
- `src/utils/live-reload.ts`
- `src/storage/app-storage.ts`
- `static/manifest.chrome.json`

### Site
- `site/README.md`
- `site/package.json`
- `site/run.sh`
- `site/infra/vite.config.ts`
- `site/src/frontend/index.html`
- `site/src/frontend/install.html`
- `site/src/frontend/main.ts`

## Recommendation

Implement this in the following order:
1. fix documentation drift
2. add explicit local test deployment commands
3. define and document the smoke test checklist
4. only then consider any extra automation around browser startup or packaging

This keeps the workflow simple, avoids unnecessary tooling, and gives the project a clear separation between development and pre-release local validation.
