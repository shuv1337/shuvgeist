# Validation Evidence

## Passed

- `./check.sh` passed after implementation.
  - Biome checked 151 files.
  - TypeScript passed for extension and node configs.
  - Unit suite passed: 57 files / 261 tests.
  - Integration suite passed: 5 files / 24 tests.
  - Site check passed.
- `npm run build` passed after implementation and rebuilt `dist-chrome/`.
- `npm run build:cli` passed after implementation and rebuilt `dist-cli/shuvgeist.mjs`.
- `npm run test:e2e:extension` passed after implementation: 4 tests passed.
- The deterministic Playwright extension fixture `tests/e2e/extension/deterministic-ci.spec.ts` now runs without a skip and verifies:
  - workflow `target.mode: "new-tab"` plus workflow assertion steps,
  - direct bridge `page_assert` for text and role assertions,
  - frame listing and role-based ref lookup inside a local iframe,
  - native trusted `ref_click` in the iframe,
  - post-click iframe assertion.
- Headless launch was verified with an isolated profile:

```text
node dist-cli/shuvgeist.mjs launch --url about:blank --headless --user-data-dir "$USERDIR" --json
```

returned a launched Helium PID using `/home/shuv/repos/shuvgeist/dist-chrome`, and subsequent status showed `extension.connected: true`, `appVersion: "1.1.14"`, and `page_assert` in the advertised capabilities.

## Environment Notes

- The default local bridge on this workstation is currently a long-running installed `shuvgeist serve` process from `/home/shuv/.local/bin/shuvgeist`. A live `assert` command against that existing server returned `Unknown method: page_assert`, even while the newly launched extension advertised `page_assert`. This is a local server/version mismatch, not a failure of the rebuilt extension or the local Playwright e2e path.
- `launchBrowser` now honors explicit `--user-data-dir` by launching that isolated profile even if another extension is already connected, so CI and validation can prove the requested extension build instead of short-circuiting on an unrelated existing browser connection.
