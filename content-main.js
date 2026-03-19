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
  const MSG_TYPE        = '__SNKY_MON_CAPTURE__';
  const MSG_TYPE_API    = '__SNKY_MON_API_CALL__'; // M1/M2: chamadas API internas Sankhya

  // Tamanho máximo do corpo (request/response) enviado à extensão.
  // 8192 bytes = 8 KB: cobre o payload JSON típico do Sankhya sem
  // comprometer a memória da página em sessões com muitas requisições.
  const MAX_BODY_LEN = 8192;

  // ---------------------------------------------------------------------------
  // M6 — Captura de call stack enriquecida (rawStack + ownerFrame)
  // ---------------------------------------------------------------------------

  /** Padrões de ruído a filtrar dos frames (extensão, webpack, browser internals). */
  const STACK_NOISE_RE = /chrome-extension:|node_modules|webpack-internal:|__SNKY_MON|MonitorXHR|patchFn|patchWhenAvailable/;

  /** Padrões que indicam libs genéricas (não-Sankhya) — owner frame não deve ser delas. */
  const GENERIC_LIB_RE = /(?:jquery|lodash|underscore|moment|axios|rxjs|zone\.js|polyfill|angular\/core|react\/cjs|vue\.runtime)/i;

  /** Padrões de código Sankhya — frames que os contêm têm mais peso como owner. */
  const SANKHYA_FRAME_RE = /ServiceProxy|CRUDService|ActionExecutor|sankhya|mge|openForm|loadForm|saveForm|notifyListeners/i;

  /**
   * Parseia um stack trace enriquecido.
   * Retorna frames filtrados + rawStack truncado + ownerFrame (primeiro frame "dono" relevante).
   *
   * M6: além dos frames resumidos, preserva rawStack e calcula ownerFrame.
   *
   * @param {string} raw  string bruta de new Error().stack
   * @returns {{ frames: Array, rawStack: string, ownerFrame: Object|null }}
   */
  function parseStack(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const frames = [];
    // Suporta dois formatos: "at fn (file:line:col)" e "at file:line:col"
    const re = /at (?:(.+?) \((.+?):(\d+):(\d+)\)|(.+?):(\d+):(\d+))/g;
    let m;
    while ((m = re.exec(raw)) !== null && frames.length < 20) {
      const fn   = (m[1] || '(anonymous)').trim();
      const file = m[2] || m[5] || '';
      const line = parseInt(m[3] || m[6] || '0', 10);
      const col  = parseInt(m[4] || m[7] || '0', 10);
      // Filtra ruído da extensão e internos do browser
      if (STACK_NOISE_RE.test(file) || STACK_NOISE_RE.test(fn)) continue;
      frames.push({ fn, file, line, col });
    }
    if (!frames.length) return null;

    // M6: calcula o "ownerFrame" — primeiro frame fora de libs genéricas e não-anônimo
    let ownerFrame = null;
    for (const f of frames) {
      if (f.fn === '(anonymous)') continue;
      if (GENERIC_LIB_RE.test(f.file)) continue;
      ownerFrame = f;
      break;
    }
    // Fallback: primeiro frame Sankhya mesmo que anônimo
    if (!ownerFrame) {
      ownerFrame = frames.find((f) => SANKHYA_FRAME_RE.test(f.fn) || SANKHYA_FRAME_RE.test(f.file)) ?? frames[0];
    }

    // M6: rawStack truncado (útil para debug quando o parser perde o frame)
    const rawStack = raw.substring(0, 2000);

    return { frames: frames.slice(0, 12), rawStack, ownerFrame };
  }

  // ---------------------------------------------------------------------------
  // E8 — Timeline de ação do usuário
  // ---------------------------------------------------------------------------

  /** Buffer circular de eventos de UI — máx 50 entradas. */
  const UI_EVENTS = [];
  const UI_EVENTS_MAX = 50;

  /**
   * Captura um evento DOM seguro (sem dados sensíveis) e o armazena no buffer.
   * Ignora campos de senha e elementos marcados como data-sensitive.
   * M4: inclui contexto dos ancestrais do elemento (até 5 níveis).
   */
  function captureUIEvent(e) {
    try {
      const el = e.target;
      if (!el) return;
      // Segurança: ignora campos de senha e elementos sensíveis (OWASP A02)
      if (el.type === 'password' || el.closest('[data-sensitive]')) return;
      // Para keydown, só captura teclas funcionais (Enter, F2, F5, Escape)
      if (e.type === 'keydown' && ![13, 116, 9, 27, 113].includes(e.keyCode)) return;

      const entry = {
        type: e.type,
        ts:   Date.now(),
        tag:  el.tagName?.toLowerCase() || '',
        id:   el.id ? String(el.id).substring(0, 60) : '',
        name: el.name ? String(el.name).substring(0, 60) : '',
        cls:  el.className ? String(el.className).substring(0, 80) : '',
        text: el.innerText ? el.innerText.substring(0, 40).trim() : '',
        data: el.dataset
          ? Object.fromEntries(Object.entries(el.dataset).slice(0, 5).map(([k, v]) => [k, String(v).substring(0, 60)]))
          : {},
        // M4: contexto DOM dos ancestrais (estrutura de tela ao redor do elemento)
        ancestors: e.type === 'click' ? captureAncestorContext(el) : undefined,
      };

      if (UI_EVENTS.length >= UI_EVENTS_MAX) UI_EVENTS.shift();
      UI_EVENTS.push(entry);
    } catch (_) { /* nunca interrompe a aplicação */ }
  }

  // Registra listeners de eventos do usuário na fase de captura (bubbling completo)
  ['click', 'change', 'submit', 'keydown'].forEach((evType) => {
    document.addEventListener(evType, captureUIEvent, true);
  });

  // ---------------------------------------------------------------------------
  // M4 — Snapshot de contexto de tela enriquecido
  // ---------------------------------------------------------------------------

  /**
   * Captura screenshot enriquecido do contexto visual da tela Sankhya (SPA).
   * M4: além de breadcrumbs, extrai aba ativa, modal/popup aberto, hints de formulário,
   * contexto do registro selecionado (rowId, pk, entityName), e atributos data-*.
   *
   * @returns {Object}
   */
  function captureScreenSnapshot() {
    try {
      const breadcrumbs = [
        ...document.querySelectorAll('.breadcrumb li, [class*=breadcrumb] li, nav ol li'),
      ]
        .map((el) => el.innerText?.trim())
        .filter(Boolean)
        .slice(0, 6);

      // M4: aba ativa (tab panels Sankhya)
      let activeTab = null;
      try {
        const tabEl = document.querySelector(
          '.tab-item.active, [class*=tab].active, [class*=tab][aria-selected="true"], [role=tab][aria-selected="true"]'
        );
        if (tabEl) activeTab = (tabEl.innerText || tabEl.getAttribute('title') || '').trim().substring(0, 60) || null;
      } catch (_) {}

      // M4: modal/popup aberto
      let modalTitle = null;
      try {
        const modalEl = document.querySelector(
          '[class*=modal] [class*=title], [class*=dialog] [class*=title], [class*=popup] [class*=header], [role=dialog] h1, [role=dialog] h2'
        );
        if (modalEl) modalTitle = (modalEl.innerText || '').trim().substring(0, 80) || null;
      } catch (_) {}

      // M4: hints de formulário — captura data-*, resource-id, form-id, component-id, application
      const formHints = {};
      try {
        const containerSelectors = [
          '[data-form-id]', '[data-component-id]', '[data-resource-id]',
          '[form-id]', '[component-id]', '[resource-id]',
          '[class*=sankhya-form]', '[class*=form-panel]', '[data-application]',
        ];
        for (const sel of containerSelectors) {
          const el = document.querySelector(sel);
          if (!el) continue;
          if (el.dataset.formId || el.getAttribute('form-id'))
            formHints.formId = (el.dataset.formId || el.getAttribute('form-id') || '').substring(0, 60);
          if (el.dataset.componentId || el.getAttribute('component-id'))
            formHints.componentId = (el.dataset.componentId || el.getAttribute('component-id') || '').substring(0, 60);
          if (el.dataset.resourceId || el.getAttribute('resource-id'))
            formHints.resourceId = (el.dataset.resourceId || el.getAttribute('resource-id') || '').substring(0, 60);
          if (el.dataset.application || el.getAttribute('data-application'))
            formHints.application = (el.dataset.application || el.getAttribute('data-application') || '').substring(0, 60);
        }
      } catch (_) {}

      // M4: contexto do registro selecionado (linha da grid, pk, entityName)
      const selectedContext = {};
      try {
        const rowEl = document.querySelector('.grid-row.selected, [class*=row][class*=selected], tr.selected, [aria-selected="true"]');
        if (rowEl) {
          selectedContext.rowId      = (rowEl.dataset.rowid      || rowEl.getAttribute('data-rowid')      || '').substring(0, 60) || undefined;
          selectedContext.pk         = (rowEl.dataset.pk         || rowEl.getAttribute('data-pk')         || '').substring(0, 100) || undefined;
          selectedContext.entityName = (rowEl.dataset.entityname || rowEl.getAttribute('data-entityname') || '').substring(0, 60) || undefined;
        }
        // Tenta pk em inputs ocultos com o nome "pk" ou "nunota"
        if (!selectedContext.pk) {
          const pkInput = document.querySelector('input[name="pk"], input[name="nunota"], input[data-pk]');
          if (pkInput) selectedContext.pk = pkInput.value.substring(0, 100) || undefined;
        }
      } catch (_) {}

      return {
        url:             location.href,
        title:           document.title,
        hash:            location.hash,
        breadcrumbs,
        activeTab:       activeTab   || undefined,
        modalTitle:      modalTitle  || undefined,
        formHints:       Object.keys(formHints).length      ? formHints      : undefined,
        selectedContext: Object.keys(selectedContext).length ? selectedContext : undefined,
      };
    } catch (_) {
      return { url: location.href, title: '', hash: location.hash, breadcrumbs: [] };
    }
  }

  /**
   * Captura o contexto DOM dos ancestrais do elemento clicado (até 5 níveis acima).
   * Usada pelo captureUIEvent para enriquecer cliques com contexto estrutural.
   * M4: captura data-* e atributos relevantes dos ancestrais.
   *
   * @param {Element} el  elemento alvo do evento
   * @returns {Array<{tag, id, cls, data}>}
   */
  function captureAncestorContext(el) {
    const ancestors = [];
    let node = el?.parentElement;
    for (let i = 0; i < 5 && node && node !== document.body; i++) {
      const data = {};
      for (const [k, v] of Object.entries(node.dataset || {})) {
        // Filtra keys pequenas e relevantes; ignora data muito longas
        if (k.length < 40 && String(v).length < 80) data[k] = v;
      }
      ancestors.push({
        tag: node.tagName?.toLowerCase(),
        id:  node.id ? node.id.substring(0, 40) : undefined,
        cls: node.className ? String(node.className).substring(0, 60) : undefined,
        data: Object.keys(data).length ? data : undefined,
      });
      node = node.parentElement;
    }
    return ancestors;
  }

  /** Snapshot atual — atualizado ao mudar rota (SPA hashchange). */
  let currentSnapshot = captureScreenSnapshot();
  window.addEventListener('hashchange', () => { currentSnapshot = captureScreenSnapshot(); });

  // ---------------------------------------------------------------------------
  // M1 + M2 — Monkey-patch de APIs Sankhya internas
  // ---------------------------------------------------------------------------
  // Em vez de inferir "quem chamou" a partir do stack HTTP, interceptamos
  // diretamente as funções do framework Sankhya (ServiceProxy, CRUDService, etc.)
  // ANTES da serialização do payload. Isso fornece:
  //   - serviceName / application / resourceID diretamente dos argumentos
  //   - payload original antes de virar body HTTP
  //   - contexto `this` (componente/tela que originou a chamada)
  //   - nome da função chamadora explícito
  //
  // O evento emitido (MSG_TYPE_API) é correlacionado no background.js com a
  // requisição HTTP que vier logo a seguir (janela de 2s, mesmo serviceName).
  // ---------------------------------------------------------------------------

  /**
   * Emite uma captura de chamada API interna para o content-bridge via postMessage.
   * Usa MSG_TYPE_API para que o bridge e background possam rotear separadamente.
   */
  function emitApiCall(data) {
    try {
      window.postMessage({ type: MSG_TYPE_API, data }, '*');
    } catch (_) {}
  }

  /**
   * Tenta extrair serviceName, application e resourceID do primeiro argumento
   * de uma chamada de API Sankhya, dado que o argumento pode ser um objeto config
   * ou uma string de serviço.
   *
   * @param {string} fnName  nome da função patchada (ex: 'ServiceProxy.callService')
   * @param {any[]}  args    argumentos originais passados à função
   * @returns {{ serviceName, application, resourceID, rawArg }}
   */
  function extractApiArgs(fnName, args) {
    const first = args[0];
    let serviceName  = null;
    let application  = null;
    let resourceID   = null;
    let rawArg       = null;

    try {
      if (typeof first === 'string') {
        serviceName = first.substring(0, 120);
      } else if (first && typeof first === 'object') {
        serviceName = String(first.serviceName || first.service || first.name || '').substring(0, 120) || null;
        application = String(first.application || first.app || '').substring(0, 80) || null;
        resourceID  = String(first.resourceID  || first.resourceId || first.id || '').substring(0, 80) || null;
        // Serializa apenas as chaves superficiais (sem dados sensíveis profundos)
        const keys = Object.keys(first).slice(0, 10);
        rawArg = JSON.stringify(Object.fromEntries(keys.map((k) => [k, typeof first[k] === 'object' ? '[Object]' : first[k]]))).substring(0, 512);
      }
      // Segundo argumento: pode conter application ou payload
      const second = args[1];
      if (!application && second && typeof second === 'object') {
        application = String(second.application || second.app || '').substring(0, 80) || null;
      }
    } catch (_) {}

    return { serviceName, application, resourceID, rawArg };
  }

  /**
   * Cria um wrapper de patch para um método do objeto alvo.
   * Captura: nome da função, argumentos, `this` context digest, call stack.
   *
   * @param {Object} target   objeto que contém o método (ex: window.ServiceProxy)
   * @param {string} method   nome do método a patchar (ex: 'callService')
   * @param {string} fullName nome completo para exibição (ex: 'ServiceProxy.callService')
   */
  function patchMethod(target, method, fullName) {
    const original = target[method];
    if (typeof original !== 'function') return;
    // Marca para não repatchar se o script for injetado mais de uma vez
    if (original.__snkyPatched) return;

    target[method] = function patchFn(...args) {
      try {
        const callStack = parseStack(new Error().stack);
        const { serviceName, application, resourceID, rawArg } = extractApiArgs(fullName, args);
        emitApiCall({
          fn:          fullName,
          serviceName,
          application,
          resourceID,
          rawArg,
          // M2: captura contexto `this` resumido (nome do componente/classe)
          thisContext: (this?.constructor?.name
                     || this?.componentId
                     || this?.id
                     || '') .toString().substring(0, 60) || null,
          callStack,
          uiContext:    UI_EVENTS.slice(-3).filter((ev) => ev.ts > Date.now() - 5000),
          screenContext: currentSnapshot,
          ts:           Date.now(),
        });
      } catch (_) { /* captura nunca interrompe a aplicação */ }

      return original.apply(this, args);
    };
    target[method].__snkyPatched = true;
  }

  /**
   * Tenta patchar um conjunto de métodos de um objeto no `window`.
   * Repete com retry exponencial (até 10 tentativas, máx 30s) para cobrir
   * o caso em que o Sankhya carrega os objetos de forma assíncrona após o
   * script ser injetado.
   *
   * @param {string}   objName  nome do objeto no window (ex: 'ServiceProxy')
   * @param {string[]} methods  lista de métodos a patchar (ex: ['callService'])
   * @param {number}   attempt  tentativa atual (controle interno)
   */
  function patchWhenAvailable(objName, methods, attempt = 0) {
    const obj = window[objName];
    if (obj && typeof obj === 'object') {
      methods.forEach((m) => patchMethod(obj, m, `${objName}.${m}`));
      return; // sucesso — todos os métodos encontrados
    }
    // Retry com backoff: 100ms, 200ms, 400ms, … até 10240ms (10 tentativas)
    if (attempt < 10) {
      setTimeout(() => patchWhenAvailable(objName, methods, attempt + 1), Math.min(100 * (2 ** attempt), 10240));
    }
  }

  // Lista de APIs Sankhya a interceptar
  // ServiceProxy é o ponto central — quase todos os serviços passam por ele
  patchWhenAvailable('ServiceProxy',  ['callService']);
  patchWhenAvailable('CRUDService',   ['loadRecords', 'save', 'remove', 'loadGrid']);
  patchWhenAvailable('ActionExecutor',['execute']);
  // Funções globais do framework
  ['openForm', 'loadForm', 'saveForm', 'notifyListeners', 'dispatchEvent', 'triggerEvent']
    .forEach((fn) => {
      if (typeof window[fn] === 'function' && !window[fn].__snkyPatched) {
        patchMethod(window, fn, fn);
      } else {
        // Para funções globais, tentamos com patchWhenAvailable
        patchWhenAvailable(fn, [fn]);
      }
    });

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
        callStack:      null,
      };
    }

    open(method, url, ...rest) {
      this._mon.method    = (method || 'GET').toUpperCase();
      this._mon.url       = url ? String(url) : '';
      // E1: captura call stack no momento do open() — antes do super.open()
      // para que o stack ainda reflita o código da aplicação, não internos do browser
      this._mon.callStack = parseStack(new Error().stack);
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
            // Usa responseURL (final URL após redirecionamentos) quando disponível.
            // Exemplo: uma requisição a /mge/login pode redirecionar para /mge/auth/sso,
            // e o responseURL reflete o destino final — importante para análise de fluxo.
            url:             this.responseURL || mon.url,
            method:          mon.method,
            requestBody:     mon.requestBody,
            responseBody:    (this.responseText || '').substring(0, MAX_BODY_LEN),
            statusCode:      this.status,
            duration,
            timestamp:       mon.startTime,
            requestHeaders:  mon.requestHeaders,
            responseHeaders,
            // E1: stack de chamadas capturado no open()
            callStack:       mon.callStack,
            // E8: contexto do usuário e da tela
            uiContext:       UI_EVENTS.slice(-5).filter((ev) => ev.ts > Date.now() - 5000),
            screenContext:   currentSnapshot,
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
    // E1: captura call stack antes de sair para o browser — enquanto o stack
    // ainda contém frames do código da aplicação Sankhya
    const fetchCallStack  = parseStack(new Error().stack);
    // E8: snapshot de eventos e tela no momento do disparo do fetch
    const fetchUiContext  = UI_EVENTS.slice(-5).filter((ev) => ev.ts > Date.now() - 5000);
    const fetchScreenCtx  = currentSnapshot;

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
        callStack: fetchCallStack, uiContext: fetchUiContext, screenContext: fetchScreenCtx,
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
        // E1 + E8
        callStack:       fetchCallStack,
        uiContext:       fetchUiContext,
        screenContext:   fetchScreenCtx,
      });
    }).catch(() => { /* body não legível (ex: binário) */ });

    return response;
  };

})();
