/**
 * devtools.js — Página DevTools da extensão
 *
 * Fonte SECUNDÁRIA de captura via chrome.devtools.network (HAR v1.2).
 * Complementa o content-main.js com dados que só estão disponíveis na
 * camada de rede: timing detalhado (DNS/TCP/SSL/TTFB/download), tamanho
 * real de transferência, content-type autoritativo e response headers completos.
 *
 * RECURSOS HAR UTILIZADOS:
 *  entry.time              — duração total da requisição (ms, mais preciso que clock JS)
 *  entry.timings           — decomposição: { blocked, dns, connect, ssl, send, wait, receive }
 *  entry.startedDateTime   — timestamp ISO 8601 de início
 *  entry.request           — method, url, headers[], postData, bodySize
 *  entry.response          — status, headers[], content.mimeType, bodySize, _transferSize
 *  entry.getContent()      — body da resposta (assíncrono, único acesso ao conteúdo)
 *  entry._resourceType     — tipo de recurso Chrome (document, xhr, fetch, script…)
 *  entry._initiator        — stack de inicialização (quem disparou a requisição)
 *
 * Restrições do contexto DevTools:
 *  - Não tem acesso ao DOM da página monitorada
 *  - NÃO pode chamar chrome.storage diretamente
 *  - Pode usar chrome.runtime.sendMessage para falar com o background
 */

