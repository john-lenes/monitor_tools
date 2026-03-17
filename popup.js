/**
 * popup.js
 * Controlador da UI do popup.
 *
 * Responsabilidades:
 *  - Comunicar-se com background.js via chrome.runtime.sendMessage
 *  - Renderizar a lista de chamadas capturadas em tempo real
 *  - Mostrar painel de detalhes ao clicar em uma chamada
 *  - Controlar botões de sessão (iniciar / finalizar / limpar)
 *  - Exportar sessão (JSON e TXT)
 *  - Abrir report.html com os dados completos
 */

// ---------------------------------------------------------------------------
// Estado local do popup
// ---------------------------------------------------------------------------

let allRequests   = [];   // todos os requests da sessão atual
let currentStatus = 'idle';
let showOnlyPriority = false;
let selectedReqId = null;
let pollIntervalId = null;

// ---------------------------------------------------------------------------
// Referências DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const statusBadge   = $('status-badge');
const sessionInput  = $('session-name');
const btnStart      = $('btn-start');
const btnStop       = $('btn-stop');
const btnClear      = $('btn-clear');
const btnReport     = $('btn-report');
const btnExportJson = $('btn-export-json');
const btnExportTxt  = $('btn-export-txt');
const callList      = $('call-list');
const filterToggle  = $('filter-toggle');
const detailPanel   = $('detail-panel');
const detailClose   = $('detail-close');
const detailTitle   = $('detail-title');
const detailGrid    = $('detail-grid');
const detailSugg    = $('detail-suggestions');
const suggList      = $('suggestion-list');
const vTotal        = $('v-total');
const vRelevant     = $('v-relevant');
const vCritical     = $('v-critical');
const vMaxtime      = $('v-maxtime');
// Botão e painel de instruções de uso
const btnHelp       = $('btn-help');
const helpPanel     = $('help-panel');

// ---------------------------------------------------------------------------
// Toggle do painel de ajuda
// ---------------------------------------------------------------------------

// Alterna a visibilidade do painel "Como usar" ao clicar no botão "?".
// O painel é fechado automaticamente quando o usuário inicia ou limpa uma sessão.
btnHelp.addEventListener('click', () => {
  const visible = helpPanel.style.display !== 'none';
  helpPanel.style.display = visible ? 'none' : 'block';
  btnHelp.classList.toggle('active', !visible);
});

// ---------------------------------------------------------------------------
// Helpers de formatação
// ---------------------------------------------------------------------------

