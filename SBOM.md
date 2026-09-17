# Software Bill of Materials (SBOM)

Graph Explorer JSON Query — components shipped in the extension and used to
build/test it. The extension has **no runtime npm dependencies**: every
third-party library is committed to the repository as a pre-built, pinned
bundle under `vendor/`, and its integrity is verified on every build
(`npm run verify:vendor`, backed by `vendor/CHECKSUMS.txt`).

Regenerate the hash column after an intentional bundle update with
`npm run vendor:hash` and review the diff.
[`docs/dependency-graph.md`](docs/dependency-graph.md) draws how these
components and the extension's own files depend on each other.

## Shipped in the extension (runtime)

| Component | Version | Source (upstream) | License | File | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| jmespath.js | 0.16.0 | https://github.com/jmespath/jmespath.js | MIT | `vendor/jmespath.js` | `a88012bb68aa9e52a316d3be81598573d686cdad226a4c5d3177d720e187fe53` |
| jsonpath-plus | 10.3.0 | https://github.com/JSONPath-Plus/JSONPath | MIT | `vendor/jsonpath-plus.js` | `85667908eee7ca1835b9cdb10e10add3ce9e3cd21bb377c0e143d02656b8bc7c` |
| jq-wasm (jq 1.8.2 compiled to WebAssembly) | 3.0.0-jq-1.8.2 | https://github.com/owenthereal/jq-wasm (jq itself: https://github.com/jqlang/jq, tag jq-1.8.2) | MIT (jq: MIT) | `vendor/jq-wasm.js` | `3b19c02eca055e0c2abdae5a32cb052934bf3bf3715d3c3bb3d47838925e4732` |
| CodeMirror 6 bundle | see sub-components below | https://codemirror.net | MIT | `vendor/codemirror.js` | `d69baf52717e2feb1515413679de8aa4ba9f6432700c348e6321da89c7db7afa` |

`vendor/jq-wasm.js` is the jq-wasm package's `inline` build (the Emscripten
JavaScript glue with the `jq.wasm` bytes embedded as a base64 payload — jq
1.8.2 built from source by the package's own pipeline) wrapped by esbuild
into an IIFE exposing a `JQWASM` global; the rebuild command is in the file's
header comment. The WebAssembly module's heap is fixed by that binary at
256 MB (16 MB initial), which is where the extension's 40 MB jq input
ceiling comes from. It is the only WebAssembly in the extension and the sole
reason the manifest CSP includes `'wasm-unsafe-eval'`.

`vendor/codemirror.js` is a single esbuild IIFE bundle of these packages
(rebuild command is in the file's header comment):

| Package | Version | License |
| --- | --- | --- |
| @codemirror/state | 6.7.1 | MIT |
| @codemirror/view | 6.43.8 | MIT |
| @codemirror/language | 6.12.4 | MIT |
| @codemirror/commands | 6.10.4 | MIT |
| @codemirror/autocomplete | 6.20.3 | MIT |
| @lezer/highlight | 1.2.3 | MIT |

First-party code (`src/**`, `popup/**`, `scripts/**`, icons) is original to
this repository (MIT, see `LICENSE`). All query-language tokenizers used by
the editor are first-party (`nextQueryToken` in `src/query-utils.js`), not
part of the CodeMirror bundle.

## Build / test only (never shipped)

| Component | Version | Purpose | Notes |
| --- | --- | --- | --- |
| playwright | 1.56.1 (pinned) | Offline end-to-end smoke test | Exact pin in `package.json` → `devDependencies`; installed ad hoc in CI with `--ignore-scripts` at that version; not a dependency of the extension and not present in any release artifact |
| Node.js | 22 (CI) | Runs the unit tests (`node:test`) and build scripts | No other test framework |
| GitHub Actions | pinned to commit SHAs | CI/CD (`.github/workflows/build.yml`) | Kept current by Dependabot; visible in GitHub's dependency graph |

There is intentionally **no `package-lock.json`**: the shipped extension has
zero npm dependencies, and the only build/test tool (Playwright) is pinned by
exact version in `package.json`, which the workflow reads when installing it —
one source of truth, so a Dependabot bump moves the whole toolchain. Because
there is no lockfile, GitHub's dependency graph lists direct dependencies only,
which here is the complete set.

## Verifying this SBOM against a checkout or a release

```bash
npm run verify:vendor        # recompute vendored hashes vs vendor/CHECKSUMS.txt
sha256sum vendor/*.js        # compare against the SHA-256 column above
```

For a downloaded release, additionally verify the release zip's checksum and
its build-provenance attestation — see [SECURITY.md](SECURITY.md).
