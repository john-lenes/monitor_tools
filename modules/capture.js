/**
 * capture.js — Utilitários de captura e normalização de requisições HTTP.
 *
 * CONTEXTO ARQUITETURAL
 * ─────────────────────
 * A extensão captura requisições HTTP de DUAS fontes independentes:
 *
 *   [FONTE PRIMÁRIA]   content-main.js (world: MAIN)
 *     Intercepta XHR/fetch diretamente no JS da página.
 *     Vantagem: sempre ativo, não exige que o DevTools esteja aberto.
 *     Limitação: acesso ao response body depende de response.clone().
 *
 *   [FONTE SECUNDÁRIA] devtools.js
 *     Usa chrome.devtools.network.onRequestFinished (HAR).
 *     Vantagem: response body e headers precisos via API dedicada.
 *     Limitação: só funciona enquanto o painel DevTools está aberto.
 *
 * A MESMA requisição pode chegar pelas duas fontes num intervalo de
 * milissegundos. Este módulo é responsável por:
 *   1. Gerar um ID de rastreamento por requisição (generateRequestId)
 *   2. Converter formatos heterogêneos em objeto canônico (normalizeRequest)
 *   3. Sanitizar headers removendo valores sensíveis/excessivos (sanitizeHeaders)
 *   4. Detectar e descartar duplicatas entre as fontes (isDuplicate)
 *   5. Pré-filtrar URLs sem valor diagnóstico (isWorthProcessing)
 *
 * IMPORTANTE: isWorthProcessing é um filtro RÁPIDO e permissivo.
 * A decisão definitiva sobre relevância é feita por classifier.js após
 * o parsing completo do payload e da resposta.
 */

// ---------------------------------------------------------------------------
// Geração de ID
// ---------------------------------------------------------------------------

let _counter = 0;

/**
 * Gera um ID único para a requisição capturada.
 *
 * Estratégia: timestamp (ms desde epoch) + contador sequencial de 5 dígitos.
 *  - O timestamp garante unicidade entre sessões e recargas da extensão.
 *  - O contador resolve colisões quando múltiplas requisições chegam no
 *    mesmo milissegundo (ex: carregamento inicial de página com 10+ XHRs).
 *  - O módulo de 100_000 evita que o contador cresça indefinidamente em
 *    sessões longas; após 99.999 chamadas ele reinicia do 0, mas o
 *    timestamp diferente garante que não haverá colisão real.
 *
 * Exemplo de ID gerado: "req_1710000000123_00042"
 *
 * @returns {string}
 */
export function generateRequestId() {
  _counter = (_counter + 1) % 100_000;
  return `req_${Date.now()}_${String(_counter).padStart(5, '0')}`;
}

// ---------------------------------------------------------------------------
// Normalização
// ---------------------------------------------------------------------------

/**
 * Transforma os dados brutos de uma requisição em um objeto CANÔNICO
 * padronizado para armazenamento e análise.
 *
 * Por que o formato canônico é necessário?
 *  As duas fontes de captura (content script e DevTools HAR) usam
 *  nomes de campos ligeiramente diferentes:
 *    - content-main.js envia `statusCode` (nome do campo XHR/fetch)
 *    - devtools.js envia o HAR que usa `status` (padrão HTTP Archive)
 *  O normalizer unifica tudo em um schema consistente que os demais
 *  módulos (parser, classifier, reporter) podem consumir sem distinção.
 *
 * Limites de tamanho (4096 bytes por corpo):
 *  O chrome.storage.local tem limite total de ~5 MB e quota de 8KB por item.
 *  Sessões longas podem acumular dezenas de requisições; truncar os corpos
 *  impede que o storage seja saturado por respostas grandes (ex: grids
 *  do Sankhya com centenas de linhas em JSON).
 *
 * @param {Object} raw     dados brutos vindos de content-bridge ou devtools
 * @param {string} source  'content' | 'devtools' — rastreia a origem da captura
 * @returns {Object}  objeto canônico pronto para parser.js
 */