function fmtDuration(ms) {
  if (ms === 0 || ms == null) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms}ms`;
}

function timeClass(ms) {
  if (ms >= 2000) return 'slow';
  if (ms >= 500)  return 'medium';
  return 'fast';
}

function methodClass(method) {
  if (['POST', 'GET', 'PUT', 'DELETE'].includes(method)) return method;
  return 'OTHER';
}

/**
 * Extrai o melhor "nome curto" para exibir na lista.
 * Prioriza serviceName, depois a última parte do path.
 */
function getDisplayName(req) {
  const sn = req.queryParams?.serviceName
          || req.parsedPayload?.businessFields?.serviceName
          || req.parsedPayload?.businessFields?.servicename;
  if (sn) return sn;

  try {
    const u = new URL(req.url);
    return u.pathname.split('/').filter(Boolean).pop() || u.pathname;
  } catch (_) {
    return req.url;
  }
}

/**
 * Retorna pathname curto da URL para exibição secundária.
 */
function getShortPath(url) {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch (_) {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Atualização de status badge + estado dos botões
// ---------------------------------------------------------------------------

function applyStatus(status) {
  currentStatus = status;

  statusBadge.className = status;
  const labels = { idle: 'Inativo', monitoring: 'Monitorando', finished: 'Sessão Finalizada' };
  statusBadge.textContent = labels[status] || status;

  btnStart.disabled      = status === 'monitoring';
  btnStop.disabled       = status !== 'monitoring';
  btnClear.disabled      = status === 'idle';
  btnReport.disabled     = status === 'idle' || allRequests.length === 0;
  btnExportJson.disabled = status === 'idle' || allRequests.length === 0;
  btnExportTxt.disabled  = status === 'idle' || allRequests.length === 0;
  sessionInput.disabled  = status === 'monitoring';
}

// ---------------------------------------------------------------------------
// Atualização dos cards de estatísticas
// ---------------------------------------------------------------------------

function updateStats(stats) {
  if (!stats) {
    vTotal.textContent = vRelevant.textContent = vCritical.textContent = vMaxtime.textContent = '—';
    return;
  }
  vTotal.textContent    = stats.total    ?? '—';
  vRelevant.textContent = stats.relevant ?? '—';
  vCritical.textContent = stats.critical ?? '—';
  vMaxtime.textContent  = fmtDuration(stats.maxDuration);
}

// ---------------------------------------------------------------------------
// Renderização da lista de chamadas
// ---------------------------------------------------------------------------

/**
 * Re-renderiza a lista de chamadas de acordo com o filtro atual.
 */
function renderList() {
  const toShow = showOnlyPriority
    ? allRequests.filter(isPriority)
    : allRequests.filter((r) => r.classification?.category !== 'IRRELEVANTE');

  if (toShow.length === 0) {
    callList.innerHTML = `<div class="empty-state">
      <strong>${allRequests.length === 0 ? 'Nenhuma chamada capturada' : 'Nenhuma chamada relevante ainda'}</strong>
      ${allRequests.length === 0 ? 'Inicie uma sessão e execute uma ação no Sankhya.' : 'Desative o filtro para ver todas as chamadas capturadas.'}
    </div>`;
    return;
  }

  // Ordena: críticos primeiro, depois por tempo decrescente
  const sorted = [...toShow].sort((a, b) => {
    const ac = a.classification?.isCritical ? 1 : 0;
    const bc = b.classification?.isCritical ? 1 : 0;
    if (bc !== ac) return bc - ac;
    return (b.duration || 0) - (a.duration || 0);
  });

  callList.innerHTML = sorted.map((req) => buildCallItem(req)).join('');

  // Re-aplica seleção
  if (selectedReqId) {
    const el = callList.querySelector(`[data-id="${selectedReqId}"]`);
    if (el) el.classList.add('selected');
  }

  // Atribui eventos de clique
  callList.querySelectorAll('.call-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-id');
      const req = allRequests.find((r) => r.id === id);
      if (req) selectRequest(req, el);
    });
  });
}

/**
 * Constrói o HTML de um item da lista.
 */
function buildCallItem(req) {
  const name   = escHtml(getDisplayName(req));
  const path   = escHtml(getShortPath(req.url));
  const method = req.method || 'GET';
  const dur    = fmtDuration(req.duration);
  const tClass = timeClass(req.duration || 0);
  const cat    = req.classification?.category ?? '';
  const crit   = req.classification?.isCritical;
  const bot    = req.classification?.isBottleneck;

  let catLabel = cat;
  let catClass = '';
  if (crit)     catClass = 'tag-critical';
  else if (bot) catClass = 'tag-bottleneck';

  return `
    <div class="call-item${crit ? ' critical' : ''}" data-id="${escHtml(req.id)}">
      <span class="method-badge ${methodClass(method)}">${escHtml(method)}</span>
      <div class="call-info">
        <div class="call-service">${name}</div>
        <div class="call-url">${path}</div>
      </div>
      <div class="call-right">
        <div class="call-time ${tClass}">${escHtml(dur)}</div>
        <div class="call-cat ${catClass}">${escHtml(catLabel)}</div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Painel de detalhes
// ---------------------------------------------------------------------------

function selectRequest(req, el) {
  // Desseleciona item anterior
  callList.querySelector('.selected')?.classList.remove('selected');
  el.classList.add('selected');
  selectedReqId = req.id;

  renderDetail(req);
}

