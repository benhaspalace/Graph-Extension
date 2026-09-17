# Graph Explorer JSON Query

A browser extension for **Chrome** and **Microsoft Edge** that adds JSON query
capabilities to [Microsoft Graph Explorer](https://developer.microsoft.com/en-us/graph/graph-explorer).
Run a Graph query, then filter, reshape, sort, and export the JSON response
with [JMESPath](https://jmespath.org/) — the same query language as Azure CLI's
`--query` option — with [JSONPath](https://github.com/JSONPath-Plus/JSONPath),
or with [jq](https://jqlang.org/) (real jq 1.8.2, running as WebAssembly).

<!-- The badge tracks main so it never goes stale after a feature branch merges. -->
[![Build & tests](https://github.com/benhaspalace/Graph-Explorer-Browser-Extension/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/benhaspalace/Graph-Explorer-Browser-Extension/actions/workflows/build.yml?query=branch%3Amain)

The **Build** workflow runs the unit tests, the offline end-to-end smoke
test, and the packaging step on every push; the badge above shows the
status for this branch.

![The query panel embedded in Graph Explorer's results area](docs/screenshot.png)

## Features

- **Split results view** — the Graph Explorer results area splits:
  the original response stays on the left, and the query tool takes the right,
  with the query input on top and the live result underneath. Drag the divider
  to resize the split; the position is remembered. Need more room? The ⧉
  button in the panel header breaks the panel out into a full-height side
  panel over the page — click it again to re-embed (the choice persists).
- **Three query languages** — JMESPath (default), JSONPath, or jq, switchable
  from the selector next to the query box or from the extension settings.
  - JMESPath: `value[?jobTitle == 'Auditor'].{name: displayName, email: mail}`
  - JSONPath: `$.value[?(@.jobTitle == 'Auditor')].displayName`
  - jq: `.value | map(select(.jobTitle == "Auditor")) | .[].displayName`
    (real jq 1.8.2 compiled to WebAssembly — every builtin, regex included)
  Switching languages auto-converts simple path queries (keys, wildcards,
  indexes, slices, simple filters, counts) between the languages; queries
  outside that subset are left untouched with the error line and refreshed
  suggestions to guide you.
- **Live indicator** — one compact row shows the response being queried as
  selectable text (timestamp · method · full URL · status) with an inline
  ● live badge while it follows the latest response (re-running your query
  automatically on every new Graph query) or a "pinned" badge when you've
  selected an older response from the dropdown next to it.
- **Advanced Graph queries by default** — when Graph Explorer opens, the
  extension adds `ConsistencyLevel: eventual` and
  `Content-Type: application/json` rows to the Request-headers view; and
  while the URI uses `$filter`, `$search`, or `$orderby`, it inserts
  `$count=true` right after the `?` as you type (your caret stays put) — the
  pieces [Microsoft Graph advanced queries](https://learn.microsoft.com/graph/aad-advanced-queries)
  require. Everything happens in the query view itself; requests are never
  modified behind the scenes. On by default; toggle it in the settings.
- **Query editor** — a CodeMirror 6 editor with per-language highlighting
  (strings, numbers, functions, `@`/`$` references, properties),
  **rainbow brackets** — `(`, `[` and `{` are colored by nesting depth, so
  the pairs in `value[?contains(a, 'b')].{c: d}` are easy to tell apart, and
  every closer matches its opener — plus matching-bracket emphasis,
  auto-closing brackets/quotes (accepted function completions close their
  own parenthesis with the caret inside), and undo/redo; Enter runs and
  saves the query, Shift+Enter inserts a line break, and the box is
  drag-resizable. Prefer something simpler? Turn off
  **Syntax-highlighting query editor** in the settings for a plain text
  box — switching swaps the editor in place, keeping your current query.
- **Query completion** — typing in the query box opens a completion
  dropdown: property names resolved from the selected response at the path
  before the cursor (`value[].` → `displayName`, `mail`, … with type hints)
  ranked first, followed by the language's functions and operators (all 26
  JMESPath functions, jq's builtins (all of jq 1.8.2's, regex included), JSONPath
  syntax snippets). ↑/↓ to choose, Enter/Tab to accept, Esc to dismiss.
  Suggestions never appear inside string literals.
- **Paste method + URL** — pasting a request with its HTTP method in front
  (`GET https://graph.microsoft.com/v1.0/me` — the shape of the panel's own
  response rows and of most docs samples) into Graph Explorer's URI field
  removes the method from the field and selects it in Graph Explorer's
  method dropdown for you, so the request goes out correctly.
- **Background-request filtering** — Graph Explorer's own calls (signed-in
  user, organization, permission grants) are kept out of the response list.
  Classification combines known-internal URL patterns, a match against the
  query in the URI field (the exact request, or at least the same resource
  path — so re-running a query with tweaked `$select`/`$filter`/`$expand`
  parameters always stays visible), and whether you actually ran a query —
  so a deliberate `GET /me` stays visible. A setting reveals the hidden
  entries (marked ⚙) when you need them.
- **Automatic sign-in** — opening Graph Explorer while signed out clicks the
  profile view for you to start the sign-in flow (on by default; your browser
  may ask you to allow the sign-in popup).
- **Fetch all pages, on demand or automatically** — every paged response
  (`@odata.nextLink`) gets fetch controls on the metrics row. By default
  nothing runs by itself: the row reads "more pages available", and
  **▶** fetches the remaining pages, **+1** fetches one page at a time,
  and **⏭** runs to the end — every remaining page, ignoring the
  configured page and size limits (⏸ still stops it at any moment) —
  building a combined dataset you can query whole. Turning the
  **Auto-fetch all pages** setting on (⟳ next to the response list, or
  the popup) starts the chain automatically instead — the controls and
  limits are the same either way. While pages stream in, the row shows
  live progress (pages · items · size) behind a leading **⏸ Pause**
  button — pausing is instant (the page in flight is aborted and simply
  retried on resume). When the first page carries an `@odata.count`
  (ask for it with `$count=true`; the Advanced-queries setting adds it
  for `$filter`/`$search`/`$orderby` requests), a progress bar and a
  whole-number percentage of items fetched so far sit next to the
  button, while running and while paused. There is no stop button: a chain you never resume
  just stays paused with everything fetched so far queryable, and
  running a new query (or turning ⟳ off mid-run) closes it out. The
  configured page-count and data-size limits (defaults: 50 pages /
  10 MB) are checkpoints, not hard stops: reaching one pauses the chain,
  and ▶ or +1 continue past it (each resume grants a fresh budget) while
  ⏭ ignores them altogether.
  While a chain is running, query editing and result refreshes are on
  hold (the editor grays out); the query re-runs exactly once against
  the settled data at each pause. Once a chain ends, the same spot reads
  "auto-fetched · N pages", with "(incomplete)" when it was closed out
  early or a page failed. The extension replays the original request's
  own headers for the follow-up pages; nothing is stored.
- **Response history** — the last 25 Graph responses are kept (in memory
  only); pick any of them from the dropdown to query it.
- **Query history** — queries you run (Enter, or clicking a suggestion) are
  saved with a timestamp and the Graph request they ran against. The history
  size is configurable in the settings (default 50, or unlimited). Clicking a
  saved query restores it — including its query language — and the **Load ↗**
  button re-populates Graph Explorer's request editor with the saved request:
  URL (query parameters included), method (selected through GE's own
  dropdown), the request's sanitized headers (re-added through the
  Request-headers view, skipping any header already shown there), and —
  for requests that had one — the body, copied
  to your clipboard to paste into the Request-body tab. Everything happens in
  place — no page reload, so your sign-in session is untouched.
- **Favorites, tags, and filtering** — star ★ a saved query to pin it
  (favorites sit on top and are never trimmed by the history limit), give a
  favorite its own display name with ✎, tag 🏷 queries with your own labels,
  and filter the expanded history by free text, time window (last hour →
  last 30 days), and tag chips (multiple tags combine as AND). Hovering a
  row reveals 📋 copy-to-clipboard and ✕ delete; **Clear** asks for a
  confirming second click, and **Export**/**Import** move the whole query
  library between browsers as a JSON file (imports merge, keeping stars,
  names, and tags).
- **Graph query equivalent (⇗)** — a button next to the query box shows
  the Microsoft Graph (OData) equivalent of the current query: filters,
  field picks, sorting, slicing, and counts become `$filter`, `$select`,
  `$orderby`, `$top`/`$skip`, and `$count=true` merged into the captured
  request's URL, ready to **Copy** or **Load ↗** into Graph Explorer.
  Translation is best-effort per part: whatever cannot run server-side
  (reshaping, regex, complex predicates) is shown as a highlighted
  *client-side* residual query — click it to run exactly that part here
  against the server-filtered response for the same result. Works in all
  three languages; the button is disabled when nothing can be translated
  (the tooltip says why).
- **Smart suggestions** — one-click query chips generated from the shape of
  the current response in the selected language, with a link to the
  language's documentation in the same section.
- **JSON, table, or tree view** — a three-way switch in the footer changes
  how the result renders, and the top-right of the result always shows its
  length and size. **CSV** renders the result as a real table: click a
  column header to sort (numbers sort numerically, missing values last),
  and **Copy**/**Download** export the table *with the applied sorting*. In
  CSV mode a small **CSV / TSV** dropdown next to Copy picks the delimiter
  for both Copy and Download — TSV pastes straight into Excel as a grid.
  Downloads include a UTF-8 BOM so Excel reads accents correctly, and cell
  values that begin with `=`, `+`, `-`, or `@` are prefixed with an
  apostrophe so a crafted Graph field (e.g. a display name) can't run as a
  spreadsheet formula. **Tree** shows a collapsible tree of the current
  result — click any property to use its path as the query (with a query
  already in the box, the click composes: `.value` + a click on
  `displayName` → `.value | .[].displayName`).
- **Compare responses (⇄)** — toggle diff mode to see what changed between
  the current response and any earlier captured one (added / removed /
  changed, with paths). Your query is applied to both sides first, so you
  can diff exactly the slice you care about; the baseline defaults to the
  previous run of the same URL.
- **Pin a result (📌)** — turn the current query result into a new queryable
  source in the response list, so you can refine it further or diff
  against it later.
- **Paste JSON** — paste any JSON document to query it, even without running a
  Graph request.
- **Quick access** — double-click the toolbar icon to jump straight to Graph
  Explorer (single click opens the settings popup, where Enter also opens
  Graph Explorer), press <kbd>Alt</kbd>+<kbd>G</kbd> from anywhere to open
  it, or <kbd>Alt</kbd>+<kbd>Q</kbd> on a Graph Explorer tab to open the
  panel and focus the query box.
- **Follows Graph Explorer's theme** — the panel switches light/dark with
  Graph Explorer's own theme setting, falling back to the OS preference.
- **All Graph clouds** — captures responses from `graph.microsoft.com`,
  US Government and China endpoints, and Graph Explorer's sample-tenant proxy
  used when you're not signed in.
- **Resilient** — if Microsoft ever changes Graph Explorer's page structure,
  the panel automatically falls back to a floating side drawer toggled from the
  bottom-right corner.

## Installation (load unpacked)

The extension is plain JavaScript — no build step.

**Option A — download a release (recommended):**

1. Open the repository's **Releases** page and download the
   `graph-explorer-json-query-v….zip` asset of the latest release.
2. Unzip it somewhere permanent.
3. **Chrome:** open `chrome://extensions` · **Edge:** open `edge://extensions`.
4. Enable **Developer mode** (Chrome: toggle top-right; Edge: toggle in the left sidebar).
5. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).

**Option B — download a build artifact:** same steps, but grab the
`graph-explorer-json-query-v…` artifact from the latest green **Build**
run on `main` in the **Actions** tab (this also works for unreleased
in-between builds).

**Option C — from a clone:** same steps, but select the repository folder
itself as the unpacked extension.

Then open [Graph Explorer](https://developer.microsoft.com/en-us/graph/graph-explorer)
and run any query. Requires Chrome/Edge 111 or newer.

## Usage

1. Run a query in Graph Explorer, e.g. `GET /v1.0/users`.
2. The response area splits and the **JSON Query** panel appears on the right
   (if you hid it, click the **{;} JSON Query** button in the bottom-right corner).
3. Pick a language (JMESPath, JSONPath, or jq) and type a query in the top
   box — the result renders below as you type. An empty query shows the
   whole response. Press Enter to save the query into the history.
4. Pick **JSON**, **CSV** (sortable table), or **Tree** in the footer, then
   **Copy** or **Download** — or explore: click tree properties to build the
   query, ⇄ to diff against an earlier response, 📌 to pin the result as a
   new source.

### Settings

Click the toolbar icon to open the settings popup:

| Setting | Default | Effect |
| --- | --- | --- |
| Query language | JMESPath | JMESPath, JSONPath, or jq (also switchable in the panel) |
| Advanced queries | on | Visibly adds `$count=true` (URI field) + `ConsistencyLevel: eventual` (Request headers view) for `$filter`/`$search`/`$orderby` queries |
| Auto sign-in | on | Starts the sign-in flow when you open Graph Explorer signed out |
| Auto-fetch all pages | off | Paged responses always get ▶/+1 fetch controls; this makes the chain start automatically instead (also toggleable from the panel's ⟳ button) |
| Auto-fetch limits | 50 pages / 10 MB | Pauses the chain at these checkpoints — ▶/+1 continue past them, ⏭ ignores them and runs to the end |
| Show background requests | off | Reveal Graph Explorer's own requests in the response list (marked ⚙) |
| Syntax-highlighting query editor | on | CodeMirror editor (highlighting, bracket matching, undo); turn off for a plain text box |
| Evaluate while typing | on | Re-runs the query on every edit; turn off to evaluate only on <kbd>Enter</kbd> (the metrics row shows "↵ Enter to evaluate" while edits are pending — recommended for very large datasets) |
| Query history limit | 50 | How many distinct queries to keep (checkbox for unlimited) |

### Choosing a query language

All three are switchable any time (the selector next to the query box or the
settings), and switching auto-converts simple path queries. Pick by task:

| | JMESPath *(default)* | JSONPath | jq |
| --- | --- | --- | --- |
| **Strengths** | Reshape/project into new objects (`{name: displayName}`), ~26 functions, sort/count; same language as Azure CLI `--query` | Recursive search (`..`) anywhere in the tree; **regex** in filters; simple selection syntax | Most expressive: pipelines, `map`/`select`/`reduce`/`group_by`, arithmetic, string interpolation, **regex** (`test`/`match`/`capture`/`gsub`), dates, build any output shape — it is jq 1.8.2 itself |
| **Limitations** | No regex; string tests limited to `contains`/`starts_with`/`ends_with` | **Selection only** — can't reshape or compute new values; result is always the flat array of matches; no `=~` operator | Datasets above **40 MB of JSON** per query are refused (the WebAssembly engine's heap is 256 MB); no `input`/`env`/file builtins (nothing to read) |
| **Best for** | Everyday pluck / filter / reshape / count | Finding & filtering nodes, deep search, regex matching | Complex reshaping, aggregation, regex |
| **Regex?** | ❌ | ✅ `$.value[?(@.mail.match(/@contoso\.com$/))]` | ✅ `.value[] \| select(.mail \| test("@contoso\\.com$"))` |
| **Example** | `value[?jobTitle == 'Auditor'].{name: displayName, email: mail}` | `$.value[?(@.jobTitle == 'Auditor')].displayName` | `.value \| map(select(.jobTitle == "Auditor")) \| .[].displayName` |

Rules of thumb: reach for **JMESPath** to pull fields into a tidy shape,
**JSONPath** when you need regex or to search deep in the tree, and **jq**
when you need real transformation, aggregation, or regex. Regex is
available in **JSONPath** — inside filter predicates (`[?(…)]`) via
`@.field.match(/…/)` or `/…/.test(@.field)`, running under the extension's
strict Content-Security-Policy because jsonpath-plus uses a safe,
`eval`-free evaluator — and in **jq** through its own builtins (`test`,
`match`, `capture`, `scan`, `sub`, `gsub`, `splits`; Oniguruma syntax, as
in jq proper). JMESPath has none.

### Query examples (JMESPath)

| Query | What it does |
| --- | --- |
| `value[].displayName` | Pluck one field from every item |
| `value[?startswith(displayName, 'A')]` | Filter items |
| `value[].{name: displayName, email: mail}` | Reshape into smaller objects |
| `sort_by(value, &displayName)[].displayName` | Sort by a field |
| `length(value)` | Count items |
| `value[?jobTitle == 'Auditor'].mail \| [0]` | Filter, project, take first |
| `"@odata.nextLink"` | Read a key containing special characters |

See the [JMESPath tutorial](https://jmespath.org/tutorial.html), the
[JSONPath syntax reference](https://github.com/JSONPath-Plus/JSONPath#syntax-through-examples),
and the [jq manual](https://jqlang.org/manual/v1.8/) (the bundled engine is
jq 1.8.2 itself, so the whole manual applies).

## How it works

- `src/interceptor.js` runs in the page's MAIN world at `document_start` and
  wraps `window.fetch`/`XMLHttpRequest`. JSON responses from Microsoft Graph
  endpoints are forwarded to the content script via `window.postMessage`.
  It observes requests only — it never modifies them; the sole extra traffic
  is the `@odata.nextLink` page fetching (started on demand with ▶/+1 by
  default; a setting starts it automatically), and
  it only ever targets Microsoft Graph hosts.
- `src/content.js` renders the panel inside a ShadowRoot and embeds it into
  Graph Explorer's results area (`#response-area`), splitting it 50/50. A
  `MutationObserver` re-attaches the panel whenever Graph Explorer's React app
  re-renders that area.
- `src/evaluator.html` + `src/evaluator.js` form a hidden extension-origin
  iframe that Chrome hosts in the extension's own process — every query
  evaluation, exact-size walk, table sort, export serialization, and diff
  runs on that process's thread whenever the frame is available, so a
  multi-second jq run over a 40 MB dataset never blocks typing, the
  page, or the auto-fetch controls. Large datasets never even touch the
  page thread: the interceptor streams auto-fetch pages into the
  evaluator one page at a time and ships large single responses as raw
  text (parsed there), while the panel holds only metadata plus a small
  structural sample that powers suggestions and property completion.
  Small results come back whole (everything behaves as before); large
  ones come back as a capped preview + exact size + table cells, with
  Copy/Download fetching the full text on demand. If the frame can't
  load, everything falls back to the previous in-panel evaluation.
- `vendor/jmespath.js` ([jmespath.js](https://github.com/jmespath/jmespath.js)
  0.16.0, MIT), `vendor/jsonpath-plus.js`
  ([jsonpath-plus](https://github.com/JSONPath-Plus/JSONPath) 10.3.0, MIT),
  and `vendor/jq-wasm.js` ([jq-wasm](https://github.com/owenthereal/jq-wasm)
  3.0.0-jq-1.8.2, MIT — real [jq](https://github.com/jqlang/jq) 1.8.2
  compiled to WebAssembly with Emscripten, the `.wasm` bytes embedded in
  the file) evaluate the queries. The jq instance is created asynchronously
  the first time it is needed (≈60 ms; the evaluator frame does it as soon
  as it loads), which is why the manifest's CSP carries
  `'wasm-unsafe-eval'`. Its heap is fixed at 256 MB by the upstream binary
  and jq keeps a document in memory at several times its JSON size, so the
  panel refuses jq over datasets above 40 MB of JSON with a message that
  says so, and an instance that aborts anyway is replaced automatically
  (`GEJQ.createJqEngine` in `src/query-utils.js`).
- [`docs/dependency-graph.md`](docs/dependency-graph.md) draws the whole
  picture: which file loads, messages, or depends on which (runtime,
  third-party, and build/release), and what GitHub's own dependency graph
  shows for this repository.
- `vendor/codemirror.js` is a bundled [CodeMirror 6](https://codemirror.net)
  (MIT) that powers the default syntax-highlighting query editor; the
  tokenizers for the three query languages are the extension's own
  (`nextQueryToken` in `src/query-utils.js`). Turning the setting off (or
  the bundle failing to load) falls back to a plain textarea. CodeMirror is
  mounted with its `root` option pointing at the panel's ShadowRoot so the
  editor's stylesheet and selection handling work inside the shadow DOM.

### Privacy

Everything runs locally in your browser. The extension makes no network
requests of its own — the only exception is the page-fetching feature
(started on demand with ▶/+1 by default; a setting can start it
automatically), which requests the *next pages of the same Graph query* by
replaying that request's own headers to Microsoft Graph hosts only; they
are never read, stored, or sent elsewhere.
Captured responses live only in memory — small ones in the page, large ones
in the extension's hidden evaluator frame — and are cleared on reload. What is
persisted via `chrome.storage.local`: your settings, your last query text,
panel state, and the query history (query text, language, timestamp, and the
method, URL, and sanitized headers of the Graph request it ran against —
never response data). Header sanitization always drops `Authorization` and
cookies, so access tokens are never read or stored, and it strips the
headers Graph Explorer adds on its own behalf — its telemetry
(`SdkVersion`, `client-request-id`), its `ms-graph-dev-mode` preference, and
its cache-busting `Cache-Control`/`Pragma: no-cache` — keeping only the parts
you typed yourself, so restoring a saved request never brings back noise you
did not add.

### Security & supply chain

The extension is built to be safe in security-conscious environments — see
[SECURITY.md](SECURITY.md) for the full security model, supply-chain
controls, and how to report a vulnerability, and [SBOM.md](SBOM.md) for the
component inventory. Highlights:

- **No runtime npm dependencies.** Every third-party library is a
  version-pinned, pre-built bundle in `vendor/`, and its SHA-256 is pinned
  in `vendor/CHECKSUMS.txt` and verified on every build
  (`npm run verify:vendor` — also a CI gate every other job depends on).
- **No dynamic code, no remote code, no telemetry.** No `eval`/`innerHTML`;
  a strict extension-pages CSP; the only permission is `storage`; host scope
  is limited to `developer.microsoft.com`.
- **Hardened CI/CD.** Actions pinned to commit SHAs (kept current by
  Dependabot), read-only default token, `--ignore-scripts` installs.
- **Verifiable releases.** Each release ships a `.sha256` checksum and a
  SLSA build-provenance attestation. Verify with `sha256sum -c …` and
  `gh attestation verify …` (commands in [SECURITY.md](SECURITY.md)).

## Development

```bash
npm test           # verify vendored checksums, then run unit tests (node:test)
npm run verify:vendor  # check vendor/*.js against vendor/CHECKSUMS.txt
npm run e2e        # offline end-to-end smoke test (needs Playwright + Chromium)
npm run icons      # regenerate icons/ from scripts/make-icons.js
npm run package    # zip the extension into dist/ for store submission
npm run vendor:hash    # regenerate vendor/CHECKSUMS.txt after a bundle update
```

The repository root is the extension — edit, then hit **Reload** on the
extensions page to pick up changes.

The e2e test loads the extension into headless Chromium and drives it
against a Graph Explorer stand-in served via Playwright route
interception, so it needs no network. Install Playwright first:
`npm i -D playwright && npx playwright install chromium`.

CI (`.github/workflows/build.yml`) runs both suites on every push and PR
to `main` and uploads a ready-to-load extension artifact. When a push to
`main` carries a new `manifest.json` version, the pipeline also publishes
a GitHub Release tagged `v<version>` with the zip attached; pushes
without a version bump publish nothing.

**Note on non-English locales:** in-place editor population and auto
sign-in locate Graph Explorer controls primarily by their English
aria-labels (with a structural fallback for the request input). On other
locales the Load ↗ button may only restore the URL, and auto sign-in may
not trigger.

### Repository layout

```
manifest.json          Manifest V3 (Chrome + Edge)
src/interceptor.js     MAIN-world fetch/XHR interceptor + request upgrades
src/content.js         Panel UI (isolated world, ShadowRoot)
src/content.css        Panel styles (light + dark theme)
src/evaluator.html     Off-thread evaluator page (hidden extension iframe)
src/evaluator.js       Evaluator logic: dataset cache + query/export/diff
src/query-utils.js     Pure helpers, shared with unit tests
src/background.js      Service worker (Alt+G / Alt+Q commands)
vendor/jmespath.js     Vendored JMESPath engine (MIT)
vendor/jsonpath-plus.js Vendored JSONPath engine (MIT)
vendor/jq-wasm.js      Vendored jq engine (jq 1.8.2 as WebAssembly via jq-wasm, MIT)
vendor/codemirror.js   Vendored CodeMirror 6 bundle (MIT)
vendor/CHECKSUMS.txt   Pinned SHA-256 of each vendored bundle
popup/                 Toolbar popup: instructions + settings
scripts/make-icons.js  Icon generator (no dependencies)
scripts/verify-vendor.js  Vendored-dependency integrity check (no deps)
test/                  Unit tests (`node --test`) + offline e2e smoke test
docs/dependency-graph.md  Module, dependency, and build graphs (Mermaid)
CONTRIBUTING.md        Dev setup, code style, security invariants, releases
CODE_OF_CONDUCT.md     Contributor Covenant 2.1 + no-tenant-data rule
SECURITY.md            Security model, supply-chain controls, reporting
SBOM.md                Software bill of materials
.github/               CI workflow, Dependabot, issue + PR templates
```

## Contributing

Bug reports, fixes, and well-scoped features are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup (no build step), the
checks to run, the code style, and the security invariants a change has to
keep. Participation is covered by the
[Code of Conduct](CODE_OF_CONDUCT.md); vulnerabilities go through the private
reporting flow in [SECURITY.md](SECURITY.md), never a public issue.

One rule matters more than the rest: **never paste real tenant data** — tokens,
cookies, user or tenant identifiers, mail addresses, or raw Graph responses —
into an issue, pull request, or screenshot. Graph Explorer's sample tenant
(available when signed out) makes shareable reproductions easy.

## License

MIT — see [LICENSE](LICENSE). The vendored `jmespath.js` (© James
Saryerwinnie) and `jsonpath-plus` are MIT licensed.
