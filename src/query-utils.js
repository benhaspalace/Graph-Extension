/**
 * Graph Explorer JSON Query — pure helper functions.
 *
 * UMD-style so the same file is loaded as a content script (attaches to
 * the global as `GEJQ`) and required from Node for unit tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GEJQ = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

  /** Clamp to an integer in [min, max]; `fallback` when not a number at all. */
  function clampInt(value, min, max, fallback) {
    var parsed = typeof value === 'string' ? parseInt(value, 10) : value;
    if (typeof parsed === 'number' && isFinite(parsed)) {
      return Math.min(Math.max(Math.floor(parsed), min), max);
    }
    return fallback;
  }

  /** Quote a JSON key so it is a valid JMESPath identifier. */
  function jmesKey(key) {
    if (PLAIN_IDENTIFIER.test(key)) {
      return key;
    }
    return '"' + String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  function safeJsonParse(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  /** Human description of a query result, e.g. "array · 25 items". */
  function describeResult(value) {
    if (value === null) {
      return 'null';
    }
    if (Array.isArray(value)) {
      return 'array · ' + value.length + (value.length === 1 ? ' item' : ' items');
    }
    switch (typeof value) {
      case 'object':
        var n = Object.keys(value).length;
        return 'object · ' + n + (n === 1 ? ' key' : ' keys');
      case 'string':
        return 'string · ' + value.length + (value.length === 1 ? ' char' : ' chars');
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'undefined':
        return 'no result';
      default:
        return typeof value;
    }
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) {
      return '';
    }
    if (bytes < 1024) {
      return bytes + ' B';
    }
    var units = ['KB', 'MB', 'GB'];
    var value = bytes;
    var unit = '';
    for (var i = 0; i < units.length; i++) {
      value = value / 1024;
      unit = units[i];
      if (value < 1024) {
        break;
      }
    }
    return (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10) + ' ' + unit;
  }

  /**
   * JSON.stringify(value, null, 2) with a character budget for the TEXT:
   * once `maxChars` is exceeded the string stops being built (so a huge
   * query result never materializes as one multi-megabyte string — that
   * froze the tab), but the walk continues counting, so `length` is
   * the exact size of the full serialization. `maxCount` is a sanity
   * ceiling on the counting itself: query results can reference the same
   * subtree many times, blowing serialized size up combinatorially, and
   * the walk must bail out (`overflow: true`, `length` = lower bound)
   * rather than hang. The emitted prefix is byte-identical to what
   * JSON.stringify would produce. Only operates on JSON-shaped data
   * (anything parsed from JSON is safe; no cycle guard). Returns
   * { text, truncated, length, overflow }.
   */
  function stringifyLimited(value, maxChars, maxCount) {
    var limit = typeof maxChars === 'number' && maxChars > 0 ? maxChars : Infinity;
    var countLimit = typeof maxCount === 'number' && maxCount > 0 ? maxCount : Infinity;
    var STOP = {};
    var parts = [];
    var size = 0;
    var truncated = false;
    var overflow = false;

    function push(text) {
      size += text.length;
      if (!truncated) {
        parts.push(text);
        if (size > limit) {
          truncated = true; // stop building — keep counting
        }
      }
      if (size > countLimit) {
        truncated = true;
        overflow = true; // stop counting too — the size is now a lower bound
        throw STOP;
      }
    }

    /** Add to the count without building text (used once truncated). */
    function count(n) {
      size += n;
      if (size > countLimit) {
        overflow = true;
        throw STOP;
      }
    }

    function skipped(v) {
      // Mirrors JSON.stringify: these become null in arrays, vanish in objects.
      return v === undefined || typeof v === 'function' || typeof v === 'symbol';
    }

    // Once counting only, strings without escapes are measured in place —
    // JSON.stringify would allocate an escaped copy of every string in the
    // dataset, and that garbage churn showed up as jank on big results.
    var CLEAN_STRING = /^[^"\\\u0000-\u001f\ud800-\udfff]*$/;

    function stringLength(s) {
      return CLEAN_STRING.test(s) ? s.length + 2 : JSON.stringify(s).length;
    }

    function walk(v, indent) {
      if (v === null) {
        push('null');
        return;
      }
      var type = typeof v;
      if (type === 'number') {
        push(isFinite(v) ? String(v) : 'null');
        return;
      }
      if (type === 'boolean') {
        push(v ? 'true' : 'false');
        return;
      }
      if (type === 'string') {
        if (truncated) {
          count(stringLength(v));
        } else {
          push(JSON.stringify(v));
        }
        return;
      }
      var childIndent = indent + '  ';
      if (Array.isArray(v)) {
        if (v.length === 0) {
          push('[]');
          return;
        }
        push('[\n');
        for (var i = 0; i < v.length; i++) {
          if (truncated) {
            count(childIndent.length);
          } else {
            push(childIndent);
          }
          if (skipped(v[i])) {
            push('null');
          } else {
            walk(v[i], childIndent);
          }
          push(i < v.length - 1 ? ',\n' : '\n');
        }
        push(indent + ']');
        return;
      }
      var keys = Object.keys(v).filter(function (key) {
        return !skipped(v[key]);
      });
      if (keys.length === 0) {
        push('{}');
        return;
      }
      push('{\n');
      for (var k = 0; k < keys.length; k++) {
        if (truncated) {
          count(childIndent.length + stringLength(keys[k]) + 2);
        } else {
          push(childIndent + JSON.stringify(keys[k]) + ': ');
        }
        walk(v[keys[k]], childIndent);
        push(k < keys.length - 1 ? ',\n' : '\n');
      }
      push(indent + '}');
    }

    if (value === undefined || skipped(value)) {
      return { text: undefined, truncated: false, length: 0, overflow: false };
    }
    try {
      walk(value, '');
    } catch (e) {
      if (e !== STOP) {
        throw e;
      }
    }
    return { text: parts.join(''), truncated: truncated, length: size, overflow: overflow };
  }

  /**
   * Small structural sample of a JSON value: arrays capped at 5 items,
   * objects at 50 keys, depth 4, long strings truncated. Enough for the
   * shape-driven features (suggestions, property completion) to work on
   * datasets that live only in the off-thread evaluator — the sample is
   * what crosses back instead of the dataset itself.
   */
  function sampleJson(value, depth) {
    var level = depth || 0;
    if (value === null || typeof value !== 'object') {
      return typeof value === 'string' && value.length > 120 ? value.slice(0, 120) + '…' : value;
    }
    if (level >= 4) {
      return Array.isArray(value) ? [] : {};
    }
    if (Array.isArray(value)) {
      var sampled = [];
      for (var i = 0; i < value.length && i < 5; i++) {
        sampled.push(sampleJson(value[i], level + 1));
      }
      return sampled;
    }
    var keys = Object.keys(value);
    var out = {};
    for (var k = 0; k < keys.length && k < 50; k++) {
      out[keys[k]] = sampleJson(value[keys[k]], level + 1);
    }
    return out;
  }

  /** Compact display form of a Graph URL: path + query, origin stripped. */
  function summarizeUrl(url, maxLength) {
    var max = maxLength || 80;
    var display = String(url || '');
    try {
      var u = new URL(display);
      display = u.pathname + u.search;
    } catch (e) {
      /* keep raw string */
    }
    try {
      display = decodeURIComponent(display);
    } catch (e) {
      /* keep encoded form */
    }
    if (display.length > max) {
      display = display.slice(0, max - 1) + '…';
    }
    return display;
  }

  /** Keep the newest `max` entries (entries are ordered newest-first). */
  function trimHistory(entries, max) {
    if (!Array.isArray(entries)) {
      return [];
    }
    if (entries.length <= max) {
      return entries;
    }
    return entries.slice(0, max);
  }

  /**
   * Trim the captured-response list (newest first) to `max` entries —
   * but count manual entries (pinned results, pasted JSON) separately,
   * so sources the user created deliberately are never pushed out by a
   * stream of new Graph responses. Each pool is capped at `max`.
   */
  function trimResponses(entries, max) {
    if (!Array.isArray(entries)) {
      return [];
    }
    var out = [];
    var live = 0;
    var manual = 0;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry) {
        continue;
      }
      if (entry.manual) {
        if (manual < max) {
          out.push(entry);
          manual++;
        }
      } else if (live < max) {
        out.push(entry);
        live++;
      }
    }
    return out;
  }

  // ---------------------------------------------------------- settings

  var VALID_LANGUAGES = ['jmespath', 'jsonpath', 'jq'];

  /**
   * The extension's stored defaults — the single source of truth shared
   * by the panel (content.js) and the settings popup (popup.js).
   */
  var DEFAULT_SETTINGS = Object.freeze({
    advancedQuery: true,
    autoSignIn: true,
    // Paged responses always get on-demand fetch controls (▶/+1); this
    // only decides whether the chain starts by itself. Manual by default.
    autoFetchNextLink: false,
    autoFetchMaxPages: 50,
    autoFetchMaxMb: 10,
    queryLanguage: 'jmespath',
    historyLimit: 50, // 0 = unlimited
    showBackgroundRequests: false,
    richEditor: true, // CodeMirror editor by default; can fall back to a plain textarea
    autoEvaluate: true // evaluate while typing; false = only on Enter (big data)
  });

  /** A raw stored settings object → complete, validated settings. */
  function normalizeSettings(raw) {
    var historyLimit =
      raw && typeof raw.historyLimit === 'number' && raw.historyLimit >= 0
        ? Math.floor(raw.historyLimit)
        : DEFAULT_SETTINGS.historyLimit;
    return {
      advancedQuery: !raw || raw.advancedQuery !== false,
      autoSignIn: !raw || raw.autoSignIn !== false,
      autoFetchNextLink: !!raw && raw.autoFetchNextLink === true,
      autoFetchMaxPages: clampInt(raw && raw.autoFetchMaxPages, 1, 1000, DEFAULT_SETTINGS.autoFetchMaxPages),
      autoFetchMaxMb: clampInt(raw && raw.autoFetchMaxMb, 1, 50, DEFAULT_SETTINGS.autoFetchMaxMb),
      queryLanguage:
        raw && VALID_LANGUAGES.indexOf(raw.queryLanguage) !== -1 ? raw.queryLanguage : DEFAULT_SETTINGS.queryLanguage,
      historyLimit: historyLimit,
      showBackgroundRequests: !!raw && raw.showBackgroundRequests === true,
      richEditor: !raw || raw.richEditor !== false,
      autoEvaluate: !raw || raw.autoEvaluate !== false
    };
  }

  /** JSONPath accessor for a key: `.key` or bracket-quoted. */
  function jsonPathKey(key) {
    if (PLAIN_IDENTIFIER.test(key)) {
      return '.' + key;
    }
    return "['" + String(key).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "']";
  }

  /** Pick up to two representative item keys from a collection response. */
  function pickItemKeys(json) {
    var first = null;
    for (var i = 0; i < json.value.length; i++) {
      var item = json.value[i];
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        first = item;
        break;
      }
    }
    if (!first) {
      return { first: null, picked: [] };
    }
    var keys = Object.keys(first);
    var preferred = ['displayName', 'name', 'subject', 'mail', 'userPrincipalName', 'id'];
    var picked = [];
    for (var p = 0; p < preferred.length && picked.length < 2; p++) {
      if (keys.indexOf(preferred[p]) !== -1) {
        picked.push(preferred[p]);
      }
    }
    for (var k = 0; k < keys.length && picked.length < 2; k++) {
      var key = keys[k];
      if (picked.indexOf(key) === -1 && key.indexOf('@') === -1) {
        picked.push(key);
      }
    }
    return { first: first, picked: picked };
  }

  function suggestJmesPathQueries(json) {
    var out = [];
    if (Array.isArray(json)) {
      out.push('[]');
      out.push('length(@)');
      return out;
    }
    if (json === null || typeof json !== 'object') {
      return out;
    }
    if (Array.isArray(json.value)) {
      var pick = pickItemKeys(json);
      var picked = pick.picked;
      for (var s = 0; s < picked.length; s++) {
        out.push('value[].' + jmesKey(picked[s]));
      }
      if (picked.length >= 2) {
        out.push(
          'value[].{' + picked[0].replace(/[^A-Za-z0-9_]/g, '_') + ': ' + jmesKey(picked[0]) +
          ', ' + picked[1].replace(/[^A-Za-z0-9_]/g, '_') + ': ' + jmesKey(picked[1]) + '}'
        );
      }
      if (picked.length >= 1 && pick.first && typeof pick.first[picked[0]] === 'string') {
        out.push('value[?contains(' + jmesKey(picked[0]) + ", 'a')]");
        out.push('sort_by(value, &' + jmesKey(picked[0]) + ')[].' + jmesKey(picked[0]));
      }
      out.push('length(value)');
      if (typeof json['@odata.nextLink'] === 'string') {
        out.push('"@odata.nextLink"');
      }
      return out;
    }
    var topKeys = Object.keys(json).filter(function (key) {
      return key.indexOf('@odata') !== 0;
    });
    for (var t = 0; t < topKeys.length && t < 3; t++) {
      out.push(jmesKey(topKeys[t]));
    }
    out.push('keys(@)');
    return out;
  }

  function suggestJsonPathQueries(json) {
    var out = [];
    if (Array.isArray(json)) {
      out.push('$[*]');
      out.push('$.length');
      return out;
    }
    if (json === null || typeof json !== 'object') {
      return out;
    }
    if (Array.isArray(json.value)) {
      var picked = pickItemKeys(json).picked;
      for (var s = 0; s < picked.length; s++) {
        out.push('$.value[*]' + jsonPathKey(picked[s]));
      }
      if (picked.length >= 1) {
        out.push('$.value[?(@' + jsonPathKey(picked[0]) + ')]');
        out.push('$..' + (PLAIN_IDENTIFIER.test(picked[0]) ? picked[0] : jsonPathKey(picked[0]).slice(1)));
      }
      out.push('$.value.length');
      if (typeof json['@odata.nextLink'] === 'string') {
        out.push("$[?(@property === '@odata.nextLink')]");
      }
      return out;
    }
    var topKeys = Object.keys(json).filter(function (key) {
      return key.indexOf('@') === -1;
    });
    for (var t = 0; t < topKeys.length && t < 3; t++) {
      out.push('$' + jsonPathKey(topKeys[t]));
    }
    out.push('$.*');
    return out;
  }

  function suggestJqQueries(json) {
    var out = [];
    if (Array.isArray(json)) {
      out.push('.[]');
      out.push('length');
      return out;
    }
    if (json === null || typeof json !== 'object') {
      return out;
    }
    if (Array.isArray(json.value)) {
      var picked = pickItemKeys(json).picked;
      for (var s = 0; s < picked.length; s++) {
        out.push('.value[].' + jqKey(picked[s]));
      }
      if (picked.length >= 2) {
        out.push('[.value[] | {' + jqKey(picked[0]) + ', ' + jqKey(picked[1]) + '}]');
      }
      if (picked.length >= 1) {
        out.push('.value | map(select(.' + jqKey(picked[0]) + ' != null))');
      }
      out.push('.value | length');
      if (typeof json['@odata.nextLink'] === 'string') {
        out.push('."@odata.nextLink"');
      }
      return out;
    }
    var topKeys = Object.keys(json).filter(function (key) {
      return key.indexOf('@') === -1;
    });
    for (var t = 0; t < topKeys.length && t < 3; t++) {
      out.push('.' + jqKey(topKeys[t]));
    }
    out.push('keys');
    return out;
  }

  /**
   * Suggest queries based on the shape of a Graph response, in the given
   * query language ('jmespath' by default, 'jsonpath', or 'jq').
   * Returns an array of query strings, most useful first.
   */
  function suggestQueries(json, language) {
    if (language === 'jsonpath') {
      return suggestJsonPathQueries(json);
    }
    if (language === 'jq') {
      return suggestJqQueries(json);
    }
    return suggestJmesPathQueries(json);
  }

  /** jq accessor for a key: `.key` or `."quoted key"`. */
  function jqKey(key) {
    if (PLAIN_IDENTIFIER.test(key)) {
      return key;
    }
    return '"' + String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  // --------------------------------------------------- query completions

  function fn(name, detail) {
    return { label: name + '(', insert: name + '(', detail: detail };
  }

  function word(name, detail) {
    return { label: name, insert: name, detail: detail };
  }

  function snippet(match, insert, detail) {
    return { label: insert, match: match, insert: insert, detail: detail };
  }

  // Function lists mirror what the bundled engines actually implement
  // (jmespath.js functionTable / the builtins of the WebAssembly jq) —
  // verified by tests.
  var QUERY_COMPLETIONS = {
    jmespath: [
      fn('abs', 'absolute value'),
      fn('avg', 'average of numbers'),
      fn('ceil', 'round up'),
      fn('contains', 'substring / element test'),
      fn('ends_with', 'string suffix test'),
      fn('floor', 'round down'),
      fn('join', 'join strings'),
      fn('keys', 'object keys'),
      fn('length', 'count items / chars'),
      fn('map', 'apply expression to array'),
      fn('max', 'largest value'),
      fn('max_by', 'largest by expression'),
      fn('merge', 'merge objects'),
      fn('min', 'smallest value'),
      fn('min_by', 'smallest by expression'),
      fn('not_null', 'first non-null argument'),
      fn('reverse', 'reverse array / string'),
      fn('sort', 'sort array'),
      fn('sort_by', 'sort by expression'),
      fn('starts_with', 'string prefix test'),
      fn('sum', 'sum of numbers'),
      fn('to_array', 'wrap in array'),
      fn('to_number', 'convert to number'),
      fn('to_string', 'convert to string'),
      fn('type', 'type name'),
      fn('values', 'object values')
    ],
    jq: [
      // jq 1.8.2 builtins (real jq, compiled to WebAssembly — see
      // vendor/jq-wasm.js). A builtin that exists both bare and with
      // arguments (add, flatten, paths, …) is listed in its common form.
      // Omitted on purpose: I/O and CLI-only builtins (input, inputs,
      // env, halt, stderr, input_filename, …) and the raw libm functions
      // (sin, j0, lgamma_r, …) — they compile but mean nothing here.
      word('abs', 'absolute value'),
      word('add', 'sum / concatenate items'),
      word('all', 'true when all items truthy'),
      word('any', 'true when any item truthy'),
      word('arrays', 'keep only arrays'),
      word('ascii_downcase', 'lowercase ASCII letters'),
      word('ascii_upcase', 'uppercase ASCII letters'),
      word('booleans', 'keep only booleans'),
      fn('bsearch', 'binary search in a sorted array'),
      word('builtins', 'list every builtin (name/arity)'),
      fn('capture', 'regex named groups → object'),
      word('ceil', 'round up'),
      word('combinations', 'cartesian product of arrays'),
      fn('contains', 'containment test'),
      word('debug', 'pass through (message to console)'),
      fn('del', 'delete paths'),
      fn('delpaths', 'delete a list of paths'),
      word('empty', 'no output'),
      fn('endswith', 'string suffix test'),
      fn('error', 'raise an error'),
      word('exp', 'e^x'),
      word('explode', 'string → codepoints'),
      word('first', 'first item'),
      word('flatten', 'flatten nested arrays'),
      word('floor', 'round down'),
      word('from_entries', 'build object from {key,value} list'),
      word('fromdate', 'ISO 8601 string → Unix time'),
      word('fromdateiso8601', 'ISO 8601 string → Unix time'),
      word('fromjson', 'parse a JSON string'),
      fn('fromstream', 'rebuild values from a stream'),
      fn('getpath', 'value at a path array'),
      word('gmtime', 'Unix time → broken-down UTC time'),
      fn('group_by', 'group items by expression'),
      fn('gsub', 'regex replace all matches'),
      fn('has', 'key / index presence'),
      word('implode', 'codepoints → string'),
      fn('in', 'key present in the given object'),
      fn('index', 'first index of substring / element'),
      fn('indices', 'all indices of substring / element'),
      word('infinite', 'positive infinity'),
      fn('inside', 'reverse containment test'),
      fn('isempty', 'true when a filter yields nothing'),
      word('isinfinite', 'test for ±infinity'),
      word('isnan', 'test for NaN'),
      word('isnormal', 'test for a normal number'),
      word('iterables', 'keep only arrays and objects'),
      fn('join', 'join strings with a separator'),
      word('keys', 'object keys / array indexes, sorted'),
      word('keys_unsorted', 'object keys in insertion order'),
      word('last', 'last item'),
      word('length', 'count items / chars'),
      fn('limit', 'first n outputs of a filter'),
      word('localtime', 'Unix time → broken-down local time'),
      word('log', 'natural logarithm'),
      word('log10', 'base-10 logarithm'),
      word('log2', 'base-2 logarithm'),
      word('ltrim', 'strip leading whitespace'),
      fn('ltrimstr', 'remove a prefix'),
      fn('map', 'apply filter to each item'),
      fn('map_values', 'apply filter to each value'),
      fn('match', 'regex match details'),
      word('max', 'largest value'),
      fn('max_by', 'largest by expression'),
      word('min', 'smallest value'),
      fn('min_by', 'smallest by expression'),
      word('mktime', 'broken-down time → Unix time'),
      word('nan', 'not-a-number'),
      word('not', 'boolean negation'),
      word('now', 'current Unix time'),
      fn('nth', 'n-th item / n-th output'),
      word('nulls', 'keep only nulls'),
      word('numbers', 'keep only numbers'),
      word('objects', 'keep only objects'),
      fn('path', 'path array of a filter'),
      word('paths', 'every path in the value'),
      fn('pick', 'keep only the given paths'),
      fn('pow', 'x^y'),
      fn('range', 'number sequence'),
      word('recurse', 'every value, recursively (..)'),
      fn('repeat', 'apply repeatedly, emitting each result'),
      word('reverse', 'reverse array / string'),
      fn('rindex', 'last index of substring / element'),
      word('round', 'round to nearest integer'),
      word('rtrim', 'strip trailing whitespace'),
      fn('rtrimstr', 'remove a suffix'),
      word('scalars', 'keep only scalars'),
      fn('scan', 'every regex match'),
      fn('select', 'keep items matching condition'),
      fn('setpath', 'set the value at a path array'),
      fn('skip', 'drop the first n outputs'),
      word('sort', 'sort array'),
      fn('sort_by', 'sort by expression'),
      fn('split', 'split string (separator or regex)'),
      fn('splits', 'split by regex, emitting each part'),
      word('sqrt', 'square root'),
      fn('startswith', 'string prefix test'),
      fn('strftime', 'format a broken-down time'),
      word('strings', 'keep only strings'),
      fn('strptime', 'parse a time string'),
      fn('sub', 'regex replace first match'),
      fn('test', 'regex test'),
      word('to_entries', 'object → {key,value} list'),
      word('toboolean', 'convert to boolean'),
      word('todate', 'Unix time → ISO 8601 string'),
      word('todateiso8601', 'Unix time → ISO 8601 string'),
      word('tojson', 'serialize to a JSON string'),
      word('tonumber', 'convert to number'),
      word('tostream', 'value → stream events'),
      word('tostring', 'convert to string'),
      word('transpose', 'transpose an array of arrays'),
      word('trim', 'strip surrounding whitespace'),
      fn('trimstr', 'remove a prefix and suffix'),
      word('trunc', 'truncate toward zero'),
      fn('truncate_stream', 'drop leading path depth from a stream'),
      word('type', 'type name'),
      fn('unique_by', 'dedupe by expression'),
      word('unique', 'dedupe array'),
      fn('until', 'apply until condition holds'),
      word('utf8bytelength', 'string length in UTF-8 bytes'),
      word('values', 'keep only non-null values'),
      fn('walk', 'apply filter to every value, bottom-up'),
      fn('while', 'apply while condition holds'),
      fn('with_entries', 'transform object entries'),
      fn('IN', 'membership test'),
      fn('INDEX', 'index items by expression → object')
    ],
    jsonpath: [
      snippet('wildcard', '[*]', 'every item'),
      snippet('all', '[*]', 'every item'),
      snippet('recursive', '..', 'recursive descent'),
      snippet('filter', "[?(@.prop == 'value')]", 'filter items'),
      snippet('exists', '[?(@.prop)]', 'items where a field exists'),
      snippet('slice', '[0:5]', 'array slice'),
      snippet('length', '.length', 'count items'),
      snippet('property', "[?(@property === 'name')]", 'match by property name'),
      snippet('root', '$', 'document root')
    ]
  };

  // ------------------------------------------------------ query tokenizer

  var TOKEN_FUNCTION_NAMES = null;

  /** Per-language set of names that read as functions/builtins, derived
   *  from QUERY_COMPLETIONS so highlighting always matches completion. */
  function tokenFunctionNames(language) {
    if (!TOKEN_FUNCTION_NAMES) {
      TOKEN_FUNCTION_NAMES = {};
      Object.keys(QUERY_COMPLETIONS).forEach(function (key) {
        var names = {};
        QUERY_COMPLETIONS[key].forEach(function (item) {
          var match = /^([A-Za-z_][A-Za-z0-9_]*)\(?$/.exec(item.label);
          if (match) {
            names[match[1]] = true;
          }
        });
        TOKEN_FUNCTION_NAMES[key] = names;
      });
    }
    return TOKEN_FUNCTION_NAMES[language] || {};
  }

  var JQ_RESERVED = ['if', 'then', 'elif', 'else', 'end', 'as', 'def', 'reduce', 'foreach', 'try', 'catch', 'label', 'import', 'include', 'and', 'or', 'not'];

  var TOKEN_BRACKETS = '()[]{}';
  var TOKEN_OPERATORS = '|&=!<>+-*/%?:.,;~';

  /**
   * Scan one token of a query string starting at `pos`. Returns
   * { end, type } where type is a CodeMirror-style token name ('string',
   * 'number', 'keyword' for functions/builtins, 'operator', 'bracket',
   * 'variableName' for @/$… references, 'propertyName') or null for
   * whitespace/plain text. `end` always advances past `pos` while there
   * is input left. Powers the query editor's syntax highlighting.
   */
  function nextQueryToken(language, text, pos) {
    var ch = text[pos];
    if (ch === undefined) {
      return { end: pos, type: null };
    }
    var end;
    if (/\s/.test(ch)) {
      end = pos + 1;
      while (end < text.length && /\s/.test(text[end])) {
        end++;
      }
      return { end: end, type: null };
    }
    // '…' and "…" strings everywhere; `…` JSON literals in JMESPath.
    if (ch === "'" || ch === '"' || (ch === '`' && language === 'jmespath')) {
      end = pos + 1;
      while (end < text.length) {
        if (text[end] === '\\') {
          end += 2;
          continue;
        }
        if (text[end] === ch) {
          end++;
          break;
        }
        end++;
      }
      return { end: Math.min(end, text.length), type: 'string' };
    }
    if (/[0-9]/.test(ch)) {
      end = pos + 1;
      while (end < text.length && /[0-9]/.test(text[end])) {
        end++;
      }
      if (text[end] === '.' && /[0-9]/.test(text[end + 1] || '')) {
        end += 2;
        while (end < text.length && /[0-9]/.test(text[end])) {
          end++;
        }
      }
      return { end: end, type: 'number' };
    }
    // $root/$vars (JSONPath, jq), @item (JMESPath, JSONPath), @base64 (jq).
    if (ch === '$' || ch === '@') {
      end = pos + 1;
      while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) {
        end++;
      }
      return { end: end, type: 'variableName' };
    }
    if (/[A-Za-z_]/.test(ch)) {
      end = pos + 1;
      while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) {
        end++;
      }
      var name = text.slice(pos, end);
      var afterDot = text[pos - 1] === '.'; // `.keys` is a property access, not the builtin
      if (!afterDot) {
        if (language === 'jq' && JQ_RESERVED.indexOf(name) !== -1) {
          return { end: end, type: 'keyword' };
        }
        if (tokenFunctionNames(language)[name] === true) {
          // jq builtins also appear bare (`.value | keys`); the other
          // languages only call functions with parentheses.
          if (language === 'jq' || /^\s*\(/.test(text.slice(end))) {
            return { end: end, type: 'keyword' };
          }
        }
      }
      return { end: end, type: 'propertyName' };
    }
    if (TOKEN_BRACKETS.indexOf(ch) !== -1) {
      return { end: pos + 1, type: 'bracket' };
    }
    if (TOKEN_OPERATORS.indexOf(ch) !== -1) {
      return { end: pos + 1, type: 'operator' };
    }
    return { end: pos + 1, type: null };
  }

  function insideStringLiteral(text) {
    var quote = null;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (quote) {
        if (ch === '\\') {
          i++;
        } else if (ch === quote) {
          quote = null;
        }
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      }
    }
    return quote !== null;
  }

  // Characters that can be part of a path expression; anything else ends
  // the candidate scanned backwards from the cursor.
  var PATH_CHARS = /[A-Za-z0-9_.\[\]"'@:$*-]/;

  /** The trailing path-like run before the cursor. Complete quoted spans
   *  and complete `[...]` bracket groups are skipped whole, so a member
   *  access after a filter — `value[?age > `18`].na` — keeps the whole
   *  `value[?…]` as its base instead of stopping at a space or backtick
   *  inside the brackets. */
  function extractPathCandidate(text) {
    var i = text.length - 1;
    while (i >= 0) {
      var ch = text[i];
      if (ch === '"' || ch === "'") {
        // Skip a complete quoted span (the caller already ruled out an
        // unterminated string at the cursor).
        var j = i - 1;
        while (j >= 0 && !(text[j] === ch && text[j - 1] !== '\\')) {
          j--;
        }
        if (j < 0) {
          break;
        }
        i = j - 1;
      } else if (ch === ']') {
        // Jump back to the matching '[', skipping nested brackets and any
        // quoted spans (which may themselves contain '[' or ']').
        var depth = 1;
        var m = i - 1;
        while (m >= 0 && depth > 0) {
          var cm = text[m];
          if (cm === '"' || cm === "'") {
            var k = m - 1;
            while (k >= 0 && !(text[k] === cm && text[k - 1] !== '\\')) {
              k--;
            }
            m = k - 1;
            continue;
          }
          if (cm === ']') {
            depth++;
          } else if (cm === '[') {
            depth--;
            if (depth === 0) {
              break;
            }
          }
          m--;
        }
        if (depth !== 0) {
          break; // unbalanced — stop before this ']'
        }
        i = m - 1; // continue scanning before the matching '['
      } else if (PATH_CHARS.test(ch)) {
        i--;
      } else {
        break;
      }
    }
    return text.slice(i + 1);
  }

  /** Resolve parsed path segments against a JSON value → array of values. */
  function resolveSegments(json, segments) {
    var current = [json];
    for (var s = 0; s < segments.length; s++) {
      var segment = segments[s];
      var next = [];
      for (var c = 0; c < current.length && next.length < 20; c++) {
        var value = current[c];
        if (segment.type === 'key') {
          if (value !== null && typeof value === 'object' && !Array.isArray(value) && segment.name in value) {
            next.push(value[segment.name]);
          }
        } else if (segment.type === 'index') {
          if (Array.isArray(value)) {
            var idx = segment.value < 0 ? value.length + segment.value : segment.value;
            if (idx >= 0 && idx < value.length) {
              next.push(value[idx]);
            }
          }
        } else if (Array.isArray(value)) {
          // wildcard, slice, filter: sample the items (shape only)
          for (var v = 0; v < value.length && next.length < 20; v++) {
            next.push(value[v]);
          }
        }
      }
      if (next.length === 0) {
        return [];
      }
      current = next;
    }
    return current;
  }

  function valueDetail(value) {
    if (Array.isArray(value)) {
      return 'array (' + value.length + ')';
    }
    if (value === null) {
      return 'null';
    }
    return typeof value;
  }

  /**
   * Tier-2 completion: property names from the response JSON at the path
   * before the cursor (e.g. `value[].` → displayName, mail, …).
   */
  function propertyCompletions(language, textBeforeCursor, json) {
    if (json === undefined || json === null) {
      return null;
    }
    var candidate = extractPathCandidate(textBeforeCursor);
    if (candidate === '') {
      return null;
    }
    var fragmentMatch = /[A-Za-z_][A-Za-z0-9_]*$/.exec(candidate);
    var fragment = fragmentMatch ? fragmentMatch[0] : '';
    var base = candidate.slice(0, candidate.length - fragment.length);
    if (base.slice(-1) === '.') {
      base = base.slice(0, -1);
    } else if (base !== '') {
      return null; // not a member position (after ']', inside a filter, …)
    }
    if (base === '') {
      // A bare fragment right after `[?` is a filter field, not a root
      // path — that context is handled by filterContextCompletions.
      var preceding = textBeforeCursor[textBeforeCursor.length - candidate.length - 1];
      if (preceding === '?') {
        return null;
      }
    }
    var values;
    if (language === 'jq') {
      if (candidate[0] !== '.') {
        return null;
      }
      if (base === '' || base === '.') {
        // A member right after a pipe — `.value[] | .frag` — completes
        // against the output of the stage left of the last pipe.
        var beforeCandidate = textBeforeCursor.slice(0, textBeforeCursor.length - candidate.length);
        if (beforeCandidate.replace(/\s+$/, '').slice(-1) === '|') {
          var leftPath = extractPathCandidate(beforeCandidate.replace(/\s*\|\s*$/, ''));
          values = leftPath === '' ? [json] : resolveFromParser(parseJqQuery, leftPath, json);
        } else {
          values = [json];
        }
      } else {
        values = resolveFromParser(parseJqQuery, base, json);
      }
    } else if (language === 'jsonpath') {
      if (candidate[0] !== '$') {
        return null;
      }
      values = base === '' || base === '$' ? [json] : resolveFromParser(parseJsonPathQuery, base, json);
    } else if (language === 'jmespath') {
      if (candidate[0] === '$' || candidate[0] === '.') {
        return null;
      }
      values = base === '' ? [json] : resolveFromParser(parseJmesPathQuery, base, json);
    } else {
      return null;
    }
    if (!values || values.length === 0) {
      return null;
    }
    var lower = fragment.toLowerCase();
    var seen = {};
    var items = [];
    for (var i = 0; i < values.length && items.length < 30; i++) {
      var value = values[i];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        continue;
      }
      var keys = Object.keys(value);
      for (var k = 0; k < keys.length && items.length < 30; k++) {
        var key = keys[k];
        var keyLower = key.toLowerCase();
        if (seen[keyLower] || keyLower.indexOf(lower) !== 0 || keyLower === lower) {
          continue;
        }
        var plain = PLAIN_IDENTIFIER.test(key);
        if (!plain && language === 'jsonpath') {
          continue; // needs bracket syntax, which a dot-completion can't insert
        }
        seen[keyLower] = true;
        items.push({
          label: key,
          insert: plain ? key : '"' + key.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"',
          detail: valueDetail(value[key])
        });
      }
    }
    if (items.length === 0) {
      return null;
    }
    return {
      replaceFrom: textBeforeCursor.length - fragment.length,
      fragment: fragment,
      items: items
    };
  }

  function resolveFromParser(parser, base, json) {
    // For completion we only need the array's items, so a filter predicate
    // is equivalent to a wildcard — and the strict parsers reject many
    // predicates (e.g. `[?a == `b`]`). Normalize filters to wildcards so a
    // member access after a filter still resolves.
    var normalized = base
      .replace(/\[\?\([^)]*\)\]/g, '[*]') // JSONPath [?(...)] → wildcard
      .replace(/\[\?[^\]]*\]/g, '[]'); // JMESPath [?...] → wildcard
    var model;
    try {
      model = parser(normalized);
    } catch (e) {
      model = null;
    }
    if (!model || model.count) {
      return null;
    }
    return resolveSegments(json, model.segments);
  }

  /** Keys of the object items inside resolved values (arrays sampled). */
  function itemKeyCompletions(values, fragment, textLength) {
    if (!values || values.length === 0) {
      return null;
    }
    var items = [];
    var seen = {};
    var lower = fragment.toLowerCase();
    values.forEach(function (value) {
      var candidates = Array.isArray(value) ? value.slice(0, 20) : [value];
      candidates.forEach(function (item) {
        if (items.length >= 30 || item === null || typeof item !== 'object' || Array.isArray(item)) {
          return;
        }
        Object.keys(item).forEach(function (key) {
          var keyLower = key.toLowerCase();
          if (items.length >= 30 || seen[keyLower] || keyLower.indexOf(lower) !== 0 || keyLower === lower) {
            return;
          }
          if (!PLAIN_IDENTIFIER.test(key)) {
            return; // filter expressions need plain identifiers
          }
          seen[keyLower] = true;
          items.push({ label: key, insert: key, detail: valueDetail(item[key]) });
        });
      });
    });
    if (items.length === 0) {
      return null;
    }
    return { replaceFrom: textLength - fragment.length, fragment: fragment, items: items };
  }

  /**
   * Property completion inside filter expressions: JMESPath `path[?fr`,
   * JSONPath `path[?(@.fr`, and jq `path | select(.fr` / `map(select(.fr`.
   * Completes with the keys of the filtered array's items.
   */
  function filterContextCompletions(language, textBeforeCursor, json) {
    if (json === undefined || json === null) {
      return null;
    }
    var match = null;
    var base = null;
    var fragment = '';
    if (language === 'jmespath') {
      // Bare field (`value[?dis`) and fields inside filter function calls
      // (`value[?contains(dis`, nested calls included) both complete with
      // the filtered array's item keys.
      match = /([A-Za-z_][\w."\[\]]*)\[\?\s*(?:!?\s*[A-Za-z_]\w*\(\s*)*([A-Za-z_]\w*)?$/.exec(textBeforeCursor);
      if (!match) {
        return null;
      }
      base = match[1];
      fragment = match[2] || '';
      return itemKeyCompletions(resolveFromParser(parseJmesPathQuery, base, json), fragment, textBeforeCursor.length);
    }
    if (language === 'jsonpath') {
      match = /(\$[\w."'\[\]*]*)\[\?\(@\.([A-Za-z_]\w*)?$/.exec(textBeforeCursor);
      if (!match) {
        return null;
      }
      base = match[1];
      fragment = match[2] || '';
      var values = base === '$' ? [json] : resolveFromParser(parseJsonPathQuery, base, json);
      return itemKeyCompletions(values, fragment, textBeforeCursor.length);
    }
    if (language === 'jq') {
      match = /((?:\.[\w"$\[\]]+)+)(?:\[\])?\s*\|\s*(?:map\(\s*)?(?:select\(\s*)\.([A-Za-z_]\w*)?$/.exec(textBeforeCursor);
      if (!match) {
        return null;
      }
      base = match[1];
      fragment = match[2] || '';
      return itemKeyCompletions(resolveFromParser(parseJqQuery, base, json), fragment, textBeforeCursor.length);
    }
    return null;
  }

  /**
   * Query-input completion. Tier 2 (property names resolved from the
   * response JSON at the path before the cursor) ranks first, followed
   * by Tier 1 (the language's functions and operators). Returns
   * { replaceFrom, fragment, items } or null (no matches, or the cursor
   * is inside a string literal).
   */
  function queryCompletions(language, textBeforeCursor, json) {
    if (typeof textBeforeCursor !== 'string' || insideStringLiteral(textBeforeCursor)) {
      return null;
    }
    var properties =
      propertyCompletions(language, textBeforeCursor, json) ||
      filterContextCompletions(language, textBeforeCursor, json);

    var functions = null;
    var entries = QUERY_COMPLETIONS[language];
    var fragmentMatch = /[A-Za-z_][A-Za-z0-9_]*$/.exec(textBeforeCursor);
    if (entries && fragmentMatch) {
      var fragment = fragmentMatch[0];
      var lower = fragment.toLowerCase();
      var items = entries.filter(function (entry) {
        var key = (entry.match || entry.label).toLowerCase();
        return key.indexOf(lower) === 0 && key !== lower;
      });
      if (items.length > 0) {
        functions = {
          replaceFrom: textBeforeCursor.length - fragment.length,
          fragment: fragment,
          items: items
        };
      }
    }

    if (properties && functions) {
      // Same fragment by construction — merge with properties first.
      return {
        replaceFrom: properties.replaceFrom,
        fragment: properties.fragment,
        items: properties.items.concat(functions.items)
      };
    }
    return properties || functions;
  }

  // ----------------------------------------------------- query conversion

  /**
   * Best-effort conversion of simple path queries between JMESPath,
   * JSONPath, and jq. Queries are parsed into a shared model of path
   * segments (keys, wildcards, indexes, slices, one simple filter) plus
   * an optional trailing count; anything beyond that subset (pipes,
   * functions, reshaping, recursive descent, …) is not convertible and
   * conversion reports ok: false so the caller can leave the query
   * untouched.
   */

  var FILTER_OPS = ['==', '!=', '<=', '>=', '<', '>'];

  function readQuoted(text, start, quote) {
    // Returns { value, end } for a quoted string starting at `start`
    // (which must be the opening quote), or null.
    if (text[start] !== quote) {
      return null;
    }
    var value = '';
    for (var i = start + 1; i < text.length; i++) {
      var ch = text[i];
      if (ch === '\\' && i + 1 < text.length) {
        value += text[i + 1];
        i++;
      } else if (ch === quote) {
        return { value: value, end: i + 1 };
      } else {
        value += ch;
      }
    }
    return null;
  }

  function parseFilterLiteral(text) {
    // 'str', "str", `123`, or bare number → { kind, v } | null
    var trimmed = text.trim();
    if (trimmed === '') {
      return null;
    }
    var quoted = readQuoted(trimmed, 0, "'") || readQuoted(trimmed, 0, '"') || readQuoted(trimmed, 0, '`');
    if (quoted && quoted.end === trimmed.length) {
      if (trimmed[0] === '`') {
        var n = Number(quoted.value);
        return isFinite(n) ? { kind: 'number', v: n } : null;
      }
      return { kind: 'string', v: quoted.value };
    }
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return { kind: 'number', v: Number(trimmed) };
    }
    return null;
  }

  function parseFilterBody(body) {
    // `<field>` or `<field> <op> <literal>`; field is an identifier or
    // quoted. Returns a filter segment or null.
    var trimmed = body.trim();
    var field = null;
    var rest = '';
    if (trimmed[0] === '"' || trimmed[0] === "'") {
      var quoted = readQuoted(trimmed, 0, trimmed[0]);
      if (!quoted) {
        return null;
      }
      field = quoted.value;
      rest = trimmed.slice(quoted.end);
    } else {
      var identMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(trimmed);
      if (!identMatch) {
        return null;
      }
      field = identMatch[0];
      rest = trimmed.slice(field.length);
    }
    rest = rest.trim();
    if (rest === '') {
      return { type: 'filter', field: field, op: null, value: null };
    }
    for (var i = 0; i < FILTER_OPS.length; i++) {
      if (rest.indexOf(FILTER_OPS[i]) === 0) {
        var literal = parseFilterLiteral(rest.slice(FILTER_OPS[i].length));
        if (!literal) {
          return null;
        }
        return { type: 'filter', field: field, op: FILTER_OPS[i], value: literal };
      }
    }
    return null;
  }

  function parseBracketInner(inner, language) {
    // Shared bracket contents: wildcard, index, slice, quoted key, filter.
    var trimmed = inner.trim();
    if (trimmed === '' || trimmed === '*') {
      return { type: 'wildcard' };
    }
    if (/^-?\d+$/.test(trimmed)) {
      return { type: 'index', value: parseInt(trimmed, 10) };
    }
    var slice = /^(-?\d*):(-?\d*)$/.exec(trimmed);
    if (slice) {
      return { type: 'slice', from: slice[1], to: slice[2] };
    }
    if (trimmed[0] === "'" || trimmed[0] === '"') {
      var quoted = readQuoted(trimmed, 0, trimmed[0]);
      if (quoted && quoted.end === trimmed.length) {
        return { type: 'key', name: quoted.value };
      }
      return null;
    }
    if (trimmed[0] === '?') {
      var body = trimmed.slice(1).trim();
      if (language === 'jsonpath') {
        var wrapped = /^\((.*)\)$/.exec(body);
        if (!wrapped) {
          return null;
        }
        body = wrapped[1].trim();
        // Field references look like @.field or @['field'].
        if (body.indexOf('@') !== 0) {
          return null;
        }
        body = body.slice(1);
        if (body[0] === '.') {
          body = body.slice(1);
        } else if (body[0] === '[') {
          var close = body.indexOf(']');
          if (close === -1) {
            return null;
          }
          var keyPart = body.slice(1, close).trim();
          var keyQuoted = readQuoted(keyPart, 0, keyPart[0]);
          if (!keyQuoted || keyQuoted.end !== keyPart.length) {
            return null;
          }
          body = '"' + keyQuoted.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' + body.slice(close + 1);
        } else {
          return null;
        }
      }
      return parseFilterBody(body);
    }
    return null;
  }

  /** Read a bracket group starting at `[`; returns { inner, end } | null. */
  function readBracket(text, start) {
    if (text[start] !== '[') {
      return null;
    }
    var depth = 0;
    var quote = null;
    for (var i = start; i < text.length; i++) {
      var ch = text[i];
      if (quote) {
        if (ch === '\\') {
          i++;
        } else if (ch === quote) {
          quote = null;
        }
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      } else if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        depth--;
        if (depth === 0) {
          return { inner: text.slice(start + 1, i), end: i + 1 };
        }
      }
    }
    return null;
  }

  function parseJmesPathQuery(query) {
    var text = query.trim();
    var count = false;
    var lengthMatch = /^length\((.*)\)$/.exec(text);
    if (lengthMatch) {
      count = true;
      text = lengthMatch[1].trim();
    }
    var segments = [];
    var i = 0;
    while (i < text.length) {
      var ch = text[i];
      if (ch === '.') {
        if (segments.length === 0) {
          return null;
        }
        i++;
        ch = text[i];
        if (ch === undefined) {
          return null;
        }
      }
      if (ch === '"') {
        var quoted = readQuoted(text, i, '"');
        if (!quoted) {
          return null;
        }
        segments.push({ type: 'key', name: quoted.value });
        i = quoted.end;
      } else if (/[A-Za-z_]/.test(ch)) {
        var ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))[0];
        segments.push({ type: 'key', name: ident });
        i += ident.length;
      } else if (ch === '[') {
        var bracket = readBracket(text, i);
        if (!bracket) {
          return null;
        }
        var segment = parseBracketInner(bracket.inner, 'jmespath');
        if (!segment || segment.type === 'key') {
          return null; // JMESPath uses ."quoted", not ['quoted']
        }
        segments.push(segment);
        i = bracket.end;
      } else {
        return null;
      }
    }
    if (segments.length === 0) {
      return null;
    }
    return { count: count, segments: segments };
  }

  function parseJsonPathQuery(query) {
    var text = query.trim();
    if (text[0] !== '$') {
      return null;
    }
    var segments = [];
    var i = 1;
    while (i < text.length) {
      var ch = text[i];
      if (ch === '.') {
        if (text[i + 1] === '.') {
          return null; // recursive descent has no equivalent
        }
        i++;
        var ident = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i));
        if (!ident) {
          return null;
        }
        segments.push({ type: 'key', name: ident[0] });
        i += ident[0].length;
      } else if (ch === '[') {
        var bracket = readBracket(text, i);
        if (!bracket) {
          return null;
        }
        var segment = parseBracketInner(bracket.inner, 'jsonpath');
        if (!segment) {
          return null;
        }
        segments.push(segment);
        i = bracket.end;
      } else {
        return null;
      }
    }
    // Trailing `.length` is jsonpath-plus's way of counting. (A genuine
    // key named "length" in that position converts to a count instead —
    // acceptable for a best-effort converter.)
    var count = false;
    var last = segments[segments.length - 1];
    if (segments.length >= 2 && last && last.type === 'key' && last.name === 'length') {
      segments.pop();
      count = true;
    }
    if (segments.length === 0) {
      return null;
    }
    return { count: count, segments: segments };
  }

  function parseJqQuery(query) {
    var text = query.trim();
    var count = false;
    var pipeParts = text.split('|');
    if (pipeParts.length === 2 && pipeParts[1].trim() === 'length') {
      count = true;
      text = pipeParts[0].trim();
    } else if (pipeParts.length > 1) {
      return null;
    }
    if (text[0] !== '.') {
      return null;
    }
    var segments = [];
    var i = 0;
    while (i < text.length) {
      var ch = text[i];
      if (ch === '.') {
        i++;
        var next = text[i];
        if (next === '"') {
          var quoted = readQuoted(text, i, '"');
          if (!quoted) {
            return null;
          }
          segments.push({ type: 'key', name: quoted.value });
          i = quoted.end;
        } else if (next !== undefined && /[A-Za-z_]/.test(next)) {
          var ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))[0];
          segments.push({ type: 'key', name: ident });
          i += ident.length;
        } else if (next === '[') {
          continue; // `.[…]` — bracket handled below
        } else {
          return null;
        }
      } else if (ch === '[') {
        var bracket = readBracket(text, i);
        if (!bracket) {
          return null;
        }
        var segment = parseBracketInner(bracket.inner, 'jq');
        if (!segment || segment.type === 'key' || segment.type === 'filter') {
          return null;
        }
        segments.push(segment);
        i = bracket.end;
      } else {
        return null;
      }
    }
    if (segments.length === 0) {
      return null;
    }
    return { count: count, segments: segments };
  }

  function emitFilterLiteral(literal, quote) {
    if (literal.kind === 'number') {
      return String(literal.v);
    }
    var escaped = String(literal.v).replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), '\\' + quote);
    return quote + escaped + quote;
  }

  function emitJmesPathQuery(model) {
    var out = '';
    for (var i = 0; i < model.segments.length; i++) {
      var segment = model.segments[i];
      switch (segment.type) {
        case 'key':
          out += (out === '' ? '' : '.') + jmesKey(segment.name);
          break;
        case 'wildcard':
          out += '[]';
          break;
        case 'index':
          out += '[' + segment.value + ']';
          break;
        case 'slice':
          out += '[' + segment.from + ':' + segment.to + ']';
          break;
        case 'filter':
          out += '[?' + jmesKey(segment.field);
          if (segment.op) {
            out += ' ' + segment.op + ' ';
            out += segment.value.kind === 'number' ? '`' + segment.value.v + '`' : emitFilterLiteral(segment.value, "'");
          }
          out += ']';
          break;
        default:
          return null;
      }
    }
    if (out === '') {
      return null;
    }
    return model.count ? 'length(' + out + ')' : out;
  }

  function emitJsonPathQuery(model) {
    var out = '$';
    for (var i = 0; i < model.segments.length; i++) {
      var segment = model.segments[i];
      switch (segment.type) {
        case 'key':
          out += PLAIN_IDENTIFIER.test(segment.name)
            ? '.' + segment.name
            : "['" + segment.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "']";
          break;
        case 'wildcard':
          out += '[*]';
          break;
        case 'index':
          out += '[' + segment.value + ']';
          break;
        case 'slice':
          out += '[' + segment.from + ':' + segment.to + ']';
          break;
        case 'filter':
          var field = PLAIN_IDENTIFIER.test(segment.field)
            ? '.' + segment.field
            : "['" + segment.field.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "']";
          out += '[?(@' + field;
          if (segment.op) {
            out += ' ' + segment.op + ' ' + emitFilterLiteral(segment.value, "'");
          }
          out += ')]';
          break;
        default:
          return null;
      }
    }
    return model.count ? out + '.length' : out;
  }

  function emitJqQuery(model) {
    var out = '';
    for (var i = 0; i < model.segments.length; i++) {
      var segment = model.segments[i];
      switch (segment.type) {
        case 'key':
          out += '.' + jqKey(segment.name);
          break;
        case 'wildcard':
          out += (out === '' ? '.' : '') + '[]';
          break;
        case 'index':
          out += (out === '' ? '.' : '') + '[' + segment.value + ']';
          break;
        case 'slice':
          out += (out === '' ? '.' : '') + '[' + segment.from + ':' + segment.to + ']';
          break;
        case 'filter':
          // Only expressible cleanly as a trailing map(select(…)).
          if (i !== model.segments.length - 1) {
            return null;
          }
          var condition = '.' + jqKey(segment.field);
          condition += segment.op
            ? ' ' + segment.op + ' ' + emitFilterLiteral(segment.value, '"')
            : ' != null';
          out = (out === '' ? '.' : out) + ' | map(select(' + condition + '))';
          break;
        default:
          return null;
      }
    }
    if (out === '') {
      return null;
    }
    return model.count ? out + ' | length' : out;
  }

  var QUERY_PARSERS = {
    jmespath: parseJmesPathQuery,
    jsonpath: parseJsonPathQuery,
    jq: parseJqQuery
  };
  var QUERY_EMITTERS = {
    jmespath: emitJmesPathQuery,
    jsonpath: emitJsonPathQuery,
    jq: emitJqQuery
  };

  /**
   * Convert a query between languages when it falls into the shared
   * simple-path subset. Returns { ok: true, query } or { ok: false }.
   */
  function convertQuery(query, fromLanguage, toLanguage) {
    if (fromLanguage === toLanguage) {
      return { ok: true, query: query };
    }
    var parse = QUERY_PARSERS[fromLanguage];
    var emit = QUERY_EMITTERS[toLanguage];
    if (!parse || !emit) {
      return { ok: false };
    }
    var model;
    try {
      model = parse(query);
    } catch (e) {
      model = null;
    }
    if (!model) {
      return { ok: false };
    }
    var emitted = emit(model);
    if (emitted === null) {
      return { ok: false };
    }
    return { ok: true, query: emitted };
  }

  // ------------------------------------ Microsoft Graph (OData) equivalent
  //
  // toGraphQuery() translates a panel query into the OData query options
  // ($filter, $select, $orderby, $top/$skip, $count) that would make the
  // server do the same work. Translation is prefix-based and best-effort:
  // constructs with a server-side equivalent become parameters, the first
  // construct without one stops translation, and everything that must
  // still run client-side is returned as the `residual` query (with notes
  // naming the untranslatable pieces).

  var ODATA_OPS = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
  var ODATA_STRING_FUNCTIONS = {
    starts_with: 'startswith',
    startswith: 'startswith',
    ends_with: 'endswith',
    endswith: 'endswith',
    contains: 'contains'
  };

  function odataLiteral(literal) {
    if (literal.kind === 'number') {
      return String(literal.v);
    }
    if (literal.kind === 'null') {
      return 'null';
    }
    if (literal.kind === 'boolean') {
      return literal.v ? 'true' : 'false';
    }
    return "'" + String(literal.v).replace(/'/g, "''") + "'";
  }

  /** OData $filter clause for a parsed comparison filter, or null. */
  function odataFilterClause(segment) {
    if (!PLAIN_IDENTIFIER.test(segment.field)) {
      return null;
    }
    if (!segment.op) {
      return segment.field + ' ne null';
    }
    var op = ODATA_OPS[segment.op];
    if (!op || !segment.value) {
      return null;
    }
    return segment.field + ' ' + op + ' ' + odataLiteral(segment.value);
  }

  /** OData clause for a string-function filter, or null. */
  function odataFunctionClause(fn, field, literal) {
    var name = ODATA_STRING_FUNCTIONS[fn];
    if (!name || !PLAIN_IDENTIFIER.test(field) || !literal || literal.kind !== 'string') {
      return null;
    }
    return name + '(' + field + ',' + odataLiteral(literal) + ')';
  }

  /** Read `name(...)` at the start of `text` → { inner, rest } or null. */
  function readCall(text, name) {
    if (text.slice(0, name.length + 1) !== name + '(') {
      return null;
    }
    var depth = 0;
    var quote = null;
    for (var i = name.length; i < text.length; i++) {
      var ch = text[i];
      if (quote) {
        if (ch === '\\') {
          i++;
        } else if (ch === quote) {
          quote = null;
        }
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          return { inner: text.slice(name.length + 1, i), rest: text.slice(i + 1) };
        }
      }
    }
    return null;
  }

  /** Read a `{…}`-style group starting at `start` → { inner, end } | null. */
  function readGroup(text, start, open, close) {
    if (text[start] !== open) {
      return null;
    }
    var depth = 0;
    var quote = null;
    for (var i = start; i < text.length; i++) {
      var ch = text[i];
      if (quote) {
        if (ch === '\\') {
          i++;
        } else if (ch === quote) {
          quote = null;
        }
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      } else if (ch === open) {
        depth++;
      } else if (ch === close) {
        depth--;
        if (depth === 0) {
          return { inner: text.slice(start + 1, i), end: i + 1 };
        }
      }
    }
    return null;
  }

  /** Split on a single-character separator at nesting depth 0. */
  function splitTopLevel(text, separator) {
    var parts = [];
    var start = 0;
    var depth = 0;
    var quote = null;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (quote) {
        if (ch === '\\') {
          i++;
        } else if (ch === quote) {
          quote = null;
        }
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      } else if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
      } else if (ch === separator && depth === 0) {
        parts.push(text.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(text.slice(start));
    return parts;
  }

  /**
   * $select keys from a JMESPath multiselect hash body ({alias: key, …}).
   * `complex` counts members whose value is more than a plain key — their
   * source fields are unknown, so callers must not emit $select for them.
   */
  function multiselectSelectKeys(inner) {
    var keys = [];
    var complex = 0;
    splitTopLevel(inner, ',').forEach(function (pair) {
      var colon = pair.indexOf(':');
      if (colon === -1) {
        complex++;
        return;
      }
      var value = pair.slice(colon + 1).trim();
      var quoted = value[0] === '"' ? readQuoted(value, 0, '"') : null;
      if (quoted && quoted.end === value.length && PLAIN_IDENTIFIER.test(quoted.value)) {
        keys.push(quoted.value);
      } else if (PLAIN_IDENTIFIER.test(value)) {
        keys.push(value);
      } else {
        complex++;
      }
    });
    return { keys: keys, complex: complex };
  }

  /** `[?starts_with(field, 'x')]`-style JMESPath function filters. */
  function parseJmesFunctionFilter(inner) {
    var trimmed = inner.trim();
    if (trimmed[0] !== '?') {
      return null;
    }
    var match = /^([A-Za-z_][A-Za-z0-9_]*)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([\s\S]+)\)\s*$/.exec(trimmed.slice(1).trim());
    if (!match || !ODATA_STRING_FUNCTIONS[match[1]]) {
      return null;
    }
    var literal = parseFilterLiteral(match[3].trim());
    if (!literal || literal.kind !== 'string') {
      return null;
    }
    return { type: 'filterfn', fn: match[1], field: match[2], value: literal };
  }

  /**
   * Loose JMESPath path scan: like parseJmesPathQuery, but a bracket
   * group it can't interpret becomes an `opaque` segment (kept verbatim
   * client-side) instead of failing the whole parse, string-function
   * filters are recognized, and a trailing `.{…}` multiselect is allowed.
   * Every segment carries its source text in `raw`.
   */
  function scanJmesPathLoose(text) {
    var segments = [];
    var i = 0;
    while (i < text.length) {
      var ch = text[i];
      if (ch === '.') {
        if (segments.length === 0) {
          return null;
        }
        i++;
        ch = text[i];
        if (ch === undefined) {
          return null;
        }
      }
      if (ch === '"') {
        var quoted = readQuoted(text, i, '"');
        if (!quoted) {
          return null;
        }
        segments.push({ type: 'key', name: quoted.value, raw: text.slice(i, quoted.end) });
        i = quoted.end;
      } else if (/[A-Za-z_]/.test(ch)) {
        var ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))[0];
        segments.push({ type: 'key', name: ident, raw: ident });
        i += ident.length;
      } else if (ch === '[') {
        var bracket = readBracket(text, i);
        if (!bracket) {
          return null;
        }
        var segment = null;
        try {
          segment = parseBracketInner(bracket.inner, 'jmespath');
        } catch (e) {
          segment = null;
        }
        if (!segment || segment.type === 'key') {
          segment = parseJmesFunctionFilter(bracket.inner) || { type: 'opaque' };
        }
        segment.raw = text.slice(i, bracket.end);
        segments.push(segment);
        i = bracket.end;
      } else if (ch === '{' && segments.length > 0) {
        var brace = readGroup(text, i, '{', '}');
        if (!brace || brace.end !== text.length) {
          return null; // multiselect only supported at the very end
        }
        segments.push({ type: 'multiselect', inner: brace.inner, raw: text.slice(i, brace.end) });
        i = brace.end;
      } else {
        return null;
      }
    }
    return segments.length > 0 ? segments : null;
  }

  /** Loose JSONPath scan (same idea; `$` root handled by the caller). */
  function scanJsonPathLoose(text) {
    if (text[0] !== '$') {
      return null;
    }
    var segments = [];
    var i = 1;
    while (i < text.length) {
      var ch = text[i];
      if (ch === '.') {
        if (text[i + 1] === '.') {
          return null; // recursive descent has no OData equivalent
        }
        i++;
        var ident = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i));
        if (!ident) {
          return null;
        }
        segments.push({ type: 'key', name: ident[0], raw: '.' + ident[0] });
        i += ident[0].length;
      } else if (ch === '[') {
        var bracket = readBracket(text, i);
        if (!bracket) {
          return null;
        }
        var segment = null;
        try {
          segment = parseBracketInner(bracket.inner, 'jsonpath');
        } catch (e) {
          segment = null;
        }
        if (!segment) {
          segment = { type: 'opaque' };
        }
        segment.raw = text.slice(i, bracket.end);
        segments.push(segment);
        i = bracket.end;
      } else {
        return null;
      }
    }
    return segments.length > 0 ? segments : null;
  }

  /**
   * Walk loose path segments over the response's `value` collection and
   * split them into server-side OData parameters plus the client-side
   * residual (ordered text parts). Prefix-based: the first construct
   * without a server-side equivalent stops translation; everything after
   * stays in the residual untouched. Shared by the JMESPath and JSONPath
   * translators; `tokens` supplies the language-specific spellings.
   */
  function interpretCollectionSegments(segments, tokens) {
    if (segments[0].type !== 'key' || segments[0].name !== 'value') {
      return null;
    }
    var params = { filter: null, select: [], orderby: null, top: null, skip: null, count: false };
    var clauses = [];
    var notes = [];
    var parts = [tokens.key(segments[0], true)];
    var selectKeys = [];
    var phase = 'collection'; // 'items' once a wildcard/filter projects into items
    var translating = true;
    var suppressSelect = false;
    var sliceTranslated = false;
    var countable = true; // stays true only while segments reduce to value(+filters)

    function pushPass() {
      if (parts[parts.length - 1] !== tokens.pass) {
        parts.push(tokens.pass);
      }
    }

    function clientNote(raw) {
      notes.push(raw + ' stays client-side (no simple OData equivalent)');
    }

    for (var s = 1; s < segments.length; s++) {
      var seg = segments[s];
      if (seg.type === 'wildcard') {
        phase = 'items';
        countable = false;
        pushPass();
      } else if (seg.type === 'filter' || seg.type === 'filterfn') {
        var clause = null;
        if (translating && phase === 'collection' && !sliceTranslated) {
          clause = seg.type === 'filterfn' ? odataFunctionClause(seg.fn, seg.field, seg.value) : odataFilterClause(seg);
        }
        if (clause) {
          clauses.push(clause);
          phase = 'items';
          pushPass();
        } else {
          translating = false;
          suppressSelect = true; // a client filter needs the full objects
          countable = false;
          phase = 'items';
          parts.push(seg.raw);
          clientNote(seg.raw);
        }
      } else if (seg.type === 'index') {
        countable = false;
        if (translating && phase === 'collection' && !sliceTranslated && seg.value >= 0) {
          if (seg.value > 0) {
            params.skip = seg.value;
          }
          params.top = 1;
          sliceTranslated = true;
          parts.push('[0]'); // the server returns exactly the wanted item
        } else {
          translating = false;
          parts.push(seg.raw);
        }
        phase = 'items'; // a key after an index reads the item's properties
      } else if (seg.type === 'slice') {
        countable = false;
        var from = seg.from === '' ? 0 : parseInt(seg.from, 10);
        var to = seg.to === '' ? null : parseInt(seg.to, 10);
        if (translating && phase === 'collection' && !sliceTranslated && from >= 0 && (to === null || to > from)) {
          if (from > 0) {
            params.skip = from;
          }
          if (to !== null) {
            params.top = to - from;
          }
          sliceTranslated = true;
          pushPass(); // server already returns exactly the window
        } else {
          translating = false;
          parts.push(seg.raw);
        }
        phase = 'items'; // slices project into the items
      } else if (seg.type === 'key') {
        countable = false;
        if (phase === 'items') {
          if (selectKeys.length === 0 && PLAIN_IDENTIFIER.test(seg.name)) {
            selectKeys.push(seg.name);
          }
        } else {
          translating = false; // value.foo — not a collection operation
        }
        parts.push(tokens.key(seg, false));
      } else if (seg.type === 'multiselect') {
        countable = false;
        if (s !== segments.length - 1) {
          return null;
        }
        var ms = multiselectSelectKeys(seg.inner);
        if (ms.complex > 0) {
          suppressSelect = true; // unknown source fields — $select could break it
        }
        ms.keys.forEach(function (key) {
          if (selectKeys.indexOf(key) === -1) {
            selectKeys.push(key);
          }
        });
        parts.push(tokens.key(seg, false));
      } else {
        translating = false;
        suppressSelect = true;
        countable = false;
        parts.push(seg.raw);
        clientNote(seg.raw);
      }
    }
    if (!suppressSelect) {
      params.select = selectKeys;
    }
    if (clauses.length === 1) {
      params.filter = clauses[0];
    } else if (clauses.length > 1) {
      params.filter = clauses
        .map(function (clause) {
          return '(' + clause + ')';
        })
        .join(' and ');
    }
    return { params: params, notes: notes, parts: parts, countable: countable };
  }

  function toGraphQueryJmesPath(query) {
    var text = query.trim();
    var count = false;
    var lengthCall = readCall(text, 'length');
    if (lengthCall && lengthCall.rest.trim() === '') {
      count = true;
      text = lengthCall.inner.trim();
    }
    var orderby = null;
    var orderDesc = false;
    var reverseCall = readCall(text, 'reverse');
    if (reverseCall && reverseCall.rest.trim() === '' && reverseCall.inner.trim().indexOf('sort_by(') === 0) {
      orderDesc = true;
      text = reverseCall.inner.trim();
    }
    var sortCall = readCall(text, 'sort_by');
    if (sortCall) {
      var args = splitTopLevel(sortCall.inner, ',');
      var fieldMatch = args.length === 2 ? /^\s*&\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(args[1]) : null;
      if (fieldMatch) {
        orderby = fieldMatch[1];
        text = args[0].trim() + sortCall.rest;
      }
    }
    if (orderby === null && orderDesc) {
      return null; // reverse(sort_by(…)) we couldn't read — leave untranslated
    }
    var segments = scanJmesPathLoose(text);
    if (!segments) {
      return null;
    }
    var interpreted = interpretCollectionSegments(segments, {
      pass: '[]',
      key: function (seg, first) {
        if (seg.type === 'multiselect') {
          return '.' + seg.raw;
        }
        return (first ? '' : '.') + seg.raw;
      }
    });
    if (!interpreted) {
      return null;
    }
    var params = interpreted.params;
    if (orderby) {
      params.orderby = orderby + (orderDesc ? ' desc' : '');
    }
    var residual = interpreted.parts.join('');
    if (count) {
      if (interpreted.countable && !params.top && !params.skip) {
        params.count = true;
        residual = '"@odata.count"';
      } else {
        residual = 'length(' + residual + ')';
      }
    }
    return { params: params, residual: residual, notes: interpreted.notes };
  }

  function toGraphQueryJsonPath(query) {
    var segments = scanJsonPathLoose(query.trim());
    if (!segments) {
      return null;
    }
    var count = false;
    var last = segments[segments.length - 1];
    if (segments.length >= 2 && last.type === 'key' && last.name === 'length') {
      segments.pop();
      count = true;
    }
    var interpreted = interpretCollectionSegments(segments, {
      pass: '[*]',
      key: function (seg) {
        return seg.raw;
      }
    });
    if (!interpreted) {
      return null;
    }
    var params = interpreted.params;
    var residual = '$' + interpreted.parts.join('');
    if (count) {
      if (interpreted.countable && !params.top && !params.skip) {
        params.count = true;
        residual = "$['@odata.count']";
      } else {
        residual = residual + '.length';
      }
    }
    return { params: params, residual: residual, notes: interpreted.notes };
  }

  /** Literal in a jq condition: "str", number, null, true/false. */
  function parseJqLiteralText(text) {
    var trimmed = text.trim();
    if (trimmed === 'null') {
      return { kind: 'null', v: null };
    }
    if (trimmed === 'true' || trimmed === 'false') {
      return { kind: 'boolean', v: trimmed === 'true' };
    }
    var quoted = trimmed[0] === '"' ? readQuoted(trimmed, 0, '"') : null;
    if (quoted && quoted.end === trimmed.length) {
      return { kind: 'string', v: quoted.value };
    }
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return { kind: 'number', v: Number(trimmed) };
    }
    return null;
  }

  /** OData clause for a jq select() condition, or null. */
  function jqConditionClause(condition) {
    var text = condition.trim();
    var match = /^\.([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|<=|>=|<|>)\s*([\s\S]+)$/.exec(text);
    if (match) {
      var literal = parseJqLiteralText(match[3]);
      if (!literal) {
        return null;
      }
      if (literal.kind === 'null') {
        return match[2] === '==' ? match[1] + ' eq null' : match[2] === '!=' ? match[1] + ' ne null' : null;
      }
      var op = ODATA_OPS[match[2]];
      return op ? match[1] + ' ' + op + ' ' + odataLiteral(literal) : null;
    }
    match = /^\.([A-Za-z_][A-Za-z0-9_]*)\s*\|\s*(startswith|endswith|contains)\(\s*("(?:\\.|[^"\\])*")\s*\)$/.exec(text);
    if (match) {
      var value = readQuoted(match[3], 0, '"');
      return value ? odataFunctionClause(match[2], match[1], { kind: 'string', v: value.value }) : null;
    }
    match = /^\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
    if (match) {
      return match[1] + ' ne null';
    }
    return null;
  }

  /** $select keys from a jq object-construction body ({a, b: .c, …}). */
  function jqSelectKeysFromObject(inner) {
    var keys = [];
    var complex = 0;
    splitTopLevel(inner, ',').forEach(function (entry) {
      var trimmed = entry.trim();
      var shorthand = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
      if (shorthand) {
        keys.push(shorthand[1]);
        return;
      }
      var pair = /^(?:"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z0-9_]*)\s*:\s*\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
      if (pair) {
        keys.push(pair[1]);
        return;
      }
      complex++;
    });
    return { keys: keys, complex: complex };
  }

  /** Loose jq path-stage scan (raw-preserving); [] for identity `.`. */
  function scanJqPathLoose(stage) {
    if (stage[0] !== '.') {
      return null;
    }
    var segments = [];
    var i = 0;
    while (i < stage.length) {
      var ch = stage[i];
      if (ch === '.') {
        i++;
        var next = stage[i];
        if (next === undefined) {
          break; // bare `.` — identity
        }
        if (next === '"') {
          var quoted = readQuoted(stage, i, '"');
          if (!quoted) {
            return null;
          }
          segments.push({ type: 'key', name: quoted.value, raw: '.' + stage.slice(i, quoted.end) });
          i = quoted.end;
        } else if (/[A-Za-z_]/.test(next)) {
          var ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(stage.slice(i))[0];
          segments.push({ type: 'key', name: ident, raw: '.' + ident });
          i += ident.length;
        } else if (next === '[') {
          continue; // `.[…]` — bracket handled below
        } else {
          return null;
        }
      } else if (ch === '[') {
        var bracket = readBracket(stage, i);
        if (!bracket) {
          return null;
        }
        var segment = null;
        try {
          segment = parseBracketInner(bracket.inner, 'jq');
        } catch (e) {
          segment = null;
        }
        if (!segment || segment.type === 'key' || segment.type === 'filter') {
          segment = { type: 'opaque' };
        }
        segment.raw = stage.slice(i, bracket.end);
        segments.push(segment);
        i = bracket.end;
      } else {
        return null;
      }
    }
    return segments;
  }

  function toGraphQueryJq(query) {
    var text = query.trim();
    var wrapped = false;
    if (text[0] === '[') {
      var group = readBracket(text, 0);
      if (group && group.end === text.length) {
        wrapped = true;
        text = group.inner.trim();
      }
    }
    var stages = splitTopLevel(text, '|').map(function (stage) {
      return stage.trim();
    });
    if (stages.length === 0 || stages[0] === '' || stages[0][0] !== '.') {
      return null;
    }

    var params = { filter: null, select: [], orderby: null, top: null, skip: null, count: false };
    var clauses = [];
    var notes = [];
    var residualStages = [];
    var selectKeys = [];
    var translating = true;
    var suppressSelect = false;
    var streaming = false; // pipeline is per-item after a `[]`
    var descended = false; // descended into item properties / reshaped
    var singleItem = false; // an index reduced the pipeline to one item
    var sliceTranslated = false;
    var lastTranslatedSort = false;

    function clientNote(stageText) {
      notes.push(stageText + ' stays client-side (no simple OData equivalent)');
    }

    for (var s = 0; s < stages.length; s++) {
      var stage = stages[s];
      if (stage === '') {
        return null;
      }
      if (!translating) {
        residualStages.push(stage);
        continue;
      }
      var isLast = s === stages.length - 1;

      if (stage === 'length' && isLast && s > 0) {
        if (!streaming && !descended && !sliceTranslated && !suppressSelect && selectKeys.length === 0) {
          params.count = true; // residual is rewritten to @odata.count below
        } else {
          residualStages.push(stage);
        }
        continue;
      }

      if (stage === 'reverse') {
        if (lastTranslatedSort && params.orderby && params.orderby.indexOf(' desc') === -1) {
          params.orderby += ' desc';
        } else {
          residualStages.push(stage);
          translating = false;
        }
        continue;
      }

      // map(select(…)) / select(…) → $filter; map({…}) → $select hints.
      var conditionText = null;
      var objectInner = null;
      var mapCall = readCall(stage, 'map');
      if (mapCall && mapCall.rest.trim() === '') {
        var mapInner = mapCall.inner.trim();
        var selectCall = readCall(mapInner, 'select');
        if (selectCall && selectCall.rest.trim() === '') {
          conditionText = selectCall.inner;
        } else if (mapInner[0] === '{') {
          var mapGroup = readGroup(mapInner, 0, '{', '}');
          if (mapGroup && mapGroup.end === mapInner.length) {
            objectInner = mapGroup.inner;
          }
        }
      } else {
        var bareSelect = readCall(stage, 'select');
        if (bareSelect && bareSelect.rest.trim() === '') {
          conditionText = bareSelect.inner;
        }
      }
      if (conditionText !== null) {
        lastTranslatedSort = false;
        var clause = !descended && !sliceTranslated ? jqConditionClause(conditionText) : null;
        if (clause) {
          clauses.push(clause); // server-side — the stage disappears
        } else {
          residualStages.push(stage);
          translating = false;
          suppressSelect = true;
          clientNote(stage);
        }
        continue;
      }

      var sortCall = readCall(stage, 'sort_by');
      if (sortCall && sortCall.rest.trim() === '') {
        var sortField = /^\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(sortCall.inner);
        if (sortField && !streaming && !descended && !sliceTranslated && params.orderby === null) {
          params.orderby = sortField[1];
          lastTranslatedSort = true;
        } else {
          residualStages.push(stage);
          translating = false;
        }
        continue;
      }

      if (stage[0] === '{' || objectInner !== null) {
        lastTranslatedSort = false;
        var objInner = objectInner;
        if (objInner === null) {
          var stageGroup = readGroup(stage, 0, '{', '}');
          objInner = stageGroup && stageGroup.end === stage.length ? stageGroup.inner : null;
        }
        if (objInner === null) {
          residualStages.push(stage);
          translating = false;
          suppressSelect = true;
          clientNote(stage);
          continue;
        }
        var objKeys = jqSelectKeysFromObject(objInner);
        if (objKeys.complex > 0) {
          suppressSelect = true; // unknown source fields — $select could break it
        }
        objKeys.keys.forEach(function (key) {
          if (selectKeys.indexOf(key) === -1) {
            selectKeys.push(key);
          }
        });
        descended = true;
        residualStages.push(stage); // the reshape itself stays client-side
        continue;
      }

      if (stage[0] === '.') {
        var segments = scanJqPathLoose(stage);
        if (segments === null) {
          residualStages.push(stage);
          translating = false;
          suppressSelect = true;
          clientNote(stage);
          continue;
        }
        lastTranslatedSort = false;
        if (s === 0 && (segments.length === 0 || segments[0].type !== 'key' || segments[0].name !== 'value')) {
          return null; // the pipeline must start at the value collection
        }
        var rebuilt = '';
        for (var g = 0; g < segments.length; g++) {
          var seg = segments[g];
          if (seg.type === 'key') {
            if (!(s === 0 && g === 0)) {
              var onItems = streaming || singleItem || (g > 0 && segments[g - 1].type === 'wildcard');
              if (onItems && !descended && selectKeys.length === 0 && PLAIN_IDENTIFIER.test(seg.name)) {
                selectKeys.push(seg.name);
              } else if (!onItems && !descended) {
                translating = false; // .value.foo — not a collection operation
              }
              descended = true;
            }
            rebuilt += seg.raw;
          } else if (seg.type === 'wildcard') {
            streaming = true;
            rebuilt += seg.raw;
          } else if (seg.type === 'index' || seg.type === 'slice') {
            var translated = false;
            if (seg.type === 'index') {
              singleItem = true; // whatever follows reads one item's properties
            }
            if (translating && !streaming && !descended && !sliceTranslated) {
              if (seg.type === 'index' && seg.value >= 0) {
                if (seg.value > 0) {
                  params.skip = seg.value;
                }
                params.top = 1;
                sliceTranslated = true;
                rebuilt += '[0]';
                translated = true;
              } else if (seg.type === 'slice') {
                var from = seg.from === '' ? 0 : parseInt(seg.from, 10);
                var to = seg.to === '' ? null : parseInt(seg.to, 10);
                if (from >= 0 && (to === null || to > from)) {
                  if (from > 0) {
                    params.skip = from;
                  }
                  if (to !== null) {
                    params.top = to - from;
                  }
                  sliceTranslated = true;
                  translated = true; // server returns exactly the window
                }
              }
            }
            if (!translated) {
              translating = false;
              rebuilt += seg.raw;
            }
          } else {
            translating = false;
            suppressSelect = true;
            rebuilt += seg.raw;
            clientNote(seg.raw);
          }
        }
        if (rebuilt !== '') {
          residualStages.push(rebuilt[0] === '[' ? '.' + rebuilt : rebuilt);
        }
        continue;
      }

      residualStages.push(stage);
      translating = false;
      suppressSelect = true;
      clientNote(stage);
    }

    if (!suppressSelect) {
      params.select = selectKeys;
    }
    if (clauses.length === 1) {
      params.filter = clauses[0];
    } else if (clauses.length > 1) {
      params.filter = clauses
        .map(function (clause) {
          return '(' + clause + ')';
        })
        .join(' and ');
    }
    var residual = params.count ? '."@odata.count"' : residualStages.join(' | ');
    if (wrapped && !params.count) {
      residual = '[' + residual + ']';
    }
    return { params: params, residual: residual, notes: notes };
  }

  /**
   * Translate a panel query into the Microsoft Graph OData query options
   * that make the server do (part of) the work. Returns
   * { ok: true, params, residual, notes, advanced } — `params` holds
   * $filter/$select/$orderby/$top/$skip/$count values, `residual` is the
   * query that must still run client-side against the new response to
   * reproduce the original result, `notes` names the pieces that could
   * not be translated, and `advanced` flags parameters that need the
   * ConsistencyLevel: eventual header. When nothing can run server-side:
   * { ok: false, reason }.
   */
  function toGraphQuery(language, query) {
    if (typeof query !== 'string' || query.trim() === '') {
      return { ok: false, reason: 'Type a query first — an empty query has nothing to translate.' };
    }
    var result = null;
    try {
      if (language === 'jsonpath') {
        result = toGraphQueryJsonPath(query);
      } else if (language === 'jq') {
        result = toGraphQueryJq(query);
      } else if (language === 'jmespath') {
        result = toGraphQueryJmesPath(query);
      }
    } catch (e) {
      result = null;
    }
    if (!result) {
      return {
        ok: false,
        reason: 'Only queries over the value collection built from filters, field picks, sorting, slicing, and counts can be translated into Graph query options.'
      };
    }
    var params = result.params;
    var hasParams = !!(
      params.filter ||
      params.select.length > 0 ||
      params.orderby ||
      params.count ||
      params.top !== null ||
      params.skip !== null
    );
    if (!hasParams) {
      return { ok: false, reason: 'This query has no server-side part — it only reshapes what the server already returns.' };
    }
    return {
      ok: true,
      params: params,
      residual: result.residual,
      notes: result.notes,
      advanced: !!(params.filter || params.orderby || params.count)
    };
  }

  /**
   * Merge translated OData params into a captured Graph request URL.
   * Existing $filter is combined with `and`; other overlapping options
   * are replaced (each replacement is reported in `notes`); unrelated
   * parameters are kept. Returns { url, notes } or null when sourceUrl
   * is not a parseable URL. Values stay readable (only characters that
   * would break parameter parsing are escaped).
   */
  function graphQueryUrl(sourceUrl, params) {
    var parsed;
    try {
      parsed = new URL(sourceUrl);
    } catch (e) {
      return null;
    }
    var kept = [];
    var existingFilter = null;
    var notes = [];
    parsed.searchParams.forEach(function (value, key) {
      var k = key.toLowerCase();
      if (k === '$filter' && params.filter) {
        existingFilter = value;
        return;
      }
      if (
        (k === '$select' && params.select.length > 0) ||
        (k === '$orderby' && params.orderby) ||
        (k === '$top' && params.top !== null) ||
        (k === '$skip' && params.skip !== null) ||
        (k === '$count' && params.count)
      ) {
        notes.push('replaces the request’s existing ' + key);
        return;
      }
      kept.push([key, value]);
    });
    var filter = params.filter || null;
    if (existingFilter) {
      filter = '(' + existingFilter + ') and (' + filter + ')';
      notes.push('combined with the request’s existing $filter');
    }
    var pairs = kept;
    if (filter) {
      pairs.push(['$filter', filter]);
    }
    if (params.select.length > 0) {
      pairs.push(['$select', params.select.join(',')]);
    }
    if (params.orderby) {
      pairs.push(['$orderby', params.orderby]);
    }
    if (params.skip !== null && params.skip !== undefined) {
      pairs.push(['$skip', String(params.skip)]);
    }
    if (params.top !== null && params.top !== undefined) {
      pairs.push(['$top', String(params.top)]);
    }
    if (params.count) {
      pairs.push(['$count', 'true']);
    }
    var query = pairs
      .map(function (pair) {
        var value = String(pair[1])
          .replace(/%/g, '%25')
          .replace(/&/g, '%26')
          .replace(/\+/g, '%2B')
          .replace(/#/g, '%23');
        return pair[0] + '=' + value;
      })
      .join('&');
    return { url: parsed.origin + parsed.pathname + (query ? '?' + query : ''), notes: notes };
  }

  // Graph Explorer's own AAD client id — its permission-management
  // requests (oauth2PermissionGrants, servicePrincipals) embed it.
  var GRAPH_EXPLORER_CLIENT_ID = 'de8bc8b5-d9f9-48b1-a8ad-b748da725064';

  // Exact request URLs (path only, no query string) Graph Explorer
  // issues on its own after sign-in: signed-in user, profile type,
  // tenant organization.
  var BACKGROUND_PATHS = ['/v1.0/me', '/beta/me/profile', '/beta/me/photo/$value', '/v1.0/organization'];

  /**
   * True when a captured request looks like one of Graph Explorer's own
   * background calls (sign-in profile/organization lookups, permission
   * management) rather than a query the user ran. Note the ambiguity: a
   * deliberately-run plain `GET /me` matches too — the panel keeps such
   * entries behind a "background" toggle instead of dropping them.
   */
  function isBackgroundGraphRequest(url) {
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return false;
    }
    var path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    if (parsed.search === '' && BACKGROUND_PATHS.indexOf(path) !== -1) {
      return true;
    }
    var query;
    try {
      query = decodeURIComponent(parsed.search).toLowerCase();
    } catch (e) {
      query = parsed.search.toLowerCase();
    }
    if (query.indexOf(GRAPH_EXPLORER_CLIENT_ID) !== -1) {
      return true; // permission grants / service principal lookups for GE itself
    }
    if (/\/oauth2permissiongrants(\/|$)/.test(path) || /\/serviceprincipals(\/|$)/.test(path)) {
      return true;
    }
    return false;
  }

  /**
   * Split an HTTP method pasted in front of a request URI — e.g.
   * "GET https://graph.microsoft.com/v1.0/me", the exact shape of the
   * panel's own response rows and of most docs samples — into
   * { method, uri }. Returns null when there is no method prefix or the
   * remainder does not look like a request URI (absolute URL, absolute
   * path, or a bare v1.0/… | beta/… request).
   */
  function splitMethodPrefix(value) {
    if (typeof value !== 'string') {
      return null;
    }
    var match = /^\s*(GET|POST|PUT|PATCH|DELETE)\s+(\S.*)$/i.exec(value);
    if (!match) {
      return null;
    }
    var uri = match[2].trim();
    if (!/^(https?:\/\/|\/|v1\.0[/?]|beta[/?])/i.test(uri)) {
      return null;
    }
    return { method: match[1].toUpperCase(), uri: uri };
  }

  /**
   * Parse the URI field's value into a URL, tolerating a pasted method
   * prefix ("GET https://…") and host-relative paths (resolved against
   * the captured request's origin). Returns null when it can't parse.
   */
  function parseEditorRequestUrl(editorValue, baseOrigin) {
    if (!editorValue || typeof editorValue !== 'string') {
      return null;
    }
    var trimmed = editorValue.trim();
    var prefixed = splitMethodPrefix(trimmed);
    if (prefixed) {
      trimmed = prefixed.uri;
    }
    try {
      return new URL(trimmed);
    } catch (e) {
      try {
        return new URL(trimmed, baseOrigin);
      } catch (e2) {
        return null;
      }
    }
  }

  /**
   * True when a captured request URL corresponds to the query currently
   * sitting in Graph Explorer's URI field — the strongest signal that
   * the user ran it deliberately. Tolerates encoding differences, a
   * pasted method prefix, and the `$count=true` the advanced-query
   * setting injects (on either side: the field-side insertion can land
   * just after the request was sent without it).
   */
  function graphRequestMatchesEditor(capturedUrl, editorValue) {
    var captured;
    try {
      captured = new URL(capturedUrl);
    } catch (e) {
      return false;
    }
    var editor = parseEditorRequestUrl(editorValue, captured.origin);
    if (!editor) {
      return false;
    }
    if (captured.origin.toLowerCase() !== editor.origin.toLowerCase()) {
      return false;
    }
    var capturedPath = captured.pathname.replace(/\/+$/, '').toLowerCase();
    var editorPath = editor.pathname.replace(/\/+$/, '').toLowerCase();
    if (capturedPath !== editorPath) {
      return false;
    }
    var capturedParams = {};
    captured.searchParams.forEach(function (value, key) {
      capturedParams[key.toLowerCase()] = value;
    });
    var mismatch = false;
    var seen = {};
    editor.searchParams.forEach(function (value, key) {
      var k = key.toLowerCase();
      if (!(k in capturedParams) || capturedParams[k] !== value) {
        if (!(k === '$count' && value === 'true' && !(k in capturedParams))) {
          mismatch = true;
        }
      }
      seen[k] = true;
    });
    if (mismatch) {
      return false;
    }
    var extras = Object.keys(capturedParams).filter(function (k) {
      return !seen[k] && !(k === '$count' && capturedParams[k] === 'true');
    });
    return extras.length === 0;
  }

  /**
   * Weaker match than graphRequestMatchesEditor: same origin and
   * resource path as the URI field, query options aside. When the user
   * iterates on a query's parameters ($select/$expand/$filter/…) the
   * field can drift from the exact URL that was sent — an edit right
   * after Run, or the advanced-query $count insertion racing a request —
   * but it still points at the same resource, which no Graph Explorer
   * background call does.
   */
  function graphRequestPathMatchesEditor(capturedUrl, editorValue) {
    var captured;
    try {
      captured = new URL(capturedUrl);
    } catch (e) {
      return false;
    }
    var editor = parseEditorRequestUrl(editorValue, captured.origin);
    if (!editor) {
      return false;
    }
    return (
      captured.origin.toLowerCase() === editor.origin.toLowerCase() &&
      captured.pathname.replace(/\/+$/, '').toLowerCase() === editor.pathname.replace(/\/+$/, '').toLowerCase()
    );
  }

  // Never captured: credentials and Graph Explorer's own telemetry
  // headers (GE re-adds those itself on every request).
  var DROPPED_REQUEST_HEADERS = ['authorization', 'cookie', 'sdkversion', 'client-request-id'];

  // Comma-separated headers whose Graph-Explorer-added directives are
  // stripped token by token: whatever the user typed themselves survives,
  // and the header is dropped only when nothing of theirs remains. GE
  // sends `Prefer: ms-graph-dev-mode` plus cache-busting
  // `Cache-Control`/`Pragma: no-cache` on every request; restoring those
  // into the Request-headers view was noise nobody asked for, while a
  // hand-typed `Cache-Control: max-age=0` is worth keeping.
  var STRIPPED_HEADER_TOKENS = {
    prefer: ['ms-graph-dev-mode'],
    'cache-control': ['no-cache', 'no-store'],
    pragma: ['no-cache']
  };

  /** Split a comma-separated header value, ignoring commas inside "…". */
  function splitHeaderTokens(value) {
    var tokens = [];
    var current = '';
    var quoted = false;
    for (var i = 0; i < value.length; i++) {
      var ch = value[i];
      if (ch === '"') {
        quoted = !quoted;
        current += ch;
      } else if (ch === ',' && !quoted) {
        tokens.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    tokens.push(current.trim());
    return tokens;
  }

  /**
   * Reduce a request's headers to the ones worth remembering and
   * restoring: credentials and Graph Explorer telemetry are dropped, and
   * the directives GE adds to `Prefer`, `Cache-Control` and `Pragma` are
   * stripped out of those headers' values (each is kept only when the
   * user's own tokens remain — see STRIPPED_HEADER_TOKENS).
   * Input and output are arrays of { name, value }.
   */
  function sanitizeRequestHeaders(pairs) {
    var out = [];
    (Array.isArray(pairs) ? pairs : []).forEach(function (pair) {
      if (out.length >= 20 || !pair || typeof pair.name !== 'string' || typeof pair.value !== 'string') {
        return;
      }
      var name = pair.name.trim();
      var lower = name.toLowerCase();
      if (DROPPED_REQUEST_HEADERS.indexOf(lower) !== -1) {
        return;
      }
      var value = pair.value;
      var strip = STRIPPED_HEADER_TOKENS[lower];
      if (strip) {
        value = splitHeaderTokens(value)
          .filter(function (token) {
            return token !== '' && strip.indexOf(token.toLowerCase()) === -1;
          })
          .join(', ');
        if (value === '') {
          return; // nothing the user added — drop the header entirely
        }
      }
      out.push({ name: name, value: value });
    });
    return out;
  }

  /** True when two { name, value } lists are element-wise identical. */
  function sameHeaderList(a, b) {
    if (!Array.isArray(a) || a.length !== b.length) {
      return false;
    }
    for (var i = 0; i < b.length; i++) {
      if (!a[i] || a[i].name !== b[i].name || a[i].value !== b[i].value) {
        return false;
      }
    }
    return true;
  }

  /**
   * Re-run header sanitization over a stored query history. Entries saved
   * by older versions predate the current drop/strip rules (and imported
   * libraries were never sanitized at all), so their headers are cleaned
   * on load rather than replayed into Graph Explorer as-is. Returns
   * { list, changed } — `changed` lets the caller persist only when
   * something was actually rewritten. Never mutates the input.
   */
  function sanitizeQueryHistory(list) {
    var changed = false;
    var out = (Array.isArray(list) ? list : []).map(function (entry) {
      if (!entry || !entry.context || typeof entry.context !== 'object') {
        return entry;
      }
      var headers = sanitizeRequestHeaders(entry.context.headers);
      if (sameHeaderList(entry.context.headers, headers)) {
        return entry;
      }
      changed = true;
      var context = {};
      Object.keys(entry.context).forEach(function (key) {
        context[key] = entry.context[key];
      });
      context.headers = headers;
      var copy = {};
      Object.keys(entry).forEach(function (key) {
        copy[key] = entry[key];
      });
      copy.context = context;
      return copy;
    });
    return { list: out, changed: changed };
  }

  /**
   * Decide whether a captured Graph request is one of Graph Explorer's
   * own background calls, combining three signals:
   *  - known-internal URL patterns (profile, organization, permission
   *    grants, service principals),
   *  - whether the URL matches the query in Graph Explorer's URI field —
   *    exactly, or (for non-pattern URLs) at least the same resource
   *    path, so iterating on a query's parameters never hides the
   *    response when the field has drifted from the exact sent URL,
   *  - whether the user recently ran a query (Run button / Enter),
   *    passed as msSinceRun (-1 = never).
   * The URI field alone is not enough: it is pre-filled with /v1.0/me,
   * which is exactly what Graph Explorer fetches on sign-in — hence
   * pattern matches also require a recent run to count as user-driven.
   * Unknown URLs that match neither the field nor a recent run are
   * treated as background too (Graph Explorer may add new internal
   * calls); the panel keeps them behind a toggle rather than dropping
   * them, so a misclassification is always recoverable.
   */
  function classifyBackgroundRequest(url, editorValue, msSinceRun) {
    var recentRun = typeof msSinceRun === 'number' && msSinceRun >= 0 && msSinceRun < 15000;
    var editorMatch = graphRequestMatchesEditor(url, editorValue);
    if (isBackgroundGraphRequest(url)) {
      return !(editorMatch && recentRun);
    }
    if (editorMatch) {
      return false;
    }
    if (graphRequestPathMatchesEditor(url, editorValue)) {
      return false;
    }
    return !recentRun;
  }

  /**
   * Split a Graph API URL into the parts Graph Explorer's deep-link
   * format uses: { graphUrl, version, request }. Returns null when the
   * URL does not look like <cloud host>/<v1.0|beta>/<resource…>.
   */
  function parseGraphRequest(url) {
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return null;
    }
    var segments = parsed.pathname.split('/').filter(function (segment) {
      return segment !== '';
    });
    if (segments.length === 0 || !/^(v1\.0|beta)$/i.test(segments[0])) {
      return null;
    }
    var request = segments.slice(1).join('/') + parsed.search;
    if (request === '') {
      return null;
    }
    return {
      graphUrl: parsed.origin,
      version: segments[0],
      request: request
    };
  }

  /**
   * Build a Graph Explorer deep link (the same format its own
   * "Share query" feature produces) that pre-fills method, version and
   * resource URL on load. `pageBase` is the Graph Explorer page URL
   * without query string. Returns null for URLs parseGraphRequest
   * cannot handle.
   */
  function buildDeepLink(pageBase, method, url) {
    var parts = parseGraphRequest(url);
    if (!parts) {
      return null;
    }
    return (
      pageBase +
      '?request=' + encodeURIComponent(parts.request) +
      '&method=' + encodeURIComponent(String(method || 'GET').toUpperCase()) +
      '&version=' + encodeURIComponent(parts.version) +
      '&GraphUrl=' + encodeURIComponent(parts.graphUrl)
    );
  }

  /**
   * Trim the query history to `limit` entries (0/null = unlimited),
   * removing the oldest unstarred entries first. Starred (favorite)
   * entries are never removed automatically.
   */
  function trimQueryHistoryList(list, limit) {
    if (!limit || limit <= 0 || !Array.isArray(list)) {
      return list;
    }
    // Favorites are fully exempt: keep every starred entry, and cap only the
    // NON-favorites to `limit` (newest first). Capping the combined length
    // instead meant a full set of favorites could crowd out — and instantly
    // trim — every newly-run query.
    var out = [];
    var nonFavorites = 0;
    for (var i = 0; i < list.length; i++) {
      if (!list[i]) {
        continue;
      }
      if (list[i].starred) {
        out.push(list[i]);
      } else if (nonFavorites < limit) {
        out.push(list[i]);
        nonFavorites++;
      }
    }
    return out;
  }

  /**
   * Insert an executed query into the query history (newest first).
   * Entries are unique per (language, query): re-running a query moves it
   * to the top, bumps `uses`, refreshes `lastUsed`/`context`, and keeps
   * its star and tags. `limit` caps the list length (favorites exempt);
   * 0 (or null) means unlimited.
   */
  function upsertQueryHistory(list, entry, limit) {
    var out = [];
    var existing = null;
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (item && item.query === entry.query && item.language === entry.language) {
        existing = item;
      } else if (item) {
        out.push(item);
      }
    });
    out.unshift({
      query: entry.query,
      language: entry.language,
      lastUsed: entry.lastUsed,
      uses: ((existing && existing.uses) || 0) + 1,
      context: entry.context || (existing && existing.context) || null,
      starred: !!(existing && existing.starred),
      tags: (existing && existing.tags) || [],
      label: (existing && existing.label) || ''
    });
    return trimQueryHistoryList(out, limit);
  }

  /**
   * Group the query history for display: favorites pinned first, the
   * rest under "Recent" (tags are shown per entry and used for
   * filtering, not grouping). Order inside each group stays
   * newest-first. Returns [{ title, items }] with empty groups omitted.
   */
  function groupQueryHistory(list) {
    var favorites = [];
    var recent = [];
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (!item) {
        return;
      }
      (item.starred ? favorites : recent).push(item);
    });
    var groups = [];
    if (favorites.length > 0) {
      groups.push({ title: '★ Favorites', items: favorites });
    }
    if (recent.length > 0) {
      groups.push({ title: 'Recent', items: recent });
    }
    return groups;
  }

  /**
   * Keep only the filter tags that still exist somewhere in the history.
   * The tag chips are built from the history, so a tag removed from the
   * last entry carrying it would otherwise leave the list filtered by
   * something with no chip left to switch back off — an empty view with
   * no way out. Input order is preserved.
   */
  function knownFilterTags(tags, list) {
    var known = {};
    distinctTags(list).forEach(function (tag) {
      known[tag] = true;
    });
    return (Array.isArray(tags) ? tags : []).filter(function (tag) {
      return known[tag] === true;
    });
  }

  /** Distinct tags across the history, alphabetical. */
  function distinctTags(list) {
    var seen = {};
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (item) {
      (item && Array.isArray(item.tags) ? item.tags : []).forEach(function (tag) {
        if (!seen[tag]) {
          seen[tag] = true;
          out.push(tag);
        }
      });
    });
    return out.sort(function (a, b) {
      return a.localeCompare(b);
    });
  }

  /**
   * Filter the query history. `filter` supports:
   *  - text: case-insensitive substring over query, language, tags, and
   *    the recorded request (method + URL)
   *  - sinceMs: only entries used within the last N milliseconds
   *  - tags: entries carrying ALL of the given tags
   * Order is preserved.
   */
  function filterQueryHistory(list, filter, now) {
    var text = ((filter && filter.text) || '').trim().toLowerCase();
    var tags = (filter && filter.tags) || [];
    var cutoff = filter && filter.sinceMs > 0 && typeof now === 'number' ? now - filter.sinceMs : 0;
    return (Array.isArray(list) ? list : []).filter(function (item) {
      if (!item) {
        return false;
      }
      if (cutoff && !(item.lastUsed >= cutoff)) {
        return false;
      }
      var itemTags = Array.isArray(item.tags) ? item.tags : [];
      for (var t = 0; t < tags.length; t++) {
        if (itemTags.indexOf(tags[t]) === -1) {
          return false;
        }
      }
      if (text) {
        var haystack = [
          item.query,
          item.language,
          itemTags.join(' '),
          item.context ? item.context.method + ' ' + item.context.url : ''
        ]
          .join(' ')
          .toLowerCase();
        if (haystack.indexOf(text) === -1) {
          return false;
        }
      }
      return true;
    });
  }

  /** "14:32:05" for today, "2026-08-06 14:32" for older timestamps. */
  function formatTimestamp(timestamp, now) {
    var time = new Date(timestamp);
    var reference = now === undefined ? new Date() : new Date(now);
    var pad = function (n) {
      return (n < 10 ? '0' : '') + n;
    };
    var clock = pad(time.getHours()) + ':' + pad(time.getMinutes());
    if (
      time.getFullYear() === reference.getFullYear() &&
      time.getMonth() === reference.getMonth() &&
      time.getDate() === reference.getDate()
    ) {
      return clock + ':' + pad(time.getSeconds());
    }
    return time.getFullYear() + '-' + pad(time.getMonth() + 1) + '-' + pad(time.getDate()) + ' ' + clock;
  }

  /**
   * Microsoft Graph "advanced queries" against directory objects require
   * the `ConsistencyLevel: eventual` header together with `$count=true`
   * (see https://learn.microsoft.com/graph/aad-advanced-queries).
   *
   * Given an outgoing request, decide whether to opt it into advanced
   * query mode: GET requests using $filter, $search, $orderby, or $count
   * get `$count=true` appended (when missing) and the header added.
   * Everything else passes through untouched.
   *
   * Returns { url, addHeader, addCount } — url is possibly rewritten;
   * addCount is true only when `$count=true` was actually appended (a
   * `/$count` path segment needs the header but must NOT get the query
   * parameter — callers must key their own insertion off addCount).
   */
  function applyAdvancedQuery(url, method) {
    var unchanged = { url: url, addHeader: false, addCount: false };
    if (String(method || 'GET').toUpperCase() !== 'GET') {
      return unchanged;
    }
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return unchanged;
    }
    // `GET /users/$count` style requests also need the header.
    if (/\/\$count$/i.test(parsed.pathname)) {
      return { url: url, addHeader: true, addCount: false };
    }
    var hasTrigger = false;
    var hasCount = false;
    parsed.searchParams.forEach(function (paramValue, paramName) {
      var name = paramName.toLowerCase();
      if (name === '$filter' || name === '$search' || name === '$orderby') {
        hasTrigger = true;
      }
      if (name === '$count') {
        hasCount = true;
      }
    });
    if (!hasTrigger && !hasCount) {
      return unchanged;
    }
    if (!hasCount) {
      parsed.searchParams.append('$count', 'true');
    }
    return { url: parsed.href, addHeader: true, addCount: !hasCount };
  }

  /**
   * How a value can be represented as CSV: 'objects' (array of flat
   * objects), 'scalars' (array of primitives), or null (not CSV-able).
   */
  function csvShape(value) {
    if (!Array.isArray(value) || value.length === 0) {
      return null;
    }
    var allObjects = value.every(function (row) {
      return row !== null && typeof row === 'object' && !Array.isArray(row);
    });
    if (allObjects) {
      var hasColumns = value.some(function (row) {
        return Object.keys(row).length > 0;
      });
      return hasColumns ? 'objects' : null;
    }
    var allScalars = value.every(function (row) {
      return row === null || typeof row !== 'object';
    });
    return allScalars ? 'scalars' : null;
  }

  /** Cheap check (no string building) used to enable/disable CSV export. */
  function csvEligible(value) {
    return csvShape(value) !== null;
  }

  /** Display text for one table cell (objects JSON-encoded, capped). */
  function csvCellText(cell) {
    if (cell === null || cell === undefined) {
      return '';
    }
    var text = typeof cell === 'object' ? JSON.stringify(cell) : String(cell);
    return text.length > 200 ? text.slice(0, 200) + '…' : text;
  }

  /**
   * Table-view package for a query result: sorted display cells for the
   * first `limit` rows plus the column set and total row count. Shared
   * by the panel (local rendering) and the off-thread evaluator (which
   * sends only this package back for large results instead of the whole
   * result). `sort` is { column, dir } with column null for unsorted;
   * scalar rows sort by the row itself whatever the column says.
   * Returns { eligible: false } when the value has no table shape.
   */
  function csvPreview(value, sort, limit) {
    var shape = csvShape(value);
    if (shape === null) {
      return { eligible: false };
    }
    var rows = value;
    if (sort && sort.column !== null && sort.column !== undefined) {
      rows = sortRows(value, shape === 'objects' ? sort.column : null, sort.dir);
    }
    var columns = shape === 'objects' ? csvColumns(rows) : ['value'];
    var max = typeof limit === 'number' && limit > 0 ? limit : rows.length;
    var cells = [];
    for (var i = 0; i < rows.length && i < max; i++) {
      var row = rows[i];
      if (shape === 'objects') {
        cells.push(
          columns.map(function (column) {
            return csvCellText(row[column]);
          })
        );
      } else {
        cells.push([csvCellText(row)]);
      }
    }
    return { eligible: true, shape: shape, columns: columns, rows: cells, total: rows.length };
  }

  /** Union of keys across an array of objects (column order = first seen). */
  function csvColumns(rows) {
    var columns = [];
    rows.forEach(function (row) {
      Object.keys(row).forEach(function (key) {
        if (columns.indexOf(key) === -1) {
          columns.push(key);
        }
      });
    });
    return columns;
  }

  function toDelimited(value, delimiter) {
    var shape = csvShape(value);
    if (shape === null) {
      return null;
    }

    function escapeCell(cell) {
      if (cell === null || cell === undefined) {
        return '';
      }
      var text;
      if (typeof cell === 'object') {
        text = JSON.stringify(cell);
      } else {
        text = String(cell);
      }
      // Neutralize spreadsheet formula injection (CWE-1236): Graph field
      // values are attacker-controllable (a displayName, mail subject, file
      // name, …). A textual cell starting with =, +, -, @ (or a control
      // char some parsers strip to reach one) is evaluated as a formula by
      // Excel / Sheets / LibreOffice on open — so prefix a guarding
      // apostrophe. Quoting alone is not a fix: Excel still parses "=…" as
      // a formula. Real numbers are exempt so negatives stay numeric.
      if (typeof cell !== 'number' && /^[=+\-@\t\r]/.test(text)) {
        text = "'" + text;
      }
      if (text.indexOf(delimiter) !== -1 || /["\n\r]/.test(text)) {
        text = '"' + text.replace(/"/g, '""') + '"';
      }
      return text;
    }

    var lines = [];
    if (shape === 'objects') {
      var columns = csvColumns(value);
      lines.push(columns.map(escapeCell).join(delimiter));
      value.forEach(function (row) {
        lines.push(
          columns
            .map(function (column) {
              return escapeCell(row[column]);
            })
            .join(delimiter)
        );
      });
      return lines.join('\r\n');
    }

    lines.push('value');
    value.forEach(function (row) {
      lines.push(escapeCell(row));
    });
    return lines.join('\r\n');
  }

  /**
   * Convert a query result to CSV. Supports arrays of flat objects
   * (nested values are JSON-encoded into the cell) and arrays of scalars.
   * Returns null when the value has no sensible CSV representation.
   */
  function toCsv(value) {
    return toDelimited(value, ',');
  }

  /** Tab-separated variant — pastes straight into Excel as a grid. */
  function toTsv(value) {
    return toDelimited(value, '\t');
  }

  /**
   * Sort table rows by a column: numbers numerically, everything else as
   * localeCompared strings; null/undefined/missing last. `direction` is
   * 1 (ascending) or -1. For arrays of scalars use column null. Returns
   * a new array; input order is kept for equal keys (stable).
   */
  function sortRows(rows, column, direction) {
    if (!Array.isArray(rows)) {
      return rows;
    }
    var dir = direction === -1 ? -1 : 1;
    var decorated = rows.map(function (row, index) {
      var cell = column === null || column === undefined ? row : row && typeof row === 'object' ? row[column] : undefined;
      return { row: row, index: index, cell: cell };
    });
    decorated.sort(function (a, b) {
      var av = a.cell;
      var bv = b.cell;
      var aMissing = av === null || av === undefined;
      var bMissing = bv === null || bv === undefined;
      if (aMissing && bMissing) {
        return a.index - b.index;
      }
      if (aMissing) {
        return 1; // missing values last, regardless of direction
      }
      if (bMissing) {
        return -1;
      }
      var result;
      if (typeof av === 'number' && typeof bv === 'number') {
        result = av - bv;
      } else if (typeof av === 'boolean' && typeof bv === 'boolean') {
        result = av === bv ? 0 : av ? 1 : -1;
      } else {
        var as = typeof av === 'object' ? JSON.stringify(av) : String(av);
        var bs = typeof bv === 'object' ? JSON.stringify(bv) : String(bv);
        result = as.localeCompare(bs);
      }
      return result === 0 ? a.index - b.index : result * dir;
    });
    return decorated.map(function (entry) {
      return entry.row;
    });
  }

  /**
   * Build a query in the given language from tree path segments
   * ({type:'key'|'index'|'wildcard'} — the shared converter model).
   * Returns null when the language can't express the path.
   */
  function pathQuery(language, segments) {
    var emit = QUERY_EMITTERS[language];
    if (!emit || !Array.isArray(segments) || segments.length === 0) {
      return null;
    }
    return emit({ count: false, segments: segments });
  }

  /**
   * Structural JSON diff. Returns up to `limit` entries of
   * { path, kind: 'added'|'removed'|'changed', before, after }, where
   * `path` is a human-readable pointer like "value[3].displayName".
   * Arrays are compared element-wise by index.
   */
  function diffJson(before, after, limit) {
    var max = limit || 500;
    var out = [];

    function record(path, kind, beforeValue, afterValue) {
      if (out.length < max) {
        out.push({ path: path || '(root)', kind: kind, before: beforeValue, after: afterValue });
      }
    }

    function walk(a, b, path) {
      if (out.length >= max) {
        return;
      }
      if (a === b) {
        return;
      }
      var aIsObj = a !== null && typeof a === 'object';
      var bIsObj = b !== null && typeof b === 'object';
      if (!aIsObj || !bIsObj || Array.isArray(a) !== Array.isArray(b)) {
        record(path, 'changed', a, b);
        return;
      }
      if (Array.isArray(a)) {
        var shared = Math.min(a.length, b.length);
        for (var i = 0; i < shared; i++) {
          walk(a[i], b[i], path + '[' + i + ']');
        }
        for (var r = shared; r < a.length; r++) {
          record(path + '[' + r + ']', 'removed', a[r], undefined);
        }
        for (var d = shared; d < b.length; d++) {
          record(path + '[' + d + ']', 'added', undefined, b[d]);
        }
        return;
      }
      var keys = {};
      Object.keys(a).forEach(function (key) {
        keys[key] = true;
      });
      Object.keys(b).forEach(function (key) {
        keys[key] = true;
      });
      Object.keys(keys).forEach(function (key) {
        var childPath = path === '' ? key : path + '.' + key;
        if (!(key in b)) {
          record(childPath, 'removed', a[key], undefined);
        } else if (!(key in a)) {
          record(childPath, 'added', undefined, b[key]);
        } else {
          walk(a[key], b[key], childPath);
        }
      });
    }

    walk(before, after, '');
    return out;
  }

  /**
   * File name for an exported result: derived from the Graph request's
   * resource path plus a local timestamp, e.g.
   * "graph-users-messages-2026-08-08-093005.csv". Falls back to
   * "graph-query-…" when the source URL is not a real URL (pasted JSON).
   * `now` is injectable for tests.
   */
  function exportFilename(url, extension, now) {
    var base = 'graph-query';
    try {
      var segments = new URL(url).pathname
        .split('/')
        .filter(function (segment) {
          return segment !== '' && !/^(v1\.0|beta)$/i.test(segment);
        })
        .slice(-2)
        .map(function (segment) {
          return decodeURIComponent(segment).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
        })
        .filter(function (segment) {
          return segment !== '';
        });
      if (segments.length > 0) {
        base = 'graph-' + segments.join('-');
      }
    } catch (e) {
      /* not a URL — keep the fallback base */
    }
    var time = new Date(now === undefined ? Date.now() : now);
    var pad = function (n) {
      return (n < 10 ? '0' : '') + n;
    };
    var stamp =
      time.getFullYear() + '-' + pad(time.getMonth() + 1) + '-' + pad(time.getDate()) +
      '-' + pad(time.getHours()) + pad(time.getMinutes()) + pad(time.getSeconds());
    return base + '-' + stamp + '.' + extension;
  }

  // ------------------------------------------------------------ jq engine

  /**
   * jq is real jq (1.8.2) compiled to WebAssembly (vendor/jq-wasm.js).
   * Its heap is fixed by the upstream binary at 256 MB, and jq's in-memory
   * representation of a document is several times its JSON text — 52 MB of
   * users runs, 70 MB aborts the instance (measured; see the PR). The
   * ceiling below leaves room for the query's own intermediates
   * (map/sort_by/group_by copy the data). It is a length in UTF-16 code
   * units of the JSON text, which is the cheap number both callers have.
   */
  var JQ_INPUT_LIMIT = 40 * 1024 * 1024;
  var JQ_HEAP_MB = 256;

  /**
   * jq's stderr, trimmed to what a panel error line should say: the
   * `jq: error (at /dev/stdin:0): ` / `jq: error: ` prefixes go (the panel
   * already prefixes the language name), and so does the `jq: 1 compile
   * error` tally line. The source excerpt + caret of a compile error stays,
   * it is the useful part. Prefers `stderr` over `message` because the
   * wrapper's message also carries whatever stdout came before the error.
   */
  function jqErrorMessage(error) {
    var raw =
      error && typeof error.stderr === 'string' && error.stderr.trim() !== ''
        ? error.stderr
        : error && typeof error.message === 'string'
          ? error.message
          : typeof error === 'string'
            ? error
            : '';
    var lines = String(raw).split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+$/, '');
      if (/^jq: \d+ compile errors?$/.test(line)) {
        continue;
      }
      out.push(line.replace(/^jq: error \(at [^)]*\): /, '').replace(/^jq: error: /, ''));
    }
    while (out.length > 0 && out[out.length - 1] === '') {
      out.pop();
    }
    while (out.length > 0 && out[0] === '') {
      out.shift();
    }
    return out.length > 0 ? out.join('\n') : 'evaluation failed';
  }

  /**
   * Adapter over the jq-wasm library (`lib` is its global, `JQWASM`),
   * shared by the evaluator frame and the panel's local fallback path.
   * Creating the WebAssembly instance is asynchronous (`load()`), calls
   * are synchronous once it is up (`evaluate()`), and the instance is
   * treated as disposable: an Emscripten abort (heap exhaustion on a
   * dataset past the ceiling, in practice) leaves it dead, so the adapter
   * drops it, reports why, and loads a fresh one for the next query.
   * Dependency-free on purpose — the library is injected, so this stays
   * unit-testable with a stub.
   */
  function createJqEngine(lib, options) {
    var inputLimit = options && typeof options.inputLimit === 'number' ? options.inputLimit : JQ_INPUT_LIMIT;
    var handle = null;
    var loading = null;
    var loadError = null;
    var restarts = 0;

    function load() {
      if (handle !== null) {
        return Promise.resolve(handle);
      }
      if (loading !== null) {
        return loading;
      }
      if (!lib || typeof lib.loadJq !== 'function') {
        loadError = new Error('the jq engine (vendor/jq-wasm.js) is not loaded in this context');
        return Promise.reject(loadError);
      }
      loading = Promise.resolve()
        .then(function () {
          return lib.loadJq();
        })
        .then(
          function (loaded) {
            handle = loaded;
            loading = null;
            loadError = null;
            return loaded;
          },
          function (e) {
            loading = null;
            loadError = e instanceof Error ? e : new Error(String(e));
            throw loadError;
          }
        );
      return loading;
    }

    /**
     * Run `query` over `input` (a JSON value, or its JSON text — callers
     * that already hold the text pass it to skip a stringify). jq emits a
     * stream; the common single output is unwrapped, several come back as
     * an array, none as [].
     */
    function evaluate(input, query) {
      if (handle === null) {
        throw new Error(
          loadError ? 'jq engine failed to load: ' + (loadError.message || String(loadError)) : 'jq engine is still loading'
        );
      }
      var text = typeof input === 'string' ? input : JSON.stringify(input === undefined ? null : input);
      if (typeof text !== 'string') {
        text = 'null';
      }
      if (text.length > inputLimit) {
        throw new Error(
          'this dataset is ' + formatBytes(text.length) + ' of JSON; the WebAssembly jq engine (' + JQ_HEAP_MB +
            ' MB heap) handles up to ' + formatBytes(inputLimit) +
            ' per query — narrow the Graph query ($select, $filter, $top) or use JMESPath / JSONPath on this response'
        );
      }
      var outputs;
      try {
        outputs = handle.json(text, query);
      } catch (e) {
        if (e && e.name === 'JqError') {
          throw new Error(jqErrorMessage(e));
        }
        // Not a jq error: the WebAssembly instance itself failed (an
        // Emscripten abort on heap exhaustion is the realistic case) and
        // is unusable from here on — replace it.
        handle = null;
        restarts += 1;
        load().catch(function () {
          /* surfaces on the next evaluate() as a load error */
        });
        throw new Error(
          'jq ran out of memory on this dataset (' + formatBytes(text.length) + ' of JSON, ' + JQ_HEAP_MB +
            ' MB WebAssembly heap); the engine was restarted — narrow the query or the dataset'
        );
      }
      return outputs.length === 1 ? outputs[0] : outputs;
    }

    return {
      load: load,
      evaluate: evaluate,
      ready: function () {
        return handle !== null;
      },
      failed: function () {
        return loadError;
      },
      restarts: function () {
        return restarts;
      },
      version: function () {
        return handle !== null ? handle.version : null;
      },
      inputLimit: inputLimit
    };
  }

  /**
   * Whole-number progress of an auto-fetch chain: `items` fetched so far
   * out of the `@odata.count` the first page announced. null when there
   * is no usable count (the request had no `$count=true`, or the API
   * returned something odd). Floored, never rounded up: 99.6 % reads 99,
   * so 100 only appears once every item is in. Capped at 100 for the
   * case where the directory grew between the count and the last page.
   */
  function fetchPercent(items, count) {
    var total = typeof count === 'string' && /^\d+$/.test(count) ? Number(count) : count;
    if (typeof total !== 'number' || !isFinite(total) || total <= 0) {
      return null;
    }
    if (typeof items !== 'number' || !isFinite(items) || items < 0) {
      return null;
    }
    return Math.min(100, Math.floor((items / total) * 100));
  }

  return {
    jmesKey: jmesKey,
    jsonPathKey: jsonPathKey,
    jqKey: jqKey,
    clampInt: clampInt,
    stringifyLimited: stringifyLimited,
    trimResponses: trimResponses,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    normalizeSettings: normalizeSettings,
    toGraphQuery: toGraphQuery,
    graphQueryUrl: graphQueryUrl,
    convertQuery: convertQuery,
    queryCompletions: queryCompletions,
    isBackgroundGraphRequest: isBackgroundGraphRequest,
    sanitizeRequestHeaders: sanitizeRequestHeaders,
    sanitizeQueryHistory: sanitizeQueryHistory,
    graphRequestMatchesEditor: graphRequestMatchesEditor,
    graphRequestPathMatchesEditor: graphRequestPathMatchesEditor,
    splitMethodPrefix: splitMethodPrefix,
    classifyBackgroundRequest: classifyBackgroundRequest,
    applyAdvancedQuery: applyAdvancedQuery,
    parseGraphRequest: parseGraphRequest,
    buildDeepLink: buildDeepLink,
    toTsv: toTsv,
    sortRows: sortRows,
    csvColumns: csvColumns,
    csvShape: csvShape,
    csvCellText: csvCellText,
    csvPreview: csvPreview,
    sampleJson: sampleJson,
    pathQuery: pathQuery,
    diffJson: diffJson,
    upsertQueryHistory: upsertQueryHistory,
    trimQueryHistoryList: trimQueryHistoryList,
    groupQueryHistory: groupQueryHistory,
    distinctTags: distinctTags,
    knownFilterTags: knownFilterTags,
    filterQueryHistory: filterQueryHistory,
    formatTimestamp: formatTimestamp,
    csvEligible: csvEligible,
    exportFilename: exportFilename,
    safeJsonParse: safeJsonParse,
    describeResult: describeResult,
    formatBytes: formatBytes,
    fetchPercent: fetchPercent,
    createJqEngine: createJqEngine,
    jqErrorMessage: jqErrorMessage,
    JQ_INPUT_LIMIT: JQ_INPUT_LIMIT,
    summarizeUrl: summarizeUrl,
    trimHistory: trimHistory,
    suggestQueries: suggestQueries,
    nextQueryToken: nextQueryToken,
    toCsv: toCsv
  };
});