function renderDetail(req) {
  const sn  = req.queryParams?.serviceName
           || req.parsedPayload?.businessFields?.serviceName
           || req.parsedPayload?.businessFields?.servicename
           || '—';
  const app = req.queryParams?.application
           || req.parsedPayload?.businessFields?.application
           || '—';
  const rid = req.queryParams?.resourceID || '—';
  const cat = req.classification?.category || '—';
  const bot = req.classification?.isBottleneck ? ' + GARGALO' : '';
  const crit = req.classification?.isCritical ? ' ⚠ CRÍTICO' : '';

  detailTitle.textContent = `${req.method} ${getShortPath(req.url)}`;

  const rows = [
    ['serviceName',  sn],
    ['application',  app],
    ['resourceID',   rid],
    ['status HTTP',  req.status || '—'],
    ['tempo',        fmtDuration(req.duration)],
    ['classificação', `${cat}${bot}${crit}`],
    ['timestamp',    new Date(req.timestamp).toLocaleTimeString('pt-BR')],
  ];

  // Adiciona campos de negócio extras
  const bf = req.parsedPayload?.businessFields ?? {};
  const extraKeys = ['nunota','codemp','codparc','codprod','nuseq','entityName',
                     'action','event','listener','method'];
  for (const k of extraKeys) {
    const v = bf[k] ?? bf[k.toLowerCase()];
    if (v != null) rows.push([k, String(v)]);
  }

  // Adiciona payload resumido
  if (req.parsedPayload?.raw) {
    rows.push(['payload',  req.parsedPayload.raw.substring(0, 120) + (req.parsedPayload.raw.length > 120 ? '…' : '')]);
  }
  // Adiciona response resumida
  if (req.parsedResponse?.summary) {
    rows.push(['response', req.parsedResponse.summary.substring(0, 120) + (req.parsedResponse.summary.length > 120 ? '…' : '')]);
  }
  if (req.parsedResponse?.errorMessage) {
    rows.push(['⚠ erro', req.parsedResponse.errorMessage.substring(0, 150)]);
  }

  detailGrid.innerHTML = rows.map(([k, v]) =>
    `<span class="dk">${escHtml(String(k))}</span><span class="dv">${escHtml(String(v ?? '—'))}</span>`
  ).join('');

  // Sugestões contextuais rápidas para esta chamada
  const suggestions = buildLocalSuggestions(req);
  if (suggestions.length) {
    suggList.innerHTML = suggestions.map((s) => `<li>${escHtml(s)}</li>`).join('');
    detailSugg.style.display = '';
  } else {
    detailSugg.style.display = 'none';
  }

  detailPanel.classList.add('visible');
}

/**
 * Gera sugestões rápidas para um único request (sem precisar do reporter completo).
 */
function buildLocalSuggestions(req) {
  const suggs = [];
  const sn  = req.queryParams?.serviceName;
  const app = req.queryParams?.application;
  const bf  = req.parsedPayload?.businessFields ?? {};

  if (sn)  suggs.push(`Procurar "${sn}" no backend`);
  if (app) suggs.push(`Verificar bean/classe "${app}"`);
  if (bf.listener) suggs.push(`Analisar listener: "${bf.listener}"`);
  if (bf.event)    suggs.push(`Verificar evento: "${bf.event}"`);
  if (req.classification?.isBottleneck) suggs.push('Investigar queries lentas / índices de banco');
  if (req.classification?.isCritical)   suggs.push('Verificar logs do servidor e stack traces');

  return suggs;
}

// ---------------------------------------------------------------------------
// Filtro de prioridade
// ---------------------------------------------------------------------------

function isPriority(req) {
  const c = req.classification;
  if (!c) return false;
  return (
    c.isCritical || c.isBottleneck ||
    c.category === 'REGRA DE NEGÓCIO' ||
    c.category === 'PERSISTÊNCIA' ||
    (req.url || '').includes('/mge/service.sbr')
  );
}

// ---------------------------------------------------------------------------
// Polling de atualizações
// ---------------------------------------------------------------------------

function startPolling() {
  if (pollIntervalId) return;
  pollIntervalId = setInterval(fetchStatus, 1500);
}

function stopPolling() {
  if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; }
}