// ── Filtros rápidos de descarte ─────────────────────────────────────────────
const STATIC_EXT_RE = /\.(?:png|jpe?g|gif|svg|ico|webp|css|js|mjs|woff2?|ttf|eot|map|pdf|zip)(?:\?|#|$)/i;
// Tipos de recurso Chrome que nunca são chamadas de negócio
const SKIP_RESOURCE_TYPES = new Set(['stylesheet', 'image', 'font', 'media', 'websocket', 'other']);

/**
 * Extrai o objeto de timing detalhado do HAR para análise de performance.
 * Os valores -1 indicam que a fase não ocorreu (ex: sem DNS lookup em cache HIT).
 *
 * @param {Object} timings  entry.timings do HAR
 * @returns {{
 *   dnsMs:      number,   lookup DNS (−1 se em cache)
 *   tcpMs:      number,   handshake TCP
 *   sslMs:      number,   handshake TLS (−1 se HTTP)
 *   sendMs:     number,   envio do request
 *   waitMs:     number,   TTFB — tempo até primeiro byte (métrica de server load)
 *   receiveMs:  number,   download da resposta
 *   blockedMs:  number,   tempo em fila antes de iniciar conexão
 * }}
 */
function extractTiming(timings) {
  if (!timings) return null;
  return {
    dnsMs:     Math.max(-1, Math.round(timings.dns     ?? -1)),
    tcpMs:     Math.max(-1, Math.round(timings.connect ?? -1)),
    sslMs:     Math.max(-1, Math.round(timings.ssl     ?? -1)),
    sendMs:    Math.max(0,  Math.round(timings.send    ?? 0)),
    waitMs:    Math.max(0,  Math.round(timings.wait    ?? 0)),   // TTFB
    receiveMs: Math.max(0,  Math.round(timings.receive ?? 0)),
    blockedMs: Math.max(-1, Math.round(timings.blocked ?? -1)),
  };
}

/**
 * E1 — Extrai initiator completo do HAR, incluindo todos os frames da call stack.
 *
 * O DevTools expõe `entry._initiator` com dois subtipos principais:
 *  - type='script': a requisição foi disparada por código JS → tem `stack.callFrames`
 *  - type='parser': a requisição veio de um link/src no HTML → sem frames úteis
 *
 * @param {Object|null} initiator  entry._initiator do HAR
 * @returns {{ type:string, topFrame:Object|null, frames:Object[] }|null}
 */
function extractInitiator(initiator) {
  if (!initiator) return null;

  const frames = (initiator.stack?.callFrames || []).map((f) => ({
    fn:   f.functionName || '(anonymous)',
    file: f.url           || '',
    line: f.lineNumber    ?? 0,
    col:  f.columnNumber  ?? 0,
  }));

  return {
    type:     initiator.type  || 'other',
    url:      initiator.url   || null,
    topFrame: frames[0] ?? null,
    frames,
  };
}

chrome.devtools.network.onRequestFinished.addListener((entry) => {
  const req  = entry.request;
  const resp = entry.response;
  const url  = req.url || '';

  // [Filtro 1] Asset estático por extensão — descarte imediato
  if (STATIC_EXT_RE.test(url)) return;

  // [Filtro 2] Tipo de recurso Chrome (quando disponível)
  if (entry._resourceType && SKIP_RESOURCE_TYPES.has(entry._resourceType)) return;

  // [Filtro 3] Foca em chamadas relevantes: MGE, mutações, erros
  const isRelevant =
    url.includes('/mge/')    ||
    url.includes('/mgecontab/') ||
    url.includes('/mgecom/')    ||
    url.includes('/mgesite/')   ||
    req.method === 'POST'    ||
    req.method === 'PUT'     ||
    req.method === 'PATCH'   ||
    req.method === 'DELETE'  ||
    resp.status >= 400;

  if (!isRelevant) return;

  // [Filtro 4] Descarta data: e blob: URLs
  if (url.startsWith('data:') || url.startsWith('blob:')) return;

  // Timestamp — prefere o HAR (mais preciso), fallback para Date.now()
  let timestamp = Date.now();
  try { timestamp = new Date(entry.startedDateTime).getTime(); } catch (_) {}

  const duration = Math.round(entry.time || 0);
  const timing   = extractTiming(entry.timings);

  // Normaliza headers para { chave: valor }
  const requestHeaders  = {};
  const responseHeaders = {};
  (req.headers  || []).forEach((h) => {
    if (h?.name) requestHeaders[h.name.toLowerCase()]  = String(h.value ?? '').substring(0, 512);
  });
  (resp.headers || []).forEach((h) => {
    if (h?.name) responseHeaders[h.name.toLowerCase()] = String(h.value ?? '').substring(0, 512);
  });

  // Extrai request body do HAR (postData)
  let requestBody = null;
  if (req.postData?.text) {
    requestBody = req.postData.text.substring(0, 8192);
  } else if (req.postData?.params?.length) {
    requestBody = req.postData.params
      .map((p) => `${encodeURIComponent(p.name || '')}=${encodeURIComponent(p.value || '')}`)
      .join('&')
      .substring(0, 8192);
  }

  // Dados de tamanho e tipo de conteúdo (HAR)
  const contentType   = resp.content?.mimeType || responseHeaders['content-type'] || '';
  const transferSize  = resp._transferSize ?? resp.bodySize ?? -1; // bytes transferidos (comprimido)
  const responseSize  = resp.content?.size ?? -1;                  // bytes descomprimido

  // Hint de classe SP: o serviceName pode estar na URL (query param) —
  // capturamos aqui para o background poder priorizar o merge desta entrada.
  let spHint = false;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://x.com${url}`);
    const sn = u.searchParams.get('serviceName') || u.searchParams.get('servicename') || '';
    spHint = /\bSP\./i.test(sn);
  } catch (_) {}

  // E1: Extrai initiator completo com todos os frames da call stack quando disponíveis
  const initiator = extractInitiator(entry._initiator);

  // Extrai response body de forma assíncrona (única forma possível no HAR)
  entry.getContent((responseBody, encoding) => {
    // base64 → texto (para respostas com encoding incomum)
    if (encoding === 'base64' && responseBody) {
      try { responseBody = atob(responseBody); } catch (_) { responseBody = ''; }
    }

    // Descarta binários não-textuais (não têm valor de diagnóstico como texto)
    if (contentType && /image|audio|video|octet-stream|font/i.test(contentType)) {
      responseBody = '';
    }

    try {
      chrome.runtime.sendMessage({
        action: 'DEVTOOLS_REQUEST_CAPTURED',
        request: {
          url,
          method:          (req.method || 'GET').toUpperCase(),
          requestBody,
          responseBody:    (responseBody || '').substring(0, 8192),
          statusCode:      resp.status || 0,
          duration,
          timestamp,
          requestHeaders,
          responseHeaders,
          // Campos extras do HAR — só disponíveis via DevTools
          timing,
          contentType,
          transferSize,
          responseSize,
          spHint,
          initiator,
          resourceType:    entry._resourceType || null,
        },
      }).catch(() => {});
    } catch (_) {
      // Extension context invalidated após reload — silenciado
    }
  });
});

// ---------------------------------------------------------------------------
// E6 / M5 — Indexação de fontes (source indexing) ao navegar
// ---------------------------------------------------------------------------
// M5: além de regex simples, captura blocos contextuais (20-40 linhas ao redor),
// nome da função externa, string literals próximas (serviceName/application/resourceID)
// e variáveis envolvidas. O indexador tem duas camadas:
//   1. Triagem por regex rápida (igual ao anterior)
//   2. Extração contextual de bloco (novo) — 20 linhas antes + 20 depois
// O resultado inclui: file, lineNum, snippet (linha exata), context (bloco),
// outerFn (função que contém o match), literals (strings/values próximos).

