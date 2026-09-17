# Dependency graph

How the pieces of this extension depend on each other — the *internal* graph
(which file loads, imports, or messages which) and the *external* graph (the
third-party components, all vendored). The component inventory with versions,
licenses, and hashes lives in [SBOM.md](../SBOM.md); this document is the
picture that goes with it.

Nothing here is generated: keep it in step with `manifest.json`,
`src/evaluator.html`, `popup/popup.html`, and `.github/workflows/build.yml`
when those change.

## Runtime: what loads what

The extension has no bundler and no module system. Every dependency edge is a
declaration in `manifest.json`, a `<script src>` in an extension page, or a
`postMessage`/`chrome.*` channel between two contexts. Solid arrows are load
edges (A pulls in B); dashed arrows are message channels.

```mermaid
graph TD
  manifest["manifest.json<br/>(Manifest V3)"]

  subgraph tab["Graph Explorer tab (developer.microsoft.com)"]
    subgraph main["MAIN world — document_start"]
      qu_main["src/query-utils.js"]
      interceptor["src/interceptor.js<br/>fetch/XHR observer + nextLink paging"]
    end
    subgraph isolated["Isolated world — document_idle"]
      jmes["vendor/jmespath.js"]
      jsonpath["vendor/jsonpath-plus.js"]
      jqwasm["vendor/jq-wasm.js<br/>(jq 1.8.2 · WebAssembly)"]
      codemirror["vendor/codemirror.js"]
      qu_content["src/query-utils.js"]
      content["src/content.js<br/>panel UI in a ShadowRoot"]
      contentcss["src/content.css"]
    end
  end

  subgraph extproc["Extension process"]
    sw["src/background.js<br/>service worker (Alt+G / Alt+Q)"]
    popup["popup/popup.html"]
    popupjs["popup/popup.js"]
    popupcss["popup/popup.css"]
    qu_popup["src/query-utils.js"]
    evalhtml["src/evaluator.html<br/>hidden iframe"]
    evaljs["src/evaluator.js<br/>dataset cache + query/export/diff"]
    jmes2["vendor/jmespath.js"]
    jsonpath2["vendor/jsonpath-plus.js"]
    jqwasm2["vendor/jq-wasm.js<br/>(jq 1.8.2 · WebAssembly)"]
    qu_eval["src/query-utils.js"]
  end

  storage[("chrome.storage.local<br/>settings · last query · panel state · query history")]
  graphhosts[("Microsoft Graph hosts<br/>(nextLink pages only)")]

  manifest --> qu_main
  manifest --> interceptor
  manifest --> jmes
  manifest --> jsonpath
  manifest --> jqwasm
  manifest --> codemirror
  manifest --> qu_content
  manifest --> content
  manifest --> sw
  manifest --> popup
  manifest -->|web_accessible_resources| evalhtml
  manifest -->|web_accessible_resources| contentcss

  content --> contentcss
  content -->|embeds| evalhtml
  evalhtml --> jmes2
  evalhtml --> jsonpath2
  evalhtml --> jqwasm2
  evalhtml --> qu_eval
  evalhtml --> evaljs
  popup --> popupcss
  popup --> qu_popup
  popup --> popupjs

  interceptor -.->|"window.postMessage<br/>captured responses"| content
  interceptor -.->|"dataset-text / chain pages"| evaljs
  interceptor -.->|"replayed request headers"| graphhosts
  content -.->|"evaluate / export / diff"| evaljs
  evaljs -.->|"result · sample · exact size"| content
  sw -.->|"gejq-focus-query"| content
  content -.-> storage
  popupjs -.-> storage
  sw -.->|"chrome.tabs.create"| tab
```

Reading the graph:

- **`src/query-utils.js` is the shared leaf.** It is loaded four times over
  (MAIN world, isolated world, evaluator frame, popup) as an independent copy
  in each context — it is UMD, side-effect free, and depends on nothing, which
  is exactly why it can be. It is also the only source file `test/` requires
  directly.
- **Nothing depends on `src/content.js`.** The panel is the top of the runtime
  graph; the query engines, the editor bundle, and the evaluator frame are all
  below it.
- **The vendored query engines are loaded twice** — once in the isolated world
  (small-dataset fast path) and once in the evaluator frame (everything large).
  `vendor/codemirror.js` is loaded only in the isolated world; the evaluator
  has no UI.
- **`src/interceptor.js` never depends on the panel.** It observes `fetch`/XHR
  and posts outward, so a panel that failed to attach cannot break capture.
- **The only outbound edge to the network** is interceptor → Graph hosts for
  `@odata.nextLink` pages. There is no edge from any node to a CDN, an
  analytics endpoint, or a remote script — see [SECURITY.md](../SECURITY.md).

