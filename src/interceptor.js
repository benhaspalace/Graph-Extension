/**
 * Graph Explorer JSON Query — network interceptor.
 *
 * Runs in the page's MAIN world (document_start) so it can wrap
 * window.fetch / XMLHttpRequest before the Graph Explorer app boots.
 * Every JSON response coming back from a Microsoft Graph endpoint is
 * forwarded to the extension's content script via window.postMessage.
 *
 * This script only observes requests (and, for the opt-in auto-fetch
 * feature, follows @odata.nextLink pages). It never modifies the
 * queries Graph Explorer sends: the advanced-queries assistance happens
 * visibly in Graph Explorer's own UI (see content.js).
 *
 * Nothing here leaves the browser: messages stay within the page.
 */
(function () {
  'use strict';

  if (window.__gejqInterceptorInstalled) {
    return;
  }
  window.__gejqInterceptorInstalled = true;

  var MESSAGE_SOURCE = 'gejq-interceptor';
  var SETTINGS_SOURCE = 'gejq-settings';
  var CONTROL_SOURCE = 'gejq-autofetch-control';
  var MAX_BODY_CHARS = 10 * 1024 * 1024; // 10 MB of JSON text is plenty
  var MAX_REQUEST_BODY_CHARS = 100 * 1024; // captured request bodies
  var LARGE_DIRECT_LIMIT = 512 * 1024; // bodies above this go straight to the evaluator
  var GRAPH_HOSTS = [
    'graph.microsoft.com',
    'graph.microsoft.us',
    'dod-graph.microsoft.us',
    'microsoftgraph.chinacloudapi.cn',
    'graph.microsoft.de'
  ];

  var idCounter = 0;

  // Paged responses always get a fetch chain with on-demand controls;
  // autoFetchNextLink only decides whether the chain STARTS by itself.
  // The stored default is manual (off), and this MAIN-world script also
  // keeps it off until the content script pushes the user's actual
  // settings in shortly after page load — so no extra requests ever fire
  // unless the user opted into auto mode or pressed ▶/+1 themselves.
  var settings = {
    autoFetchNextLink: false,
    autoFetchMaxPages: 50,
    autoFetchMaxChars: 10 * 1024 * 1024
  };

  window.addEventListener('message', function (event) {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }
    var data = event.data;
    if (data && data.source === SETTINGS_SOURCE && data.settings && typeof data.settings === 'object') {
      settings.autoFetchNextLink = data.settings.autoFetchNextLink === true;
      settings.autoFetchMaxPages = GEJQ.clampInt(data.settings.autoFetchMaxPages, 1, 1000, 50);
      settings.autoFetchMaxChars = GEJQ.clampInt(data.settings.autoFetchMaxChars, 1, 50 * 1024 * 1024, 10 * 1024 * 1024);
      if (!settings.autoFetchNextLink && activeFetch && activeFetch.state !== 'done') {
        // Turning the setting off also stops a chain already in flight.
        if (activeFetch.state === 'paused') {
          finalizeChain(activeFetch, activeFetch.nextUrl, 'stopped');
        } else {
          activeFetch.stopRequested = true;
          abortInFlight(activeFetch);
        }
      }
    }
    if (data && data.source === CONTROL_SOURCE && typeof data.action === 'string') {
      handleAutoFetchControl(data.action);
    }
  });

  function isGraphHost(hostname) {
    var h = String(hostname || '').toLowerCase();
    return GRAPH_HOSTS.some(function (graphHost) {
      return h === graphHost || h.endsWith('.' + graphHost);
    });
  }

  /**
   * Returns { url, direct } for the Graph API URL a request targets, or
   * null if it is not a Graph request. `direct` is true when the request
   * itself goes to a Graph host; false when it goes through Graph
   * Explorer's anonymous-mode proxy (…/proxy?url=<encoded graph url>),
   * whose URL we must not rewrite.
   */
  function resolveGraphUrl(rawUrl) {
    try {
      var u = new URL(rawUrl, window.location.href);
      if (isGraphHost(u.hostname)) {
        return { url: u.href, direct: true };
      }
      var inner = u.searchParams.get('url');
      if (inner) {
        var innerUrl = new URL(inner);
        if (isGraphHost(innerUrl.hostname)) {
          return { url: innerUrl.href, direct: false };
        }
      }
    } catch (e) {
      /* not a parseable URL — ignore */
    }
    return null;
  }

  function post(payload) {
    postTyped('graph-response', payload);
  }

  /**
   * The panel's hidden off-thread evaluator iframe, once the content
   * script has marked it ready (data-gejq-ready — messages posted to a
   * still-loading frame would be dropped silently). Returns
   * { window, origin } or null; every use falls back to the legacy
   * everything-through-the-panel path when null.
   */
  function evaluatorTarget() {
    var frame = document.getElementById('gejq-evaluator');
    if (!frame || !frame.contentWindow || frame.getAttribute('data-gejq-ready') !== '1') {
      return null;
    }
    try {
      return { window: frame.contentWindow, origin: new URL(frame.src).origin };
    } catch (e) {
      return null;
    }
  }

  /**
   * Ship data straight to the evaluator, skipping the page thread's
   * expensive object clones through the panel. Returns false when the
   * evaluator isn't available (callers keep the legacy path).
   */
  function sendToEvaluator(message) {
    var target = evaluatorTarget();
    if (!target) {
      return false;
    }
    try {
      target.window.postMessage(message, target.origin);
      return true;
    } catch (e) {
      return false;
    }
  }

  function postTyped(type, payload) {
    try {
      window.postMessage({ source: MESSAGE_SOURCE, type: type, payload: payload }, window.location.origin);
    } catch (e) {
      /* payload not cloneable — ignore */
    }
  }

  function makeEntry(method, url, status) {
    idCounter += 1;
    return {
      id: Date.now() + '-' + idCounter,
      method: String(method || 'GET').toUpperCase(),
      url: url,
      status: status,
      timestamp: Date.now()
    };
  }

  function handleBodyText(text, method, url, status, requestHeaders, requestBody) {
    if (typeof text !== 'string' || text.length === 0) {
      return null;
    }
    var entry = makeEntry(method, url, status);
    if (requestHeaders && requestHeaders.length > 0) {
      entry.requestHeaders = requestHeaders;
    }
    if (typeof requestBody === 'string' && requestBody.length > 0) {
      entry.requestBody = requestBody.slice(0, MAX_REQUEST_BODY_CHARS);
    }
    if (text.length > MAX_BODY_CHARS) {
      entry.tooLarge = true;
      entry.size = text.length;
      post(entry);
      return null;
    }
    var trimmed = text.replace(/^\uFEFF/, '').trim();
    if (trimmed[0] !== '{' && trimmed[0] !== '[') {
      return null; // not JSON (binary, HTML error page, …)
    }
    var json;
    try {
      json = JSON.parse(trimmed);
    } catch (e) {
      return null;
    }
    entry.size = text.length;
    if (text.length > LARGE_DIRECT_LIMIT && sendToEvaluator({ type: 'gejq-dataset-text', id: entry.id, text: trimmed })) {
      // Big body: hand the RAW TEXT to the evaluator (a string clone is a
      // cheap memcpy; it re-parses on its own thread) and give the panel
      // metadata only — the parsed dataset never crosses the page thread.
      entry.remote = true;
      post(entry);
      entry.json = json; // kept locally only to drive the auto-fetch chain
      return entry;
    }
    entry.json = json;
    post(entry);
    return entry;
  }

  // -------------------------------------------------- @odata.nextLink pages

  /**
   * Auto-fetch controller. When the setting is on and a captured GET
   * response is paged, follow the @odata.nextLink chain (replaying the
   * original request's own headers, so authentication keeps working),
   * merge all `value` arrays, and post the combined dataset as one extra
   * entry. The entry id stays stable across posts, so later posts update
   * the same entry in place instead of adding new ones.
   *
   * The chain is interactive: the panel pauses, resumes, or steps it
   * (one page at a time) via gejq-autofetch-control messages. The
   * configured page/size limits are checkpoints, not hard stops — when
   * one is reached the chain pauses, and Resume/Step continue past it
   * (each resume grants another full page/size budget). There is no
   * explicit stop: a paused chain simply stays paused until a newer
   * query supersedes it or the setting is turned off, both of which
   * close it out. A chain only finishes when the links run out, it is
   * closed out like that, or a page fetch fails; incomplete datasets are
   * flagged `truncated` with a `stopReason` ('stopped' | 'error') so the
   * panel can say honestly why — never blamed on a limit.
   */
  var activeFetch = null;

  function postProgress(chain, state, reason) {
    postTyped('graph-fetch-progress', {
      url: chain.url,
      pages: chain.pages,
      items: chain.totalItems,
      size: chain.totalSize,
      count: chain.count, // @odata.count from the first page, or null
      state: state,
      reason: reason || null,
      unlimited: chain.unlimited === true
    });
  }

  /**
   * The total the first page announced (`@odata.count`, present when the
   * request asked for `$count=true`) — what the panel's progress bar is
   * measured against. Numbers and digit strings pass through as-is; the
   * panel normalizes (GEJQ.fetchPercent). Anything else means "unknown".
   */
  function odataCount(json) {
    var count = json['@odata.count'];
    if (typeof count === 'number' && isFinite(count) && count >= 0) {
      return count;
    }
    if (typeof count === 'string' && /^\d+$/.test(count)) {
      return count;
    }
    return null;
  }

  /** Post the chain's combined dataset (same entry id every time). */
  function postChainEntry(chain, remainingNextLink, flags) {
    if (chain.pages < 2) {
      return; // nothing beyond the original response — no entry to add
    }
    var entry = {
      id: chain.id,
      method: chain.method,
      url: chain.url,
      status: chain.status,
      timestamp: Date.now(),
      size: chain.totalSize,
      pages: chain.pages,
      partial: flags.partial === true,
      truncated: flags.truncated === true
    };
    if (flags.stopReason) {
      entry.stopReason = flags.stopReason;
    }
    if (chain.requestHeaders) {
      entry.requestHeaders = chain.requestHeaders;
    }
    if (chain.streamed) {
      // Streaming mode: the pages already live in the evaluator — commit
      // them there and give the panel metadata only. The combined dataset
      // never exists on this thread, so pausing/finishing never clones a
      // multi-megabyte object graph through the page.
      sendToEvaluator({
        type: 'gejq-chain-commit',
        id: chain.id,
        nextLink: remainingNextLink || null,
        final: flags.partial !== true
      });
      entry.remote = true;
      post(entry);
      return;
    }
    var combined = {};
    for (var key in chain.firstJson) {
      if (Object.prototype.hasOwnProperty.call(chain.firstJson, key) && key !== '@odata.nextLink') {
        combined[key] = chain.firstJson[key];
      }
    }
    if (remainingNextLink) {
      combined['@odata.nextLink'] = remainingNextLink;
    }
    combined.value = chain.combinedValue;
    entry.json = combined;
    post(entry);
  }

  function pauseChain(chain, reason) {
    chain.state = 'paused';
    chain.pausedReason = reason;
    postChainEntry(chain, chain.nextUrl, { partial: true });
    postProgress(chain, 'paused', reason);
  }

  /** End the chain. No stopReason = the links simply ran out. */
  function finalizeChain(chain, remainingNextLink, stopReason) {
    if (chain.state === 'done') {
      return;
    }
    chain.state = 'done';
    // A page fetch may still be in flight (e.g. a newer query superseding
    // a running chain) — abort it, or its success handler would keep the
    // closed-out chain fetching pages and posting progress forever.
    abortInFlight(chain);
    if (chain.streamed && chain.pages < 2) {
      // Nothing will be posted — free the pages staged in the evaluator.
      sendToEvaluator({ type: 'gejq-chain-abort', id: chain.id });
    }
    postChainEntry(chain, remainingNextLink || null, {
      truncated: !!remainingNextLink,
      stopReason: remainingNextLink ? stopReason || 'stopped' : undefined
    });
    postProgress(chain, 'done', stopReason || null);
    if (activeFetch === chain) {
      activeFetch = null;
    }
  }

  function continueChain(chain) {
    if (chain.state === 'done') {
      return; // closed out while a page was in flight
    }
    var nextUrl = chain.nextUrl;
    chain.nextUrl = null;
    var parsed;
    try {
      parsed = new URL(nextUrl);
    } catch (e) {
      finalizeChain(chain, null); // unusable link — the chain is complete
      return;
    }
    if (!isGraphHost(parsed.hostname)) {
      finalizeChain(chain, null);
      return;
    }
    if (chain.stopRequested) {
      finalizeChain(chain, nextUrl, 'stopped');
      return;
    }
    if (chain.pauseRequested) {
      chain.pauseRequested = false;
      chain.nextUrl = nextUrl;
      pauseChain(chain, 'user');
      return;
    }
    // "Run to the end" (⏭) opts out of the limit checkpoints entirely —
    // the chain then only stops when the links run out, on an error, or
    // when the user pauses it (⏸ stays available throughout).
    if (!chain.unlimited) {
      if (chain.pages >= chain.pageBudget) {
        chain.nextUrl = nextUrl;
        pauseChain(chain, 'page-limit');
        return;
      }
      if (chain.totalSize > chain.sizeBudget) {
        chain.nextUrl = nextUrl;
        pauseChain(chain, 'size-limit');
        return;
      }
    }
    postProgress(chain, 'running');
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    chain.abortController = controller;

    /**
     * In-flight failure/abort router: user intent (stop, pause) wins over
     * reporting an error. Pause aborts the page fetch so it takes effect
     * immediately — the aborted page's URL is kept and simply re-fetched
     * on resume.
     */
    function pageFailed() {
      chain.abortController = null;
      if (chain.state === 'done') {
        return;
      }
      if (chain.stopRequested) {
        finalizeChain(chain, nextUrl, 'stopped');
        return;
      }
      if (chain.pauseRequested) {
        chain.pauseRequested = false;
        chain.nextUrl = nextUrl;
        pauseChain(chain, 'user');
        return;
      }
      finalizeChain(chain, nextUrl, 'error');
    }

    originalFetch(nextUrl, controller ? { headers: chain.headers, signal: controller.signal } : { headers: chain.headers })
      .then(function (response) {
        if (!response.ok) {
          pageFailed();
          return;
        }
        response
          .text()
          .then(function (text) {
            chain.abortController = null;
            if (chain.state === 'done') {
              return; // closed out while this page was in flight — drop it
            }
            var pageJson;
            try {
              pageJson = JSON.parse(text);
            } catch (e) {
              pageFailed();
              return;
            }
            if (!pageJson || !Array.isArray(pageJson.value)) {
              pageFailed();
              return;
            }
            chain.totalSize += text.length;
            if (chain.streamed) {
              // One small page-sized clone to the evaluator; this thread
              // never accumulates the combined dataset.
              if (!sendToEvaluator({ type: 'gejq-chain-page', id: chain.id, value: pageJson.value })) {
                finalizeChain(chain, nextUrl, 'error'); // evaluator vanished mid-chain
                return;
              }
            } else {
              chain.combinedValue = chain.combinedValue.concat(pageJson.value);
            }
            chain.totalItems += pageJson.value.length;
            chain.pages += 1;
            var next = pageJson['@odata.nextLink'];
            if (typeof next !== 'string') {
              finalizeChain(chain, null); // all pages fetched
              return;
            }
            chain.nextUrl = next;
            if (chain.stopRequested) {
              finalizeChain(chain, next, 'stopped');
            } else if (chain.stepping) {
              chain.stepping = false;
              pauseChain(chain, 'step');
            } else if (chain.pauseRequested) {
              chain.pauseRequested = false;
              pauseChain(chain, 'user');
            } else {
              continueChain(chain);
            }
          })
          .catch(pageFailed);
      })
      .catch(pageFailed);
  }

  /** Abort the page fetch currently in flight (pause/stop act instantly). */
  function abortInFlight(chain) {
    if (chain.abortController) {
      try {
        chain.abortController.abort();
      } catch (e) {
        /* ignore */
      }
    }
  }

  function handleAutoFetchControl(action) {
    var chain = activeFetch;
    if (!chain || chain.state === 'done') {
      return;
    }
    if (action === 'pause' && chain.state === 'running') {
      chain.pauseRequested = true;
      chain.unlimited = false; // a later ▶ resumes with the normal budget
      abortInFlight(chain); // pause NOW — the aborted page is retried on resume
    } else if (action === 'resume' && chain.state === 'paused' && chain.nextUrl) {
      // Each resume grants a fresh budget, so a chain paused at a limit
      // can keep going as far as the user wants.
      chain.unlimited = false;
      chain.pageBudget = chain.pages + settings.autoFetchMaxPages;
      chain.sizeBudget = chain.totalSize + settings.autoFetchMaxChars;
      chain.state = 'running';
      continueChain(chain);
    } else if (action === 'step' && chain.state === 'paused' && chain.nextUrl) {
      chain.unlimited = false;
      chain.stepping = true;
      chain.pageBudget = Math.max(chain.pageBudget, chain.pages + 1);
      chain.sizeBudget = Math.max(chain.sizeBudget, chain.totalSize + settings.autoFetchMaxChars);
      chain.state = 'running';
      continueChain(chain);
    } else if (action === 'all' && chain.state === 'paused' && chain.nextUrl) {
      // Fetch every remaining page, ignoring the configured limits.
      chain.unlimited = true;
      chain.stepping = false;
      chain.state = 'running';
      continueChain(chain);
    }
  }

  function maybeAutoFetchAllPages(firstEntry, headers, method) {
    if (String(method || 'GET').toUpperCase() !== 'GET') {
      return;
    }
    var firstJson = firstEntry.json;
    if (!firstJson || typeof firstJson !== 'object' || Array.isArray(firstJson) || !Array.isArray(firstJson.value)) {
      return;
    }
    if (typeof firstJson['@odata.nextLink'] !== 'string') {
      return;
    }
    if (activeFetch && activeFetch.state !== 'done') {
      // A newer query supersedes a chain still running or paused.
      finalizeChain(activeFetch, activeFetch.nextUrl, 'stopped');
    }
    idCounter += 1;
    var chainId = Date.now() + '-' + idCounter + '-pages';
    // Streaming mode (evaluator present): pages accumulate off-thread and
    // this world keeps counters only. Legacy mode otherwise.
    var streamed = sendToEvaluator({ type: 'gejq-chain-start', id: chainId, firstJson: firstJson });
    activeFetch = {
      id: chainId,
      method: String(method || 'GET').toUpperCase(),
      url: firstEntry.url,
      status: firstEntry.status,
      requestHeaders: firstEntry.requestHeaders || null,
      headers: headers,
      firstJson: firstJson,
      streamed: streamed,
      combinedValue: streamed ? null : firstJson.value.slice(),
      pages: 1,
      totalItems: firstJson.value.length,
      totalSize: firstEntry.size || 0,
      count: odataCount(firstJson),
      nextUrl: firstJson['@odata.nextLink'],
      state: 'running',
      pageBudget: settings.autoFetchMaxPages,
      sizeBudget: settings.autoFetchMaxChars,
      stepping: false,
      unlimited: false, // ⏭ sets this: run to the end, ignoring the limits
      pauseRequested: false,
      stopRequested: false,
      pausedReason: null
    };
    if (settings.autoFetchNextLink) {
      continueChain(activeFetch); // auto mode: start fetching right away
    } else {
      // Manual mode (the default): the chain exists with the same
      // controls and limits, it just doesn't run until the user asks —
      // ▶ fetches the remaining pages, +1 fetches one.
      activeFetch.state = 'paused';
      activeFetch.pausedReason = 'manual';
      postProgress(activeFetch, 'paused', 'manual');
    }
  }

  /** Best-effort view of the headers a fetch call is about to send. */
  function requestHeaders(input, init) {
    if (init && init.headers) {
      return init.headers;
    }
    if (input instanceof Request) {
      return input.headers;
    }
    return undefined;
  }

  /**
   * Best-effort capture of a body-carrying request's body as a string
   * (resolves null for streams/forms or when there is no body).
   */
  function capturedRequestBody(input, init, method) {
    try {
      if (!/^(POST|PUT|PATCH)$/i.test(String(method || ''))) {
        return Promise.resolve(null);
      }
      if (init && typeof init.body === 'string') {
        return Promise.resolve(init.body);
      }
      if (input instanceof Request && !input.bodyUsed) {
        return input
          .clone()
          .text()
          .then(function (text) {
            return text || null;
          })
          .catch(function () {
            return null;
          });
      }
    } catch (e) {
      /* ignore */
    }
    return Promise.resolve(null);
  }

  /**
   * The request's own headers as sanitized {name, value} pairs — never
   * including Authorization/cookies, Graph Explorer's telemetry, or the
   * cache-busting directives it adds itself (see sanitizeRequestHeaders).
   * Used so the panel can restore a query's headers later.
   */
  function capturedRequestHeaders(input, init) {
    try {
      var source = requestHeaders(input, init);
      if (!source) {
        return [];
      }
      var pairs = [];
      new Headers(source).forEach(function (value, name) {
        pairs.push({ name: name, value: value });
      });
      return typeof GEJQ !== 'undefined' ? GEJQ.sanitizeRequestHeaders(pairs) : [];
    } catch (e) {
      return [];
    }
  }

  // ---- fetch ----
  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var graphUrl = null;
      var graphInfo = null;
      var method = 'GET';
      var requestBodyPromise = null;
      try {
        var rawUrl =
          typeof input === 'string'
            ? input
            : input && typeof input.url === 'string'
              ? input.url
              : String(input);
        graphInfo = resolveGraphUrl(rawUrl);
        if (graphInfo) {
          graphUrl = graphInfo.url;
          method =
            (init && init.method) ||
            (input && typeof input === 'object' && input.method) ||
            'GET';
          if (graphInfo.direct) {
            // Must clone before originalFetch consumes the body stream.
            requestBodyPromise = capturedRequestBody(input, init, method);
          }
        }
      } catch (e) {
        /* never break the page's fetch */
      }
      var result = originalFetch.apply(this, arguments);
      try {
        if (graphUrl) {
          result
            .then(function (response) {
              try {
                var contentType = (response.headers && response.headers.get('content-type')) || '';
                if (contentType && !/json|text/i.test(contentType)) {
                  return; // images, binary streams, …
                }
                var direct = graphInfo && graphInfo.direct;
                var bodyPromise = requestBodyPromise || Promise.resolve(null);
                response
                  .clone()
                  .text()
                  .then(function (text) {
                    bodyPromise.then(function (requestBody) {
                      var sanitized = direct ? capturedRequestHeaders(input, init) : [];
                      var entry = handleBodyText(text, method, graphUrl, response.status, sanitized, requestBody);
                      if (entry && entry.json && direct) {
                        maybeAutoFetchAllPages(entry, requestHeaders(input, init), method);
                      }
                    });
                  })
                  .catch(function () {});
              } catch (e) {
                /* ignore */
              }
            })
            .catch(function () {});
        }
      } catch (e) {
        /* never break the page's fetch */
      }
      return result;
    };
  }

  // ---- XMLHttpRequest (belt and braces; Graph Explorer mainly uses fetch) ----
  var XhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XhrProto) {
    var originalOpen = XhrProto.open;
    var originalSend = XhrProto.send;
    XhrProto.open = function (method, url) {
      try {
        this.__gejqRequest = { method: method, url: url };
      } catch (e) {
        /* ignore */
      }
      return originalOpen.apply(this, arguments);
    };
    XhrProto.send = function () {
      var info = this.__gejqRequest;
      if (info) {
        var graphInfo = resolveGraphUrl(info.url);
        if (graphInfo) {
          var graphUrl = graphInfo.url;
          var xhr = this;
          xhr.addEventListener('load', function () {
            try {
              if (xhr.responseType === '' || xhr.responseType === 'text') {
                handleBodyText(xhr.responseText, info.method, graphUrl, xhr.status);
              } else if (xhr.responseType === 'json' && xhr.response !== null && typeof xhr.response === 'object') {
                var entry = makeEntry(info.method, graphUrl, xhr.status);
                entry.json = xhr.response;
                post(entry);
              }
            } catch (e) {
              /* ignore */
            }
          });
        }
      }
      return originalSend.apply(this, arguments);
    };
  }
})();
