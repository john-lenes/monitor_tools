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

import { normalizeRequest, findDuplicate, mergeWithDevtools, isWorthProcessing } from './modules/capture.js';
import { parseQueryParams, parsePayload, parseResponse }    from './modules/parser.js';
import { classifyRequest, isStaticAsset, isPolling }        from './modules/classifier.js';
import { generateTextReport, getSessionStats }              from './modules/reporter.js';
import { correlate, buildHypothesis, lookupEvidence }       from './modules/correlator.js';

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
// Cache em memória — elimina I/O de storage por requisição capturada
// ---------------------------------------------------------------------------
//
// PROBLEMA ORIGINAL: processAndStore fazia chrome.storage.local.get + set
// a cada requisição. Em rajadas de 20+ XHRs simultâneos (carregamento de
// página), isso gerava dezenas de operações de disco concorrentes, travando
// o processo do browser e o event loop do service worker.
//
// SOLUÇÃO: manter estado e sessão em variáveis de módulo (RAM). Escritas ao
// storage são coaleizadas num único flush a cada STORAGE_FLUSH_MS ms.
// Leituras são imediatas (sem I/O). A durabilidade é preservada: qualquer
// dado escrito na memória será persistido em no máximo STORAGE_FLUSH_MS ms.

let _memState     = State.IDLE;
let _memSession   = null;
let _cacheReady   = false;   // true após primeira carga do storage
let _flushTimer   = null;    // handle do setTimeout de flush em batch

const STORAGE_FLUSH_MS = 400; // intervalo máximo de delay entre writes

/**
 * E6 — Índice de fontes JS construído pelo devtools.js (source-indexer).
 * Armazenado em memória (não no storage — pode ser grande).
 * Usado pelo passo 9.6 do pipeline para enriquecer correlações com evidência textual.
 */
let _sourceIndex = null;

/**
 * Inicializa o cache lendo o storage UMA vez por vida do service worker.
 * Chamadas subsequentes retornam imediatamente (guard _cacheReady).
 */
async function initCache() {
  if (_cacheReady) return;
  const data = await chrome.storage.local.get([STORAGE_STATE, STORAGE_SESSION]);
  _memState   = data[STORAGE_STATE]   ?? State.IDLE;
  _memSession = data[STORAGE_SESSION] ?? null;
  _cacheReady = true;
}

/**
 * Força a escrita imediata ao storage (sem aguardar o timer).
 * Usar apenas em operações que exigem durabilidade imediata (STOP/CLEAR).
 */
async function flushToStorage() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  await chrome.storage.local.set({
    [STORAGE_STATE]:   _memState,
    [STORAGE_SESSION]: _memSession,
  });
}

/** Lê estado e sessão do cache em memória (sem I/O de disco). */
function readStorage() {
  return { status: _memState, session: _memSession };
}

/**
 * Atualiza o cache em memória e agenda flush coaleizado para o storage.
 * Múltiplas chamadas dentro de STORAGE_FLUSH_MS resultam em apenas UMA
 * escrita ao disco, absorvendo rajadas de requisições sem overhead de I/O.
 */
