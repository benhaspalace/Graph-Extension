/**
 * End-to-end smoke test: loads the extension into Chromium (headless)
 * and drives it against a Graph Explorer stand-in page served entirely
 * through Playwright route interception — no network access needed.
 *
 * Requirements: Playwright with its Chromium build available
 * (`npm i -D playwright && npx playwright install chromium`, or a
 * global install reachable via NODE_PATH).
 *
 * Run with: npm run e2e
 */
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXT = path.resolve(__dirname, '..', '..');
const SHOT_DIR = path.join(__dirname, 'artifacts');

// Minimal stand-in for the Graph Explorer page: same URL, same
// #response-area anchor the embed logic targets.
const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Graph Explorer fixture</title><style>
  body { margin:0; font-family:sans-serif; }
  #app { display:flex; flex-direction:column; height:100vh; }
  #request { height:120px; background:#eee; padding:12px; }
  #response-area { flex:1; overflow:auto; padding:8px; }
  #ge-response { background:#fafafa; border:1px solid #ccc; height:100%; overflow:auto; }
</style></head>
<body>
<div id="app">
  <div id="request">Graph Explorer fixture —
    <button aria-label="HTTP request method option" id="ge-method">GET</button>
    <span id="ge-method-list" hidden>
      <button role="option">GET</button><button role="option">POST</button><button role="option">PATCH</button>
    </span>
    <input aria-label="Query sample input" id="ge-editor-input" size="60" />
    <button aria-label="Run query" id="ge-run">▶ Run query</button>
    <button aria-label="Sign in" id="fake-profile-view">(avatar)</button>
    <span>
      <button role="tab" aria-selected="true" id="fake-body-tab">Request body</button>
      <button role="tab" aria-selected="false" id="request-headers">Request headers</button>
    </span>
    <div role="tabpanel" id="ge-headers-panel" hidden>
      <input name="name" placeholder="Key" /> <input name="value" placeholder="Value" />
      <button id="ge-add-header">Add</button>
    </div>
    <!-- Like real Graph Explorer, added header rows render OUTSIDE the
         input's tabpanel, so the extension can't confirm a row by scanning
         that panel — it must not re-add on every edit. -->
    <ul id="ge-header-list"></ul>
  </div>
  <div id="response-area"><div id="ge-response"><pre id="ge-json">(run a query)</pre></div></div>
</div>
<script>
  window.__signInClicks = 0;
  document.getElementById('fake-profile-view').addEventListener('click', function () {
    window.__signInClicks++;
  });
  // Mimic Graph Explorer running a query: the URI field always holds the
  // query being run (that's how the extension tells user queries apart
  // from Graph Explorer's own background calls).
  window.runGraphQuery = function (path) {
    var url = 'https://graph.microsoft.com' + (path || '/v1.0/users?$top=3');
    document.getElementById('ge-editor-input').value = url;
    return fetch(url, {
      headers: {
        Accept: 'application/json',
        SdkVersion: 'GraphExplorer/4.0',
        prefer: 'ms-graph-dev-mode',
        Authorization: 'Bearer secret-token',
        // Graph Explorer sends cache-busting directives on every request;
        // they must never be captured or restored into the headers view.
        Pragma: 'no-cache',
        'cache-control': 'no-cache',
        'x-demo': 'yes'
      }
    }).then(r => r.json()).then(j => {
      document.getElementById('ge-json').textContent = JSON.stringify(j, null, 2);
      return j;
    });
  };
  // Method "dropdown": clicking the control shows role=option buttons.
  var methodBtn = document.getElementById('ge-method');
  var methodList = document.getElementById('ge-method-list');
  methodBtn.addEventListener('click', function () {
    methodList.hidden = !methodList.hidden;
  });
  methodList.querySelectorAll('[role="option"]').forEach(function (opt) {
    opt.addEventListener('click', function () {
      methodBtn.textContent = opt.textContent;
      methodList.hidden = true;
    });
  });
  document.getElementById('ge-run').addEventListener('click', function () {
    var url = document.getElementById('ge-editor-input').value;
    window.runGraphQuery(url.replace('https://graph.microsoft.com', ''));
  });
  // Minimal stand-in for GE's Request-headers tab.
  function selectTab(which) {
    document.getElementById('fake-body-tab').setAttribute('aria-selected', String(which === 'body'));
    document.getElementById('request-headers').setAttribute('aria-selected', String(which === 'headers'));
    document.getElementById('ge-headers-panel').hidden = which !== 'headers';
  }
  document.getElementById('fake-body-tab').addEventListener('click', function () { selectTab('body'); });
  document.getElementById('request-headers').addEventListener('click', function () { selectTab('headers'); });
  // Like real GE, the Add button stays disabled until both inputs have
  // values (React-processed) — the extension must wait for that.
  var headerName = document.querySelector('input[name="name"]');
  var headerValue = document.querySelector('input[name="value"]');
  var addHeaderBtn = document.getElementById('ge-add-header');
  function syncAddButton() {
    addHeaderBtn.disabled = !(headerName.value && headerValue.value);
  }
  syncAddButton();
  headerName.addEventListener('input', function () { setTimeout(syncAddButton, 30); });
  headerValue.addEventListener('input', function () { setTimeout(syncAddButton, 30); });
  addHeaderBtn.addEventListener('click', function () {
    if (!headerName.value) return;
    var li = document.createElement('li');
    li.textContent = headerName.value + ': ' + headerValue.value;
    document.getElementById('ge-header-list').appendChild(li);
    headerName.value = '';
    headerValue.value = '';
    syncAddButton();
  });
