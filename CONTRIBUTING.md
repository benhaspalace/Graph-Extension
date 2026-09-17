# Contributing

Thanks for taking an interest in Graph Explorer JSON Query. Bug reports, small
fixes, and well-scoped features are all welcome.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Found a security vulnerability? **Do not open an issue** — follow
[SECURITY.md](SECURITY.md) instead.

## Before you post anything

This extension handles data from real Microsoft 365 tenants. Anything you paste
into an issue, a pull request, or a screenshot must be **redacted or
synthetic**: no access tokens, no cookies, no tenant or user identifiers, no
real mail addresses or display names, no raw Graph responses. Graph Explorer's
sample tenant (available when signed out) is the easiest way to produce a
shareable reproduction.

## Reporting a bug or requesting a feature

Open an issue using one of the templates (**New issue** offers a bug report and
a feature request form). The bug template asks for the browser and extension
version, the query language, and a minimal reproduction — please fill those in;
most reports that stall are missing one of them.

## Development setup

The extension is plain JavaScript with **no build step** — the repository root
*is* the extension.

1. Clone the repository.
2. Open `chrome://extensions` (Edge: `edge://extensions`) and enable
   **Developer mode**.
3. **Load unpacked** and select the repository folder.
4. Edit a file, then hit **Reload** on the extensions page to pick up the
   change. Reloading also requires reloading the Graph Explorer tab, since the
   content scripts are injected at page load.

Node.js 22 is what CI uses; anything recent works for the tests.

## Checks to run before opening a pull request

```bash
npm test               # verify vendored checksums (pretest), then unit tests
npm run e2e            # offline end-to-end smoke test (needs Playwright)
npm run verify:vendor  # vendored bundles vs vendor/CHECKSUMS.txt
```

The unit tests are `node --test` over `test/*.test.js` and need no
dependencies. The e2e smoke test drives headless Chromium against a Graph
Explorer stand-in served through Playwright route interception, so it needs no
network — install it first with
`npm i -D playwright && npx playwright install chromium`.

CI (`.github/workflows/build.yml`) runs the same three checks on every push and
pull request. `verify:vendor` is the gate every other job depends on.

## Code style and invariants

Match the file you are editing; there is no formatter or linter to defer to.

- **Browser code (`src/**`, `popup/**`) is ES5-flavored:** `'use strict'`,
  `var`, `function` declarations, 2-space indent, single quotes, semicolons.
  Test and script files are Node and use `const`/`require`.
- **Pure logic belongs in `src/query-utils.js`** — it is UMD, dependency-free,
  and loaded independently into four contexts (MAIN world, isolated world,
  evaluator frame, popup). It is also the one source file the unit tests
  require, so new helpers there should arrive with tests in
  `test/query-utils.test.js`.
- **Comments explain *why*.** Follow the existing JSDoc-style headers on
  functions and the module-level block comments describing each file's role.

These invariants are load-bearing for the security model in
[SECURITY.md](SECURITY.md) — a pull request that breaks one will not be merged:

- **No dynamic code.** No `eval`, `new Function`, remote scripts, or
  `innerHTML`/`insertAdjacentHTML`/`document.write`. The panel is built with
  `createElement`/`textContent` only, so Graph response data is never
  interpreted as markup. The one WebAssembly module (`vendor/jq-wasm.js` —
  jq itself) is a vendored, checksummed binary instantiated from embedded
  bytes; the manifest's `'wasm-unsafe-eval'` exists for it alone and must
  not widen.
- **No new permissions or host access.** `storage` and
  `developer.microsoft.com` are the whole surface.
- **No credentials, ever.** `Authorization`, `Cookie`, `SdkVersion`, and
  `client-request-id` are stripped in the MAIN world before anything leaves it;
  response bodies stay in memory and are never persisted.
- **No new network requests.** The only outbound traffic is `@odata.nextLink`
  paging to verified Microsoft Graph hosts.
- **No telemetry, no runtime npm dependencies.**
- **The interceptor stays observe-only** — it may read requests and responses,
  never rewrite them.

New to the layout? [`docs/dependency-graph.md`](docs/dependency-graph.md) maps
which file loads, messages, or depends on which.

## Updating a vendored dependency

Third-party libraries live in `vendor/` as pre-built, version-pinned bundles
whose SHA-256 hashes are pinned in `vendor/CHECKSUMS.txt`:

1. Rebuild the bundle from the pinned upstream version — each vendored file's
   header documents the exact version and the command used to produce it.
2. Update that header, then run `npm run vendor:hash` to regenerate
   `vendor/CHECKSUMS.txt`, and review the diff.
3. Update the version, license, and hash rows in [SBOM.md](SBOM.md) (and the
   component list in [`docs/dependency-graph.md`](docs/dependency-graph.md) if
   the set of packages changed).
4. Run the full check list above — `verify:vendor` must pass.

Explain in the pull request why the update is needed and what changed upstream.
Adding a *new* third-party library is a bigger conversation: open an issue
first.

## Pull requests

- Branch off `main`, one topic per pull request.
- Fill in the pull-request template — reviewers rely on the checks and
  security-invariant boxes.
- Keep the docs in step with behavior: `README.md` for user-visible features,
  the settings table for new settings, `SECURITY.md`/`SBOM.md` for
  dependency or security-model changes.
- Commit messages use an imperative summary line (`Fix …`, `Add …`), with a
  `(vX.Y.Z)` suffix on the commit that carries a version bump.

### Versioning and releases

Versions live in **both** `manifest.json` and `package.json` and must match.
When a change lands on `main` with a bumped version, CI publishes a GitHub
Release tagged `v<version>` with the zip, its `.sha256`, and a SLSA
build-provenance attestation; pushes without a bump publish nothing. Bump the
minor version for user-visible features, the patch version for fixes — and feel
free to leave the bump to a maintainer if you are unsure.

## Questions

Open an issue. For anything security-sensitive, use the private reporting flow
in [SECURITY.md](SECURITY.md).