export function normalizeRequest(raw, source = 'content') {
  return {
    id:              generateRequestId(),
    source,                                        // 'content' | 'devtools'
    url:             String(raw.url || ''),
    method:          String(raw.method || 'GET').toUpperCase(),
    // statusCode = campo do content-main.js | status = campo do HAR (devtools)
    status:          Number(raw.statusCode || raw.status || 0),
    duration:        Number(raw.duration || 0),     // em milissegundos
    timestamp:       Number(raw.timestamp || Date.now()),  // epoch ms de início
    requestHeaders:  sanitizeHeaders(raw.requestHeaders),
    responseHeaders: sanitizeHeaders(raw.responseHeaders),
    // Trunca corpos para proteger o chrome.storage.local de overflow.
    // Limite: 8192 bytes ≈ 8 KB por corpo — cobre a maioria das respostas
    // Sankhya (grids pequenos, JSON de negócio) sem saturar o storage em
    // sessões longas. Respostas maiores (grids de centenas de linhas) ficam
    // parcialmente truncadas mas ainda contêm dados suficientes para diagnóstico.
    requestBody:     truncate(raw.requestBody, 8192),
    responseBody:    truncate(raw.responseBody, 8192),
  };
}

/**
 * Normaliza e sanitiza um objeto de headers HTTP para armazenamento seguro.
 *
 * Por que o limite de 256 caracteres por valor?
 *  Headers como `Cookie` e `Set-Cookie` podem ter centenas de bytes e
 *  não têm valor de diagnóstico para análise de chamadas Sankhya.
 *  Outros headers relevantes (Content-Type, Authorization parcial,
 *  X-XSRF-Token) cabem confortavelmente em 256 chars.
 *
 * As chaves são normalizadas para lowercase para garantir comparação
 * consistente independente da capitalização enviada pelo servidor.
 *
 * @param {any} headers  objeto de headers no formato { Nome: 'valor' }
 * @returns {Record<string,string>}  objeto plano lowercased e truncado
 */
function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof key === 'string') {
      result[key.toLowerCase()] = String(value).substring(0, 256);
    }
  }
  return result;
}

/**
 * Trunca uma string ao tamanho máximo especificado.
 * @param {any}    value
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(value, maxLen) {
  if (!value || typeof value !== 'string') return '';
  return value.length > maxLen ? value.substring(0, maxLen) + '…[truncado]' : value;
}

// ---------------------------------------------------------------------------
// Deduplicação
// ---------------------------------------------------------------------------

/**
 * Encontra a entrada existente que corresponde à nova requisição.
 * Retorna a entrada ou null (null = não é duplicata, deve ser adicionada).
 *
 * Critério de duplicata: mesma URL + mesmo método HTTP + timestamps a
 * menos de 500ms de diferença (cobre o delta entre a captura do content
 * script no momento do send() e a captura do DevTools no onRequestFinished).
 *
 * Substituiu `isDuplicate` (boolean) para permitir merge inteligente no
 * background.js: quando o DevTools captura algo que o content já registrou,
 * enriquecemos a entrada em vez de descartar os dados melhores do DevTools.
 *
 * @param {Object}   newReq     request normalizado recém chegado
 * @param {Object[]} existing   lista de requests já salvos na sessão atual
 * @returns {Object|null}  entrada existente ou null
 */
export function findDuplicate(newReq, existing = []) {
  return existing.find((r) =>
    r.url    === newReq.url &&
    r.method === newReq.method &&
    Math.abs(r.timestamp - newReq.timestamp) < 500,
  ) ?? null;
}

/**
 * Enriquece uma requisição content-capturada com dados mais completos do DevTools.
 *
 * Por que o DevTools tem dados melhores?
 *  - responseBody: o content script lê `responseText` com limite MAX_BODY_LEN;
 *    o DevTools acessa o buffer completo via getContent() (HAR API).
 *  - duration: medido na camada de rede (HAR) — mais preciso que clock JS.
 *  - status HTTP: o HAR reporta o código real independente de CORS.
 *  - responseHeaders: DevTools vê todos os headers, inclusive os que o
 *    browser bloqueia para scripts (ex: Set-Cookie, Content-Security-Policy).
 *
 * Muta `target` in place (a entrada já no storage) para evitar custos de cópia.
 *
 * @param {Object} target       entrada existente na sessão (source='content')
 * @param {Object} devtoolsReq  dados normalizados com source='devtools'
 */
