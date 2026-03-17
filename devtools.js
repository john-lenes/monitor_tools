/**
 * devtools.js — Página DevTools da extensão
 *
 * Este script roda no contexto da DevTools page (não no contexto da aba
 * monitorada). Usa a API chrome.devtools.network para capturar requisições
 * HTTP com dados mais completos (response body, headers precisos) quando o
 * painel DevTools estiver aberto pelo desenvolvedor.
 *
 * Papel: fonte SECUNDÁRIA de captura.
 *  - PRIMARY:   content-main.js intercepta XHR/fetch (sempre ativo)
 *  - SECONDARY: este script captura via DevTools Network (requer painel aberto)
 *  O background.js deduplica automaticamente requests das duas fontes.
 *
 * FORMATO HAR (HTTP Archive):
 *  Cada entrada do onRequestFinished é um objeto `entry` no formato HAR v1.2:
 *  {
 *    startedDateTime: "2024-01-15T10:30:00.000Z",  // ISO 8601
 *    time: 245.3,                                    // duração total (ms)
 *    request:  { method, url, headers: [{name,value}], postData: {text|params} },
 *    response: { status, headers: [{name,value}] }
 *  }
 *  NOTA: o body da resposta NÃO está disponível diretamente no objeto HAR
 *  por razões de memória; é necessário chamar `entry.getContent()` de forma
 *  ASSÍNCRONA para obtê-lo.
 *
 * Restrições do contexto DevTools:
 *  - Não tem acesso ao DOM da página monitorada
 *  - NÃO pode chamar chrome.storage diretamente (só background pode)
 *  - Pode usar chrome.runtime.sendMessage para falar com o background
 */

// Extensões de arquivo estático — descarte rápido antes de enviar ao background
const STATIC_EXT_RE = /\.(?:png|jpe?g|gif|svg|ico|webp|css|js|mjs|woff2?|ttf|eot|map)(?:\?|#|$)/i;

/**
 * Recebe cada requisição finalizada pelo DevTools Network panel.
 * @param {chrome.devtools.network.Request} entry  Objeto HAR (HTTP Archive)
 */
chrome.devtools.network.onRequestFinished.addListener((entry) => {
  const req  = entry.request;
  const resp = entry.response;
  const url  = req.url || '';

  // Descarte rápido de assets estáticos
  if (STATIC_EXT_RE.test(url)) return;

  // Foca em chamadas relevantes: MGE, POST, ou respostas de erro
  const isRelevant =
    url.includes('/mge/') ||
    req.method === 'POST'  ||
    req.method === 'PUT'   ||
    req.method === 'DELETE'||
    resp.status >= 400;

  if (!isRelevant) return;

  // Converte o timestamp HAR (string ISO) em milissegundos Unix
  let timestamp = Date.now();
  try { timestamp = new Date(entry.startedDateTime).getTime(); } catch (_) { /* usa now */ }

  const duration = Math.round(entry.time || 0);

  // Normaliza headers para { chave: valor }
  const requestHeaders  = {};
  const responseHeaders = {};
  (req.headers  || []).forEach((h) => { requestHeaders[h.name.toLowerCase()]  = String(h.value).substring(0, 256); });
  (resp.headers || []).forEach((h) => { responseHeaders[h.name.toLowerCase()] = String(h.value).substring(0, 256); });

  // Extrai request body
  let requestBody = null;
  if (req.postData?.text)     requestBody = req.postData.text.substring(0, 8192);
  else if (req.postData?.params) {
    // Formato de formulário: array de { name, value }
    requestBody = req.postData.params
      .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value || '')}`)
      .join('&')
      .substring(0, 8192);
  }

  // Extrai response body de forma assíncrona (API HAR do DevTools)
  // POR QUE assíncrono?
  //  O Chrome DevTools armazena o body da resposta separado do objeto HAR
  //  por eficiência de memória. `getContent()` é a única forma de acessá-lo
  //  e sempre é assíncrona. O parâmetro `encoding` pode ser 'base64' para
  //  respostas binárias (imagens, PDFs) — por isso a decodificação defensiva.
  entry.getContent((responseBody, encoding) => {
    // Se a resposta estiver em base64 (binário), tenta decodificar
    if (encoding === 'base64' && responseBody) {
      try { responseBody = atob(responseBody); } catch (_) { responseBody = ''; }
    }

    // Wrap try/catch síncrono + .catch() assíncrono:
    //  - try/catch: captura throw síncrono de 'Extension context invalidated'
    //    (chrome.runtime.sendMessage lança síncronamente quando o contexto da
    //    DevTools page é invalidado após reload da extensão)
    //  - .catch(): captura rejeições assíncronas (service worker pausado, etc.)
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
        },
      }).catch(() => {
        // Service worker pausado pelo Chrome — será reiniciado automaticamente
      });
    } catch (_) {
      // Contexto da extensão invalidado — extensão foi recarregada.
      // Não há como se auto-remover aqui (DevTools page não tem removeListener
      // para onRequestFinished), mas o erro é silenciado.
    }
  });
});
