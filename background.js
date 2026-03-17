/**
 * background.js — Service Worker (Manifest V3)
 *
 * Central de controle da extensão Sankhya Monitor.
 * Única peça com acesso completo às APIs chrome.storage e chrome.runtime.
 *
 * MÁQUINA DE ESTADOS DA SESSÃO:
 * ─────────────────────────────────────────────────────────────────────
 *   ┌────────────────────────────────────────────────────────────┐
 *   │                                                            │
 *   ▼                                                            │
 *  [idle] ─── START_SESSION ──▶ [monitoring] ─── STOP_SESSION ──▶ [finished]
 *    ▲                                │                               │
 *    └──────────────────── CLEAR_SESSION ◀─────────────────────────── ┘
 *
 * Estados armazenados na chave 'sankhya_monitor_state' do storage.local.
 *
 * PIPELINE DE PROCESSAMENTO (em processAndStore):
 *  1. isWorthProcessing()  → pré-filtro rápido por URL/method (evita parse)
 *  2. isStaticAsset()      → descarta PNG, CSS, JS, fontes, etc.
 *  3. isPolling()          → descarta heartbeat e keep-alive
 *  4. normalizeRequest()   → cria objeto canônico com campos padronizados
 *  5. isDuplicate()        → janela de 500ms evita duplicatas das 2 fontes
 *  6. parseQueryParams()   → extrai serviceName, application, etc. da URL
 *  7. parsePayload()       → decodifica o body (JSON, form-encoded ou misto)
 *  8. parseResponse()      → detecta erros Sankhya/Java/Oracle no response
 *  9. classifyRequest()    → determina categoria, criticidade e gargalos
 * 10. persist + notify     → grava na sessão e avisa o popup se aberto
 *
 * FONTES DE CAPTURA:
 *  PRIMARY   → content-main.js intercepta XHR/fetch (sempre ativo)
 *  SECONDARY → devtools.js via chrome.devtools.network (requer painel aberto)
 */

import { normalizeRequest, isDuplicate, isWorthProcessing } from './modules/capture.js';
import { parseQueryParams, parsePayload, parseResponse }    from './modules/parser.js';
import { classifyRequest, isStaticAsset, isPolling }        from './modules/classifier.js';
import { generateTextReport, getSessionStats }              from './modules/reporter.js';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const STORAGE_SESSION = 'sankhya_monitor_session';
const STORAGE_STATE   = 'sankhya_monitor_state';

/** Estados possíveis da sessão. */
const State = Object.freeze({
  IDLE:       'idle',
  MONITORING: 'monitoring',
  FINISHED:   'finished',
});

// ---------------------------------------------------------------------------
// Acesso ao storage
// ---------------------------------------------------------------------------

/** Lê o estado e a sessão atuais do storage. */
async function readStorage() {
  const data = await chrome.storage.local.get([STORAGE_STATE, STORAGE_SESSION]);
  return {
    status:  data[STORAGE_STATE]   ?? State.IDLE,
    session: data[STORAGE_SESSION] ?? null,
  };
}

/** Persiste estado e sessão no storage. */
async function writeStorage(status, session) {
  await chrome.storage.local.set({
    [STORAGE_STATE]:   status,
    [STORAGE_SESSION]: session,
  });
}

// ---------------------------------------------------------------------------
// Processamento de requisição capturada
// ---------------------------------------------------------------------------

/**
 * Recebe dados brutos de uma fonte de captura, executa o pipeline de 10 passos
 * e, se a requisição for nova e relevante, persiste na sessão ativa.
 *
 * Só processa se: estado === 'monitoring' AND sessão existe AND não é duplicata.
 *
 * @param {Object} raw     dados brutos da requisição (estrutura varia por fonte)
 * @param {string} source  'content' (content-bridge) | 'devtools' (DevTools Network)
 */
