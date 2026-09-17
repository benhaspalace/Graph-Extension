'use strict';

const test = require('node:test');
const { before } = require('node:test');
const assert = require('node:assert/strict');

const GEJQ = require('../src/query-utils.js');
const jmespath = require('../vendor/jmespath.js');
const { JSONPath } = require('../vendor/jsonpath-plus.js');

// vendor/jq-wasm.js is an IIFE browser bundle exposing a JQWASM global
// (real jq 1.8.2 compiled to WebAssembly, bytes embedded). Evaluated in
// this realm so it sees Node's WebAssembly/TextDecoder; loading the
// instance is async, so it happens once in a `before` hook and the tests
// below stay synchronous.
const vm = require('node:vm');
const JQWASM = vm.runInThisContext(
  '(function () {' + require('node:fs').readFileSync(__dirname + '/../vendor/jq-wasm.js', 'utf8') + '\nreturn JQWASM; })()',
  { filename: 'vendor/jq-wasm.js' }
);
const jqEngine = GEJQ.createJqEngine(JQWASM);
let jqBuiltins = null; // Set of "name/arity" from the engine itself
before(async () => {
  await jqEngine.load();
  jqBuiltins = new Set(jqEngine.evaluate(null, '[builtins[]]'));
});

function runJq(query, json) {
  return jqEngine.evaluate(json, query);
}

const SAMPLE_USERS_RESPONSE = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users',
  '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc',
  value: [
    { id: '1', displayName: 'Adele Vance', mail: 'adele@contoso.com', jobTitle: 'Retail Manager' },
    { id: '2', displayName: 'Alex Wilber', mail: 'alex@contoso.com', jobTitle: 'Marketing Assistant' },
    { id: '3', displayName: 'Megan Bowen', mail: null, jobTitle: 'Auditor' }
  ]
};

test('jmesKey quotes only when needed', () => {
  assert.equal(GEJQ.jmesKey('displayName'), 'displayName');
  assert.equal(GEJQ.jmesKey('_private'), '_private');
  assert.equal(GEJQ.jmesKey('@odata.context'), '"@odata.context"');
  assert.equal(GEJQ.jmesKey('has space'), '"has space"');
  assert.equal(GEJQ.jmesKey('has"quote'), '"has\\"quote"');
});

test('safeJsonParse handles valid and invalid input', () => {
  assert.deepEqual(GEJQ.safeJsonParse('{"a":1}'), { ok: true, value: { a: 1 } });
  const bad = GEJQ.safeJsonParse('{nope');
  assert.equal(bad.ok, false);
  assert.ok(bad.error.length > 0);
});

test('describeResult covers common shapes', () => {
  assert.equal(GEJQ.describeResult([1, 2, 3]), 'array · 3 items');
  assert.equal(GEJQ.describeResult([1]), 'array · 1 item');
  assert.equal(GEJQ.describeResult({ a: 1, b: 2 }), 'object · 2 keys');
  assert.equal(GEJQ.describeResult('hi'), 'string · 2 chars');
  assert.equal(GEJQ.describeResult(42), 'number');
  assert.equal(GEJQ.describeResult(true), 'boolean');
  assert.equal(GEJQ.describeResult(null), 'null');
  assert.equal(GEJQ.describeResult(undefined), 'no result');
});

test('formatBytes renders human-readable sizes', () => {
  assert.equal(GEJQ.formatBytes(0), '0 B');
  assert.equal(GEJQ.formatBytes(512), '512 B');
  assert.equal(GEJQ.formatBytes(2048), '2 KB');
  assert.equal(GEJQ.formatBytes(5 * 1024 * 1024), '5 MB');
  assert.equal(GEJQ.formatBytes(-1), '');
  assert.equal(GEJQ.formatBytes(NaN), '');
});

test('summarizeUrl strips origin and truncates', () => {
  assert.equal(
    GEJQ.summarizeUrl('https://graph.microsoft.com/v1.0/me/messages?$top=5'),
    '/v1.0/me/messages?$top=5'
  );
  const long = 'https://graph.microsoft.com/v1.0/' + 'x'.repeat(200);
  assert.ok(GEJQ.summarizeUrl(long, 50).length <= 50);
  assert.ok(GEJQ.summarizeUrl(long, 50).endsWith('…'));
  assert.equal(GEJQ.summarizeUrl('not a url'), 'not a url');
});

test('trimHistory keeps the newest entries', () => {
  const entries = [5, 4, 3, 2, 1];
  assert.deepEqual(GEJQ.trimHistory(entries, 3), [5, 4, 3]);
  assert.deepEqual(GEJQ.trimHistory(entries, 10), entries);
  assert.deepEqual(GEJQ.trimHistory(null, 3), []);
});

test('suggestQueries proposes useful queries for collection responses', () => {
  const suggestions = GEJQ.suggestQueries(SAMPLE_USERS_RESPONSE);
  assert.ok(suggestions.includes('value[].displayName'));
  assert.ok(suggestions.includes('length(value)'));
  assert.ok(suggestions.includes('"@odata.nextLink"'));
});

test('every suggested query is valid JMESPath against the source data', () => {
  const shapes = [
    SAMPLE_USERS_RESPONSE,
    { id: '1', displayName: 'Adele Vance', '@odata.context': 'ctx' },
    [1, 2, 3],
    { value: [] },
    { value: [{ '@odata.type': '#microsoft.graph.user', 'odd key': 1 }] },
    'scalar',
    null
  ];
  for (const shape of shapes) {
    for (const query of GEJQ.suggestQueries(shape)) {
      assert.doesNotThrow(() => jmespath.search(shape, query), `query ${query} should compile`);
    }
  }
});

test('applyAdvancedQuery upgrades GET requests using advanced query options', () => {
  for (const trigger of ['$filter=startswith(displayName,%27a%27)', '$search="displayName:room"', '$orderby=displayName']) {
    const result = GEJQ.applyAdvancedQuery('https://graph.microsoft.com/v1.0/users?' + trigger, 'GET');
    assert.equal(result.addHeader, true, trigger);
    assert.ok(result.url.includes('%24count=true') || result.url.includes('$count=true'), result.url);
  }
});

test('applyAdvancedQuery keeps an existing $count and still asks for the header', () => {
  const url = 'https://graph.microsoft.com/v1.0/users?$count=true&$filter=x';
  const result = GEJQ.applyAdvancedQuery(url, 'GET');
  assert.equal(result.addHeader, true);
  assert.equal((result.url.match(/%24count|\$count/g) || []).length, 1);
});

test('applyAdvancedQuery handles /$count path segments', () => {
  const result = GEJQ.applyAdvancedQuery('https://graph.microsoft.com/v1.0/users/$count', 'GET');
  assert.equal(result.addHeader, true);
  assert.equal(result.url, 'https://graph.microsoft.com/v1.0/users/$count');
  // The header is needed but the $count=true parameter must NOT be added
  // to a /$count segment — callers key their insertion off addCount.
  assert.equal(result.addCount, false);
});

test('applyAdvancedQuery reports addCount only when it appended $count', () => {
  const appended = GEJQ.applyAdvancedQuery('https://graph.microsoft.com/v1.0/users?$filter=x', 'GET');
  assert.equal(appended.addCount, true);
  const existing = GEJQ.applyAdvancedQuery('https://graph.microsoft.com/v1.0/users?$count=true&$filter=x', 'GET');
  assert.equal(existing.addHeader, true);
  assert.equal(existing.addCount, false);
});

test('applyAdvancedQuery leaves plain and non-GET requests untouched', () => {
  const plain = GEJQ.applyAdvancedQuery('https://graph.microsoft.com/v1.0/me', 'GET');
  assert.deepEqual(plain, { url: 'https://graph.microsoft.com/v1.0/me', addHeader: false, addCount: false });

  const select = GEJQ.applyAdvancedQuery('https://graph.microsoft.com/v1.0/users?$select=id', 'GET');
  assert.equal(select.addHeader, false);
  assert.ok(!select.url.includes('$count'));

  const post = GEJQ.applyAdvancedQuery('https://graph.microsoft.com/v1.0/users?$filter=x', 'POST');
  assert.equal(post.addHeader, false);
  assert.ok(!post.url.includes('$count'));

  const invalid = GEJQ.applyAdvancedQuery('not a url', 'GET');
  assert.deepEqual(invalid, { url: 'not a url', addHeader: false, addCount: false });
});

test('applyAdvancedQuery preserves existing query parameters', () => {
  const result = GEJQ.applyAdvancedQuery(
    'https://graph.microsoft.com/v1.0/users?$select=displayName&$filter=startswith(displayName,%27a%27)&$top=5',
    'get'
  );
  assert.equal(result.addHeader, true);
  const parsed = new URL(result.url);
  assert.equal(parsed.searchParams.get('$select'), 'displayName');
  assert.equal(parsed.searchParams.get('$top'), '5');
  assert.equal(parsed.searchParams.get('$count'), 'true');
  assert.equal(parsed.searchParams.get('$filter'), "startswith(displayName,'a')");
});

test('suggestQueries also proposes JSONPath queries', () => {
  const suggestions = GEJQ.suggestQueries(SAMPLE_USERS_RESPONSE, 'jsonpath');
  assert.ok(suggestions.includes('$.value[*].displayName'));
  assert.ok(suggestions.includes('$.value.length'));
});

test('every suggested JSONPath query is valid against the source data', () => {
  const shapes = [
    SAMPLE_USERS_RESPONSE,
    { id: '1', displayName: 'Adele Vance', '@odata.context': 'ctx' },
    [1, 2, 3],
    { value: [] },
    { value: [{ '@odata.type': '#microsoft.graph.user', 'odd key': 1 }] },
    'scalar',
    null
  ];
  for (const shape of shapes) {
    for (const query of GEJQ.suggestQueries(shape, 'jsonpath')) {
      assert.doesNotThrow(
        () => JSONPath({ path: query, json: shape, wrap: true }),
        `query ${query} should evaluate`
      );
    }
  }
});

test('parseGraphRequest splits Graph URLs into deep-link parts', () => {
  assert.deepEqual(GEJQ.parseGraphRequest('https://graph.microsoft.com/v1.0/me/messages?$top=5'), {
    graphUrl: 'https://graph.microsoft.com',
    version: 'v1.0',
    request: 'me/messages?$top=5'
  });
  assert.deepEqual(GEJQ.parseGraphRequest('https://graph.microsoft.us/beta/users'), {
    graphUrl: 'https://graph.microsoft.us',
    version: 'beta',
    request: 'users'
  });
  assert.equal(GEJQ.parseGraphRequest('https://graph.microsoft.com/v2.0/users'), null);
  assert.equal(GEJQ.parseGraphRequest('https://graph.microsoft.com/v1.0'), null);
  assert.equal(GEJQ.parseGraphRequest('not a url'), null);
});