## Third-party components

Every third-party library is committed as a pre-built, version-pinned bundle
under `vendor/` and integrity-checked on each build, so the runtime graph
below is closed — nothing is resolved at install time.

```mermaid
graph LR
  subgraph shipped["Shipped in the extension (vendor/, pinned by SHA-256)"]
    jmes["jmespath.js 0.16.0<br/>MIT"]
    jsonpath["jsonpath-plus 10.3.0<br/>MIT"]
    jqwasm["jq-wasm 3.0.0-jq-1.8.2<br/>(jq 1.8.2 as WebAssembly)<br/>MIT"]
    cm["CodeMirror 6 bundle<br/>MIT (esbuild IIFE)"]
    cm_state["@codemirror/state 6.7.1"]
    cm_view["@codemirror/view 6.43.8"]
    cm_lang["@codemirror/language 6.12.4"]
    cm_cmds["@codemirror/commands 6.10.4"]
    cm_ac["@codemirror/autocomplete 6.20.3"]
    lezer["@lezer/highlight 1.2.3"]
    cm --> cm_state
    cm --> cm_view
    cm --> cm_lang
    cm --> cm_cmds
    cm --> cm_ac
    cm --> lezer
  end

  subgraph firstparty["First-party code"]
    src["src/** · popup/** · scripts/** · icons/**"]
  end

  subgraph buildtest["Build / test only — never shipped"]
    node["Node.js 22 (CI)<br/>node:test, build scripts"]
    pw["playwright 1.56.1<br/>+ Chromium (e2e)"]
    actions["GitHub Actions,<br/>pinned to commit SHAs"]
  end

  src --> jmes
  src --> jsonpath
  src --> jqwasm
  src --> cm
  node --> src
  pw --> src
  actions --> node
  actions --> pw
```

The query-language tokenizers the editor uses are first-party
(`nextQueryToken` in `src/query-utils.js`), not part of the CodeMirror bundle —
so the editor has no language-package dependencies beyond the six above.

## Build, test, and release

```mermaid
graph LR
  checksums["vendor/CHECKSUMS.txt"]
  verify["scripts/verify-vendor.js"]
  vendorfiles["vendor/*.js"]
  unit["test/query-utils.test.js<br/>node:test"]
  qu["src/query-utils.js"]
  e2e["test/e2e/smoke.js"]
  pw["playwright (pinned)"]
  ext["the unpacked extension"]
  pkg["package.json scripts"]

  pkg --> verify
  verify --> checksums
  verify --> vendorfiles
  pkg -->|pretest| verify
  pkg --> unit
  unit --> qu
  unit --> vendorfiles
  pkg --> e2e
  e2e --> pw
  e2e --> ext

  subgraph ci["CI jobs (.github/workflows/build.yml)"]
    integrity["integrity<br/>verify:vendor"] --> test["test<br/>unit tests"]
    test --> e2ejob["e2e<br/>smoke test"]
    integrity --> package["package<br/>zip artifact"]
    test --> package
    e2ejob --> release["release<br/>tag · zip · sha256 · SLSA provenance<br/>(main + version bump only)"]
    package --> release
  end
```

`integrity` is the gate every other job depends on: a modified, missing, or
unlisted vendored bundle fails the build before anything is tested or shipped.

## The dependency graph on GitHub

GitHub's own view of this repository lives under **Insights → Dependency
graph**, and it is fed by two manifests:

| Manifest | What GitHub sees | Kept current by |
| --- | --- | --- |
| `.github/workflows/build.yml` | every GitHub Action used, at its pinned commit SHA | Dependabot (`github-actions` ecosystem, weekly) |
| `package.json` | `playwright` — the single pinned dev/test tool | Dependabot (`npm` ecosystem, weekly) |

Two consequences worth knowing when reading that tab:

- **There are no runtime npm dependencies to show, by design.** The shipped
  extension installs nothing; the libraries it runs are the vendored bundles
  above, which are plain committed files and therefore invisible to GitHub's
  resolver. `SBOM.md` and `vendor/CHECKSUMS.txt` are the authority for those,
  and `npm run verify:vendor` is the check that enforces them.
- **There is intentionally no `package-lock.json`.** With no lockfile GitHub
  lists direct dependencies only — which here is the complete set.

Dependabot alerts and security updates apply to what is in that graph
(Actions, Playwright). Vulnerabilities in the vendored engines are handled by
updating the bundle: see the vendored-dependency instructions in
[CONTRIBUTING.md](../CONTRIBUTING.md).