function writeStorage(status, session) {
  _memState   = status;
  _memSession = session;
  if (_flushTimer) return; // flush já agendado — valor mais recente será gravado
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    chrome.storage.local.set({
      [STORAGE_STATE]:   _memState,
      [STORAGE_SESSION]: _memSession,
    }).catch(() => {}); // dados já estão em memória; falha silenciosa é aceitável
  }, STORAGE_FLUSH_MS);
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
  await initCache(); // no-op na 2ª+ chamada — guard booleano em RAM
  const { status, session } = readStorage(); // leitura de RAM, sem I/O
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

  // [Passo 5] Dedução inteligente com merge:
  //   - Se já existe uma entrada do content-main.js para esta requisição E
  //     a nova captura veio do DevTools, ENRIQUECEMOS a entrada existente
  //     com os dados mais completos do DevTools (response body, duration, headers).
  //   - Se a duplicata veio do content script, descartamos (entrada já existe).
  const existing = findDuplicate(normalized, session.requests || []);
  if (existing) {
    if (source === 'devtools') {
      // Enriquece a entrada com dados mais completos do DevTools
      mergeWithDevtools(existing, normalized);
      // Re-parseia com o response body agora mais completo
      existing.parsedResponse = parseResponse(existing.responseBody);
      // Re-parseia payload se o request body melhorou
      if (normalized.requestBody && normalized.requestBody.length > (existing.requestBody?.length ?? 0)) {
        existing.parsedPayload = parsePayload(existing.requestBody);
      }
      // Re-classifica com os dados enriquecidos (pode detectar erro antes não visível)
      existing.classification = classifyRequest(existing);
      writeStorage(State.MONITORING, session); // atualiza RAM + agenda flush
      // Notifica o popup para atualizar o item já exibido
      const mergeStats = getSessionStats(session.requests);
      chrome.runtime.sendMessage({ action: 'REQUEST_ADDED', request: existing, stats: mergeStats }).catch(() => {});
    }
    return;
  }

  // [Passo 6–8] Parsear URL, body e response
  normalized.queryParams    = parseQueryParams(normalized.url);
  normalized.parsedPayload  = parsePayload(normalized.requestBody);
  normalized.parsedResponse = parseResponse(normalized.responseBody);

  // [Passo 9] Classificar — determina categoria funcional, criticidade e gargalos
  normalized.classification = classifyRequest(normalized);

  // [Passo 9.6] Correlação frontend + hipótese de backend (E2 + E5 + E7)
  // Identifica o padrão frontend que originou a chamada (callStack/initiator).
  // Gera hipótese de classe/bean Java que provavelmente processou a requisição.
  // Se o índice de sources (E6) estiver disponível, enriquece com evidência textual.
  try {
    const correlation = correlate(normalized);
    if (_sourceIndex) {
      const evidence = lookupEvidence(correlation, _sourceIndex);
      correlation.sourceEvidence     = evidence.sourceEvidence;
      correlation.confidence         = evidence.boostedConfidence;
    }
    normalized.correlation = correlation;
    normalized.hypothesis  = buildHypothesis(normalized);
  } catch (_) { /* correlação é best-effort — nunca bloqueia o pipeline */ }

  // [Passo 9.5] Cap de armazenamento para chamadas repetitivas não-essenciais.
  // SP, críticos e gargalos são SEMPRE armazenados (cada execução é única).
  // Demais chamadas com o mesmo serviceName ficam limitadas a MAX_REPEATED por sessão
  // para evitar que sessões longas saturem o storage com centenas do mesmo serviço.
  const MAX_REPEATED = 10;
  const _sn =
    normalized.queryParams?.serviceName ??
    normalized.parsedPayload?.businessFields?.serviceName ??
    normalized.parsedPayload?.businessFields?.servicename;
  const _isSP = _sn && /\bSP\./i.test(_sn);
  if (!_isSP && !normalized.classification.isCritical && !normalized.classification.isBottleneck && _sn) {
    const sameCount = (session.requests || []).filter((r) => {
      const rsn = r.queryParams?.serviceName
                ?? r.parsedPayload?.businessFields?.serviceName
                ?? r.parsedPayload?.businessFields?.servicename;
      return rsn === _sn;
    }).length;
    if (sameCount >= MAX_REPEATED) return; // excesso descartado — dado já representado
  }

  // [Passo 10] Persistir e notificar o popup
  session.requests = session.requests || [];
  session.requests.push(normalized);
  writeStorage(State.MONITORING, session); // atualiza RAM + agenda flush em batch

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
  await initCache(); // garante que o cache está carregado antes de qualquer operação
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
      writeStorage(State.MONITORING, session);
      await flushToStorage(); // garante persistência imediata ao iniciar
      return { success: true, status: State.MONITORING };
    }

    // ── Finalizar sessão ────────────────────────────────────────────────
    case 'STOP_SESSION': {
      const { session } = readStorage();
      if (!session) return { success: false, error: 'Nenhuma sessão ativa' };

      session.finishedAt = Date.now();
      session.textReport = generateTextReport(session);
      writeStorage(State.FINISHED, session);
      await flushToStorage(); // garante persistência imediata ao finalizar
      return { success: true, status: State.FINISHED };
    }

    // ── Limpar sessão ───────────────────────────────────────────────────
    case 'CLEAR_SESSION': {
      writeStorage(State.IDLE, null);
      await flushToStorage(); // garante persistência imediata ao limpar
      return { success: true, status: State.IDLE };
    }

    // ── Consultar status (usado pelo popup no polling) ──────────────────
    case 'GET_STATUS': {
      const { status, session } = readStorage();
      const stats = session ? getSessionStats(session.requests || []) : null;
      return { status, stats, sessionName: session?.name ?? null };
    }

    // ── Dados completos da sessão (usado por report.html) ───────────────
    case 'GET_SESSION_DATA': {
      const { status, session } = readStorage();
      return { status, session };
    }

    // ── Captura vinda do content-bridge.js (request único) ─────────────
    case 'REQUEST_CAPTURED': {
      await processAndStore(message.request, 'content');
      return { received: true };
    }

    // ── Captura em lote do content-bridge.js (batch de requests) ────────
    // Processa múltiplos requests em uma única mensagem IPC, reduzindo
    // o número de acordadas do service worker em rajadas de requisições.
    case 'REQUEST_CAPTURED_BATCH': {
      if (Array.isArray(message.requests)) {
        for (const req of message.requests) {
          await processAndStore(req, 'content');
        }
      }
      return { received: true };
    }

    // ── Captura vinda do devtools.js ────────────────────────────────────
    case 'DEVTOOLS_REQUEST_CAPTURED': {
      await processAndStore(message.request, 'devtools');
      return { received: true };
    }
    // ── Índice de fontes construído pelo devtools.js (E6) ───────────────────
    case 'SOURCE_INDEX_READY': {
      _sourceIndex = message.index ?? null;
      return { received: true };
    }
    // ── Estado do monitoramento (consultado pelo content-bridge) ────────
    case 'GET_MONITORING_STATE': {
      const { status } = readStorage();
      return { isMonitoring: status === State.MONITORING };
    }

    // ── Exportar dados da sessão em JSON ────────────────────────────────
    case 'EXPORT_JSON': {
      const { session } = readStorage();
      if (!session) return { error: 'Nenhuma sessão disponível' };
      return { json: JSON.stringify(session, null, 2) };
    }

    default:
      return { error: `Ação desconhecida: ${message.action}` };
  }
}