</script>
</body></html>`;

const SAMPLE_RESPONSE = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users',
  value: [
    { id: '1', displayName: 'Adele Vance', mail: 'adele@contoso.com', jobTitle: 'Retail Manager' },
    { id: '2', displayName: 'Alex Wilber', mail: 'alex@contoso.com', jobTitle: 'Marketing Assistant' },
    { id: '3', displayName: 'Megan Bowen', mail: 'megan@contoso.com', jobTitle: 'Auditor' }
  ]
};

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
}

(async () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gejq-e2e-profile-'));
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  // Tabs opened by the extension itself (chrome.tabs.create) need a
  // context-level route so their navigation can commit offline.
  await ctx.route('https://developer.microsoft.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>GE</title>Graph Explorer stub' })
  );

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

  const PAGE_TWO = {
    '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?paged=3',
    value: [
      { id: '4', displayName: 'Nestor Wilke', mail: 'nestor@contoso.com', jobTitle: 'Director' },
      { id: '5', displayName: 'Lidia Holloway', mail: 'lidia@contoso.com', jobTitle: 'Engineer' },
      { id: '6', displayName: 'Lynne Robbins', mail: 'lynne@contoso.com', jobTitle: 'Planner' }
    ]
  };
  const PAGE_THREE = {
    value: [
      { id: '7', displayName: 'Joni Sherman', mail: 'joni@contoso.com', jobTitle: 'Paralegal' },
      { id: '8', displayName: 'Isaiah Langer', mail: 'isaiah@contoso.com', jobTitle: 'Sales Rep' },
      { id: '9', displayName: 'Patti Fernandez', mail: 'patti@contoso.com', jobTitle: 'President' }
    ]
  };

  const graphRequests = [];
  let extOrigin = null;
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('https://developer.microsoft.com/en-us/graph/graph-explorer')) {
      return route.fulfill({ contentType: 'text/html', body: FIXTURE_HTML });
    }
    if (url.startsWith('https://graph.microsoft.com/')) {
      graphRequests.push({ url, headers: route.request().headers() });
      let body = SAMPLE_RESPONSE;
      const manyMatch = /[?&]many=(\d+)/.exec(url);
      if (manyMatch) {
        // A 6-page chain: long enough that "run to the end" has to blow
        // past a 2-page limit several times over.
        const n = Number(manyMatch[1]);
        body = { value: [{ id: 'm' + n, displayName: 'Many ' + n }] };
        if (n < 6) {
          body['@odata.nextLink'] = 'https://graph.microsoft.com/v1.0/users?many=' + (n + 1);
        }
        return route.fulfill({
          contentType: 'application/json;odata.metadata=minimal',
          body: JSON.stringify(body)
        });
      }
      if (url.includes('bigsingle=1')) {
        // Large single response (~1.5 MB) — exercises the interceptor's
        // direct-to-evaluator text path.
        const bigItems = [];
        for (let i = 0; i < 20000; i++) {
          bigItems.push({ id: 'u' + i, displayName: 'Big User ' + i, mail: 'biguser' + i + '@contoso.com' });
        }
        body = { value: bigItems };
      } else if (url.includes('pagedslow=1')) {
        // Carries an @odata.count (as a `$count=true` request would), so
        // this chain drives the progress bar: 3 of 9 items after page 1.
        body = Object.assign({}, SAMPLE_RESPONSE, {
          '@odata.count': 9,
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?pagedslow=2'
        });
      } else if (url.includes('pagedslow=2')) {
        // Slow page: gives the pause test a window while the fetch is in
        // flight (pause must abort it, not wait for it).
        await new Promise((resolve) => setTimeout(resolve, 1500));
        body = Object.assign({}, PAGE_TWO, {
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?pagedslow=3'
        });
      } else if (url.includes('pagedslow=3')) {
        body = PAGE_THREE;
      } else if (url.includes('paged=1')) {
        body = Object.assign({}, SAMPLE_RESPONSE, {
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?paged=2'
        });
      } else if (url.includes('paged=2')) {
        body = PAGE_TWO;
      } else if (url.includes('paged=3')) {
        body = PAGE_THREE;
      }
      try {
        return await route.fulfill({
          contentType: 'application/json;odata.metadata=minimal',
          body: JSON.stringify(body)
        });
      } catch (e) {
        return; // request aborted client-side (the pause test does this)
      }
    }
    if (url.startsWith('chrome-extension://')) {
      return route.fallback(); // extension resources load normally
    }
    return route.abort();
  });

  // Unpacked extension IDs derive from the SHA-256 of the install path;
  // the background service worker URL confirms it once registered.
  {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(EXT, 'utf8').digest('hex').slice(0, 32);
    const computedId = hash
      .split('')
      .map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)))
      .join('');
    extOrigin = 'chrome-extension://' + computedId;
    for (let i = 0; i < 20 && ctx.serviceWorkers().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const [sw] = ctx.serviceWorkers();
    if (sw) {
      extOrigin = 'chrome-extension://' + new URL(sw.url()).host;
    }
  }

  await page.goto('https://developer.microsoft.com/en-us/graph/graph-explorer', {
    waitUntil: 'domcontentloaded'
  });

  // 1. Panel embeds into #response-area, splitting it.
  await page.waitForFunction(() => {
    const host = document.getElementById('gejq-host');
    return host && host.parentElement && host.parentElement.id === 'response-area';
  }, { timeout: 10000 });
  check('panel embedded inside #response-area', true);

  const split = await page.evaluate(() => {
    const area = document.getElementById('response-area');
    const host = document.getElementById('gejq-host');
    const ge = document.getElementById('ge-response');
    return {
      display: getComputedStyle(area).display,
      hostWidth: host.getBoundingClientRect().width,
      geWidth: ge.getBoundingClientRect().width,
      areaWidth: area.getBoundingClientRect().width
    };
  });
  check('results area is a flex row', split.display === 'flex');
  check(
    'split is roughly half/half',
    Math.abs(split.hostWidth - split.geWidth) < split.areaWidth * 0.1,
    `ge=${Math.round(split.geWidth)} ext=${Math.round(split.hostWidth)}`
  );

  const panel = page.locator('.gejq-panel');
  check('panel visible by default', await panel.isVisible());

  // The standing headers are added right when Graph Explorer opens,
  // independent of any query parameters.
  await page.waitForTimeout(1500);
  const startupHeaders = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#ge-header-list li')).map((li) => li.textContent)
  );
  check(
    'headers added on open (ConsistencyLevel + Content-Type)',
    startupHeaders.includes('ConsistencyLevel: eventual') && startupHeaders.includes('Content-Type: application/json'),
    startupHeaders.join(' | ')
  );
  check(
    'previous tab restored after startup header add',
    await page.evaluate(() => document.getElementById('fake-body-tab').getAttribute('aria-selected') === 'true')
  );

  // Query input must sit above the results box (vertical split).
  const layout = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const input = shadow.querySelector('.gejq-query-input').getBoundingClientRect();
    const result = shadow.querySelector('.gejq-result').getBoundingClientRect();
    return { inputBottom: input.bottom, resultTop: result.top };
  });
  check('query input sits above results', layout.inputBottom <= layout.resultTop + 1);

  // 2. Run a "Graph query" in the fixture; interceptor must capture it.
  await page.evaluate(() => window.runGraphQuery());
  await page.waitForFunction(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const select = shadow.querySelector('.gejq-history-select');
    return select && !select.disabled && select.options.length === 1;
  }, { timeout: 10000 });
  check('graph response captured into history', true);

  // 3. Type a JMESPath query, verify the live result. The default editor
  // is CodeMirror (contenteditable); a plain-textarea fallback is behind a
  // setting and exercised in its own block below. queryValue reads the
  // CodeMirror container's data-query mirror, or a textarea's value.
  const query = page.locator('.gejq-query-input .cm-content');
  const queryValue = () =>
    page.evaluate(() => {
      const el = document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-query-input');
      return typeof el.value === 'string' ? el.value : el.dataset.query || '';
    });
  check(
    'CodeMirror editor mounted by default',
    await page.evaluate(() => !!document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-query-editor .cm-editor'))
  );

  // Regression: CodeMirror must be told it lives in the ShadowRoot (the
  // `root` option). Without it, CM injects its stylesheet into
  // document.head — invisible to the shadow DOM — so the caret jumps to
  // position 0 on every edit and the end of the line is unreachable. Type
  // character-by-character (fill() would hide the bug); closeBrackets
  // over-types the closing ], so the literal string round-trips exactly
  // unless the caret is jumping.
  await query.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type('value[0].displayName');
  await page.waitForTimeout(300);
  check('CM: incremental typing keeps character order (no caret jump)', (await queryValue()) === 'value[0].displayName', await queryValue());
  await page.keyboard.type(' too');
  await page.waitForTimeout(200);
  check('CM: can keep typing at the end of the query', (await queryValue()) === 'value[0].displayName too', await queryValue());
  const cmStyled = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const announce = shadow.querySelector('.gejq-query-editor .cm-announced');
    return {
      announce: announce ? getComputedStyle(announce).position : 'missing',
      highlightSpans: shadow.querySelectorAll('.gejq-query-editor .cm-line span[class]').length
    };
  });
  // CM's baseTheme sets .cm-announced to position:fixed (off-screen); any
  // non-static value proves the stylesheet reached the shadow root.
  check('CM: stylesheet applied inside the shadow root', cmStyled.announce !== 'static' && cmStyled.announce !== 'missing', JSON.stringify(cmStyled));
  check('CM: highlights tokens', cmStyled.highlightSpans > 0, JSON.stringify(cmStyled));
  // Brackets are their own colored token (color-coding), and the matched
  // pair is emphasized with weight/color rather than a background box that
  // would sit over the caret. Type value[0] so the caret lands right after
  // the ] — that is when CodeMirror renders .cm-matchingBracket.
  await query.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type('value[0]');
  await page.waitForTimeout(200);
  const bracketStyle = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const spans = Array.from(shadow.querySelectorAll('.gejq-query-editor .cm-line span[class]'));
    const bracketSpan = spans.find((s) => /^[()[\]{}]+$/.test(s.textContent));
    const match = shadow.querySelector('.gejq-query-editor .cm-matchingBracket');
    return {
      bracketColored: !!bracketSpan,
      matchFound: !!match,
      matchBg: match ? getComputedStyle(match).backgroundColor : '',
      matchWeight: match ? getComputedStyle(match).fontWeight : ''
    };
  });
  check('CM: brackets get their own colored token', bracketStyle.bracketColored, JSON.stringify(bracketStyle));
  check(
    'CM: matched bracket uses weight, not a caret-covering box',
    bracketStyle.matchFound &&
      (bracketStyle.matchBg === 'rgba(0, 0, 0, 0)' || bracketStyle.matchBg === 'transparent') &&
      Number(bracketStyle.matchWeight) >= 700,
    JSON.stringify(bracketStyle)
  );
  // Rainbow brackets: nesting depth (not bracket kind) drives the color,
  // and a closer matches its own opener. `value[?contains(a, 'b')].{c: d}`
  // nests [ → ( at depths 1/2, while the trailing { is depth 1 again.
  await query.fill("value[?contains(displayName, 'A')].{n: displayName}");
  await page.waitForTimeout(300);
  const rainbow = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const colors = {};
    Array.from(shadow.querySelectorAll('.gejq-query-editor .cm-line span[class]')).forEach((span) => {
      if (/^[()[\]{}]$/.test(span.textContent)) {
        (colors[span.textContent] = colors[span.textContent] || []).push(getComputedStyle(span).color);
      }
    });
    return colors;
  });
  check(
    'CM: nested brackets get different colors by depth',
    !!rainbow['['] && !!rainbow['('] && rainbow['['][0] !== rainbow['('][0],
    JSON.stringify(rainbow)
  );
  check(
    'CM: a closing bracket matches its opener’s color',
    !!rainbow[']'] && rainbow[']'][0] === rainbow['['][0] && !!rainbow[')'] && rainbow[')'][0] === rainbow['('][0],
    JSON.stringify(rainbow)
  );
  check(
    'CM: depth resets — the trailing { shares the outer depth color',
    !!rainbow['{'] && rainbow['{'][0] === rainbow['['][0],
    JSON.stringify(rainbow)
  );

  await query.fill('value[].{name: displayName, email: mail}');
  await page.waitForTimeout(400);
  const resultText = await page.locator('.gejq-result').innerText();
  check('reshape query returns expected data', resultText.includes('adele@contoso.com') && resultText.includes('"name"'));
  check('editor value reflects the text', (await queryValue()) === 'value[].{name: displayName, email: mail}');

  await query.fill("value[?jobTitle == 'Auditor'].displayName");
  await page.waitForTimeout(400);
  check('filter query works', (await page.locator('.gejq-result').innerText()).includes('Megan Bowen'));

  await query.fill('value[].displayName)))');
  await page.waitForTimeout(400);
  check('syntax error surfaced', (await page.locator('.gejq-panel .gejq-error').first().innerText()).length > 0);

  await query.fill('value[].displayName');
  await page.waitForTimeout(400);
  const exportState = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const read = (sel) => {
      const node = shadow.querySelector(sel);
      return { disabled: node.disabled, active: node.classList.contains('gejq-seg-active') };
    };
    return {
      json: read('.gejq-seg-btn:first-child'),
      csv: read('.gejq-seg-btn:nth-child(2)'),
      copy: shadow.querySelectorAll('.gejq-footer .gejq-action')[0].disabled,
      download: shadow.querySelectorAll('.gejq-footer .gejq-action')[1].disabled
    };
  });
  check('JSON format active by default', exportState.json.active && !exportState.json.disabled);
  check('CSV toggle enabled for CSV-able result', !exportState.csv.disabled);
  check('Copy/Download enabled', !exportState.copy && !exportState.download);

  // Switch to CSV; a scalar result should then disable exports.
  await page.locator('.gejq-seg-btn', { hasText: 'CSV' }).click();
  const csvActive = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return shadow.querySelector('.gejq-seg-btn:nth-child(2)').classList.contains('gejq-seg-active');
  });
  check('CSV format selectable', csvActive);

  await query.fill('length(value)');
  await page.waitForTimeout(400);
  const scalarCsv = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      csvDisabled: shadow.querySelector('.gejq-seg-btn:nth-child(2)').disabled,
      copyDisabled: shadow.querySelectorAll('.gejq-footer .gejq-action')[0].disabled
    };
  });
  check('CSV disabled for non-CSV-able result', scalarCsv.csvDisabled && scalarCsv.copyDisabled);
  await page.locator('.gejq-seg-btn', { hasText: 'JSON' }).click();
  await page.waitForTimeout(200);
  check(
    'switching back to JSON re-enables exports',
    await page.evaluate(() => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      return !shadow.querySelectorAll('.gejq-footer .gejq-action')[0].disabled;
    })
  );
  await query.fill('value[].displayName');
  await page.waitForTimeout(400);

  const meta = await page.locator('.gejq-meta-right').innerText();
  check('meta line describes result', meta.includes('array'), meta);

  // Advanced-query setting (default on): leaving the URI field with a
  // $filter query visibly appends $count=true to the field itself (the
  // ConsistencyLevel header goes through GE's Request-headers view,
  // which this fixture doesn't have — the assist must not crash without
  // it). Nothing is rewritten at the network layer.
  await page.evaluate(() => {
    const editor = document.getElementById('ge-editor-input');
    editor.value = "https://graph.microsoft.com/v1.0/users?$filter=startswith(displayName,'a')";
    editor.focus();
  });
  await page.locator('#ge-json').click(); // blur the URI field
  await page.waitForTimeout(400);
  const editorAfterAssist = await page.evaluate(() => document.getElementById('ge-editor-input').value);
  check(
    'advanced query visibly gains $count=true right after the ?',
    editorAfterAssist === "https://graph.microsoft.com/v1.0/users?$count=true&$filter=startswith(displayName,'a')",
    editorAfterAssist
  );
  // The header rows are added through GE's Request-headers view.
  await page.waitForTimeout(800);
  const headerRows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#ge-header-list li')).map((li) => li.textContent)
  );
  check('ConsistencyLevel added via the headers view', headerRows.includes('ConsistencyLevel: eventual'), headerRows.join(' | '));
  check('Content-Type added via the headers view', headerRows.includes('Content-Type: application/json'), headerRows.join(' | '));
  check(
    'previous tab restored after adding headers',
    await page.evaluate(() => document.getElementById('fake-body-tab').getAttribute('aria-selected') === 'true')
  );
  await page.locator('#ge-run').click(); // run it — the field content is what goes out
  await page.waitForTimeout(400);
  const advReq = graphRequests.find((r) => r.url.includes('%24filter') || r.url.includes('$filter'));
  check('the visible $count=true is what got sent', !!advReq && /[$%]24count=true|\$count=true/.test(advReq.url), advReq && advReq.url);
  check('no hidden header was injected', !!advReq && advReq.headers['consistencylevel'] === undefined);
  const plainReq = graphRequests.find((r) => r.url.includes('$top=3'));
  check('plain query left untouched', !!plainReq && !plainReq.url.includes('count') && plainReq.headers['consistencylevel'] === undefined);
  // Regression: editing the query repeatedly (each blur re-runs the assist)
  // must not re-add the header — it is added once per session, even though
  // the fixture (like real GE) renders header rows outside the input panel.
  const edits = [
    "https://graph.microsoft.com/v1.0/users?$filter=startswith(displayName,'ab')",
    "https://graph.microsoft.com/v1.0/users?$filter=startswith(displayName,'ab')&$select=id,displayName",
    'https://graph.microsoft.com/v1.0/users?$select=id,displayName&$orderby=displayName'
  ];
  for (const q of edits) {
    await page.evaluate((v) => {
      const e = document.getElementById('ge-editor-input');
      e.value = v;
      e.focus();
    }, q);
    await page.locator('#ge-json').click(); // blur → runs the assist again
    await page.waitForTimeout(300);
  }
  const consistencyCount = await page.evaluate(
    () => Array.from(document.querySelectorAll('#ge-header-list li')).filter((li) => li.textContent.indexOf('ConsistencyLevel') === 0).length
  );
  check('ConsistencyLevel added only once across query edits', consistencyCount === 1, 'count=' + consistencyCount);
  // A plain query must not be touched when leaving the field either.
  await page.evaluate(() => {
    const editor = document.getElementById('ge-editor-input');
    editor.value = 'https://graph.microsoft.com/v1.0/users?$top=3';
    editor.focus();
  });
  await page.locator('#ge-json').click();
  await page.waitForTimeout(300);
  check(
    'plain query URI field not touched by the assist',
    (await page.evaluate(() => document.getElementById('ge-editor-input').value)) === 'https://graph.microsoft.com/v1.0/users?$top=3'
  );
  // Typing alone (no blur, no run) already triggers the assist.
  await page.locator('#ge-editor-input').fill('https://graph.microsoft.com/v1.0/users?$orderby=displayName');
  await page.waitForTimeout(900);
  check(
    'assist fires while typing, without leaving the field',
    (await page.evaluate(() => document.getElementById('ge-editor-input').value)) ===
      'https://graph.microsoft.com/v1.0/users?$count=true&$orderby=displayName',
    await page.evaluate(() => document.getElementById('ge-editor-input').value)
  );

  // Pasting a method in front of the URI ("PATCH https://…") strips the
  // method from the field and selects it through GE's method dropdown.
  await page.locator('#ge-editor-input').fill('PATCH https://graph.microsoft.com/v1.0/users/x');
  await page.waitForTimeout(400);
  check(
    'pasted method prefix is stripped from the URI field',
    (await page.evaluate(() => document.getElementById('ge-editor-input').value)) ===
      'https://graph.microsoft.com/v1.0/users/x',
    await page.evaluate(() => document.getElementById('ge-editor-input').value)
  );
  check(
    'pasted method selected in the method dropdown',
    (await page.evaluate(() => document.getElementById('ge-method').textContent.trim())) === 'PATCH'
  );
  await page.locator('#ge-editor-input').fill('GET https://graph.microsoft.com/v1.0/users?$top=3');
  await page.waitForTimeout(400);
  check(
    'pasting a GET request switches the method back',
    (await page.evaluate(() => document.getElementById('ge-method').textContent.trim())) === 'GET' &&
      (await page.evaluate(() => document.getElementById('ge-editor-input').value)) ===
        'https://graph.microsoft.com/v1.0/users?$top=3'
  );

  // Auto sign-in: the fixture's profile-view button must get clicked once.
  check('auto sign-in clicked the profile view', (await page.evaluate(() => window.__signInClicks)) === 1);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, 'embedded.png') });

  // 4. Collapse via ✕ — GE view reclaims full width, FAB appears.
  await page.locator('.gejq-close').click();
  await page.waitForTimeout(300);
  const collapsed = await page.evaluate(() => {
    const host = document.getElementById('gejq-host');
    const shadow = host.shadowRoot;
    return {
      panelVisible: shadow.querySelector('.gejq-panel').offsetParent !== null,
      fabVisible: !shadow.querySelector('.gejq-fab').classList.contains('gejq-hidden'),
      geWidth: document.getElementById('ge-response').getBoundingClientRect().width,
      areaWidth: document.getElementById('response-area').getBoundingClientRect().width
    };
  });
  check('collapse hides panel', !collapsed.panelVisible);
  check('collapse shows FAB', collapsed.fabVisible);
  check('GE view reclaims full width', collapsed.geWidth > collapsed.areaWidth * 0.9);

  // 5. FAB re-opens the panel.
  await page.locator('.gejq-fab').click();
  await page.waitForTimeout(300);
  check('FAB re-opens panel', await panel.isVisible());

  // 6. Paste JSON flow.
  await page.locator('.gejq-icon-button', { hasText: 'Paste JSON' }).click();
  await page.locator('.gejq-paste-input').fill('{"value":[{"displayName":"Pasted Person","mail":"p@x.com"}]}');
  await page.locator('.gejq-action.gejq-primary').click();
  await query.fill('value[0].mail');
  await page.waitForTimeout(400);
  check('paste JSON flow works', (await page.locator('.gejq-result').innerText()).includes('p@x.com'));

  // 7. Popup page: settings controls drive the panel live.
  check('extension origin discovered', typeof extOrigin === 'string' && extOrigin.startsWith('chrome-extension://'), extOrigin);
  const popup = await ctx.newPage();
  await popup.goto(extOrigin + '/popup/popup.html');
  check('popup shows settings controls', (await popup.locator('#setting-language').count()) === 1);
  await popup.selectOption('#setting-language', 'jsonpath');
  await popup.check('#setting-auto-fetch');
  await page.waitForTimeout(500);
  const panelLanguage = await page.evaluate(
    () => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-lang-select').value
  );
  check('panel language synced from popup', panelLanguage === 'jsonpath');

  // 8. JSONPath queries work after the switch.
  await query.fill('$.value[*].mail');
  await page.waitForTimeout(400);
  check('JSONPath query works', (await page.locator('.gejq-result').innerText()).includes('p@x.com'));

  // 8b. The editor mode is switchable. CodeMirror is the default (verified
  // in section 3); turning the setting off swaps in a plain textarea in
  // place, preserving the query, and turning it back on restores CM.
  await query.fill('$.value[*].mail');
  await page.waitForTimeout(200);
  await popup.uncheck('#setting-rich-editor');
  await page.waitForFunction(
    () => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-query-input').tagName === 'TEXTAREA',
    { timeout: 5000 }
  );
  check('disabling the setting swaps in the plain textarea', (await queryValue()) === '$.value[*].mail', await queryValue());
  const plainInput = page.locator('textarea.gejq-query-input');
  await plainInput.fill('$.value[*].displayName');
  await page.waitForTimeout(300);
  check('plain textarea drives the query', (await page.locator('.gejq-result').innerText()).includes('Pasted Person'));
  await popup.check('#setting-rich-editor');
  await page.waitForFunction(
    () => !!document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-query-editor .cm-editor'),
    { timeout: 5000 }
  );
  check(
    're-enabling the setting restores CodeMirror',
    await page.evaluate(() => {
      const el = document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-query-input');
      return el && el.classList.contains('gejq-query-editor') && !!el.querySelector('.cm-editor');
    })
  );
  check('editor swap preserves the query text', (await queryValue()) === '$.value[*].displayName', await queryValue());
  await query.fill('$.value[*].mail');
  await page.waitForTimeout(300);

  // 8c. Manual evaluation mode: with "Evaluate while typing" off, edits
  // do NOT run the query (no continuous processing over big data) — only
  // Enter does, and the metrics row says so while edits are pending.
  await popup.uncheck('#setting-auto-evaluate');
  await page.waitForTimeout(400);
  await query.fill('$.value[*].displayName');
  await page.waitForTimeout(500);
  const manualState = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      result: shadow.querySelector('.gejq-result').textContent,
      meta: shadow.querySelector('.gejq-meta-right').textContent
    };
  });
  check('typing does not evaluate in manual mode', manualState.result.includes('p@x.com') && !manualState.result.includes('Pasted Person'), manualState.result.slice(0, 60));
  check('metrics row hints Enter in manual mode', manualState.meta.includes('Enter to evaluate'), manualState.meta);
  await query.press('Enter');
  await page.waitForTimeout(400);
  check('Enter evaluates in manual mode', (await page.locator('.gejq-result').innerText()).includes('Pasted Person'));
  await popup.check('#setting-auto-evaluate');
  await page.waitForTimeout(400);
  await query.fill('$.value[*].mail');
  await page.waitForTimeout(300);
  check('auto-evaluate restored', (await page.locator('.gejq-result').innerText()).includes('p@x.com'));

  // 9. Enter records the query into the persistent history with timestamp + context.
  await query.press('Enter');
  await page.waitForTimeout(300);
  const historyRow = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const rows = shadow.querySelectorAll('.gejq-query-history .gejq-example');
    return rows.length ? rows[0].textContent : null;
  });
  check('query recorded in history with timestamp', !!historyRow && /\d\d:\d\d/.test(historyRow), historyRow);

  // 10. Auto-fetch nextLink aggregates all pages into one dataset.
  await page.evaluate(() => window.runGraphQuery('/v1.0/users?paged=1'));
  try {
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        const options = shadow.querySelectorAll('.gejq-history-select option');
        return Array.from(options).some((o) => o.textContent.includes('3 pages') && !o.textContent.includes('incomplete'));
      },
      { timeout: 10000 }
    );
    check('auto-fetch aggregated 3 pages into one entry', true);
  } catch (e) {
    check('auto-fetch aggregated 3 pages into one entry', false, e.message.split('\n')[0]);
  }
  await query.fill('$.value.length');
  await page.waitForTimeout(400);
  check('aggregated dataset holds all 9 items', (await page.locator('.gejq-result').innerText()).trim().includes('9'));
  check('no truncation warning under the limits', (await page.locator('.gejq-warning').innerText()).trim() === '');

  // 10b. "Load ↗" re-populates the (mock) Graph Explorer request editor.
  await query.press('Enter'); // record with context = the aggregated GET
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    shadow.querySelector('.gejq-query-history .gejq-load').click();
  });
  await page.waitForTimeout(200);
  const editorValue = await page.evaluate(() => document.getElementById('ge-editor-input').value);
  check(
    'Load button re-populates the request editor in place',
    editorValue === 'https://graph.microsoft.com/v1.0/users?paged=1',
    editorValue
  );
  check('no page reload happened (in-place path)', !page.url().includes('request='), page.url());
  // The saved request's sanitized headers are restored through the
  // Request-headers view; credentials are never captured.
  await page.waitForTimeout(1600);
  const restoredHeaders = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#ge-header-list li')).map((li) => li.textContent)
  );
  check('Load restores the saved custom header', restoredHeaders.includes('x-demo: yes'), restoredHeaders.join(' | '));
  check(
    'Authorization is never captured or restored',
    restoredHeaders.every((h) => !h.toLowerCase().includes('authorization') && !h.includes('secret-token'))
  );
  // Graph Explorer's own cache-busting directives must not come back.
  check(
    'cache-control / pragma are never restored',
    restoredHeaders.every((h) => !/^\s*(pragma|cache-control)\s*:/i.test(h)),
    restoredHeaders.join(' | ')
  );
  // …and nothing already present is added a second time.
  const duplicateRows = restoredHeaders.filter((h) => /^\s*(ConsistencyLevel|Content-Type)\s*:/i.test(h));
  check(
    'Load does not duplicate headers already in the view',
    duplicateRows.length === new Set(duplicateRows.map((h) => h.split(':')[0].toLowerCase())).size,
    restoredHeaders.join(' | ')
  );
  // A differing method is restored via GE's own method dropdown.
  await page.evaluate(() => {
    document.getElementById('ge-method').textContent = 'POST';
  });
  await page.evaluate(() => {
    document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-query-history .gejq-load').click();
  });
  await page.waitForTimeout(1200);
  check(
    'Load restores the saved method via the dropdown',
    (await page.evaluate(() => document.getElementById('ge-method').textContent.trim())) === 'GET'
  );

  // 10b1b. Queries saved by an OLDER version still carry the cache
  // directives in chrome.storage.local. Seed such an entry, reload the
  // page, and prove the migration cleans it: Load ↗ restores the real
  // header only, and the stored value itself no longer holds the noise.
  {
    const seeder = await ctx.newPage();
    await seeder.goto(extOrigin + '/popup/popup.html');
    await seeder.evaluate(() =>
      new Promise((resolve) => {
        chrome.storage.local.set(
          {
            'gejq.queryHistory': [
              {
                query: '.value | length',
                language: 'jq',
                lastUsed: Date.now(),
                uses: 1,
                starred: false,
                tags: [],
                label: '',
                context: {
                  method: 'GET',
                  url: 'https://graph.microsoft.com/v1.0/users?legacy=1',
                  headers: [
                    { name: 'cache-control', value: 'no-cache' },
                    { name: 'Pragma', value: 'no-cache' },
                    { name: 'x-legacy', value: 'keep' }
                  ],
                  body: ''
                }
              }
            ]
          },
          resolve
        );
      })
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const host = document.getElementById('gejq-host');
      return host && host.shadowRoot && host.shadowRoot.querySelector('.gejq-query-history .gejq-example');
    }, { timeout: 10000 });
    const storedAfterMigration = await seeder.evaluate(() =>
      new Promise((resolve) => {
        chrome.storage.local.get(['gejq.queryHistory'], (items) =>
          resolve(JSON.stringify(items['gejq.queryHistory']))
        );
      })
    );
    check(
      'legacy stored headers are migrated in place',
      !/cache-control|pragma/i.test(storedAfterMigration) && storedAfterMigration.includes('x-legacy'),
      storedAfterMigration.slice(0, 160)
    );
    await page.evaluate(() => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      shadow.querySelector('.gejq-query-history .gejq-load').click();
    });
    await page.waitForTimeout(1600);
    const legacyRestored = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#ge-header-list li')).map((li) => li.textContent)
    );
    check(
      'a legacy saved query restores its real header only',
      legacyRestored.includes('x-legacy: keep') &&
        legacyRestored.every((h) => !/^\s*(pragma|cache-control)\s*:/i.test(h)),
      legacyRestored.join(' | ')
    );
    await seeder.close();
    // Clear the seeded entry so the sections below start from a clean
    // history, exactly as they did before this block ran.
    await page.evaluate(() => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      const buttons = Array.from(shadow.querySelectorAll('.gejq-history-actions .gejq-icon-button'));
      const clear = buttons.find((b) => b.textContent.toLowerCase().includes('clear'));
      clear.click();
      clear.click(); // confirm
    });
    await page.waitForTimeout(300);
  }

  // 10b2. Pausing a RUNNING chain is instant (the in-flight page fetch is
  // aborted and retried on resume), the controls survive streaming
  // progress events, and there is no redundant stop link while running —
  // pause first, then decide (▶ / +1 / ■).
  await page.evaluate(() => window.runGraphQuery('/v1.0/users?pagedslow=1'));
  await page.waitForFunction(
    () => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      const box = shadow.querySelector('.gejq-fetch-status');
      return box && box.style.display !== 'none' && box.textContent.includes('Auto-fetching');
    },
    { timeout: 10000 }
  );
  const runningControls = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      buttons: Array.from(shadow.querySelectorAll('.gejq-fetch-status .gejq-fetch-btn')).map((b) => b.textContent),
      links: shadow.querySelectorAll('.gejq-fetch-status .gejq-link-button').length
    };
  });
  check(
    'running chain shows only the pause control (no stop link)',
    runningControls.buttons.join('') === '⏸' && runningControls.links === 0,
    JSON.stringify(runningControls)
  );
  // The first page announced @odata.count = 9 and holds 3 items, and the
  // second page is still in flight (1500 ms): the bar must read 33 %,
  // a whole number, with the fill at the same width.
  const runningPercent = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const bar = shadow.querySelector('.gejq-fetch-status .gejq-fetch-bar');
    const pct = shadow.querySelector('.gejq-fetch-status .gejq-fetch-pct');
    return {
      pct: pct ? pct.textContent : null,
      barShown: !!bar && bar.style.display !== 'none',
      fill: bar ? bar.firstChild.style.width : null,
      now: bar ? bar.getAttribute('aria-valuenow') : null
    };
  });
  check(
    'progress bar + whole-number percentage from @odata.count (3 of 9 items → 33%)',
    runningPercent.pct === '33%' && runningPercent.barShown && runningPercent.fill === '33%' && runningPercent.now === '33',
    JSON.stringify(runningPercent)
  );
  // While pages are in flight the query editor is grayed out and the
  // result view does not refresh — evaluating against the continuously
  // growing dataset is what froze the panel (regression). Pausing the
  // fetch re-enables both.
  const lockedState = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const input = shadow.querySelector('.gejq-query-input');
    const cmContent = input.querySelector('.cm-content');
    return {
      lockedClass: input.classList.contains('gejq-query-locked'),
      editable: cmContent ? cmContent.getAttribute('contenteditable') : String(!input.disabled),
      statusText: shadow.querySelector('.gejq-fetch-status').textContent
    };
  });
  check(
    'query editor grayed out while fetching',
    lockedState.lockedClass && lockedState.editable === 'false',
    JSON.stringify(lockedState)
  );
  check('status line says editing is paused', lockedState.statusText.includes('editing paused'), lockedState.statusText);
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    Array.from(shadow.querySelectorAll('.gejq-fetch-status .gejq-fetch-btn'))
      .find((b) => b.textContent === '⏸')
      .click();
  });
  try {
    // The in-flight page takes 1500ms — 'Paused' must appear well before
    // that, proving the pause aborted it instead of waiting for it.
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        return shadow.querySelector('.gejq-fetch-status').textContent.includes('Paused');
      },
      { timeout: 1200 }
    );
    check('pause takes effect immediately (in-flight page aborted)', true);
  } catch (e) {
    check('pause takes effect immediately (in-flight page aborted)', false, await page.evaluate(
      () => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-fetch-status').textContent
    ));
  }
  // Once paused, the editor unlocks and edits evaluate again.
  check(
    'editor unlocked once paused',
    await page.evaluate(() => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      const input = shadow.querySelector('.gejq-query-input');
      const cmContent = input.querySelector('.cm-content');
      return !input.classList.contains('gejq-query-locked') && (!cmContent || cmContent.getAttribute('contenteditable') === 'true');
    })
  );
  await query.fill('$.value[*].displayName');
  await page.waitForTimeout(400);
  check(
    'query edits evaluate once paused',
    (await page.locator('.gejq-result').innerText()).includes('Adele Vance')
  );
  // Resume re-fetches the aborted page and completes all three pages.
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    Array.from(shadow.querySelectorAll('.gejq-fetch-status .gejq-fetch-btn'))
      .find((b) => b.textContent === '▶')
      .click();
  });
  try {
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        const options = Array.from(shadow.querySelectorAll('.gejq-history-select option'));
        return options.some(
          (o) => o.textContent.includes('pagedslow=1') && o.textContent.includes('3 pages') && !o.textContent.includes('incomplete')
        );
      },
      { timeout: 10000 }
    );
    check('resume after pause re-fetches the aborted page and completes', true);
  } catch (e) {
    check('resume after pause re-fetches the aborted page and completes', false, e.message.split('\n')[0]);
  }

  // 10b3. A newer query superseding a RUNNING chain closes it out cleanly:
  // the in-flight page fetch is aborted (the superseded chain must not
  // keep fetching pages as a zombie), the progress/lock state clears, and
  // the panel follows the new query's own chain — regression for the panel
  // getting stuck on "editing paused" and never showing the new response.
  const supersedeStart = graphRequests.length;
  await page.evaluate(() => window.runGraphQuery('/v1.0/users?pagedslow=1'));
  await page.waitForFunction(
    () => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      const box = shadow.querySelector('.gejq-fetch-status');
      return box && box.style.display !== 'none' && box.textContent.includes('Auto-fetching');
    },
    { timeout: 10000 }
  );
  // The slow page (pagedslow=2, 1500 ms) is now in flight — run a new query.
  await page.evaluate(() => window.runGraphQuery('/v1.0/users?paged=1'));
  try {
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        const box = shadow.querySelector('.gejq-fetch-status');
        const text = (shadow.querySelector('.gejq-response-text') || {}).value || '';
        return (!box || box.style.display === 'none') && text.includes('paged=1') && text.includes('3 pages');
      },
      { timeout: 10000 }
    );
    check('superseding query completes its own chain and clears the fetch state', true);
  } catch (e) {
    check(
      'superseding query completes its own chain and clears the fetch state',
      false,
      await page.evaluate(() => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        const box = shadow.querySelector('.gejq-fetch-status');
        return (box ? box.textContent : '') + ' | ' + ((shadow.querySelector('.gejq-response-text') || {}).value || '');
      })
    );
  }
  check(
    'editor unlocked after the supersede',
    await page.evaluate(() => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      return !shadow.querySelector('.gejq-query-input').classList.contains('gejq-query-locked');
    })
  );
  await query.fill('$.value.length');
  await page.waitForTimeout(400);
  check(
    'panel queries the superseding chain’s aggregated dataset',
    (await page.locator('.gejq-result').innerText()).trim().includes('9')
  );
  await page.waitForTimeout(2000); // a zombie chain would keep fetching in this window
  const supersedeUrls = graphRequests.slice(supersedeStart).map((r) => r.url);
  check(
    'superseded chain stopped fetching (pagedslow=3 never requested)',
    !supersedeUrls.some((u) => u.includes('pagedslow=3')),
    supersedeUrls.join(' ').replace(/https:\/\/graph\.microsoft\.com\/v1\.0\/users/g, '…')
  );

  // 10c. Reaching the auto-fetch page limit PAUSES the chain (with resume/
  // step/stop controls on the metrics row) instead of ending it.
  await popup.fill('#setting-auto-fetch-pages', '2');
  await popup.dispatchEvent('#setting-auto-fetch-pages', 'change');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.runGraphQuery('/v1.0/users?paged=1'));
  const fetchStatusText = () =>
    page.evaluate(() => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      const box = shadow.querySelector('.gejq-fetch-status');
      return box && box.style.display !== 'none' ? box.textContent : '';
    });
  try {
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        const box = shadow.querySelector('.gejq-fetch-status');
        return box && box.style.display !== 'none' && box.textContent.includes('Paused');
      },
      { timeout: 10000 }
    );
    check('page limit pauses the chain with controls on the metrics row', true);
  } catch (e) {
    check('page limit pauses the chain with controls on the metrics row', false, e.message.split('\n')[0]);
  }
  const pausedStatus = await fetchStatusText();
  check('paused status names the page limit', /page limit/i.test(pausedStatus), pausedStatus.slice(0, 90));
  check(
    'no progress bar or percentage when the response has no @odata.count',
    await page.evaluate(() => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      const bar = shadow.querySelector('.gejq-fetch-status .gejq-fetch-bar');
      const pct = shadow.querySelector('.gejq-fetch-status .gejq-fetch-pct');
      return !!bar && bar.style.display === 'none' && !!pct && pct.style.display === 'none' && !/\d+%/.test(shadow.querySelector('.gejq-fetch-status').textContent);
    })
  );
  const pausedOptions = await page.evaluate(() =>
    Array.from(document.getElementById('gejq-host').shadowRoot.querySelectorAll('.gejq-history-select option')).map(
      (o) => o.textContent
    )
  );
  check('paused chain posts the partial dataset ("so far")', pausedOptions.some((t) => t.includes('2 pages so far')), pausedOptions[0]);
  check(
    'no incomplete-dataset warning while merely paused',
    (await page.locator('.gejq-warning').innerText()).trim() === ''
  );
  const fetchControl = (label) =>
    page.evaluate((wanted) => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      const btn = Array.from(shadow.querySelectorAll('.gejq-fetch-status .gejq-fetch-btn')).find(
        (b) => b.textContent === wanted
      );
      if (btn) btn.click();
      return !!btn;
    }, label);
  // Step (+1 page) continues PAST the configured limit and, with only one
  // page left, completes the dataset: 3 pages, not marked incomplete.
  check('step button present while paused', await fetchControl('+1'));
  try {
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        const options = Array.from(shadow.querySelectorAll('.gejq-history-select option'));
        const box = shadow.querySelector('.gejq-fetch-status');
        return (
          options.some((o) => o.textContent.includes('3 pages') && !o.textContent.includes('incomplete')) &&
          !options.some((o) => o.textContent.includes('so far')) &&
          (!box || box.style.display === 'none')
        );
      },
      { timeout: 10000 }
    );
    check('stepping past the limit completes the dataset', true);
  } catch (e) {
    check('stepping past the limit completes the dataset', false, e.message.split('\n')[0]);
  }
  await query.fill('$.value.length');
  await page.waitForTimeout(400);
  check('stepped dataset holds all 9 items', (await page.locator('.gejq-result').innerText()).trim().includes('9'));
  const metaLeftDone = await page.locator('.gejq-meta').first().innerText();
  check('left metrics slot says the result was auto-fetched', metaLeftDone.includes('auto-fetched · 3 pages'), metaLeftDone);

  // 10c1b. ⏭ runs to the end: with the page limit still at 2, a 6-page
  // chain must complete in one click — the limits are ignored, not
  // re-applied at every checkpoint.
  await page.evaluate(() => window.runGraphQuery('/v1.0/users?many=1'));
  await page.waitForFunction(
    () => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      const box = shadow.querySelector('.gejq-fetch-status');
      return box && box.style.display !== 'none' && box.textContent.includes('page limit reached');
    },
    { timeout: 10000 }
  );
  check('run-to-end control offered at a limit pause', await fetchControl('⏭'));
  try {
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        const options = Array.from(shadow.querySelectorAll('.gejq-history-select option'));
        const box = shadow.querySelector('.gejq-fetch-status');
        return (
          options.some((o) => o.textContent.includes('many=1') && o.textContent.includes('6 pages') && !o.textContent.includes('incomplete')) &&
          (!box || box.style.display === 'none')
        );
      },
      { timeout: 15000 }
    );
    check('⏭ fetches every remaining page past the configured limit', true);
  } catch (e) {
    check('⏭ fetches every remaining page past the configured limit', false, await fetchStatusText());
  }
  await query.fill('$.value.length');
  await page.waitForTimeout(400);
  check(
    'run-to-end dataset is complete and queryable',
    (await page.locator('.gejq-result').innerText()).trim().includes('6'),
    await page.locator('.gejq-result').innerText()
  );

  // 10c2. There is no stop button: a paused chain the user never resumes
  // simply stays paused, and turning auto-fetch off (⟳) — or running a new
  // query — closes it out. The kept dataset is labeled "(incomplete)" in
  // the metrics row (no separate warning line), never blaming a limit.
  await page.evaluate(() => window.runGraphQuery('/v1.0/users?paged=1'));
  await page.waitForFunction(
    () => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      const box = shadow.querySelector('.gejq-fetch-status');
      return box && box.style.display !== 'none' && box.textContent.includes('Paused');
    },
    { timeout: 10000 }
  );
  const pausedControls = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return Array.from(shadow.querySelectorAll('.gejq-fetch-status .gejq-fetch-btn')).map((b) => b.textContent);
  });
  check(
    'paused chain offers resume, step, and run-to-end',
    pausedControls.join('') === '▶+1⏭',
    pausedControls.join(' ')
  );
  await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-autofetch-toggle').click());
  try {
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        const options = shadow.querySelectorAll('.gejq-history-select option');
        return Array.from(options).some((o) => o.textContent.includes('2 pages, incomplete'));
      },
      { timeout: 10000 }
    );
    check('closing out a paused chain (⟳ off) marks the entry incomplete', true);
  } catch (e) {
    check('closing out a paused chain (⟳ off) marks the entry incomplete', false, e.message.split('\n')[0]);
  }
  await query.fill('$.value.length');
  await page.waitForTimeout(400);
  const metaLeftStopped = await page.locator('.gejq-meta').first().innerText();
  check(
    'metrics row labels the kept dataset incomplete',
    metaLeftStopped.includes('auto-fetched · 2 pages (incomplete)'),
    metaLeftStopped
  );
  check('no redundant warning line for incomplete datasets', (await page.locator('.gejq-warning').innerText()).trim() === '');
  check('incomplete label does not blame a configured limit', !/limit/i.test(metaLeftStopped), metaLeftStopped);
  // Auto-fetch back on for the rest of the run.
  await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-autofetch-toggle').click());
  await page.waitForTimeout(400);

  // 10d. Switching languages auto-converts simple queries.
  await query.fill('$.value[*].displayName');
  await page.waitForTimeout(300);
  await page.locator('.gejq-lang-select').selectOption('jmespath');
  await page.waitForTimeout(400);
  check('language switch converts the query', (await queryValue()) === 'value[].displayName', await queryValue());
  check('converted query runs without error', (await page.locator('.gejq-panel .gejq-error').first().innerText()).trim() === '');
  check('converted query returns data', (await page.locator('.gejq-result').innerText()).includes('Nestor Wilke'));

  // 10d2. The ⇗ button shows the Graph (OData) equivalent of the query:
  // server-side parameters merged into the captured request URL plus the
  // highlighted client-side residual.
  await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-grapheq-toggle').click());
  await page.waitForTimeout(300);
  const graphEq = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const box = shadow.querySelector('.gejq-grapheq');
    return {
      visible: box.style.display !== 'none',
      server: (shadow.querySelector('.gejq-grapheq-text') || {}).value || '',
      residual: (shadow.querySelector('.gejq-grapheq-residual') || {}).textContent || ''
    };
  });
  check('Graph equivalent panel opens', graphEq.visible);
  check(
    'server line carries $select merged into the request URL',
    graphEq.server.startsWith('GET https://graph.microsoft.com/v1.0/users') && graphEq.server.includes('$select=displayName'),
    graphEq.server
  );
  check('client-side residual shown highlighted', graphEq.residual === 'value[].displayName', graphEq.residual);
  // A filter translates too, and the residual drops the translated part.
  await query.fill("value[?jobTitle == 'Auditor'].mail");
  await page.waitForTimeout(400);
  const graphEqFilter = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      server: (shadow.querySelector('.gejq-grapheq-text') || {}).value || '',
      residual: (shadow.querySelector('.gejq-grapheq-residual') || {}).textContent || ''
    };
  });
  check(
    'filters become $filter on the server line',
    graphEqFilter.server.includes("$filter=jobTitle eq 'Auditor'") && graphEqFilter.server.includes('$select=mail'),
    graphEqFilter.server
  );
  check('residual keeps only the client-side part', graphEqFilter.residual === 'value[].mail', graphEqFilter.residual);
  await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-grapheq-toggle').click());
  await page.waitForTimeout(200);
  check(
    'Graph equivalent panel toggles off',
    await page.evaluate(
      () => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-grapheq').style.display === 'none'
    )
  );

  // 10d3. The panel's ⟳ chip toggles the auto-fetch setting in place.
  const autoFetchChip = () =>
    page.evaluate(() => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      const chip = shadow.querySelector('.gejq-autofetch-toggle');
      return { pressed: chip.getAttribute('aria-pressed'), title: chip.title };
    });
  check('auto-fetch chip reflects the enabled setting', (await autoFetchChip()).pressed === 'true');
  await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-autofetch-toggle').click());
  await page.waitForTimeout(400);
  check('clicking the chip turns auto-fetch off', (await autoFetchChip()).pressed === 'false');
  await popup.reload();
  await popup.waitForTimeout(300);
  check(
    'popup shows the setting the chip changed',
    !(await popup.isChecked('#setting-auto-fetch'))
  );
  await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-autofetch-toggle').click());
  await page.waitForTimeout(400);
  check('clicking the chip again turns auto-fetch back on', (await autoFetchChip()).pressed === 'true');

  // 10d4. With auto-fetch OFF (the default), paged responses still get the
  // fetch chain — it just starts paused with the ▶/+1 controls; the same
  // configured limits apply once it runs.
  await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-autofetch-toggle').click());
  await page.waitForTimeout(400);
  await page.evaluate(() => window.runGraphQuery('/v1.0/users?manual=1&paged=1'));
  try {
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        const box = shadow.querySelector('.gejq-fetch-status');
        return box && box.style.display !== 'none' && box.textContent.includes('more pages available');
      },
      { timeout: 10000 }
    );
    check('manual mode offers the fetch controls without running', true);
  } catch (e) {
    check('manual mode offers the fetch controls without running', false, e.message.split('\n')[0]);
  }
  check('manual chain has not fetched anything yet', (await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return !Array.from(shadow.querySelectorAll('.gejq-history-select option')).some(
      (o) => o.textContent.includes('manual=1') && o.textContent.includes('pages')
    );
  })));
  await fetchControl('+1');
  try {
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        return Array.from(shadow.querySelectorAll('.gejq-history-select option')).some(
          (o) => o.textContent.includes('manual=1') && o.textContent.includes('2 pages so far')
        );
      },
      { timeout: 10000 }
    );
    check('manual +1 fetches exactly one page', true);
  } catch (e) {
    check('manual +1 fetches exactly one page', false, e.message.split('\n')[0]);
  }
  await fetchControl('▶');
  try {
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        return Array.from(shadow.querySelectorAll('.gejq-history-select option')).some(
          (o) => o.textContent.includes('manual=1') && o.textContent.includes('3 pages') && !o.textContent.includes('incomplete')
        );
      },
      { timeout: 10000 }
    );
    check('manual ▶ fetches the remaining pages', true);
  } catch (e) {
    check('manual ▶ fetches the remaining pages', false, e.message.split('\n')[0]);
  }
  await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-autofetch-toggle').click());
  await page.waitForTimeout(400);
  // Restore the dataset shape the sections below were written against:
  // an auto chain on paged=1, paused at the 2-page limit, closed out via
  // ⟳ off (newest entry = "2 pages, incomplete", 6 items).
  await page.evaluate(() => window.runGraphQuery('/v1.0/users?paged=1'));
  await page.waitForFunction(
    () => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      const box = shadow.querySelector('.gejq-fetch-status');
      return box && box.style.display !== 'none' && box.textContent.includes('Paused');
    },
    { timeout: 10000 }
  );
  await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-autofetch-toggle').click());
  await page.waitForFunction(
    () => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      const first = shadow.querySelector('.gejq-history-select option');
      return !!first && first.textContent.includes('paged=1') && first.textContent.includes('2 pages, incomplete');
    },
    { timeout: 10000 }
  );
  await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-autofetch-toggle').click());
  await page.waitForTimeout(400);

  // 10e. Unconvertible queries keep their text, but suggestions follow
  // the new language even while the query errors: `$..displayName` has
  // no JMESPath equivalent and errors there as a syntax error.
  await page.locator('.gejq-lang-select').selectOption('jsonpath');
  await query.fill('$..displayName');
  await page.waitForTimeout(300);
  await page.locator('.gejq-lang-select').selectOption('jmespath');
  await page.waitForTimeout(400);
  check('unconvertible query left untouched', (await queryValue()) === '$..displayName');
  check('error shown for incompatible query', (await page.locator('.gejq-panel .gejq-error').first().innerText()).trim() !== '');
  const chipTexts = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return Array.from(shadow.querySelectorAll('.gejq-suggestions .gejq-chip')).map((c) => c.textContent);
  });
  check('suggestions refreshed to new language despite error', chipTexts.length > 0 && chipTexts.every((c) => !c.startsWith('$')), chipTexts.join(' | '));

  // 10f. jq engine.
  await page.locator('.gejq-lang-select').selectOption('jq');
  await query.fill('.value | length');
  await page.waitForTimeout(400);
  check('jq count query works', (await page.locator('.gejq-result').innerText()).trim().includes('6'));
  await query.fill('.value[].displayName');
  await page.waitForTimeout(400);
  check('jq iteration query works', (await page.locator('.gejq-result').innerText()).includes('Lidia Holloway'));
  // Regex builtins only exist because jq is the real thing (WebAssembly)
  // — and it runs inside the extension's CSP ('wasm-unsafe-eval').
  await query.fill('.value | map(select(.displayName | test("^L"))) | length');
  await page.waitForTimeout(600);
  check('jq regex builtin (test) works in the WebAssembly engine', (await page.locator('.gejq-result').innerText()).trim() === '2', (await page.locator('.gejq-result').innerText()).trim().slice(0, 80));
  await query.fill('.value[0].displayName | capture("(?<first>\\\\w+) (?<last>\\\\w+)") | .last');
  await page.waitForTimeout(600);
  check('jq capture builtin works', (await page.locator('.gejq-result').innerText()).includes('"Vance"'), (await page.locator('.gejq-result').innerText()).trim().slice(0, 80));
  await query.fill('.value | nope');
  await page.waitForTimeout(600);
  const jqError = (await page.locator('.gejq-panel .gejq-error').first().innerText()).trim();
  check('jq compile error is shown tidily (no jq: prefix, no tally line)', jqError.startsWith('jq: nope/0 is not defined') && !/compile error/.test(jqError), jqError.slice(0, 120));

  // 10f2. Tier-2 autocomplete: property names from the selected response.
  await query.fill('.value[].ma');
  await page.waitForTimeout(300);
  const propItems = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const list = shadow.querySelector('.gejq-autocomplete');
    return list.style.display === 'none'
      ? null
      : Array.from(list.querySelectorAll('.gejq-ac-label')).map((l) => l.textContent);
  });
  check('property completion offers response keys', !!propItems && propItems.includes('mail'), (propItems || []).join(' | '));
  await query.press('Enter');
  await page.waitForTimeout(200);
  check('accepting property completion builds the path', (await queryValue()) === '.value[].mail', await queryValue());

  // Tier-1 autocomplete: language builtins.
  await query.fill('.value | uniq');
  await page.waitForTimeout(300);
  const acItems = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const list = shadow.querySelector('.gejq-autocomplete');
    return list.style.display === 'none'
      ? null
      : Array.from(list.querySelectorAll('.gejq-ac-label')).map((l) => l.textContent);
  });
  check('autocomplete dropdown offers matching builtins', !!acItems && acItems.includes('unique') && acItems.includes('unique_by('), (acItems || []).join(' | '));
  await query.press('ArrowDown');
  await query.press('Enter');
  await page.waitForTimeout(200);
  check('ArrowDown+Enter accepts the highlighted completion', (await queryValue()) === '.value | unique', await queryValue());
  check(
    'dropdown closes after accepting',
    await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-autocomplete').style.display === 'none')
  );
  // Accepted function completions close their own parenthesis and leave
  // the caret inside.
  await query.fill('.value | unique_b');
  await page.waitForTimeout(300);
  await query.press('Enter');
  await page.waitForTimeout(200);
  check('accepted function completion closes its parenthesis', (await queryValue()) === '.value | unique_by()', await queryValue());
  await query.fill('.value | so');
  await page.waitForTimeout(300);
  await query.press('Escape');
  const escState = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      dropdownHidden: shadow.querySelector('.gejq-autocomplete').style.display === 'none',
      panelVisible: shadow.querySelector('.gejq-panel').offsetParent !== null
    };
  });
  check('Escape closes the dropdown but not the panel', escState.dropdownHidden && escState.panelVisible, JSON.stringify(escState));
  await query.fill('.value[].displayName');
  await page.waitForTimeout(400);

  // 10g. CSV toggle switches the output view itself.
  await page.locator('.gejq-seg-btn', { hasText: 'CSV' }).click();
  await page.waitForTimeout(300);
  const csvView = await page.locator('.gejq-result').innerText();
  check('CSV view renders CSV text', csvView.startsWith('value') && csvView.includes('Adele Vance'), csvView.slice(0, 40));
  check('meta marks table view', (await page.locator('.gejq-meta-right').innerText()).includes('table view'));
  await page.locator('.gejq-seg-btn', { hasText: 'JSON' }).click();
  await page.waitForTimeout(200);
  check('JSON view restored', (await page.locator('.gejq-result').innerText()).trim().startsWith('['));

  // 10h. Response row: full selectable text with timestamp, URL, status,
  // and the inline live indicator.
  const info = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      badge: shadow.querySelector('.gejq-live-badge').textContent,
      text: shadow.querySelector('.gejq-response-text').value
    };
  });
  check('response row shows live badge inline', info.badge.includes('live'), info.badge);
  check(
    'response row combines timestamp, full URL, and status',
    /^\d\d:\d\d:\d\d · GET https:\/\/graph\.microsoft\.com\/v1\.0\/users\?paged=1 → 200/.test(info.text),
    info.text
  );
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const select = shadow.querySelector('.gejq-history-select');
    select.value = select.options[1].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  check(
    'pinned badge when an older response is selected',
    await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-live-badge').textContent.includes('pinned'))
  );
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const select = shadow.querySelector('.gejq-history-select');
    select.value = select.options[0].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(200);

  // 10i. Star and tag grouping in the query history.
  await query.fill('.value[].displayName');
  await query.press('Enter');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    shadow.querySelector('.gejq-query-history .gejq-star').click();
  });
  await page.waitForTimeout(200);
  await query.fill('.value | length');
  await query.press('Enter');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const rows = shadow.querySelectorAll('.gejq-query-history .gejq-example');
    for (const row of rows) {
      const star = row.querySelector('.gejq-star');
      if (star && !star.classList.contains('gejq-starred')) {
        Array.from(row.querySelectorAll('.gejq-icon-mini')).find((b) => b.textContent === '🏷').click();
        return;
      }
    }
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const input = shadow.querySelector('.gejq-tag-input');
    input.value = 'counts';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await page.waitForTimeout(300);
  const historyState = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      headings: Array.from(shadow.querySelectorAll('.gejq-query-history .gejq-help-heading')).map((h) => h.textContent),
      rowMetas: Array.from(shadow.querySelectorAll('.gejq-query-history .gejq-example-label')).map((s) => s.textContent)
    };
  });
  check('favorites group pinned first', historyState.headings[0] === '★ Favorites', historyState.headings.join(' | '));
  check('no per-tag groups (tags shown inline)', !historyState.headings.includes('counts') && historyState.rowMetas.some((m) => m.includes('#counts')), historyState.headings.join(' | '));

  // 10i2. History filtering: free text, tag chips.
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    shadow.querySelectorAll('details').forEach((d) => {
      if (d.querySelector('.gejq-hist-filter-text')) {
        d.open = true; // expand the history section so the filter bar is interactable
      }
    });
  });
  const rowsBefore = await page.evaluate(
    () => document.getElementById('gejq-host').shadowRoot.querySelectorAll('.gejq-query-history .gejq-example').length
  );
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const chip = Array.from(shadow.querySelectorAll('.gejq-hist-tags .gejq-chip')).find((c) => c.textContent === '#counts');
    chip.click();
  });
  await page.waitForTimeout(200);
  const tagFiltered = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      rows: shadow.querySelectorAll('.gejq-query-history .gejq-example').length,
      summary: shadow.querySelectorAll('.gejq-panel details summary')[0] ? Array.from(shadow.querySelectorAll('.gejq-panel details summary')).map((s) => s.textContent).find((t) => t.startsWith('Query history')) : ''
    };
  });
  check('tag chip filters the history', tagFiltered.rows === 1 && tagFiltered.rows < rowsBefore, `rows ${rowsBefore} → ${tagFiltered.rows}, ${tagFiltered.summary}`);
  check('summary shows filtered/total count', /\(\d+\/\d+\)/.test(tagFiltered.summary), tagFiltered.summary);
  // Regression: removing the tag from the LAST row that carries it while
  // filtering by that tag used to strand the panel — every row filtered
  // away, and the chip that could switch the filter off was gone with the
  // tag. The filter must drop tags the history no longer has.
  const clearFilterButtonVisible = await page.evaluate(() => {
    const clear = document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-hist-filter-clear');
    return !!clear && clear.style.display !== 'none';
  });
  check('a clear-filters control is offered while filtering', clearFilterButtonVisible);
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const row = shadow.querySelector('.gejq-query-history .gejq-example');
    Array.from(row.querySelectorAll('.gejq-icon-mini')).find((b) => b.textContent === '🏷').click();
  });
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const input = shadow.querySelector('.gejq-query-history .gejq-tag-input');
    input.value = ''; // remove the only #counts tag
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await page.waitForTimeout(300);
  const afterTagRemoval = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      rows: shadow.querySelectorAll('.gejq-query-history .gejq-example').length,
      body: shadow.querySelector('.gejq-query-history').textContent,
      chips: Array.from(shadow.querySelectorAll('.gejq-hist-tags .gejq-chip')).map((c) => c.textContent),
      summary: Array.from(shadow.querySelectorAll('.gejq-panel details summary')).map((s) => s.textContent).find((t) => t.startsWith('Query history'))
    };
  });
  check(
    'removing the last instance of a filtered tag does not strand the list',
    afterTagRemoval.rows === rowsBefore && !afterTagRemoval.body.includes('No saved queries match'),
    JSON.stringify({ rows: afterTagRemoval.rows, expected: rowsBefore, summary: afterTagRemoval.summary })
  );
  check(
    'the vanished tag is dropped from the filter and its chips',
    !afterTagRemoval.chips.includes('#counts') && !/\(\d+\/\d+\)/.test(afterTagRemoval.summary || ''),
    JSON.stringify(afterTagRemoval.chips) + ' ' + afterTagRemoval.summary
  );
  const filterInput = page.locator('.gejq-hist-filter-text');
  await filterInput.fill('displayName');
  await page.waitForTimeout(200);
  const textFiltered = await page.evaluate(
    () => document.getElementById('gejq-host').shadowRoot.querySelectorAll('.gejq-query-history .gejq-example').length
  );
  check('free-text filter narrows the history', textFiltered >= 1 && textFiltered < rowsBefore, `rows ${rowsBefore} → ${textFiltered}`);
  await filterInput.fill('');
  await page.waitForTimeout(200);

  // 10i3. Suggestions section is collapsible.
  const suggestionsCollapsible = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const details = shadow.querySelector('.gejq-suggestions-details');
    return {
      isDetails: details && details.tagName === 'DETAILS' && details.open,
      summaryText: details ? details.querySelector('summary').textContent : ''
    };
  });
  check(
    'suggestions live in an open collapsible section',
    suggestionsCollapsible.isDetails && suggestionsCollapsible.summaryText === 'Suggested for this response',
    JSON.stringify(suggestionsCollapsible)
  );

  // 10j. The split between response view and panel is draggable.
  const hostWidthBefore = await page.evaluate(() => document.getElementById('gejq-host').getBoundingClientRect().width);
  const resizerBox = await page.locator('.gejq-resizer').boundingBox();
  check('resizer present in embedded mode', !!resizerBox);
  if (resizerBox) {
    await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(resizerBox.x - 150, resizerBox.y + 100, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const hostWidthAfter = await page.evaluate(() => document.getElementById('gejq-host').getBoundingClientRect().width);
    check('dragging the divider widens the panel', hostWidthAfter > hostWidthBefore + 100, `${Math.round(hostWidthBefore)} → ${Math.round(hostWidthAfter)}`);
  }

  // 10j2. ⧉ breaks the panel out into a full-height side panel and back.
  await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-float-toggle').click());
  await page.waitForTimeout(400);
  const floatState = await page.evaluate(() => {
    const host = document.getElementById('gejq-host');
    const panel = host.shadowRoot.querySelector('.gejq-panel');
    const rect = panel.getBoundingClientRect();
    return {
      parent: host.parentElement.tagName,
      inResponseArea: host.parentElement.id === 'response-area',
      floatMax: panel.classList.contains('gejq-float-max'),
      open: panel.classList.contains('gejq-open'),
      fullHeight: Math.abs(rect.height - window.innerHeight) < 4
    };
  });
  check(
    'panel breaks out into a full-height side panel',
    !floatState.inResponseArea && floatState.floatMax && floatState.open && floatState.fullHeight,
    JSON.stringify(floatState)
  );
  await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-float-toggle').click());
  await page.waitForTimeout(400);
  check(
    'panel re-embeds into the results area',
    await page.evaluate(() => {
      const host = document.getElementById('gejq-host');
      return host.parentElement.id === 'response-area' && !host.shadowRoot.querySelector('.gejq-panel').classList.contains('gejq-float-max');
    })
  );

  // 10k. Query input starts as tall as the language selector.
  const inputHeights = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      input: shadow.querySelector('.gejq-query-input').getBoundingClientRect().height,
      select: shadow.querySelector('.gejq-lang-select').getBoundingClientRect().height
    };
  });
  check('query input matches language selector height', Math.abs(inputHeights.input - inputHeights.select) <= 2, JSON.stringify(inputHeights));

  // 10m. Table view: CSV mode renders a sortable table.
  await query.fill('.value');
  await page.waitForTimeout(400);
  await page.locator('.gejq-seg-btn', { hasText: 'CSV' }).click();
  await page.waitForTimeout(300);
  const tableState = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const table = shadow.querySelector('.gejq-table');
    return {
      exists: !!table,
      headers: table ? Array.from(table.querySelectorAll('.gejq-th-button')).map((b) => b.textContent.trim()) : [],
      rows: table ? table.querySelectorAll('tbody tr').length : 0,
      metaRight: shadow.querySelector('.gejq-meta-right').textContent
    };
  });
  check('CSV mode renders a table', tableState.exists && tableState.rows === 6, JSON.stringify(tableState.headers));
  check('size/count readout shown top-right', tableState.metaRight.includes('6 items') && tableState.metaRight.includes('table view'), tableState.metaRight);
  const clickHeader = (dirLabel) =>
    page.evaluate(() => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      Array.from(shadow.querySelectorAll('.gejq-th-button')).find((b) => b.textContent.includes('displayName')).click();
    });
  await clickHeader();
  await page.waitForTimeout(200);
  const firstAsc = await page.evaluate(
    () => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-table tbody tr').children[1].textContent
  );
  check('header click sorts ascending', firstAsc === 'Adele Vance', firstAsc);
  await clickHeader();
  await page.waitForTimeout(200);
  const firstDesc = await page.evaluate(
    () => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-table tbody tr').children[1].textContent
  );
  check('second click sorts descending', firstDesc === 'Nestor Wilke', firstDesc);
  // The CSV/TSV copy-format dropdown replaces the old standalone TSV
  // button: visible in CSV mode with CSV + TSV options, hidden otherwise.
  const copyFormatCsv = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const sel = shadow.querySelector('.gejq-copy-format');
    return {
      visible: !!sel && sel.style.display !== 'none',
      options: sel ? Array.from(sel.options).map((o) => o.value) : []
    };
  });
  check(
    'CSV mode shows the CSV/TSV copy-format dropdown',
    copyFormatCsv.visible && copyFormatCsv.options.join(',') === 'csv,tsv',
    JSON.stringify(copyFormatCsv)
  );
  await page.locator('.gejq-seg-btn', { hasText: 'JSON' }).click();
  await page.waitForTimeout(200);
  check(
    'copy-format dropdown hidden outside CSV mode',
    await page.evaluate(() => {
      const sel = document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-copy-format');
      return sel.style.display === 'none';
    })
  );
  await page.locator('.gejq-seg-btn', { hasText: 'CSV' }).click();
  await page.waitForTimeout(200);
  // Selecting TSV makes Copy/Download emit tab-separated output; verify via
  // the Download path (clipboard isn't available in headless) that the
  // exported header row switches from comma- to tab-delimited.
  const downloadedHeader = async (fmt) => {
    await page.evaluate((f) => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      const sel = shadow.querySelector('.gejq-copy-format');
      sel.value = f;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, fmt);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(() => {
        const btns = document.getElementById('gejq-host').shadowRoot.querySelectorAll('.gejq-footer .gejq-action');
        btns[btns.length - 1].click(); // Download is the last footer action
      })
    ]);
    const stream = await download.createReadStream();
    let data = '';
    for await (const chunk of stream) data += chunk;
    return { name: download.suggestedFilename(), header: data.split('\n')[0] };
  };
  const csvDl = await downloadedHeader('csv');
  const tsvDl = await downloadedHeader('tsv');
  check(
    'copy-format dropdown switches CSV vs TSV output',
    csvDl.header.includes(',') && !csvDl.header.includes('\t') && tsvDl.header.includes('\t'),
    JSON.stringify({ csv: csvDl.header, tsv: tsvDl.header })
  );
  check('download extension follows the copy format', csvDl.name.endsWith('.csv') && tsvDl.name.endsWith('.tsv'), csvDl.name + ' / ' + tsvDl.name);
  // Leave the dropdown on CSV for any later export checks.
  await page.evaluate(() => {
    const sel = document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-copy-format');
    sel.value = 'csv';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // 10n. Tree view: clicking a property composes the path query.
  await page.locator('.gejq-seg-btn', { hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    shadow.querySelector('.gejq-tree-toggle').click(); // expand [0]
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    Array.from(shadow.querySelectorAll('.gejq-tree-key')).find((k) => k.textContent === 'displayName').click();
  });
  await page.waitForTimeout(400);
  check('tree click composes the path query', (await queryValue()) === '.value | .[].displayName', await queryValue());
  await page.locator('.gejq-seg-btn', { hasText: 'JSON' }).click();
  await page.waitForTimeout(300);
  check('tree-built query returns the data', (await page.locator('.gejq-result').innerText()).includes('Adele Vance'));

  // 10o. Compare mode (⇄): diff against another captured response.
  await query.fill('');
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-diff-toggle').click());
  await page.waitForTimeout(500);
  const diffState = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      rows: shadow.querySelectorAll('.gejq-result .gejq-diff-row').length,
      meta: shadow.querySelector('.gejq-meta-right').textContent,
      baselineOptions: shadow.querySelectorAll('.gejq-diff-select option').length
    };
  });
  check('diff mode shows differences', diffState.rows > 0 && diffState.meta.includes('difference'), JSON.stringify(diffState));
  await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-diff-toggle').click());
  await page.waitForTimeout(300);
  check(
    'diff mode toggles back off',
    await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelectorAll('.gejq-result .gejq-diff-row').length === 0)
  );

  // 10p. Pin result as a new queryable source.
  await query.fill('.value[].mail');
  await page.waitForTimeout(400);
  await page.locator('.gejq-icon-button', { hasText: 'Pin result' }).click();
  await page.waitForTimeout(300);
  const pinnedState = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      firstOption: shadow.querySelector('.gejq-history-select option').textContent,
      query: (function (el) {
        return typeof el.value === 'string' ? el.value : el.dataset.query || '';
      })(shadow.querySelector('.gejq-query-input')),
      result: shadow.querySelector('.gejq-result').textContent
    };
  });
  check('pinned result becomes the selected source', pinnedState.firstOption.includes('pinned result'), pinnedState.firstOption);
  check('pinned result is queryable', pinnedState.query === '' && pinnedState.result.includes('adele@contoso.com'));

  // 10p2. Off-thread evaluation: datasets above 512 KB are queried in the
  // hidden extension-origin evaluator iframe (its own process), which
  // returns a capped preview + exact size instead of the whole value.
  check(
    'evaluator iframe embedded (extension origin, hidden)',
    await page.evaluate(() => {
      const frame = document.getElementById('gejq-evaluator');
      return !!frame && frame.src.startsWith('chrome-extension://') && frame.style.display === 'none';
    })
  );
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    Array.from(shadow.querySelectorAll('.gejq-icon-button'))
      .find((b) => b.textContent === 'Paste JSON')
      .click();
    const items = [];
    for (let i = 0; i < 30000; i++) {
      items.push({
        id: i,
        name: 'Item number ' + String(i).padStart(5, '0'),
        description: 'A reasonably long description string for item ' + i + ' that pads the dataset with enough bytes to cross the off-thread threshold.'
      });
    }
    const input = shadow.querySelector('.gejq-paste-input');
    input.value = JSON.stringify({ value: items });
    input.dispatchEvent(new Event('input', { bubbles: true }));
    Array.from(shadow.querySelectorAll('.gejq-dialog .gejq-action'))
      .find((b) => b.textContent === 'Use JSON')
      .click();
  });
  try {
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        return shadow.querySelector('.gejq-result').textContent.includes('Result is large');
      },
      { timeout: 15000 }
    );
    check('large pasted dataset renders an off-thread preview', true);
  } catch (e) {
    check('large pasted dataset renders an off-thread preview', false, e.message.split('\n')[0]);
  }
  const largeMeta = await page.locator('.gejq-meta-right').innerText();
  check('exact size reported for the large result', /object · 1 key · \d+(\.\d+)? MB/.test(largeMeta), largeMeta);
  await query.fill('.value');
  await page.waitForFunction(
    () => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-meta-right').textContent.includes('30000 items'),
    { timeout: 15000 }
  );
  check(
    'tree view disabled for large results',
    await page.evaluate(() => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      return Array.from(shadow.querySelectorAll('.gejq-seg-btn')).find((b) => b.textContent === 'Tree').disabled;
    })
  );
  await page.locator('.gejq-seg-btn', { hasText: 'CSV' }).click();
  await page.waitForFunction(
    () => document.getElementById('gejq-host').shadowRoot.querySelectorAll('.gejq-table tbody tr').length === 1000,
    { timeout: 15000 }
  );
  const largeTable = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      notice: shadow.querySelector('.gejq-result .gejq-notice').textContent,
      firstCell: shadow.querySelector('.gejq-table tbody tr').children[1].textContent
    };
  });
  check('large table shows capped evaluator rows', largeTable.notice.includes('first 1000 of 30000'), largeTable.notice);
  // Sorting a large table round-trips through the evaluator.
  const clickLargeHeader = () =>
    page.evaluate(() => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      Array.from(shadow.querySelectorAll('.gejq-th-button')).find((b) => b.textContent.includes('name')).click();
    });
  await clickLargeHeader();
  await page.waitForTimeout(400);
  await clickLargeHeader(); // descending
  try {
    await page.waitForFunction(
      () =>
        document
          .getElementById('gejq-host')
          .shadowRoot.querySelector('.gejq-table tbody tr')
          .children[1].textContent.includes('29999'),
      { timeout: 15000 }
    );
    check('large table sorts via the evaluator', true);
  } catch (e) {
    check('large table sorts via the evaluator', false, e.message.split('\n')[0]);
  }
  // Download of a large result fetches the full text from the evaluator.
  await page.locator('.gejq-seg-btn', { hasText: 'JSON' }).click();
  await page.waitForTimeout(400);
  const [largeDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => {
      const btns = document.getElementById('gejq-host').shadowRoot.querySelectorAll('.gejq-footer .gejq-action');
      btns[btns.length - 1].click();
    })
  ]);
  const largeStream = await largeDownload.createReadStream();
  let largeBytes = 0;
  let largeHead = '';
  for await (const chunk of largeStream) {
    if (largeHead.length < 2) largeHead += chunk.toString('utf8', 0, 2);
    largeBytes += chunk.length;
  }
  check(
    'large download exports the full off-thread result',
    largeBytes > 3000000 && largeHead.startsWith('['),
    largeBytes + ' bytes, starts ' + JSON.stringify(largeHead)
  );

  // 10p2b. Results that come back WHOLE (under the value limit) but are
  // still hundreds of KB must render capped: laying out a ~400 KB <pre>
  // right after an evaluation was itself a freeze.
  await query.fill('.value[0:2000]');
  await page.waitForFunction(
    () => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-meta-right').textContent.includes('2000 items'),
    { timeout: 15000 }
  );
  const cappedRender = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const notice = shadow.querySelector('.gejq-result .gejq-notice');
    const pre = shadow.querySelector('.gejq-result .gejq-json');
    return {
      notice: notice ? notice.textContent : '',
      preChars: pre ? pre.textContent.length : 0,
      spans: shadow.querySelectorAll('.gejq-result .gejq-json span').length,
      meta: shadow.querySelector('.gejq-meta-right').textContent
    };
  });
  check(
    'mid-size result renders a capped preview, not the whole text',
    cappedRender.preChars > 0 && cappedRender.preChars < 300000 && cappedRender.notice.includes('Showing the first'),
    JSON.stringify({ notice: cappedRender.notice.slice(0, 70), preChars: cappedRender.preChars })
  );
  check(
    'capped preview is not syntax-highlighted span-by-span',
    cappedRender.spans === 0,
    String(cappedRender.spans)
  );
  check(
    'full size still reported for the capped result',
    /· \d+(\.\d+)? (KB|MB)/.test(cappedRender.meta),
    cappedRender.meta
  );
  await query.fill('.value'); // the section below counts the whole collection
  await page.waitForTimeout(400);

  // 10p3. Large SINGLE responses are shipped by the interceptor straight
  // to the evaluator as raw text — the panel receives metadata plus a
  // structural sample (so suggestions still work) and never touches the
  // parsed dataset; queries run off-thread from the first keystroke.
  await page.evaluate(() => window.runGraphQuery('/v1.0/users?bigsingle=1'));
  try {
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        return shadow.querySelector('.gejq-meta-right').textContent.includes('20000 items');
      },
      { timeout: 15000 }
    );
    check('interceptor-delivered large response queries off-thread', true);
  } catch (e) {
    check('interceptor-delivered large response queries off-thread', false, e.message.split('\n')[0]);
  }
  const bigSuggestions = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return Array.from(shadow.querySelectorAll('.gejq-suggestions .gejq-chip')).map((c) => c.textContent);
  });
  check(
    'suggestions derive from the remote dataset sample',
    bigSuggestions.some((t) => t.includes('displayName')),
    bigSuggestions.join(' | ')
  );

  // 10q. History rows: hover copy, label, delete, confirm-clear.
  const rowButtons = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const row = shadow.querySelector('.gejq-query-history .gejq-example');
    return Array.from(row.querySelectorAll('.gejq-icon-mini.gejq-hover')).map((b) => b.textContent);
  });
  check('hover actions include copy, tags, delete', rowButtons.includes('📋') && rowButtons.includes('🏷') && rowButtons.includes('✕'), rowButtons.join(' '));
  // Star the first row, then name it.
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const row = shadow.querySelector('.gejq-query-history .gejq-example');
    if (!row.querySelector('.gejq-star').classList.contains('gejq-starred')) {
      row.querySelector('.gejq-star').click();
    }
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const row = shadow.querySelector('.gejq-query-history .gejq-example');
    Array.from(row.querySelectorAll('.gejq-icon-mini')).find((b) => b.textContent === '✎').click();
  });
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const input = shadow.querySelector('.gejq-query-history .gejq-tag-input');
    input.value = 'My favorite';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await page.waitForTimeout(200);
  check(
    'favorite shows its custom name',
    await page.evaluate(() =>
      document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-query-history .gejq-chip').textContent === 'My favorite'
    )
  );
  const rowsBeforeDelete = await page.evaluate(
    () => document.getElementById('gejq-host').shadowRoot.querySelectorAll('.gejq-query-history .gejq-example').length
  );
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const row = shadow.querySelector('.gejq-query-history .gejq-example');
    Array.from(row.querySelectorAll('.gejq-icon-mini')).find((b) => b.textContent === '✕').click();
  });
  await page.waitForTimeout(200);
  const rowsAfterDelete = await page.evaluate(
    () => document.getElementById('gejq-host').shadowRoot.querySelectorAll('.gejq-query-history .gejq-example').length
  );
  check('row delete removes one entry', rowsAfterDelete === rowsBeforeDelete - 1, `${rowsBeforeDelete} → ${rowsAfterDelete}`);
  // Clear asks for confirmation first.
  const clearBtn = () =>
    page.evaluate(() => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      const btn = Array.from(shadow.querySelectorAll('.gejq-history-actions .gejq-icon-button')).find((b) =>
        b.textContent.toLowerCase().includes('clear') || b.textContent.toLowerCase().includes('really')
      );
      const text = btn.textContent;
      btn.click();
      return text;
    });
  await clearBtn();
  const armedText = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return Array.from(shadow.querySelectorAll('.gejq-history-actions .gejq-icon-button')).map((b) => b.textContent).join('|');
  });
  check('clear history asks to confirm', armedText.includes('Really clear'), armedText);
  await clearBtn();
  await page.waitForTimeout(200);
  check(
    'confirmed clear empties the history',
    await page.evaluate(() =>
      document.getElementById('gejq-host').shadowRoot.querySelectorAll('.gejq-query-history .gejq-example').length === 0
    )
  );
  check(
    'export/import buttons present',
    await page.evaluate(() => {
      const texts = Array.from(
        document.getElementById('gejq-host').shadowRoot.querySelectorAll('.gejq-history-actions .gejq-icon-button')
      ).map((b) => b.textContent);
      return texts.includes('Export') && texts.includes('Import');
    })
  );

  // 10r. The panel follows Graph Explorer's own theme switcher.
  await page.evaluate(() => localStorage.setItem('CURRENT_THEME', 'dark'));
  await page.locator('.gejq-seg-btn', { hasText: 'JSON' }).click(); // any runQuery syncs the theme
  await page.waitForTimeout(200);
  check(
    'panel follows GE dark theme',
    await page.evaluate(() => document.getElementById('gejq-host').classList.contains('gejq-theme-dark'))
  );
  // In dark mode the query editor's caret must be light (white), not the
  // black CodeMirror default.
  const caretDark = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const content = shadow.querySelector('.gejq-query-editor .cm-content');
    const cursor = shadow.querySelector('.gejq-query-editor .cm-cursor');
    return {
      caretColor: content ? getComputedStyle(content).caretColor : '',
      cursorBorder: cursor ? getComputedStyle(cursor).borderLeftColor : 'none'
    };
  });
  check(
    'query editor caret is white in dark mode',
    caretDark.caretColor === 'rgb(255, 255, 255)' && (caretDark.cursorBorder === 'none' || caretDark.cursorBorder === 'rgb(255, 255, 255)'),
    JSON.stringify(caretDark)
  );
  await page.evaluate(() => localStorage.removeItem('CURRENT_THEME'));
  await page.locator('.gejq-seg-btn', { hasText: 'JSON' }).click();
  await page.waitForTimeout(200);
  check(
    'panel returns to OS theme when GE theme is unset',
    await page.evaluate(() => !document.getElementById('gejq-host').classList.contains('gejq-theme-dark'))
  );
  const caretLight = await page.evaluate(() => {
    const content = document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-query-editor .cm-content');
    return content ? getComputedStyle(content).caretColor : '';
  });
  check('query editor caret is dark in light mode', caretLight === 'rgb(36, 36, 36)', caretLight);

  // 10l. Graph Explorer's own background calls are hidden behind a toggle.
  const optionCountBefore = await page.evaluate(
    () => document.getElementById('gejq-host').shadowRoot.querySelectorAll('.gejq-history-select option').length
  );
  // Internal-style call: URL not in the URI field, no run interaction.
  await page.evaluate(() => fetch('https://graph.microsoft.com/v1.0/organization').then((r) => r.json()));
  await page.waitForTimeout(600);
  const bgState = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      options: shadow.querySelectorAll('.gejq-history-select option').length
    };
  });
  check('background request hidden from the response list', bgState.options === optionCountBefore, `options ${optionCountBefore} → ${bgState.options}`);
  await popup.check('#setting-show-background');
  await page.waitForTimeout(500);
  const shownBg = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return Array.from(shadow.querySelectorAll('.gejq-history-select option')).map((o) => o.textContent);
  });
  check('settings toggle reveals background entry with ⚙ marker', shownBg.some((t) => t.includes('⚙') && t.includes('/v1.0/organization')), shownBg.find((t) => t.includes('⚙')));
  await popup.uncheck('#setting-show-background');
  await page.waitForTimeout(500);
  const hiddenAgain = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return Array.from(shadow.querySelectorAll('.gejq-history-select option')).every((o) => !o.textContent.includes('⚙'));
  });
  check('unchecking the setting hides background entries again', hiddenAgain);

  // A deliberate run of a "background-looking" URL (via the Run button)
  // stays visible: URI field matches + recent run interaction.
  await page.evaluate(() => {
    document.getElementById('ge-editor-input').value = 'https://graph.microsoft.com/v1.0/me';
  });
  await page.locator('#ge-run').click();
  await page.waitForTimeout(600);
  const meVisible = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return Array.from(shadow.querySelectorAll('.gejq-history-select option')).map((o) => o.textContent);
  });
  check(
    'deliberately-run GET /me stays visible',
    meVisible.some((t) => t.includes('/v1.0/me') && !t.includes('⚙')),
    meVisible[0]
  );

  // 11. Re-opening the popup within the double-click window opens Graph Explorer.
  const tabsBefore = ctx.pages().length;
  const popupA = await ctx.newPage();
  await popupA.goto(extOrigin + '/popup/popup.html');
  // A second popup open within the double-click window opens Graph
  // Explorer (chrome.tabs.create — verified to return a tab id, but the
  // created tab is invisible to Playwright's tracker in headless mode)
  // and then self-closes. The self-close is the observable signal that
  // the double-open was detected and handled.
  await popupA.waitForTimeout(250); // human double-click gap; lets the first open's timestamp land
  await popupA.reload().catch(() => {});
  let selfClosed = false;
  for (let i = 0; i < 20 && !selfClosed; i++) {
    await new Promise((r) => setTimeout(r, 200));
    selfClosed = popupA.isClosed();
  }
  check(
    'double-open popup detected (opens Graph Explorer and closes itself)',
    selfClosed,
    `pages before=${tabsBefore} after=${ctx.pages().length}`
  );

  // 12. Simulate a React remount wiping the results area — panel must re-embed.
  await page.evaluate(() => {
    const area = document.getElementById('response-area');
    area.remove();
    const fresh = document.createElement('div');
    fresh.id = 'response-area';
    const inner = document.createElement('div');
    inner.id = 'ge-response';
    inner.textContent = 'fresh response view';
    fresh.appendChild(inner);
    document.getElementById('app').appendChild(fresh);
  });
  await page.waitForFunction(() => {
    const host = document.getElementById('gejq-host');
    return host && host.parentElement && host.parentElement.id === 'response-area';
  }, { timeout: 5000 });
  check('panel re-embeds after results area remount', true);

  await page.screenshot({ path: path.join(SHOT_DIR, 'after-remount.png') });
  await ctx.close();
  fs.rmSync(profileDir, { recursive: true, force: true });

  console.log(failures === 0 ? '\nSMOKE TEST PASSED' : `\nSMOKE TEST: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('SMOKE TEST CRASHED:', e.message);
  process.exit(1);
});