async function processAndStore(raw, source) {
  const { status, session } = await readStorage();
  if (status !== State.MONITORING || !session) return;

  const { url = '', method = 'GET' } = raw;

  // [Passo 1] Pré-filtro rápido — evita o custo de normalizar requisições
  //           claramente irrelevantes (GETs simples a assets, data: URLs, etc.)
  if (!isWorthProcessing(url, method)) return;
  // [Passo 2–3] Descarta assets e polling (funções do classifier são baratas)
  if (isStaticAsset(url))  return;
  if (isPolling(url))      return;

  // [Passo 4] Normaliza — cria o objeto canônico independente da fonte de captura
  //           Mapeia campos de nomes diferentes (statusCode vs status) em um só formato.
  const normalized = normalizeRequest(raw, source);

  // [Passo 5] Deduplicar — janela de 500ms evita que a mesma requisição
  //           capturada por content-main.js E por devtools.js seja contada duas vezes.
  if (isDuplicate(normalized, session.requests || [])) return;

  // [Passo 6–8] Parsear URL, body e response
  normalized.queryParams    = parseQueryParams(normalized.url);
  normalized.parsedPayload  = parsePayload(normalized.requestBody);
  normalized.parsedResponse = parseResponse(normalized.responseBody);

  // [Passo 9] Classificar — determina categoria funcional, criticidade e gargalos
  normalized.classification = classifyRequest(normalized);

  // [Passo 10] Persistir e notificar o popup
  session.requests = session.requests || [];
  session.requests.push(normalized);
  await writeStorage(State.MONITORING, session);

  // Notifica o popup (ignora erro se popup estiver fechado)
  const stats = getSessionStats(session.requests);
  chrome.runtime.sendMessage({
    action:  'REQUEST_ADDED',
    request: normalized,
    stats,
  }).catch(() => { /* popup fechado — ignorado */ });
}

// ---------------------------------------------------------------------------
// Handler de mensagens
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));
  return true; // resposta assíncrona
});

/**
 * Despacha a mensagem para o handler correto.
 *
 * @param {{ action: string, [key: string]: any }} message
 * @returns {Promise<Object>}
 */
async function handleMessage(message) {
  switch (message.action) {

    // ── Iniciar sessão ──────────────────────────────────────────────────
    case 'START_SESSION': {
      const name = message.name?.trim() || `Sessão ${new Date().toLocaleString('pt-BR')}`;
      const session = {
        name,
        requests:   [],
        startedAt:  Date.now(),
        finishedAt: null,
        textReport: null,
      };
      await writeStorage(State.MONITORING, session);
      return { success: true, status: State.MONITORING };
    }

    // ── Finalizar sessão ────────────────────────────────────────────────
    case 'STOP_SESSION': {
      const { session } = await readStorage();
      if (!session) return { success: false, error: 'Nenhuma sessão ativa' };

      session.finishedAt = Date.now();
      session.textReport = generateTextReport(session);
      await writeStorage(State.FINISHED, session);
      return { success: true, status: State.FINISHED };
    }

    // ── Limpar sessão ───────────────────────────────────────────────────
    case 'CLEAR_SESSION': {
      await writeStorage(State.IDLE, null);
      return { success: true, status: State.IDLE };
    }

    // ── Consultar status (usado pelo popup no polling) ──────────────────
    case 'GET_STATUS': {
      const { status, session } = await readStorage();
      const stats = session ? getSessionStats(session.requests || []) : null;
      return { status, stats, sessionName: session?.name ?? null };
    }

    // ── Dados completos da sessão (usado por report.html) ───────────────
    case 'GET_SESSION_DATA': {
      const { status, session } = await readStorage();
      return { status, session };
    }

    // ── Captura vinda do content-bridge.js ─────────────────────────────
    case 'REQUEST_CAPTURED': {
      await processAndStore(message.request, 'content');
      return { received: true };
    }

    // ── Captura vinda do devtools.js ────────────────────────────────────
    case 'DEVTOOLS_REQUEST_CAPTURED': {
      await processAndStore(message.request, 'devtools');
      return { received: true };
    }

    // ── Estado do monitoramento (consultado pelo content-bridge) ────────
    case 'GET_MONITORING_STATE': {
      const { status } = await readStorage();
      return { isMonitoring: status === State.MONITORING };
    }

    // ── Exportar dados da sessão em JSON ────────────────────────────────
    case 'EXPORT_JSON': {
      const { session } = await readStorage();
      if (!session) return { error: 'Nenhuma sessão disponível' };
      return { json: JSON.stringify(session, null, 2) };
    }

    default:
      return { error: `Ação desconhecida: ${message.action}` };
  }
}