chrome.devtools.network.onNavigated.addListener(() => {
  try {
    // Executa no contexto da página inspecionada via eval assíncrono.
    const evalScript = `(async function() {
      const SOURCE_PATTERNS = [
        { name: 'ServiceProxy.callService', re: 'ServiceProxy\\\\.callService' },
        { name: 'callService',              re: 'callService\\\\s*\\\\(' },
        { name: 'CRUDService',              re: 'CRUDService' },
        { name: 'ActionExecutor',           re: 'ActionExecutor' },
        { name: 'loadRecords',              re: 'loadRecords\\\\s*\\\\(' },
        { name: 'openForm',                 re: 'openForm\\\\s*\\\\(' },
        { name: 'serviceName:',             re: 'serviceName\\\\s*:' },
        { name: 'application:',             re: 'application\\\\s*:' },
        { name: 'saveForm',                 re: 'saveForm\\\\s*\\\\(' },
        { name: 'notifyListeners',          re: 'notifyListeners\\\\s*\\\\(' },
      ];

      /**
       * Extrai string literals e identificadores de negócio próximos ao match.
       * Busca serviceName:'...', application:'...', resourceID, entityName, etc.
       */
      function extractLiterals(block) {
        const literals = {};
        const patterns = [
          ['serviceName', /serviceName\\s*[:=]\\s*['"\\x60]([^'"\\x60]{1,100})/i],
          ['application',  /application\\s*[:=]\\s*['"\\x60]([^'"\\x60]{1,80})/i],
          ['resourceID',   /resourceID\\s*[:=]\\s*['"\\x60]([^'"\\x60]{1,80})/i],
          ['entityName',   /entityName\\s*[:=]\\s*['"\\x60]([^'"\\x60]{1,80})/i],
        ];
        for (const [k, re] of patterns) {
          const m = block.match(re);
          if (m) literals[k] = m[1];
        }
        return Object.keys(literals).length ? literals : null;
      }

      /**
       * Tenta encontrar o nome da função externa que contém o match.
       * Busca para trás (linhas anteriores) por "function Nome" ou "Nome = function" ou "Nome: function".
       */
      function findOuterFunction(lines, matchIdx) {
        const fnRe = /(?:function\\s+(\\w+)|(?:^|\\s)(\\w+)\\s*[:=]\\s*(?:async\\s+)?function)/;
        for (let i = matchIdx; i >= Math.max(0, matchIdx - 40); i--) {
          const m = lines[i].match(fnRe);
          if (m) return (m[1] || m[2] || '').trim().substring(0, 80) || null;
        }
        return null;
      }

      const resources = performance.getEntriesByType('resource')
        .filter(r => r.initiatorType === 'script' && r.name && r.name.startsWith('http') && !r.name.includes('chrome-extension'));
      const results = {};
      for (const res of resources.slice(0, 40)) {
        try {
          const resp = await fetch(res.name, { cache: 'force-cache' });
          if (!resp.ok) continue;
          const text = await resp.text();
          if (text.length > 8000000) continue;
          const lines = text.split('\\n');
          for (const p of SOURCE_PATTERNS) {
            const re = new RegExp(p.re, 'g');
            if (!results[p.name]) results[p.name] = [];
            lines.forEach((line, idx) => {
              if (results[p.name].length >= 30) return;
              if (re.test(line)) {
                re.lastIndex = 0;
                // M5: bloco contextual de ±20 linhas
                const start   = Math.max(0, idx - 20);
                const end     = Math.min(lines.length - 1, idx + 20);
                const context = lines.slice(start, end + 1).join('\\n').substring(0, 3000);
                const outerFn = findOuterFunction(lines, idx);
                const literals = extractLiterals(context);
                results[p.name].push({
                  file:     res.name,
                  lineNum:  idx + 1,
                  snippet:  line.trim().substring(0, 200),
                  context,
                  outerFn,
                  literals,
                });
              }
            });
          }
        } catch(_) {}
      }
      return JSON.stringify(results);
    })()`;

    chrome.devtools.inspectedWindow.eval(evalScript, { useContentScriptContext: false }, (result, isException) => {
      if (isException || !result) return;
      try {
        const index = JSON.parse(typeof result === 'string' ? result : JSON.stringify(result));
        chrome.runtime.sendMessage({ action: 'SOURCE_INDEX_READY', index }).catch(() => {});
      } catch (_) {}
    });
  } catch (_) {}
});