async function fetchStatus() {
  try {
    const res = await sendMsg({ action: 'GET_STATUS' });
    applyStatus(res.status);
    updateStats(res.stats);

    if (res.status !== 'idle') {
      const full = await sendMsg({ action: 'GET_SESSION_DATA' });
      if (full.session?.requests) {
        allRequests = full.session.requests;
        renderList();
      }
    }
  } catch (_) { /* background reiniciou — será retomado no próximo tick */ }
}

// ---------------------------------------------------------------------------
// Event handlers dos botões
// ---------------------------------------------------------------------------

btnStart.addEventListener('click', async () => {
  const name = sessionInput.value.trim() || undefined;
  try {
    await sendMsg({ action: 'START_SESSION', name });
    allRequests  = [];
    selectedReqId = null;
    detailPanel.classList.remove('visible');
    // Fecha o painel de ajuda ao iniciar uma sessão para maximizar espaço
    helpPanel.style.display = 'none';
    btnHelp.classList.remove('active');
    renderList();
    applyStatus('monitoring');
    updateStats(null);
    startPolling();
  } catch (e) {
    alert('Erro ao iniciar sessão: ' + e.message);
  }
});

btnStop.addEventListener('click', async () => {
  try {
    await sendMsg({ action: 'STOP_SESSION' });
    stopPolling();
    await fetchStatus(); // atualiza UI com dados finais
    applyStatus('finished');
  } catch (e) {
    alert('Erro ao finalizar sessão: ' + e.message);
  }
});

btnClear.addEventListener('click', async () => {
  if (!confirm('Limpar a sessão atual? Os dados serão perdidos.')) return;
  try {
    await sendMsg({ action: 'CLEAR_SESSION' });
    stopPolling();
    allRequests   = [];
    selectedReqId = null;
    detailPanel.classList.remove('visible');
    renderList();
    applyStatus('idle');
    updateStats(null);
  } catch (e) {
    alert('Erro ao limpar sessão: ' + e.message);
  }
});

btnReport.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('report.html') });
});

detailClose.addEventListener('click', () => {
  detailPanel.classList.remove('visible');
  callList.querySelector('.selected')?.classList.remove('selected');
  selectedReqId = null;
});

filterToggle.addEventListener('click', () => {
  showOnlyPriority = !showOnlyPriority;
  filterToggle.textContent = showOnlyPriority ? 'Mostrar Todas' : 'Apenas Prioritárias';
  renderList();
});

// ── Exportações ──────────────────────────────────────────────────────────────

btnExportJson.addEventListener('click', async () => {
  try {
    const { json } = await sendMsg({ action: 'EXPORT_JSON' });
    downloadText(json, 'sankhya-monitor-sessao.json', 'application/json');
  } catch (e) {
    alert('Erro ao exportar JSON: ' + e.message);
  }
});

btnExportTxt.addEventListener('click', async () => {
  try {
    const { session } = await sendMsg({ action: 'GET_SESSION_DATA' });
    if (!session?.textReport) {
      alert('Finalize a sessão para gerar o relatório TXT.');
      return;
    }
    downloadText(session.textReport, 'sankhya-monitor-relatorio.txt', 'text/plain');
  } catch (e) {
    alert('Erro ao exportar TXT: ' + e.message);
  }
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Envia mensagem ao background e retorna a resposta como Promise.
 */
function sendMsg(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Dispara o download de um arquivo de texto.
 */
function downloadText(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Escapa HTML para evitar XSS na renderização da lista. */
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

(async function init() {
  try {
    const res = await sendMsg({ action: 'GET_STATUS' });
    applyStatus(res.status);
    updateStats(res.stats);

    if (res.status !== 'idle') {
      const full = await sendMsg({ action: 'GET_SESSION_DATA' });
      if (full.session?.requests) {
        allRequests = full.session.requests;
        sessionInput.value = full.session.name || '';
        renderList();
      }
    }

    if (res.status === 'monitoring') {
      startPolling();
    }
  } catch (e) {
    // Background pode estar inicializando
    applyStatus('idle');
  }
})();