export function mergeWithDevtools(target, devtoolsReq) {
  // Prefere response body mais longo (mais completo, menos truncado)
  if (
    devtoolsReq.responseBody &&
    devtoolsReq.responseBody.length > (target.responseBody?.length ?? 0)
  ) {
    target.responseBody = devtoolsReq.responseBody;
  }

  // request body do DevTools vem do postData.text (formato HAR) — pode ser
  // mais completo se o content script não capturou por ser FormData/Blob
  if (devtoolsReq.requestBody && devtoolsReq.requestBody.length > (target.requestBody?.length ?? 0)) {
    target.requestBody = devtoolsReq.requestBody;
  }

  // Status HTTP do DevTools (HAR) é autoritativo
  if (devtoolsReq.status > 0) target.status = devtoolsReq.status;

  // Duration do HAR (camada de rede) é mais preciso que clock JS
  if (devtoolsReq.duration > 0) target.duration = devtoolsReq.duration;

  // Resposta headers: devtools tem acesso a headers normalmente ocultos
  if (devtoolsReq.responseHeaders && Object.keys(devtoolsReq.responseHeaders).length > 0) {
    target.responseHeaders = { ...target.responseHeaders, ...devtoolsReq.responseHeaders };
  }

  // Marca a entrada como enriquecida para fins de diagnóstico no relatório
  target.source = 'merged';
}

// ---------------------------------------------------------------------------
// Pontuação de relevância rápida (pré-classificação)
// ---------------------------------------------------------------------------

/**
 * PRÉ-FILTRO RÁPIDO — decide se vale a pena processar esta requisição.
 *
 * Esta função é DIFERENTE e ANTERIOR à classificação feita por classifier.js:
 *
 *   isWorthProcessing (aqui)
 *     → Executada no background.js ANTES de qualquer parsing.
 *     → Regras simples baseadas apenas em URL e método HTTP.
 *     → Objetivo: rejeitar rapidamente o que é obviamente inútil,
 *       poupando CPU de parsear e classificar imagens, fontes, etc.
 *
 *   classifyRequest (classifier.js)
 *     → Executada DEPOIS do parsing completo de queryParams e payload.
 *     → Tem acesso ao serviceName, status HTTP, tempo de resposta.
 *     → Decisão definitiva e detalhada sobre categoria e criticidade.
 *
 * Regras aplicadas aqui (ordem de prioridade):
 *  1. Sempre inclui chamadas Sankhya /mge/ (endpoint central do sistema)
 *  2. Sempre inclui mutações (POST, PUT, PATCH, DELETE) de qualquer origem
 *  3. Descarta GETs com extensão de arquivo estático conhecida
 *  4. Permite demais GETs (podem ser APIs REST da empresa)
 *
 * @param {string} url     URL completa da requisição
 * @param {string} method  Método HTTP em uppercase
 * @returns {boolean}  true = prosseguir com processamento e armazenamento
 */
export function isWorthProcessing(url, method) {
  if (!url) return false;

  // Endpoint central do Sankhya — sempre inclui (ex: POST /mge/service.sbr)
  if (url.includes('/mge/')) return true;

  // Mutações de dados têm alto valor diagnóstico independente da origem
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return true;

  // Descarta GETs com extensão de arquivo estático (imagens, CSS, JS, fontes)
  const staticExt = /\.(?:png|jpe?g|gif|svg|ico|css|js|woff2?|ttf|eot|map)(?:\?|#|$)/i;
  if (staticExt.test(url)) return false;

  // Demais GETs (APIs REST, endpoints de dados) são incluídos para análise
  return true;
}