test('buildDeepLink produces Graph Explorer share-style links', () => {
  const link = GEJQ.buildDeepLink(
    'https://developer.microsoft.com/en-us/graph/graph-explorer',
    'get',
    'https://graph.microsoft.com/v1.0/me/messages?$top=5'
  );
  assert.equal(
    link,
    'https://developer.microsoft.com/en-us/graph/graph-explorer' +
      '?request=me%2Fmessages%3F%24top%3D5&method=GET&version=v1.0&GraphUrl=https%3A%2F%2Fgraph.microsoft.com'
  );
  assert.equal(GEJQ.buildDeepLink('https://x', 'GET', 'https://graph.microsoft.com/v2.0/oops'), null);
});

test('upsertQueryHistory keeps distinct queries newest-first with timestamps', () => {
  let history = [];
  history = GEJQ.upsertQueryHistory(history, { query: 'a', language: 'jmespath', lastUsed: 1000, context: { method: 'GET', url: '/v1.0/users' } }, 50);
  history = GEJQ.upsertQueryHistory(history, { query: 'b', language: 'jmespath', lastUsed: 2000, context: null }, 50);
  assert.deepEqual(history.map((h) => h.query), ['b', 'a']);
  assert.equal(history[1].lastUsed, 1000);
  assert.equal(history[1].context.url, '/v1.0/users');

  // Re-running "a" moves it up, bumps uses, refreshes lastUsed, keeps context.
  history = GEJQ.upsertQueryHistory(history, { query: 'a', language: 'jmespath', lastUsed: 3000, context: null }, 50);
  assert.deepEqual(history.map((h) => h.query), ['a', 'b']);
  assert.equal(history[0].uses, 2);
  assert.equal(history[0].lastUsed, 3000);
  assert.equal(history[0].context.url, '/v1.0/users');

  // Same text in a different language is a distinct entry.
  history = GEJQ.upsertQueryHistory(history, { query: 'a', language: 'jsonpath', lastUsed: 4000, context: null }, 50);
  assert.equal(history.length, 3);
});

test('upsertQueryHistory honors the limit; 0 means unlimited', () => {
  let history = [];
  for (let i = 0; i < 10; i++) {
    history = GEJQ.upsertQueryHistory(history, { query: 'q' + i, language: 'jmespath', lastUsed: i, context: null }, 3);
  }
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((h) => h.query), ['q9', 'q8', 'q7']);

  let unlimited = [];
  for (let i = 0; i < 10; i++) {
    unlimited = GEJQ.upsertQueryHistory(unlimited, { query: 'q' + i, language: 'jmespath', lastUsed: i, context: null }, 0);
  }
  assert.equal(unlimited.length, 10);
});

test('formatTimestamp shows clock time today and full date otherwise', () => {
  const noon = new Date(2026, 7, 7, 12, 0, 0).getTime();
  const morning = new Date(2026, 7, 7, 9, 5, 7).getTime();
  const lastWeek = new Date(2026, 6, 30, 9, 5, 0).getTime();
  assert.equal(GEJQ.formatTimestamp(morning, noon), '09:05:07');
  assert.equal(GEJQ.formatTimestamp(lastWeek, noon), '2026-07-30 09:05');
});

test('suggestQueries proposes valid jq queries', () => {
  const suggestions = GEJQ.suggestQueries(SAMPLE_USERS_RESPONSE, 'jq');
  assert.ok(suggestions.includes('.value[].displayName'));
  assert.ok(suggestions.includes('.value | length'));
  const shapes = [SAMPLE_USERS_RESPONSE, [1, 2], { a: 1 }, { value: [] }, null];
  for (const shape of shapes) {
    for (const query of GEJQ.suggestQueries(shape, 'jq')) {
      assert.doesNotThrow(() => runJq(query, shape), `jq query ${query} should run`);
    }
  }
});

test('the documented jq examples run on the sample response', () => {
  const examples = [
    '.value[].displayName',
    '.value | map(select(.jobTitle == "Auditor"))',
    '[.value[] | select((.displayName // "") | test("^a"; "i"))]',
    '[.value[] | {name: .displayName, email: .mail}]',
    '.value | sort_by(.displayName) | .[].displayName',
    '.value | length'
  ];
  for (const example of examples) {
    assert.doesNotThrow(() => runJq(example, SAMPLE_USERS_RESPONSE), example);
  }
  assert.deepEqual(runJq('.value[].displayName', SAMPLE_USERS_RESPONSE), [
    'Adele Vance',
    'Alex Wilber',
    'Megan Bowen'
  ]);
  assert.equal(runJq('.value | length', SAMPLE_USERS_RESPONSE), 3);
});

test('convertQuery translates simple paths between all three languages', () => {
  const conversions = [
    ['jsonpath', 'jmespath', '$.value[*].displayName', 'value[].displayName'],
    ['jsonpath', 'jmespath', "$['@odata.nextLink']", '"@odata.nextLink"'],
    ['jsonpath', 'jmespath', '$.value[?(@.mail)].mail', 'value[?mail].mail'],
    ['jsonpath', 'jmespath', "$.value[?(@.jobTitle == 'Auditor')]", "value[?jobTitle == 'Auditor']"],
    ['jsonpath', 'jmespath', '$.value.length', 'length(value)'],
    ['jmespath', 'jsonpath', 'value[].displayName', '$.value[*].displayName'],
    ['jmespath', 'jsonpath', 'length(value)', '$.value.length'],
    ['jmespath', 'jsonpath', '"@odata.nextLink"', "$['@odata.nextLink']"],
    ['jmespath', 'jsonpath', "value[?jobTitle == 'Auditor'].mail", "$.value[?(@.jobTitle == 'Auditor')].mail"],
    ['jmespath', 'jq', 'value[].displayName', '.value[].displayName'],
    ['jmespath', 'jq', 'length(value)', '.value | length'],
    ['jmespath', 'jq', "value[?jobTitle == 'Auditor']", '.value | map(select(.jobTitle == "Auditor"))'],
    ['jmespath', 'jq', 'value[0].mail', '.value[0].mail'],
    ['jq', 'jmespath', '.value[].displayName', 'value[].displayName'],
    ['jq', 'jmespath', '.value | length', 'length(value)'],
    ['jq', 'jsonpath', '."@odata.nextLink"', "$['@odata.nextLink']"],
    ['jsonpath', 'jq', '$.value[*].mail', '.value[].mail'],
    ['jsonpath', 'jq', '$.value[0:5]', '.value[0:5]']
  ];
  for (const [from, to, input, expected] of conversions) {
    const result = GEJQ.convertQuery(input, from, to);
    assert.equal(result.ok, true, `${from}→${to} ${input}`);
    assert.equal(result.query, expected, `${from}→${to} ${input}`);
  }
});

test('converted queries actually run in the target engine', () => {
  const engines = {
    jmespath: (q) => jmespath.search(SAMPLE_USERS_RESPONSE, q),
    jsonpath: (q) => JSONPath({ path: q, json: SAMPLE_USERS_RESPONSE, wrap: true }),
    jq: (q) => runJq(q, SAMPLE_USERS_RESPONSE)
  };
  const sources = { jmespath: 'value[].displayName', jsonpath: '$.value[*].displayName', jq: '.value[].displayName' };
  const expected = ['Adele Vance', 'Alex Wilber', 'Megan Bowen'];
  for (const from of Object.keys(sources)) {
    for (const to of Object.keys(engines)) {
      const converted = GEJQ.convertQuery(sources[from], from, to);
      assert.equal(converted.ok, true, `${from}→${to}`);
      assert.deepEqual(engines[to](converted.query), expected, `${from}→${to}: ${converted.query}`);
    }
  }
});

test('convertQuery refuses queries outside the simple-path subset', () => {
  const unconvertible = [
    ['jmespath', 'jsonpath', 'value[].{name: displayName}'],
    ['jmespath', 'jsonpath', 'sort_by(value, &displayName)'],
    ['jmespath', 'jq', "value[?jobTitle == 'x'].mail"], // filter not last
    ['jsonpath', 'jmespath', '$..displayName'],
    ['jq', 'jmespath', '.value | map(select(.a == "b"))'],
    ['jq', 'jmespath', '.'],
    ['jsonpath', 'jmespath', 'not even a path']
  ];
  for (const [from, to, query] of unconvertible) {
    assert.equal(GEJQ.convertQuery(query, from, to).ok, false, `${from}→${to} ${query}`);
  }
  // Same-language conversion is the identity.
  assert.deepEqual(GEJQ.convertQuery('anything | at all', 'jq', 'jq'), { ok: true, query: 'anything | at all' });
});

test('upsertQueryHistory preserves stars and tags across re-runs', () => {
  let history = GEJQ.upsertQueryHistory([], { query: 'a', language: 'jmespath', lastUsed: 1, context: null }, 10);
  history[0].starred = true;
  history[0].tags = ['users'];
  history = GEJQ.upsertQueryHistory(history, { query: 'a', language: 'jmespath', lastUsed: 2, context: null }, 10);
  assert.equal(history[0].starred, true);
  assert.deepEqual(history[0].tags, ['users']);
});

test('trimQueryHistoryList caps non-favorites and keeps all favorites', () => {
  const entries = [
    { query: 'q5', starred: false },
    { query: 'q4', starred: true },
    { query: 'q3', starred: false },
    { query: 'q2', starred: true },
    { query: 'q1', starred: false }
  ];
  // The limit applies to NON-favorites only (newest first): keep q5, q3 of
  // the three unstarred, drop the oldest unstarred q1; both favorites stay.
  const trimmed = GEJQ.trimQueryHistoryList(entries, 2);
  assert.deepEqual(trimmed.map((e) => e.query), ['q5', 'q4', 'q3', 'q2']);
  // The newest query is always kept even when favorites are plentiful — the
  // bug this fixes: favorites must never crowd out a freshly-run query.
  const manyFavs = [
    { query: 'new', starred: false },
    { query: 'f1', starred: true },
    { query: 'f2', starred: true },
    { query: 'f3', starred: true }
  ];
  assert.ok(GEJQ.trimQueryHistoryList(manyFavs, 1).some((e) => e.query === 'new'));
  // Favorites are never dropped, even when they alone exceed the limit.
  const allStarred = [{ query: 'a', starred: true }, { query: 'b', starred: true }];
  assert.equal(GEJQ.trimQueryHistoryList(allStarred, 1).length, 2);
  assert.equal(GEJQ.trimQueryHistoryList(entries, 0), entries);
});

