# Security Policy

This extension is designed to be safe to run in security-conscious and
enterprise environments. This document describes its security model, the
supply-chain controls around how it is built and distributed, how to verify
a build before deploying it, and how to report a vulnerability.

## Reporting a vulnerability

Please report security issues **privately** via GitHub's
[private vulnerability reporting](https://github.com/benhaspalace/Graph-Explorer-Browser-Extension/security/advisories/new)
(the repository's **Security → Report a vulnerability** tab). Do not open a
public issue for a suspected vulnerability. We aim to acknowledge reports
within a few business days.

## Security model

- **Runs entirely locally.** The extension makes **no network requests of its
  own**. The only exception is the auto-fetch feature (**on by default; can be
  turned off** in the settings or by policy), which requests the next pages of
  the *same* Microsoft Graph query the user already ran, and only after
  verifying the target is a Microsoft Graph host. There is **no telemetry,
  analytics, or phone-home** of any kind.
- **The network interceptor is observe-only.** It wraps `fetch`/`XHR` to read
  Graph JSON responses for display; it never rewrites requests or responses.
- **No credentials are read or stored.** Captured request headers are
  sanitized before anything leaves the page's MAIN world: `Authorization`,
  `Cookie`, `SdkVersion`, and `client-request-id` are always dropped, and the
  directives Graph Explorer adds itself are stripped from the values of
  `Prefer` (`ms-graph-dev-mode`), `Cache-Control` and `Pragma` (`no-cache`,
  `no-store`) — each header is kept only when tokens the user typed remain.
  Access tokens and the user's MSAL/session storage are never read for their
  values or persisted. The same sanitization is re-applied to the stored query
  history when it is loaded and to any imported query library, so nothing that
  predates a rule (or arrives in a file) is replayed into Graph Explorer's
  request editor unchecked.
- **No dynamic code execution.** There is no `eval`, `new Function`, remote
  script loading, or `innerHTML`/`insertAdjacentHTML`/`document.write` in the
  extension's own code (`src/**`). The UI is built in a ShadowRoot exclusively
  via `createElement`/`textContent`, so untrusted Graph response data is never
  interpreted as markup. Query results are evaluated by the vendored query
  engines as data, not as JavaScript. The jq engine is jq itself compiled
  to WebAssembly (`vendor/jq-wasm.js`): a fixed, checksummed binary shipped
  with the extension and instantiated from its embedded bytes — never from
  anything fetched or computed at runtime — and it only ever receives JSON
  text and a filter string.
- **Strict Content-Security-Policy.** Extension pages declare
  `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; base-uri 'none'`
  (Manifest V3 also forbids remote code by default). `'wasm-unsafe-eval'` is
  the narrowest directive that lets a page instantiate WebAssembly at all; it
  does not allow `eval` or any string-to-code path, and the only module it
  is used for is the vendored jq binary. Query engines and the editor are
  bundled locally; nothing is fetched from a CDN.
- **Cross-context messaging is validated.** The MAIN-world ↔ isolated-world
  `postMessage` bridge checks `event.source === window` and
  `event.origin === location.origin` and validates the message shape.
- **The off-thread evaluator is inert by design.** Large datasets are queried
  in a hidden extension-origin iframe (`src/evaluator.html`, hosted in the
  extension's own process so evaluations never block the page). It holds
  datasets in memory only, runs nothing but the three vendored query engines
  over the JSON it is handed (no code evaluation, no storage, no network,
  no privileged APIs), and the panel only trusts replies whose
  `event.source` is that exact frame — page scripts cannot forge it.
- **Least privilege.** The only requested permission is `storage`. Host access
  is limited to `developer.microsoft.com` graph-explorer pages via content
  script `matches` — there is no `tabs` permission and no broad host access.
- **Spreadsheet-injection safe exports.** CSV/TSV cells beginning with
  `=`, `+`, `-`, or `@` are prefixed with an apostrophe (CWE-1236) so crafted
  Graph field values cannot execute as formulas when a file is opened in
  Excel/Sheets/LibreOffice.

### Data stored locally (`chrome.storage.local`, never `sync`)

Settings, the last query text, panel/layout state, and the query history
(query text, language, timestamp, and the **method, URL, and sanitized
headers** of the Graph request each query ran against). Captured response
**bodies live only in memory** — small ones in the page, large ones in the
hidden evaluator frame's extension process — and are cleared on reload;
they are never persisted. Nothing is sent anywhere.

## Supply-chain controls

- **No runtime npm dependencies.** The shipped extension pulls in zero npm
  packages at install time. Every third-party library is committed as a
  pre-built, version-pinned bundle under `vendor/` (see [SBOM.md](SBOM.md)).
- **Vendored bundles are integrity-checked.** `vendor/CHECKSUMS.txt` pins the
  SHA-256 of each bundle. `npm run verify:vendor` (also run automatically
  before the test suite and as a dedicated CI gate that every other job
  depends on) fails the build if any bundle is modified, missing, or added
  without being listed — so tampered dependencies never build or ship.
- **Reproducible bundles.** Each vendored file's header documents the exact
  upstream version and the command used to build it, so an auditor can
  regenerate and diff it.
- **Hardened CI/CD** (`.github/workflows/build.yml`):
  - All GitHub Actions are **pinned to full commit SHAs** (not floating
    tags), and kept current via Dependabot.
  - The workflow token is **read-only by default**; only the release job
    elevates to the minimum scopes it needs.
  - Checkouts use `persist-credentials: false`.
  - The one build/test tool (Playwright) is installed at a **pinned version
    with `--ignore-scripts`** to block lifecycle-script execution.
- **Signed, verifiable releases.** Each release attaches the extension zip, a
  `.sha256` checksum, and a **SLSA build-provenance attestation**
  (`actions/attest-build-provenance`) so you can prove the artifact was built
  by this repository's workflow from this source.

## Verifying a release before deploying

```bash
# 1. Integrity — the download matches its published checksum
sha256sum -c graph-explorer-json-query-v<version>.zip.sha256

# 2. Provenance — the artifact was built by this repo's CI from this source
gh attestation verify graph-explorer-json-query-v<version>.zip \
  --repo benhaspalace/Graph-Explorer-Browser-Extension

# 3. Vendored dependencies — unzip, then confirm the bundles are unmodified
unzip -q graph-explorer-json-query-v<version>.zip -d ge-jq
cd ge-jq/graph-explorer-json-query
node ../../scripts/verify-vendor.js   # or diff vendor/*.js against SBOM.md
```

## Guidance for locked-down / managed deployments

- Deploy a **specific, pinned version** that you have reviewed and whose
  checksum and provenance you have verified — do not auto-track `main`.
- Distribute via your organization's **enterprise force-install policy**
  (Chrome/Edge `ExtensionInstallForcelist` / self-hosted CRX) rather than
  ad-hoc load-unpacked, so integrity is enforced by the browser.
- Auto-fetch is the only feature that makes network calls, and it is now
  **on by default** (it follows `@odata.nextLink` to Microsoft Graph hosts to
  page through the user's own query). If any outbound request beyond the exact
  request the user ran is unacceptable, **turn it off** — in the settings, or
  by seeding `chrome.storage.local` `gejq.settings.autoFetchNextLink = false`
  via managed policy.
- Review the requested permission (`storage`) and host scope
  (`developer.microsoft.com`) against your policy; both are intentionally
  minimal.

## Supported versions

Security fixes are applied to the latest released version. Please upgrade to
the latest release before reporting an issue.
