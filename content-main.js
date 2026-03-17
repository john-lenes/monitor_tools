/**
 * content-main.js — Content Script (world: "MAIN")
 *
 * Executa diretamente no contexto JavaScript da página (mesmo escopo do
 * código do Sankhya), o que permite interceptar XMLHttpRequest e fetch
 * antes que as chamadas sejam enviadas.
 *
 * IMPORTANTE: Este script NÃO tem acesso às APIs chrome.*
 * A comunicação com o extension background é feita via window.postMessage
 * para o content-bridge.js (ISOLATED world), que então repassa ao background.
 *
 * POR QUE WORLD: "MAIN"?
 *  No Manifest V3, content scripts rodam por padrão em um mundo ISOLATED sem
 *  acesso ao escopo JS da página. Para fazer monkey-patching em window.XMLHttpRequest
 *  e window.fetch precisamos do mundo MAIN, onde a página e a extensão
 *  compartilham o mesmo objeto window.
 *
 * SEGURANÇA:
 *  - A mensagem postMessage usa um tipo privado difícil de adivinhar
 *  - O content-bridge valida event.source === window (rejeita iframes externos)
 *  - Nenhum dado de autenticação é extraído além do que o Sankhya já trafega
 */
(function () {
  'use strict';
  // IIFE (Immediately Invoked Function Expression): encapsula todas as
  // variáveis locais para NÃO poluir o escopo global da página monitorada.
  // Sem o IIFE, `const MSG_TYPE =` ficaria exposto em window e poderia
  // colidir com o código JavaScript do Sankhya.

  // Prefixo da mensagem — deve ser idêntico ao content-bridge.js
  const MSG_TYPE = '__SNKY_MON_CAPTURE__';

  // Tamanho máximo do corpo (request/response) enviado à extensão.
  // 8192 bytes = 8 KB: cobre o payload JSON típico do Sankhya sem
  // comprometer a memória da página em sessões com muitas requisições.
  const MAX_BODY_LEN = 8192;

  // ---------------------------------------------------------------------------
  // Filtros rápidos (executados no MAIN world para não sobrecarregar o bridge)
  // ---------------------------------------------------------------------------

  /** Extensões de arquivo estático a ignorar completamente. */
  const STATIC_RE = /\.(?:png|jpe?g|gif|svg|ico|webp|css|js|mjs|woff2?|ttf|eot|map)(?:\?|#|$)/i;

  /** Trackers e analytics a ignorar. */
  const TRACKER_RE = /(?:google-analytics|googletagmanager|gtag|clarity\.ms|facebook\.net)/i;

  /**
   * Decide se esta URL vale a pena capturar.
   * Prioriza chamadas /mge/ e descartas assets + trackers.
   */
  function shouldCapture(url) {
    if (!url) return false;
    if (url.startsWith('data:') || url.startsWith('blob:')) return false;
    if (STATIC_RE.test(url))  return false;
    if (TRACKER_RE.test(url)) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Envio da captura ao content-bridge via postMessage
  // ---------------------------------------------------------------------------

  /**
   * Envia os dados capturados ao content-bridge.js via postMessage.
   * Usa targetOrigin do próprio documento para não vazar dados.
   */
  function emit(data) {
    try {
      // targetOrigin '*' é necessário pois o Sankhya pode redirecionar para
      // sub-domínios; o content-bridge valida event.source === window
      window.postMessage({ type: MSG_TYPE, data }, '*');
    } catch (_) {
      // Silencia — nunca deve interromper a aplicação monitorada
    }
  }

  // ---------------------------------------------------------------------------
  // Interceptação de XMLHttpRequest
  // ---------------------------------------------------------------------------

  const OrigXHR = window.XMLHttpRequest;

    /**
     * Classe derivada de XMLHttpRequest nativa que adiciona captura transparente.
     *
     * Por que subclasse em vez de substituir propriedades diretamente?
     *  - `class extends OrigXHR` preserva todos os métodos e propriedades nativos
     *    sem precisar reimplementar `readyState`, `response`, `responseText`, etc.
     *  - O código do Sankhya usa `new XMLHttpRequest()` normalmente e não percebe
     *    a mudança — só `send()` e `setRequestHeader()` são sobrescritos.
     *  - `super.open()` / `super.send()` garantem que a requisição real ainda sai.
     */
    class MonitorXHR extends OrigXHR {
    constructor() {
      super();
      this._mon = {
        method:         'GET',
        url:            '',
        startTime:      0,
        requestHeaders: {},
        requestBody:    null,
      };
    }

    open(method, url, ...rest) {
      this._mon.method = (method || 'GET').toUpperCase();
      this._mon.url    = url ? String(url) : '';
      return super.open(method, url, ...rest);
    }

    setRequestHeader(header, value) {
      if (typeof header === 'string') {
        this._mon.requestHeaders[header.toLowerCase()] = String(value).substring(0, 256);
      }
      return super.setRequestHeader(header, value);
    }

    send(body) {
      const mon = this._mon;

      if (!shouldCapture(mon.url)) {
        return super.send(body);
      }

      mon.startTime = Date.now();

      // Captura o body da requisição (apenas strings; Blobs ignorados)
      if (typeof body === 'string') {
        mon.requestBody = body.substring(0, MAX_BODY_LEN);
      } else if (body instanceof URLSearchParams) {
        mon.requestBody = body.toString().substring(0, MAX_BODY_LEN);
      }

      // Escuta o evento de conclusão
      // POR QUE `loadend` em vez de `load` ou `readystatechange`?
      //  - `load`             só dispara em sucesso (não captura erros de rede ERR_*)
      //  - `readystatechange` dispara várias vezes durante o ciclo de vida
      //  - `loadend`          dispara UMA única vez ao final, qualquer que seja
      //                       o resultado (sucesso, erro HTTP, erro de rede, abort)
      //  Resultado: capturamos 100% das requisições iniciadas, inclusive timeouts.
      this.addEventListener('loadend', () => {
        try {
          const duration = Date.now() - mon.startTime;

          // Copia headers de resposta
          const responseHeaders = {};
          const rawHeaders = this.getAllResponseHeaders();
          if (rawHeaders) {
            rawHeaders.trim().split(/\r?\n/).forEach((line) => {
              const sep = line.indexOf(': ');
              if (sep > 0) {
                responseHeaders[line.substring(0, sep).toLowerCase()] =
                  line.substring(sep + 2).substring(0, 256);
              }
            });
          }

          emit({
            url:             mon.url,
            method:          mon.method,
            requestBody:     mon.requestBody,
            responseBody:    (this.responseText || '').substring(0, MAX_BODY_LEN),
            statusCode:      this.status,
            duration,
            timestamp:       mon.startTime,
            requestHeaders:  mon.requestHeaders,
            responseHeaders,
          });
        } catch (_) { /* nunca interrompe a aplicação */ }
      });

      return super.send(body);
    }
  }

  // Substitui globalmente (afeta todo código que usar new XMLHttpRequest())
  window.XMLHttpRequest = MonitorXHR;

  // ---------------------------------------------------------------------------
  // Interceptação de fetch
  // ---------------------------------------------------------------------------

  const origFetch = window.fetch;

  window.fetch = async function (input, init = {}) {
    // Extrai URL e método dos diferentes formatos aceitos por fetch()
    let url    = '';
    let method = 'GET';
    let reqHeaders = {};
    let reqBody    = null;

    try {
      if (typeof input === 'string')    url = input;
      else if (input instanceof URL)    url = input.toString();
      else if (input instanceof Request) {
        url    = input.url;
        method = (input.method || 'GET').toUpperCase();
      }
      if (init?.method) method = init.method.toUpperCase();
      if (init?.body && typeof init.body === 'string') {
        reqBody = init.body.substring(0, MAX_BODY_LEN);
      } else if (init?.body instanceof URLSearchParams) {
        reqBody = init.body.toString().substring(0, MAX_BODY_LEN);
      }
      if (init?.headers) {
        const h = new Headers(init.headers);
        h.forEach((v, k) => { reqHeaders[k.toLowerCase()] = v.substring(0, 256); });
      }
    } catch (_) { /* parsing defensivo */ }

    if (!shouldCapture(url)) {
      return origFetch.call(this, input, init);
    }

    const startTime = Date.now();

    let response;
    try {
      response = await origFetch.call(this, input, init);
    } catch (networkError) {
      // Captura erros de rede (ex: ERR_CONNECTION_REFUSED)
      emit({
        url, method, requestBody: reqBody, responseBody: '',
        statusCode: 0, duration: Date.now() - startTime,
        timestamp: startTime, requestHeaders: reqHeaders,
        responseHeaders: {}, networkError: String(networkError),
      });
      throw networkError;
    }

    const duration = Date.now() - startTime;

    // Captura response de forma não-destrutiva (clone)
    // POR QUE `response.clone()`?
    //  O stream do body de um Response só pode ser LIDO UMA ÚNICA VEZ.
    //  Se chamassemos response.text() diretamente, o stream seria consumido
    //  aqui e o código do Sankhya receberia um response com body vazio.
    //  `clone()` cria uma cópia indépendente do stream: nós lemos o clone,
    //  o Sankhya lê o response original — ambos funcionam normalmente.
    const respHeaders = {};
    response.headers.forEach((v, k) => { respHeaders[k.toLowerCase()] = v.substring(0, 256); });

    response.clone().text().then((body) => {
      emit({
        url, method, requestBody: reqBody,
        responseBody:    body.substring(0, MAX_BODY_LEN),
        statusCode:      response.status,
        duration, timestamp: startTime,
        requestHeaders:  reqHeaders,
        responseHeaders: respHeaders,
      });
    }).catch(() => { /* body não legível (ex: binário) */ });

    return response;
  };

})();