test('groupQueryHistory pins favorites, keeps the rest in order', () => {
  const groups = GEJQ.groupQueryHistory([
    { query: 'newest', starred: false, tags: [] },
    { query: 'tagged-b', starred: false, tags: ['beta'] },
    { query: 'fav', starred: true, tags: ['kept-not-grouped'] },
    { query: 'tagged-a', starred: false, tags: ['alpha', 'second'] },
    { query: 'old', starred: false }
  ]);
  assert.deepEqual(groups.map((g) => g.title), ['★ Favorites', 'Recent']);
  assert.deepEqual(groups[0].items.map((i) => i.query), ['fav']);
  assert.deepEqual(groups[1].items.map((i) => i.query), ['newest', 'tagged-b', 'tagged-a', 'old']);
  assert.deepEqual(GEJQ.groupQueryHistory([]), []);
});

test('filterQueryHistory filters by text, time, and tags (AND)', () => {
  const NOW = 1000000000;
  const HOUR = 60 * 60 * 1000;
  const history = [
    { query: 'value[].displayName', language: 'jmespath', lastUsed: NOW - HOUR / 2, tags: ['users'], context: { method: 'GET', url: 'https://graph.microsoft.com/v1.0/users' } },
    { query: '.value | length', language: 'jq', lastUsed: NOW - 3 * HOUR, tags: ['users', 'counts'], context: null },
    { query: '$.value[*].subject', language: 'jsonpath', lastUsed: NOW - 48 * HOUR, tags: [], context: { method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/messages' } }
  ];
  assert.equal(GEJQ.filterQueryHistory(history, {}, NOW).length, 3);
  assert.deepEqual(GEJQ.filterQueryHistory(history, { text: 'messages' }, NOW).map((i) => i.language), ['jsonpath']);
  assert.deepEqual(GEJQ.filterQueryHistory(history, { text: 'LENGTH' }, NOW).map((i) => i.language), ['jq']);
  assert.deepEqual(GEJQ.filterQueryHistory(history, { sinceMs: HOUR }, NOW).map((i) => i.language), ['jmespath']);
  assert.deepEqual(GEJQ.filterQueryHistory(history, { tags: ['users'] }, NOW).length, 2);
  assert.deepEqual(GEJQ.filterQueryHistory(history, { tags: ['users', 'counts'] }, NOW).map((i) => i.language), ['jq']);
  assert.equal(GEJQ.filterQueryHistory(history, { text: 'users', tags: ['counts'], sinceMs: 4 * HOUR }, NOW).length, 1);
  assert.equal(GEJQ.filterQueryHistory(history, { text: 'nope' }, NOW).length, 0);
});

test('distinctTags collects unique tags alphabetically', () => {
  assert.deepEqual(
    GEJQ.distinctTags([{ tags: ['zeta', 'users'] }, { tags: ['users'] }, { tags: [] }, {}]),
    ['users', 'zeta']
  );
});

test('property completions resolve keys from the response JSON', () => {
  const jmes = GEJQ.queryCompletions('jmespath', 'value[].disp', SAMPLE_USERS_RESPONSE);
  assert.ok(jmes.items.some((i) => i.label === 'displayName' && i.insert === 'displayName'));

  const afterDot = GEJQ.queryCompletions('jmespath', 'value[].', SAMPLE_USERS_RESPONSE);
  assert.ok(afterDot.items.map((i) => i.label).includes('mail'));
  assert.equal(afterDot.replaceFrom, 'value[].'.length);

  const root = GEJQ.queryCompletions('jmespath', 'val', SAMPLE_USERS_RESPONSE);
  assert.ok(root.items.some((i) => i.label === 'value' && i.detail.startsWith('array')));
  assert.ok(root.items.some((i) => i.label === 'values(')); // Tier-1 merged after properties
  assert.ok(root.items.findIndex((i) => i.label === 'value') < root.items.findIndex((i) => i.label === 'values('));

  const jq = GEJQ.queryCompletions('jq', '.value[].m', SAMPLE_USERS_RESPONSE);
  assert.ok(jq.items.some((i) => i.label === 'mail'));

  const jqRoot = GEJQ.queryCompletions('jq', '.', SAMPLE_USERS_RESPONSE);
  assert.ok(jqRoot.items.some((i) => i.label === 'value'));
  assert.ok(jqRoot.items.some((i) => i.label === '@odata.context' && i.insert === '"@odata.context"'));

  const jsonpath = GEJQ.queryCompletions('jsonpath', '$.value[*].j', SAMPLE_USERS_RESPONSE);
  assert.ok(jsonpath.items.some((i) => i.label === 'jobTitle'));

  // No property completion right after a bracket (would be invalid syntax).
  assert.equal(GEJQ.queryCompletions('jmespath', 'value[]', SAMPLE_USERS_RESPONSE), null);
  // Unresolvable paths yield no property items.
  assert.equal(GEJQ.queryCompletions('jmespath', 'nosuch.', SAMPLE_USERS_RESPONSE), null);
  // Without JSON, Tier-1 still works.
  assert.ok(GEJQ.queryCompletions('jmespath', 'sor').items.length >= 2);
});

test('property completions resolve after filter brackets and jq pipes', () => {
  // JMESPath: member access after a filter predicate (which the strict
  // parser rejects) still completes by sampling the filtered array's items.
  const afterFilter = GEJQ.queryCompletions('jmespath', "value[?jobTitle == 'Auditor'].disp", SAMPLE_USERS_RESPONSE);
  assert.ok(afterFilter && afterFilter.items.map((i) => i.label).includes('displayName'), 'jmespath filter-member');
  const afterFilterBacktick = GEJQ.queryCompletions('jmespath', 'value[?jobTitle == `x`].m', SAMPLE_USERS_RESPONSE);
  assert.ok(afterFilterBacktick && afterFilterBacktick.items.map((i) => i.label).includes('mail'), 'jmespath backtick filter-member');
  // jq: member access after a pipe completes against the piped stage.
  const afterPipe = GEJQ.queryCompletions('jq', '.value[] | .disp', SAMPLE_USERS_RESPONSE);
  assert.ok(afterPipe && afterPipe.items.map((i) => i.label).includes('displayName'), 'jq pipe-member');
  // JSONPath: member access after a filter predicate.
  const jsonFilter = GEJQ.queryCompletions('jsonpath', "$.value[?(@.jobTitle == 'Auditor')].disp", SAMPLE_USERS_RESPONSE);
  assert.ok(jsonFilter && jsonFilter.items.map((i) => i.label).includes('displayName'), 'jsonpath filter-member');
});

test('queryCompletions matches identifier fragments per language', () => {
  const jmes = GEJQ.queryCompletions('jmespath', 'sort_by(value, &displayName) | so');
  assert.ok(jmes.items.map((i) => i.label).includes('sort('));
  assert.ok(jmes.items.map((i) => i.label).includes('sort_by('));
  assert.equal(jmes.fragment, 'so');
  assert.equal(jmes.replaceFrom, 'sort_by(value, &displayName) | '.length);

  const jq = GEJQ.queryCompletions('jq', '.value | uniq');
  assert.deepEqual(jq.items.map((i) => i.label), ['unique_by(', 'unique']);

  const jsonpath = GEJQ.queryCompletions('jsonpath', '$.value fil');
  assert.ok(jsonpath.items.some((i) => i.insert.startsWith('[?(')));

  assert.equal(GEJQ.queryCompletions('jmespath', 'value['), null); // no fragment
  assert.equal(GEJQ.queryCompletions('jmespath', ''), null);
  assert.equal(GEJQ.queryCompletions('jmespath', "value[?contains(displayName, 'so"), null); // inside string
  // Typed-out JMESPath 'length' still completes to 'length(' (adds the paren)…
  assert.ok(GEJQ.queryCompletions('jmespath', 'length').items.some((i) => i.label === 'length('));
  // …while an exact bare-word match (jq 'length') has nothing left to add.
  assert.equal(GEJQ.queryCompletions('jq', '.value | length'), null);
  assert.equal(GEJQ.queryCompletions('unknown', 'so'), null);
  const caseInsensitive = GEJQ.queryCompletions('jmespath', 'SORT');
  assert.ok(caseInsensitive && caseInsensitive.items.length >= 2);
});

test('every JMESPath completion is a real jmespath.js function', () => {
  const source = require('node:fs').readFileSync(__dirname + '/../vendor/jmespath.js', 'utf8');
  let count = 0;
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    const result = GEJQ.queryCompletions('jmespath', letter);
    for (const item of (result && result.items) || []) {
      const name = item.label.replace(/\($/, '');
      assert.ok(new RegExp('"?' + name + '"?: \\{').test(source), `${name} must exist in jmespath functionTable`);
      count++;
    }
  }
  assert.ok(count >= 26, `expected the full function list, saw ${count}`);
});

test('every jq completion names a builtin of the bundled jq engine, in the right form', () => {
  // The engine's own `builtins` list is the authority: a bare completion
  // must exist with arity 0, a `name(` completion with some arity ≥ 1.
  const arities = new Map();
  for (const entry of jqBuiltins) {
    const [name, arity] = entry.split('/');
    if (!arities.has(name)) arities.set(name, new Set());
    arities.get(name).add(Number(arity));
  }
  const seen = new Set();
  for (const letter of 'abcdefghijklmnopqrstuvwxyzI') {
    const result = GEJQ.queryCompletions('jq', letter);
    for (const item of (result && result.items) || []) {
      if (seen.has(item.label)) continue;
      seen.add(item.label);
      const name = item.label.replace(/\($/, '');
      assert.ok(arities.has(name), `jq completion ${item.label} is not a builtin of jq ${jqEngine.version()}`);
      if (item.insert.endsWith('(')) {
        assert.ok([...arities.get(name)].some((n) => n >= 1), `${name}( must take arguments`);
      } else {
        assert.ok(arities.get(name).has(0), `${name} must exist bare (arity 0)`);
      }
    }
  }
  assert.ok(seen.size >= 100, `expected the jq 1.8 builtin list, got ${seen.size}`);
  // Regex builtins — the reason for the WebAssembly engine — are offered.
  for (const label of ['test(', 'match(', 'capture(', 'gsub(', 'sub(', 'scan(', 'splits(']) {
    assert.ok(seen.has(label), `${label} must be completable`);
  }
});

test('the WebAssembly jq engine runs regex, dates, and multi-output queries', () => {
  assert.equal(jqEngine.version(), 'jq-1.8.2');
  // (Regex escapes are doubled twice: once for this JS literal, once for
  // the jq string literal the regex sits in — exactly as typed in jq.)
  const contosoMails = SAMPLE_USERS_RESPONSE.value.filter((u) => /@contoso\.com$/.test(u.mail || '')).length;
  assert.deepEqual(runJq('[.value[] | select((.mail // "") | test("@contoso\\\\.com$"))] | length', SAMPLE_USERS_RESPONSE), contosoMails);
  // Real jq semantics: a regex builtin on null is an error, not a silent skip.
  throwsMessage(() => runJq('.value[] | select(.mail | test("x"))', { value: [{ mail: null }] }), /cannot be matched, as it is not a string/);
  assert.deepEqual(runJq('.value[0].displayName | capture("(?<first>\\\\w+) (?<last>\\\\w+)")', SAMPLE_USERS_RESPONSE), {
    first: 'Adele',
    last: 'Vance'
  });
  assert.equal(runJq('.value[1].displayName | gsub("l"; "L")', SAMPLE_USERS_RESPONSE), 'ALex WiLber');
  assert.equal(runJq('1700000000 | todate', null), '2023-11-14T22:13:20Z');
  // A stream of several outputs comes back as an array, none as [].
  assert.deepEqual(runJq('.value[].id', SAMPLE_USERS_RESPONSE), ['1', '2', '3']);
  assert.deepEqual(runJq('empty', SAMPLE_USERS_RESPONSE), []);
  assert.equal(runJq('.missing', SAMPLE_USERS_RESPONSE), null);
  // JSON text input is accepted as-is (the evaluator caches it).
  assert.equal(runJq('.a', '{"a": 42}'), 42);
});

/** assert.throws whose pattern is matched against error.message alone. */
function throwsMessage(fn, pattern) {
  assert.throws(fn, (e) => {
    assert.match(e.message, pattern);
    return true;
  });
}

test('jq errors are reported as tidy messages', () => {
  assert.throws(() => runJq('.foo ]', {}), (e) => {
    assert.match(e.message, /^syntax error, unexpected INVALID_CHARACTER/);
    assert.ok(!/compile error/.test(e.message), e.message);
    assert.ok(e.message.includes('.foo ]'), 'keeps the source excerpt');
    return true;
  });
  throwsMessage(() => runJq('.value | nope', {}), /^nope\/0 is not defined/);
  throwsMessage(() => runJq('.a.b', { a: 'str' }), /^Cannot index string with string \("b"\)$/);
  throwsMessage(() => runJq('error("boom")', {}), /^boom$/);
  // A runtime error after some output must not leak that output into the message.
  throwsMessage(() => runJq('.[] | test("x")', ['ok', null]), /^null \(null\) cannot be matched, as it is not a string$/);
});

test('jqErrorMessage strips jq prefixes and the compile-error tally', () => {
  assert.equal(GEJQ.jqErrorMessage({ stderr: 'jq: error (at /dev/stdin:0): boom' }), 'boom');
  assert.equal(GEJQ.jqErrorMessage({ stderr: 'jq: error (at <stdin>:12): Cannot iterate over null' }), 'Cannot iterate over null');
  assert.equal(
    GEJQ.jqErrorMessage({ stderr: 'jq: error: syntax error, unexpected end of file at <top-level>, line 1:\n    .a |\n       ^\njq: 1 compile error\n' }),
    'syntax error, unexpected end of file at <top-level>, line 1:\n    .a |\n       ^'
  );
  assert.equal(GEJQ.jqErrorMessage({ stderr: '', message: 'jq: error: module not found: x\n\njq: 1 compile error' }), 'module not found: x');
  assert.equal(GEJQ.jqErrorMessage(new Error('plain')), 'plain');
  assert.equal(GEJQ.jqErrorMessage({ stderr: '\n\n' }), 'evaluation failed');
});

test('createJqEngine loads lazily, enforces the input ceiling, and restarts after an abort', async () => {
  // Stub library: records instance creations and can be told to "abort"
  // (a non-JqError throw, as an Emscripten heap exhaustion produces).
  let created = 0;
  let abortNext = false;
  const lib = {
    loadJq: async () => {
      created += 1;
      return {
        version: 'jq-stub',
        json: (text, query) => {
          if (abortNext) {
            abortNext = false;
            throw new WebAssembly.RuntimeError('Aborted()');
          }
          if (query === 'bad') {
            const e = new Error('jq: error (at /dev/stdin:0): bad\n');
            e.name = 'JqError';
            e.stderr = 'jq: error (at /dev/stdin:0): bad';
            e.exitCode = 5;
            throw e;
          }
          return query === 'many' ? [1, 2] : query === 'none' ? [] : [JSON.parse(text)];
        }
      };
    }
  };
  const engine = GEJQ.createJqEngine(lib, { inputLimit: 20 });
  assert.equal(engine.ready(), false);
  throwsMessage(() => engine.evaluate({ a: 1 }, '.'), /^jq engine is still loading$/);
  const p1 = engine.load();
  const p2 = engine.load();
  assert.equal(p1, p2, 'concurrent loads share one promise');
  await p1;
  assert.equal(created, 1);
  assert.equal(engine.ready(), true);
  assert.equal(engine.version(), 'jq-stub');
  assert.deepEqual(engine.evaluate({ a: 1 }, '.'), { a: 1 });
  assert.deepEqual(engine.evaluate({ a: 1 }, 'many'), [1, 2]);
  assert.deepEqual(engine.evaluate({ a: 1 }, 'none'), []);
  assert.equal(engine.evaluate(undefined, '.'), null, 'undefined input is jq null');
  throwsMessage(() => engine.evaluate({ a: 1 }, 'bad'), /^bad$/);
  throwsMessage(() => engine.evaluate({ a: 'x'.repeat(30) }, '.'), /handles up to 20 B per query/);
  assert.equal(created, 1, 'a jq error or a refused input does not restart the engine');
  abortNext = true;
  throwsMessage(() => engine.evaluate({ a: 1 }, '.'), /^jq ran out of memory .* the engine was restarted/);
  assert.equal(engine.ready(), false, 'the aborted instance is dropped');
  assert.equal(engine.restarts(), 1);
  await engine.load();
  assert.equal(created, 2, 'a fresh instance replaces it');
  assert.deepEqual(engine.evaluate({ a: 2 }, '.'), { a: 2 });
});

test('createJqEngine reports a missing or failing library on evaluate', async () => {
  const none = GEJQ.createJqEngine(null);
  await assert.rejects(none.load(), /not loaded in this context/);
  assert.ok(none.failed());
  throwsMessage(() => none.evaluate({}, '.'), /^jq engine failed to load: .*not loaded/);
  const failing = GEJQ.createJqEngine({ loadJq: () => Promise.reject(new Error('CompileError: wasm blocked by CSP')) });
  await assert.rejects(failing.load(), /wasm blocked/);
  throwsMessage(() => failing.evaluate({}, '.'), /^jq engine failed to load: CompileError: wasm blocked by CSP$/);
  assert.equal(GEJQ.JQ_INPUT_LIMIT, 40 * 1024 * 1024);
});

test('fetchPercent floors to whole numbers and hides itself without a count', () => {
  assert.equal(GEJQ.fetchPercent(3, 9), 33);
  assert.equal(GEJQ.fetchPercent(6, 9), 66);
  assert.equal(GEJQ.fetchPercent(9, 9), 100);
  assert.equal(GEJQ.fetchPercent(996, 1000), 99, 'never rounds up to 100 early');
  assert.equal(GEJQ.fetchPercent(0, 40892), 0);
  assert.equal(GEJQ.fetchPercent(30700, 40892), 75);
  assert.equal(GEJQ.fetchPercent(41000, 40892), 100, 'capped when the directory grew');
  assert.equal(GEJQ.fetchPercent(2, '7'), 28, 'digit strings are accepted');
  assert.equal(GEJQ.fetchPercent(5, null), null);
  assert.equal(GEJQ.fetchPercent(5, undefined), null);
  assert.equal(GEJQ.fetchPercent(5, 0), null);
  assert.equal(GEJQ.fetchPercent(5, -1), null);
  assert.equal(GEJQ.fetchPercent(5, 'many'), null);
  assert.equal(GEJQ.fetchPercent(NaN, 9), null);
  assert.equal(GEJQ.fetchPercent(-1, 9), null);
});

test('toTsv produces tab-separated rows', () => {
  assert.equal(
    GEJQ.toTsv([{ name: 'Adele', dept: 'Sales' }, { name: 'Alex' }]),
    'name\tdept\r\nAdele\tSales\r\nAlex\t'
  );
  assert.equal(GEJQ.toTsv([{ note: 'has\ttab' }]), 'note\r\n"has\ttab"');
  assert.equal(GEJQ.toTsv('nope'), null);
});

test('sortRows sorts numbers, strings, and puts missing values last', () => {
  const rows = [
    { name: 'Bea', age: 30 },
    { name: 'Al' },
    { name: 'Cyd', age: 7 }
  ];
  assert.deepEqual(GEJQ.sortRows(rows, 'age', 1).map((r) => r.name), ['Cyd', 'Bea', 'Al']);
  assert.deepEqual(GEJQ.sortRows(rows, 'age', -1).map((r) => r.name), ['Bea', 'Cyd', 'Al']);
  assert.deepEqual(GEJQ.sortRows(rows, 'name', 1).map((r) => r.name), ['Al', 'Bea', 'Cyd']);
  // Scalar rows: column null sorts the values themselves.
  assert.deepEqual(GEJQ.sortRows(['b', 'a', 'c'], null, 1), ['a', 'b', 'c']);
  // Original array untouched.
  assert.equal(rows[0].name, 'Bea');
});

test('pathQuery emits tree-click queries in all languages', () => {
  const segments = [{ type: 'key', name: 'value' }, { type: 'wildcard' }, { type: 'key', name: 'displayName' }];
  assert.equal(GEJQ.pathQuery('jmespath', segments), 'value[].displayName');
  assert.equal(GEJQ.pathQuery('jsonpath', segments), '$.value[*].displayName');
  assert.equal(GEJQ.pathQuery('jq', segments), '.value[].displayName');
  const odata = [{ type: 'key', name: '@odata.context' }];
  assert.equal(GEJQ.pathQuery('jmespath', odata), '"@odata.context"');
  assert.equal(GEJQ.pathQuery('jq', odata), '."@odata.context"');
  assert.equal(GEJQ.pathQuery('jmespath', []), null);
});

test('diffJson reports added, removed, and changed paths', () => {
  const before = { value: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }], count: 2 };
  const after = { value: [{ id: '1', name: 'A2' }, { id: '2', name: 'B' }, { id: '3', name: 'C' }], total: 3 };
  const diffs = GEJQ.diffJson(before, after, 100);
  const byPath = {};
  diffs.forEach((d) => (byPath[d.path] = d));
  assert.equal(byPath['value[0].name'].kind, 'changed');
  assert.equal(byPath['value[0].name'].after, 'A2');
  assert.equal(byPath['value[2]'].kind, 'added');
  assert.equal(byPath['count'].kind, 'removed');
  assert.equal(byPath['total'].kind, 'added');
  assert.deepEqual(GEJQ.diffJson({ a: 1 }, { a: 1 }, 10), []);
  // Bounded output.
  const big = GEJQ.diffJson({}, Object.fromEntries(Array.from({ length: 600 }, (_, i) => ['k' + i, i])), 50);
  assert.equal(big.length, 50);
});

test('property completion works inside filter expressions', () => {
  const jmes = GEJQ.queryCompletions('jmespath', 'value[?job', SAMPLE_USERS_RESPONSE);
  assert.ok(jmes && jmes.items.some((i) => i.label === 'jobTitle'), JSON.stringify(jmes));
  const jmesEmpty = GEJQ.queryCompletions('jmespath', 'value[?', SAMPLE_USERS_RESPONSE);
  assert.ok(jmesEmpty && jmesEmpty.items.some((i) => i.label === 'displayName'));
  const jsonpath = GEJQ.queryCompletions('jsonpath', '$.value[?(@.ma', SAMPLE_USERS_RESPONSE);
  assert.ok(jsonpath && jsonpath.items.some((i) => i.label === 'mail'));
  const jq = GEJQ.queryCompletions('jq', '.value | map(select(.job', SAMPLE_USERS_RESPONSE);
  assert.ok(jq && jq.items.some((i) => i.label === 'jobTitle'));
  const jqPlain = GEJQ.queryCompletions('jq', '.value | select(.ma', SAMPLE_USERS_RESPONSE);
  assert.ok(jqPlain && jqPlain.items.some((i) => i.label === 'mail'));
});

test('upsertQueryHistory keeps the favorite label across re-runs', () => {
  let history = GEJQ.upsertQueryHistory([], { query: 'a', language: 'jmespath', lastUsed: 1, context: null }, 10);
  history[0].label = 'My favorite';
  history = GEJQ.upsertQueryHistory(history, { query: 'a', language: 'jmespath', lastUsed: 2, context: null }, 10);
  assert.equal(history[0].label, 'My favorite');
});

test('sanitizeRequestHeaders drops credentials and GE telemetry', () => {
  const sanitized = GEJQ.sanitizeRequestHeaders([
    { name: 'Authorization', value: 'Bearer secret-token' },
    { name: 'Cookie', value: 'session=abc' },
    { name: 'SdkVersion', value: 'GraphExplorer/4.0' },
    { name: 'client-request-id', value: 'guid' },
    { name: 'ConsistencyLevel', value: 'eventual' },
    { name: 'x-custom', value: 'demo' },
    { name: 'Accept', value: 'application/json' }
  ]);
  assert.deepEqual(sanitized.map((h) => h.name), ['ConsistencyLevel', 'x-custom', 'Accept']);
  assert.ok(!JSON.stringify(sanitized).includes('secret-token'));
});

test('sanitizeRequestHeaders strips ms-graph-dev-mode from Prefer', () => {
  assert.deepEqual(GEJQ.sanitizeRequestHeaders([{ name: 'prefer', value: 'ms-graph-dev-mode' }]), []);
  assert.deepEqual(
    GEJQ.sanitizeRequestHeaders([{ name: 'Prefer', value: 'ms-graph-dev-mode, outlook.timezone="W. Europe Standard Time"' }]),
    [{ name: 'Prefer', value: 'outlook.timezone="W. Europe Standard Time"' }]
  );
  assert.deepEqual(GEJQ.sanitizeRequestHeaders(null), []);
  assert.deepEqual(GEJQ.sanitizeRequestHeaders([{ name: 5, value: 'x' }, null]), []);
});

test('isBackgroundGraphRequest flags Graph Explorer internals only', () => {
  const background = [
    'https://graph.microsoft.com/v1.0/me',
    'https://graph.microsoft.com/beta/me/profile',
    'https://graph.microsoft.com/v1.0/organization',
    "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?$filter=clientId eq 'x'",
    'https://graph.microsoft.com/v1.0/oauth2PermissionGrants/abc123',
    "https://graph.microsoft.com/v1.0/servicePrincipals?$filter=appId eq 'de8bc8b5-d9f9-48b1-a8ad-b748da725064'",
    'https://graph.microsoft.com/v1.0/users?$filter=id%20eq%20%27de8bc8b5-d9f9-48b1-a8ad-b748da725064%27'
  ];
  const userRun = [
    'https://graph.microsoft.com/v1.0/me?$select=displayName',
    'https://graph.microsoft.com/v1.0/me/messages',
    'https://graph.microsoft.com/v1.0/organization?$select=id',
    'https://graph.microsoft.com/v1.0/users?$top=5',
    'pasted JSON #1'
  ];
  for (const url of background) {
    assert.equal(GEJQ.isBackgroundGraphRequest(url), true, url);
  }
  for (const url of userRun) {
    assert.equal(GEJQ.isBackgroundGraphRequest(url), false, url);
  }
});

test('graphRequestMatchesEditor tolerates encoding and injected $count', () => {
  assert.equal(
    GEJQ.graphRequestMatchesEditor(
      "https://graph.microsoft.com/v1.0/users?%24filter=startswith(displayName%2C'a')&%24count=true",
      "https://graph.microsoft.com/v1.0/users?$filter=startswith(displayName,'a')"
    ),
    true
  );
  assert.equal(
    GEJQ.graphRequestMatchesEditor('https://graph.microsoft.com/v1.0/me', 'https://graph.microsoft.com/v1.0/me'),
    true
  );
  assert.equal(
    GEJQ.graphRequestMatchesEditor('https://graph.microsoft.com/v1.0/me', 'https://graph.microsoft.com/v1.0/users'),
    false
  );
  assert.equal(
    GEJQ.graphRequestMatchesEditor(
      'https://graph.microsoft.com/v1.0/users?$top=5',
      'https://graph.microsoft.com/v1.0/users?$top=10'
    ),
    false
  );
  assert.equal(GEJQ.graphRequestMatchesEditor('https://graph.microsoft.com/v1.0/me', ''), false);
  assert.equal(GEJQ.graphRequestMatchesEditor('not a url', 'https://graph.microsoft.com/v1.0/me'), false);
  // Field-side $count=true (the assist can insert it just after the
  // request was sent without it) is tolerated, like the captured side.
  assert.equal(
    GEJQ.graphRequestMatchesEditor(
      "https://graph.microsoft.com/v1.0/users?$filter=startswith(displayName,'a')",
      "https://graph.microsoft.com/v1.0/users?$count=true&$filter=startswith(displayName,'a')"
    ),
    true
  );
  // A method prefix pasted into the field doesn't break the match.
  assert.equal(
    GEJQ.graphRequestMatchesEditor(
      'https://graph.microsoft.com/v1.0/users?$top=5',
      'GET https://graph.microsoft.com/v1.0/users?$top=5'
    ),
    true
  );
  // Nested query options survive encoding (the $expand($select=…) shape).
  assert.equal(
    GEJQ.graphRequestMatchesEditor(
      'https://graph.microsoft.com/v1.0/identityGovernance/entitlementManagement/assignmentPolicies?%24select=id%2CdisplayName&%24expand=accessPackage(%24select%3Did%2CdisplayName)&%24count=true',
      'https://graph.microsoft.com/v1.0/identityGovernance/entitlementManagement/assignmentPolicies?$select=id,displayName&$expand=accessPackage($select=id,displayName)&$count=true'
    ),
    true
  );
});

test('graphRequestPathMatchesEditor matches the resource path, params aside', () => {
  const CAPTURED = 'https://graph.microsoft.com/v1.0/users?$select=id,displayName&$count=true';
  assert.equal(GEJQ.graphRequestPathMatchesEditor(CAPTURED, 'https://graph.microsoft.com/v1.0/users?$top=10'), true);
  assert.equal(GEJQ.graphRequestPathMatchesEditor(CAPTURED, 'GET https://graph.microsoft.com/v1.0/users'), true);
  assert.equal(GEJQ.graphRequestPathMatchesEditor(CAPTURED, 'https://graph.microsoft.com/v1.0/users/x'), false);
  assert.equal(GEJQ.graphRequestPathMatchesEditor(CAPTURED, 'https://graph.microsoft.com/beta/users'), false);
  assert.equal(GEJQ.graphRequestPathMatchesEditor(CAPTURED, ''), false);
  assert.equal(GEJQ.graphRequestPathMatchesEditor('not a url', 'https://graph.microsoft.com/v1.0/users'), false);
});

test('splitMethodPrefix splits a pasted method + URI, and nothing else', () => {
  assert.deepEqual(GEJQ.splitMethodPrefix('GET https://graph.microsoft.com/v1.0/me'), {
    method: 'GET',
    uri: 'https://graph.microsoft.com/v1.0/me'
  });
  assert.deepEqual(GEJQ.splitMethodPrefix('  patch   /v1.0/users/x  '), {
    method: 'PATCH',
    uri: '/v1.0/users/x'
  });
  assert.deepEqual(GEJQ.splitMethodPrefix('DELETE v1.0/users/x'), {
    method: 'DELETE',
    uri: 'v1.0/users/x'
  });
  assert.deepEqual(GEJQ.splitMethodPrefix("POST beta/users?$filter=name eq 'x'"), {
    method: 'POST',
    uri: "beta/users?$filter=name eq 'x'"
  });
  // No prefix, unknown methods, or a remainder that isn't a URI: untouched.
  assert.equal(GEJQ.splitMethodPrefix('https://graph.microsoft.com/v1.0/me'), null);
  assert.equal(GEJQ.splitMethodPrefix('HEAD https://graph.microsoft.com/v1.0/me'), null);
  assert.equal(GEJQ.splitMethodPrefix('GET some words'), null);
  assert.equal(GEJQ.splitMethodPrefix('GET '), null);
  assert.equal(GEJQ.splitMethodPrefix(''), null);
  assert.equal(GEJQ.splitMethodPrefix(null), null);
});

test('classifyBackgroundRequest combines pattern, editor, and run signals', () => {
  const ME = 'https://graph.microsoft.com/v1.0/me';
  const ORG = 'https://graph.microsoft.com/v1.0/organization';
  const USERS = 'https://graph.microsoft.com/v1.0/users?$top=5';
  // Sign-in burst: /me matches the pre-filled field but nothing was run.
  assert.equal(GEJQ.classifyBackgroundRequest(ME, ME, -1), true);
  // Deliberately running GET /me: field matches and a run just happened.
  assert.equal(GEJQ.classifyBackgroundRequest(ME, ME, 500), false);
  // Internal organization lookup while the field shows something else.
  assert.equal(GEJQ.classifyBackgroundRequest(ORG, USERS, 500), true);
  // Normal user query matching the field, even without a tracked run.
  assert.equal(GEJQ.classifyBackgroundRequest(USERS, USERS, -1), false);
  // Unknown call matching neither field nor a recent run stays hidden.
  assert.equal(GEJQ.classifyBackgroundRequest('https://graph.microsoft.com/v1.0/whatever', USERS, -1), true);
  // …but a recent run rescues unknown non-pattern URLs (field edited).
  assert.equal(GEJQ.classifyBackgroundRequest('https://graph.microsoft.com/v1.0/whatever', USERS, 500), false);
  // Same resource path with different query options stays visible even
  // without a tracked run — the user is iterating on the parameters.
  assert.equal(
    GEJQ.classifyBackgroundRequest('https://graph.microsoft.com/v1.0/users?$top=99', USERS, -1),
    false
  );
  // The path rule never rescues known-internal patterns: a plain /me
  // while the field holds /me?$select=… still needs a recent run.
  assert.equal(GEJQ.classifyBackgroundRequest(ME, ME + '?$select=id', -1), true);
});

test('clampInt clamps numbers and numeric strings, falls back otherwise', () => {
  assert.equal(GEJQ.clampInt(5, 1, 10, 3), 5);
  assert.equal(GEJQ.clampInt(99, 1, 10, 3), 10);
  assert.equal(GEJQ.clampInt(0, 1, 10, 3), 1); // below-min clamps up instead of falling back
  assert.equal(GEJQ.clampInt(7.9, 1, 10, 3), 7);
  assert.equal(GEJQ.clampInt('42', 1, 100, 3), 42);
  assert.equal(GEJQ.clampInt('nope', 1, 10, 3), 3);
  assert.equal(GEJQ.clampInt(undefined, 1, 10, 3), 3);
  assert.equal(GEJQ.clampInt(NaN, 1, 10, 3), 3);
});

test('csvEligible agrees with toCsv across shapes', () => {
  const shapes = [
    [{ a: 1 }, { b: 2 }],
    [{}],
    [{}, { a: 1 }],
    ['a', 'b'],
    [1, null, true],
    [],
    [{ a: 1 }, 'mixed'],
    [[1, 2]],
    { a: 1 },
    'scalar',
    null,
    42
  ];
  for (const shape of shapes) {
    assert.equal(
      GEJQ.csvEligible(shape),
      GEJQ.toCsv(shape) !== null,
      'csvEligible must match toCsv for ' + JSON.stringify(shape)
    );
  }
});

test('exportFilename derives a name from the request path plus timestamp', () => {
  const now = new Date(2026, 7, 8, 9, 30, 5).getTime();
  assert.equal(
    GEJQ.exportFilename('https://graph.microsoft.com/v1.0/me/messages?$top=5', 'json', now),
    'graph-me-messages-2026-08-08-093005.json'
  );
  assert.equal(
    GEJQ.exportFilename('https://graph.microsoft.com/beta/users', 'csv', now),
    'graph-users-2026-08-08-093005.csv'
  );
  assert.equal(GEJQ.exportFilename('pasted JSON #1', 'json', now), 'graph-query-2026-08-08-093005.json');
  assert.equal(GEJQ.exportFilename('', 'json', now), 'graph-query-2026-08-08-093005.json');
});

test('toCsv converts arrays of objects with union of columns', () => {
  const csv = GEJQ.toCsv([
    { name: 'Adele', mail: 'a@x.com' },
    { name: 'Alex', dept: 'Sales' }
  ]);
  assert.equal(csv, 'name,mail,dept\r\nAdele,a@x.com,\r\nAlex,,Sales');
});

test('toCsv escapes quotes, commas and newlines', () => {
  const csv = GEJQ.toCsv([{ note: 'has "quote", and comma', plain: 'x\ny' }]);
  assert.equal(csv, 'note,plain\r\n"has ""quote"", and comma","x\ny"');
});

test('toCsv handles arrays of scalars and rejects mixed/unsupported shapes', () => {
  assert.equal(GEJQ.toCsv(['a', 'b']), 'value\r\na\r\nb');
  assert.equal(GEJQ.toCsv([1, null, true]), 'value\r\n1\r\n\r\ntrue');
  assert.equal(GEJQ.toCsv([]), null);
  assert.equal(GEJQ.toCsv({ a: 1 }), null);
  assert.equal(GEJQ.toCsv('nope'), null);
  assert.equal(GEJQ.toCsv([{ a: 1 }, 'mixed']), null);
});

test('toCsv JSON-encodes nested values into cells', () => {
  const csv = GEJQ.toCsv([{ name: 'A', tags: ['x', 'y'] }]);
  assert.equal(csv, 'name,tags\r\nA,"[""x"",""y""]"');
});

test('toCsv/toTsv neutralize spreadsheet formula injection (CWE-1236)', () => {
  // Textual cells starting with a formula trigger get a guarding apostrophe
  // so Excel/Sheets/LibreOffice do not evaluate attacker-controlled Graph
  // field values (displayName, mail subject, file name, …) as formulas.
  assert.equal(GEJQ.toCsv([{ n: '=IMPORTXML("//evil","x")' }]), 'n\r\n"\'=IMPORTXML(""//evil"",""x"")"');
  assert.equal(GEJQ.toCsv([{ n: '=1+1' }]), "n\r\n'=1+1");
  assert.equal(GEJQ.toCsv([{ n: '+1' }]), "n\r\n'+1");
  assert.equal(GEJQ.toCsv([{ n: '-1' }]), "n\r\n'-1");
  assert.equal(GEJQ.toCsv([{ n: '@foo' }]), "n\r\n'@foo");
  // Guard applies before quoting when the value also needs quoting.
  assert.equal(GEJQ.toCsv([{ n: '=cmd,evil' }]), 'n\r\n"\'=cmd,evil"');
  // Contains a quote, so it is also RFC-quoted (guard applied first).
  assert.equal(GEJQ.toTsv([{ n: '=WEBSERVICE("//x")' }]), 'n\r\n"\'=WEBSERVICE(""//x"")"');
  assert.equal(GEJQ.toTsv([{ n: '=SUM(A1:A2)' }]), "n\r\n'=SUM(A1:A2)");
  // A leading tab (which some parsers strip to reach a formula) is guarded;
  // a tab needs no CSV quoting, but does need TSV quoting (it is the delimiter).
  assert.equal(GEJQ.toCsv([{ n: '\t=1' }]), "n\r\n'\t=1");
  assert.equal(GEJQ.toTsv([{ n: '\t=1' }]), 'n\r\n"\'\t=1"');
  // Scalar arrays get the same treatment.
  assert.equal(GEJQ.toCsv(['=danger', 'safe']), "value\r\n'=danger\r\nsafe");
  // Ordinary text is untouched, and real numbers (incl. negatives) stay
  // numeric — only string values that look like formulas are guarded.
  assert.equal(GEJQ.toCsv([{ n: 'Adele' }]), 'n\r\nAdele');
  assert.equal(GEJQ.toCsv([{ n: 5 }, { n: -3 }]), 'n\r\n5\r\n-3');
  assert.equal(GEJQ.toCsv([{ n: '-3' }]), "n\r\n'-3");
});

test('vendored jmespath supports the documented example queries', () => {
  assert.deepEqual(
    jmespath.search(SAMPLE_USERS_RESPONSE, 'value[].displayName'),
    ['Adele Vance', 'Alex Wilber', 'Megan Bowen']
  );
  assert.deepEqual(
    jmespath.search(SAMPLE_USERS_RESPONSE, "value[?contains(displayName, 'Vance')].mail"),
    ['adele@contoso.com']
  );
  assert.deepEqual(
    jmespath.search(SAMPLE_USERS_RESPONSE, 'value[].{name: displayName, email: mail}')[0],
    { name: 'Adele Vance', email: 'adele@contoso.com' }
  );
  assert.equal(jmespath.search(SAMPLE_USERS_RESPONSE, 'length(value)'), 3);
  assert.deepEqual(
    jmespath.search(SAMPLE_USERS_RESPONSE, 'sort_by(value, &displayName)[0].displayName'),
    'Adele Vance'
  );
  assert.equal(
    jmespath.search(SAMPLE_USERS_RESPONSE, '"@odata.nextLink"'),
    'https://graph.microsoft.com/v1.0/users?$skiptoken=abc'
  );
});

// --------------------------------------------------------- nextQueryToken

/** Tokenize a whole query; returns [text, type] pairs, whitespace skipped. */
function tokenize(language, text) {
  const out = [];
  let pos = 0;
  while (pos < text.length) {
    const { end, type } = GEJQ.nextQueryToken(language, text, pos);
    assert.ok(end > pos, `tokenizer must advance at ${pos} in ${JSON.stringify(text)}`);
    if (type !== null || text.slice(pos, end).trim() !== '') {
      out.push([text.slice(pos, end), type]);
    }
    pos = end;
  }
  return out;
}

test('nextQueryToken classifies strings, numbers, and brackets', () => {
  assert.deepEqual(tokenize('jmespath', "value[?age >= 21].name | [0:5]"), [
    ['value', 'propertyName'],
    ['[', 'bracket'],
    ['?', 'operator'],
    ['age', 'propertyName'],
    ['>', 'operator'],
    ['=', 'operator'],
    ['21', 'number'],
    [']', 'bracket'],
    ['.', 'operator'],
    ['name', 'propertyName'],
    ['|', 'operator'],
    ['[', 'bracket'],
    ['0', 'number'],
    [':', 'operator'],
    ['5', 'number'],
    [']', 'bracket']
  ]);
  assert.deepEqual(tokenize('jmespath', "'it''s'")[0], ["'it'", 'string']);
  assert.deepEqual(tokenize('jmespath', '`{"a": 1}`'), [['`{"a": 1}`', 'string']]);
  // Unterminated strings extend to the end without looping forever.
  assert.deepEqual(tokenize('jq', '"unterminated \\'), [['"unterminated \\', 'string']]);
  assert.deepEqual(tokenize('jq', '3.14'), [['3.14', 'number']]);
});

test('nextQueryToken marks functions as keywords only where they are calls', () => {
  // JMESPath: function name followed by ( → keyword; bare name → property.
  assert.deepEqual(tokenize('jmespath', 'length(value)')[0], ['length', 'keyword']);
  assert.deepEqual(tokenize('jmespath', 'value[].length')[4], ['length', 'propertyName']);
  // jq builtins are keywords even bare, but not as .property access.
  assert.deepEqual(tokenize('jq', '.value | keys')[3], ['keys', 'keyword']);
  assert.deepEqual(tokenize('jq', '.keys')[1], ['keys', 'propertyName']);
  assert.deepEqual(tokenize('jq', 'if .a then .b else .c end').filter(([, t]) => t === 'keyword').map(([w]) => w), [
    'if',
    'then',
    'else',
    'end'
  ]);
});

test('nextQueryToken marks @/$ references as variables', () => {
  assert.deepEqual(tokenize('jsonpath', "$.value[?(@property === 'x')]").filter(([, t]) => t === 'variableName'), [
    ['$', 'variableName'],
    ['@property', 'variableName']
  ]);
  assert.deepEqual(tokenize('jq', '. as $x | $x')[2], ['$x', 'variableName']);
  assert.deepEqual(tokenize('jmespath', 'value[?contains(@, `1`)]')[5], ['@', 'variableName']);
});

// --------------------------------------------------------- new helpers

test('clampInt clamps below-min values instead of ignoring them', () => {
  assert.equal(GEJQ.clampInt(0, 1, 1000, 50), 1);
  assert.equal(GEJQ.clampInt('-3', 1, 1000, 50), 1);
  assert.equal(GEJQ.clampInt(2000, 1, 1000, 50), 1000);
  assert.equal(GEJQ.clampInt('7', 1, 1000, 50), 7);
  assert.equal(GEJQ.clampInt('abc', 1, 1000, 50), 50);
  assert.equal(GEJQ.clampInt(undefined, 1, 1000, 50), 50);
});

test('stringifyLimited matches JSON.stringify when under the limit', () => {
  const samples = [
    { a: [1, 'two', null, { b: {}, c: [], d: false }], e: 'x"y\n\\z', f: -1.5 },
    [],
    {},
    [[{ deep: [true, null] }]],
    'plain string',
    42,
    null
  ];
  for (const sample of samples) {
    const expected = JSON.stringify(sample, null, 2);
    const limited = GEJQ.stringifyLimited(sample, 1000000);
    assert.equal(limited.text, expected);
    assert.equal(limited.truncated, false);
    assert.equal(limited.length, expected.length);
  }
});

test('stringifyLimited caps the text but reports the exact full size', () => {
  const big = { value: Array.from({ length: 1000 }, (unused, i) => ({ id: i, name: 'user ' + i })) };
  const full = JSON.stringify(big, null, 2);
  const limited = GEJQ.stringifyLimited(big, 500);
  assert.equal(limited.truncated, true);
  assert.ok(limited.text.length <= 550, String(limited.text.length));
  // Counting continues past the text budget: the size is exact, not a
  // lower bound stuck at the render cap.
  assert.equal(limited.length, full.length);
  // The emitted prefix is byte-identical to the full serialization.
  assert.ok(full.startsWith(limited.text));
});

test('trimResponses caps manual and live entries separately', () => {
  const list = [
    { id: 'r1' },
    { id: 'm1', manual: true },
    { id: 'r2' },
    { id: 'r3' },
    { id: 'm2', manual: true },
    { id: 'r4' }
  ];
  assert.deepEqual(GEJQ.trimResponses(list, 2).map((entry) => entry.id), ['r1', 'm1', 'r2', 'm2']);
  assert.deepEqual(GEJQ.trimResponses(list, 10).map((entry) => entry.id), ['r1', 'm1', 'r2', 'r3', 'm2', 'r4']);
  assert.deepEqual(GEJQ.trimResponses(null, 3), []);
});

test('normalizeSettings fills defaults and validates stored values', () => {
  assert.deepEqual(GEJQ.normalizeSettings(null), Object.assign({}, GEJQ.DEFAULT_SETTINGS));
  const normalized = GEJQ.normalizeSettings({
    advancedQuery: false,
    queryLanguage: 'klingon',
    autoFetchMaxPages: 99999,
    historyLimit: 12.7
  });
  assert.equal(normalized.advancedQuery, false);
  assert.equal(normalized.queryLanguage, 'jmespath');
  assert.equal(normalized.autoFetchMaxPages, 1000);
  assert.equal(normalized.historyLimit, 12);
  assert.equal(normalized.autoSignIn, true);
});

// ------------------------------------------- Graph (OData) equivalents

test('toGraphQuery translates JMESPath filters, selects, and sorts', () => {
  const full = GEJQ.toGraphQuery('jmespath', "value[?jobTitle == 'Auditor'].{name: displayName, email: mail}");
  assert.equal(full.ok, true);
  assert.equal(full.params.filter, "jobTitle eq 'Auditor'");
  assert.deepEqual(full.params.select, ['displayName', 'mail']);
  assert.equal(full.residual, 'value[].{name: displayName, email: mail}');
  assert.equal(full.advanced, true);
  assert.deepEqual(full.notes, []);

  const sorted = GEJQ.toGraphQuery('jmespath', 'sort_by(value, &displayName)[].displayName');
  assert.equal(sorted.params.orderby, 'displayName');
  assert.deepEqual(sorted.params.select, ['displayName']);
  assert.equal(sorted.residual, 'value[].displayName');

  const desc = GEJQ.toGraphQuery('jmespath', 'reverse(sort_by(value, &displayName))');
  assert.equal(desc.params.orderby, 'displayName desc');

  const fn = GEJQ.toGraphQuery('jmespath', "value[?starts_with(displayName, 'A')]");
  assert.equal(fn.params.filter, "startswith(displayName,'A')");
  assert.equal(fn.residual, 'value[]');
});

test('toGraphQuery translates counts to $count / @odata.count', () => {
  const count = GEJQ.toGraphQuery('jmespath', 'length(value)');
  assert.equal(count.params.count, true);
  assert.equal(count.residual, '"@odata.count"');

  const filtered = GEJQ.toGraphQuery('jmespath', "length(value[?jobTitle == 'Auditor'])");
  assert.equal(filtered.params.count, true);
  assert.equal(filtered.params.filter, "jobTitle eq 'Auditor'");

  const jq = GEJQ.toGraphQuery('jq', '.value | length');
  assert.equal(jq.params.count, true);
  assert.equal(jq.residual, '."@odata.count"');

  const jsonpath = GEJQ.toGraphQuery('jsonpath', '$.value.length');
  assert.equal(jsonpath.params.count, true);
  assert.equal(jsonpath.residual, "$['@odata.count']");
});

test('toGraphQuery translates slices and indexes to $top/$skip', () => {
  const top = GEJQ.toGraphQuery('jmespath', 'value[0:5]');
  assert.equal(top.params.top, 5);
  assert.equal(top.params.skip, null);

  const window = GEJQ.toGraphQuery('jq', '.value[2:8]');
  assert.equal(window.params.top, 6);
  assert.equal(window.params.skip, 2);
  assert.equal(window.residual, '.value');

  const index = GEJQ.toGraphQuery('jmespath', 'value[2].displayName');
  assert.equal(index.params.top, 1);
  assert.equal(index.params.skip, 2);
  assert.equal(index.residual, 'value[0].displayName');
  assert.deepEqual(index.params.select, ['displayName']);
});

test('toGraphQuery translates jq pipelines stage by stage', () => {
  const filtered = GEJQ.toGraphQuery('jq', '.value | map(select(.jobTitle == "Auditor")) | .[].displayName');
  assert.equal(filtered.ok, true);
  assert.equal(filtered.params.filter, "jobTitle eq 'Auditor'");
  assert.deepEqual(filtered.params.select, ['displayName']);
  assert.equal(filtered.residual, '.value | .[].displayName');

  const wrapped = GEJQ.toGraphQuery('jq', '[.value[] | {name: .displayName, email: .mail}]');
  assert.deepEqual(wrapped.params.select, ['displayName', 'mail']);
  assert.equal(wrapped.residual, '[.value[] | {name: .displayName, email: .mail}]');

  const existsFilter = GEJQ.toGraphQuery('jq', '.value[] | select(.mail != null) | .mail');
  assert.equal(existsFilter.params.filter, 'mail ne null');
  assert.equal(existsFilter.residual, '.value[] | .mail');

  const sortedDesc = GEJQ.toGraphQuery('jq', '.value | sort_by(.displayName) | reverse');
  assert.equal(sortedDesc.params.orderby, 'displayName desc');
  assert.equal(sortedDesc.residual, '.value');
});

test('toGraphQuery translates JSONPath filters and selections', () => {
  const filtered = GEJQ.toGraphQuery('jsonpath', "$.value[?(@.jobTitle == 'Auditor')].displayName");
  assert.equal(filtered.params.filter, "jobTitle eq 'Auditor'");
  assert.deepEqual(filtered.params.select, ['displayName']);
  assert.equal(filtered.residual, '$.value[*].displayName');

  const exists = GEJQ.toGraphQuery('jsonpath', '$.value[?(@.mail)]');
  assert.equal(exists.params.filter, 'mail ne null');

  const sliced = GEJQ.toGraphQuery('jsonpath', '$.value[0:5].mail');
  assert.equal(sliced.params.top, 5);
  assert.deepEqual(sliced.params.select, ['mail']);
});

test('toGraphQuery keeps untranslatable parts client-side with notes', () => {
  const partial = GEJQ.toGraphQuery('jq', '.value | map(select(.a == 1)) | map(select(.b | test("x")))');
  assert.equal(partial.ok, true);
  assert.equal(partial.params.filter, 'a eq 1');
  assert.equal(partial.residual, '.value | map(select(.b | test("x")))');
  assert.equal(partial.notes.length, 1);
  assert.ok(partial.notes[0].includes('test("x")'), partial.notes[0]);
  // A client-side filter needs full objects — no $select may be emitted.
  assert.deepEqual(partial.params.select, []);

  const nested = GEJQ.toGraphQuery('jmespath', "value[?contains(assignedLicenses[].skuId, 'x')].displayName");
  assert.equal(nested.ok, false); // nothing translatable at all
});

test('toGraphQuery escapes and types OData literals', () => {
  const quote = GEJQ.toGraphQuery('jmespath', "value[?displayName == 'O'Brien']");
  // JMESPath raw-string quoting aside, verify doubled quotes via jq:
  const jqQuote = GEJQ.toGraphQuery('jq', '.value | map(select(.displayName == "O\'Brien"))');
  assert.equal(jqQuote.params.filter, "displayName eq 'O''Brien'");
  const num = GEJQ.toGraphQuery('jmespath', 'value[?age > `30`]');
  assert.equal(num.params.filter, 'age gt 30');
  const bool = GEJQ.toGraphQuery('jq', '.value | map(select(.accountEnabled == true))');
  assert.equal(bool.params.filter, 'accountEnabled eq true');
  void quote;
});

test('toGraphQuery rejects queries with no server-side part', () => {
  assert.equal(GEJQ.toGraphQuery('jmespath', 'value[]').ok, false);
  assert.equal(GEJQ.toGraphQuery('jmespath', 'keys(@)').ok, false);
  assert.equal(GEJQ.toGraphQuery('jsonpath', '$..displayName').ok, false);
  assert.equal(GEJQ.toGraphQuery('jq', '.value[] | .displayName | ascii_downcase').ok, false);
  assert.equal(GEJQ.toGraphQuery('jmespath', '').ok, false);
  assert.equal(GEJQ.toGraphQuery('jmespath', '"@odata.nextLink"').ok, false);
});

test('graphQueryUrl merges params into the source request URL', () => {
  const merged = GEJQ.graphQueryUrl('https://graph.microsoft.com/v1.0/users?$top=10&$filter=accountEnabled eq true', {
    filter: "jobTitle eq 'Auditor'",
    select: ['displayName'],
    orderby: null,
    top: 5,
    skip: null,
    count: false
  });
  assert.equal(
    merged.url,
    "https://graph.microsoft.com/v1.0/users?$filter=(accountEnabled eq true) and (jobTitle eq 'Auditor')&$select=displayName&$top=5"
  );
  assert.equal(merged.notes.length, 2);

  const plain = GEJQ.graphQueryUrl('https://graph.microsoft.com/v1.0/users', {
    filter: null,
    select: ['id'],
    orderby: 'displayName',
    top: null,
    skip: null,
    count: true
  });
  assert.equal(plain.url, 'https://graph.microsoft.com/v1.0/users?$select=id&$orderby=displayName&$count=true');

  assert.equal(GEJQ.graphQueryUrl('pasted JSON #1', { filter: null, select: [], orderby: null, top: null, skip: null, count: false }), null);
});

test('stringifyLimited bails out at the counting ceiling instead of hanging', () => {
  // Shared references blow serialized size up combinatorially (2^30 × 1 KB
  // here) — the walk must stop at the ceiling, not run to completion.
  let node = { leaf: 'x'.repeat(1024) };
  for (let i = 0; i < 30; i++) {
    node = { a: node, b: node };
  }
  const limited = GEJQ.stringifyLimited(node, 1000, 100000);
  assert.equal(limited.truncated, true);
  assert.equal(limited.overflow, true);
  assert.ok(limited.length > 100000);
  assert.ok(limited.text.length <= 1100, String(limited.text.length));
  // Without a ceiling the same walk reports exact sizes and no overflow.
  const exact = GEJQ.stringifyLimited({ a: [1, 2, 3] }, 10, 100000);
  assert.equal(exact.overflow, false);
  assert.equal(exact.length, JSON.stringify({ a: [1, 2, 3] }, null, 2).length);
});

test('csvPreview builds sorted display cells with a row cap', () => {
  const rows = [
    { name: 'Bravo', n: 2 },
    { name: 'Alpha', n: 3, extra: true },
    { name: 'Charlie', n: 1 }
  ];
  const plain = GEJQ.csvPreview(rows, null, 10);
  assert.equal(plain.eligible, true);
  assert.equal(plain.shape, 'objects');
  assert.deepEqual(plain.columns, ['name', 'n', 'extra']);
  assert.equal(plain.total, 3);
  assert.deepEqual(plain.rows[0], ['Bravo', '2', '']);

  const sorted = GEJQ.csvPreview(rows, { column: 'n', dir: 1 }, 2);
  assert.deepEqual(sorted.rows.map((r) => r[0]), ['Charlie', 'Bravo']);
  assert.equal(sorted.total, 3); // cap applies to cells, not the count

  const scalars = GEJQ.csvPreview(['b', 'a'], { column: 'value', dir: 1 }, 10);
  assert.equal(scalars.shape, 'scalars');
  assert.deepEqual(scalars.columns, ['value']);
  assert.deepEqual(scalars.rows, [['a'], ['b']]);

  assert.deepEqual(GEJQ.csvPreview({ not: 'an array' }, null, 10), { eligible: false });
});

test('csvCellText encodes objects and caps long cells', () => {
  assert.equal(GEJQ.csvCellText(null), '');
  assert.equal(GEJQ.csvCellText({ a: 1 }), '{"a":1}');
  assert.equal(GEJQ.csvCellText('x'.repeat(300)).length, 201);
});

test('sampleJson prunes arrays, keys, depth, and long strings', () => {
  const big = {
    '@odata.context': 'ctx',
    value: Array.from({ length: 100 }, (unused, i) => ({
      id: i,
      displayName: 'User ' + i,
      note: 'y'.repeat(500),
      nested: { a: { b: { c: { d: { e: 1 } } } } }
    }))
  };
  const sample = GEJQ.sampleJson(big);
  assert.equal(sample.value.length, 5); // arrays capped
  assert.ok(Object.keys(sample.value[0]).includes('displayName')); // keys survive
  assert.ok(sample.value[0].note.length <= 121); // long strings truncated
  assert.deepEqual(sample.value[0].nested.a, {}); // depth capped
  assert.equal(sample['@odata.context'], 'ctx');
  assert.equal(GEJQ.sampleJson(42), 42);
  assert.equal(GEJQ.sampleJson(null), null);
});

test('normalizeSettings covers the auto-evaluate toggle', () => {
  assert.equal(GEJQ.normalizeSettings(null).autoEvaluate, true);
  assert.equal(GEJQ.normalizeSettings({ autoEvaluate: false }).autoEvaluate, false);
  assert.equal(GEJQ.normalizeSettings({ autoEvaluate: 'yes' }).autoEvaluate, true);
});

test('property completions work inside filter function calls', () => {
  const json = { value: [{ displayName: 'Adele', mail: 'a@x', jobTitle: 'Auditor' }] };
  const empty = GEJQ.queryCompletions('jmespath', 'value[?contains(', json);
  assert.ok(empty && empty.items.some((i) => i.label === 'displayName'), JSON.stringify(empty));
  const frag = GEJQ.queryCompletions('jmespath', 'value[?contains(dis', json);
  assert.ok(frag.items.some((i) => i.label === 'displayName'));
  assert.equal(frag.replaceFrom, 'value[?contains('.length);
  const nested = GEJQ.queryCompletions('jmespath', 'value[?starts_with(to_string(job', json);
  assert.ok(nested.items.some((i) => i.label === 'jobTitle'));
  // Bare filter fields keep completing as before.
  const bare = GEJQ.queryCompletions('jmespath', 'value[?dis', json);
  assert.ok(bare.items.some((i) => i.label === 'displayName'));
  // Inside a string literal, nothing pops.
  assert.equal(GEJQ.queryCompletions('jmespath', "value[?contains(displayName, 'Ad", json), null);
});

test('knownFilterTags drops filter tags no longer present in the history', () => {
  const list = [
    { query: 'a', language: 'jq', tags: ['users', 'counts'] },
    { query: 'b', language: 'jq', tags: [] }
  ];
  assert.deepEqual(GEJQ.knownFilterTags(['counts', 'gone', 'users'], list), ['counts', 'users']);
  // The last entry carrying a tag loses it → the filter must not keep it.
  assert.deepEqual(GEJQ.knownFilterTags(['counts'], [{ query: 'a', language: 'jq', tags: [] }]), []);
  assert.deepEqual(GEJQ.knownFilterTags(['counts'], []), []);
  assert.deepEqual(GEJQ.knownFilterTags(undefined, list), []);
  // Entries with no tags array at all are tolerated.
  assert.deepEqual(GEJQ.knownFilterTags(['x'], [{ query: 'a', language: 'jq' }]), []);
});

test('sanitizeRequestHeaders strips Graph Explorer cache-busting directives', () => {
  // GE sends these on every request; restoring them into the headers view
  // is noise, so the header goes away when nothing else remains.
  assert.deepEqual(
    GEJQ.sanitizeRequestHeaders([
      { name: 'Pragma', value: 'no-cache' },
      { name: 'cache-control', value: 'no-cache' },
      { name: 'x-demo', value: 'yes' }
    ]),
    [{ name: 'x-demo', value: 'yes' }]
  );
  // Case-insensitive on both the name and the directive.
  assert.deepEqual(GEJQ.sanitizeRequestHeaders([{ name: 'PRAGMA', value: 'No-Cache' }]), []);
  assert.deepEqual(GEJQ.sanitizeRequestHeaders([{ name: 'Cache-Control', value: 'NO-STORE' }]), []);
  // A value the user typed themselves survives untouched…
  assert.deepEqual(
    GEJQ.sanitizeRequestHeaders([{ name: 'Cache-Control', value: 'max-age=0' }]),
    [{ name: 'Cache-Control', value: 'max-age=0' }]
  );
  // …and only GE's directive is removed from a mixed value.
  assert.deepEqual(
    GEJQ.sanitizeRequestHeaders([{ name: 'Cache-Control', value: 'no-cache, max-age=30' }]),
    [{ name: 'Cache-Control', value: 'max-age=30' }]
  );
});

test('sanitizeRequestHeaders keeps commas inside quoted header values', () => {
  assert.deepEqual(
    GEJQ.sanitizeRequestHeaders([
      { name: 'Prefer', value: 'ms-graph-dev-mode, outlook.body-content-type="text/html, plain"' }
    ]),
    [{ name: 'Prefer', value: 'outlook.body-content-type="text/html, plain"' }]
  );
});

test('sanitizeRequestHeaders is idempotent and caps output at 20 pairs', () => {
  const once = GEJQ.sanitizeRequestHeaders([
    { name: 'Prefer', value: 'ms-graph-dev-mode, odata.maxpagesize=10' },
    { name: 'Cache-Control', value: 'no-cache, max-age=5' },
    { name: 'x-keep', value: '1' }
  ]);
  assert.deepEqual(GEJQ.sanitizeRequestHeaders(once), once);

  // Dropped headers must not consume cap budget: Authorization plus 21
  // real headers still yields the 20 cap, all of them real.
  const many = [{ name: 'Authorization', value: 'Bearer x' }];
  for (let i = 0; i < 21; i++) {
    many.push({ name: 'x-h' + i, value: String(i) });
  }
  const capped = GEJQ.sanitizeRequestHeaders(many);
  assert.equal(capped.length, 20);
  assert.equal(capped[0].name, 'x-h0');
});

test('sanitizeQueryHistory cleans stored headers saved by older versions', () => {
  const legacy = [
    {
      query: '.value',
      language: 'jq',
      context: { method: 'GET', url: 'https://graph.microsoft.com/v1.0/users', headers: [
        { name: 'cache-control', value: 'no-cache' },
        { name: 'Pragma', value: 'no-cache' },
        { name: 'x-keep', value: '1' }
      ], body: '' }
    }
  ];
  const result = GEJQ.sanitizeQueryHistory(legacy);
  assert.equal(result.changed, true);
  assert.deepEqual(result.list[0].context.headers, [{ name: 'x-keep', value: '1' }]);
  // Other fields survive and the input is never mutated.
  assert.equal(result.list[0].context.url, 'https://graph.microsoft.com/v1.0/users');
  assert.equal(result.list[0].query, '.value');
  assert.equal(legacy[0].context.headers.length, 3);

  // Already-clean input is reported unchanged, so nothing is re-persisted.
  assert.equal(GEJQ.sanitizeQueryHistory(result.list).changed, false);

  // Malformed shapes are tolerated (old data, hand-edited storage).
  assert.equal(GEJQ.sanitizeQueryHistory(null).changed, false);
  assert.deepEqual(GEJQ.sanitizeQueryHistory([null, { query: 'a' }, { query: 'b', context: null }]).list.length, 3);
  assert.deepEqual(
    GEJQ.sanitizeQueryHistory([{ query: 'c', context: { headers: 'nope' } }]).list[0].context.headers,
    []
  );
});
