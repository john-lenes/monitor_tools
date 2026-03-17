/**
 * report.js — Módulo ES para a página report.html
 *
 * Página de relatório completo, aberta numa nova aba quando o usuário
 * clica "Ver Relatório Completo" no popup (ou via chrome.tabs.create).
 *
 * DIFERENÇA EM RELAÇÃO AO POPUP:
 *  O popup.js exibe uma lista inline com 500px de largura e renderiza
 *  apenas o essencial (nome, tempo, categoria) por questões de espaço.
 *  Este módulo renderiza uma página completa de 1000px com:
 *    - Tabela com todas as colunas (serviceName, application, status, etc.)
 *    - Linhas expansíveis (acordeon) com payload, response e classificação
 *    - Aba de chamadas críticas separada
 *    - Aba de sugestões geradas pelo reporter.js (deduplicas)
 *    - Aba de relatório em texto plano (para exportação .txt)
 *
 * USANDO COMO MÓDULO ES:
 *  Importa apenas as funções necessárias do reporter.js.
 *  NÃO depende de popup.js — carrega dados do background diretamente.
 */

import { generateTextReport, generateSuggestions, getSessionStats, getServiceMap } from './modules/reporter.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

(async function main() {
  const app = document.getElementById('app');

  let session, status;
  try {
    const res = await sendMsg({ action: 'GET_SESSION_DATA' });
    session = res.session;
    status  = res.status;
  } catch (e) {
    app.innerHTML = `<div class="empty-page">
      <h2>Erro ao carregar sessão</h2>
      <p>${escHtml(e.message)}</p>
    </div>`;
    return;
  }

  if (!session || !session.requests || session.requests.length === 0) {
    app.innerHTML = `<div class="empty-page">
      <h2>Nenhuma sessão disponível</h2>
      <p>Inicie uma sessão no popup e execute ações no Sankhya antes de abrir o relatório.</p>
    </div>`;
    return;
  }

  // Garante que o relatório textual está gerado
  if (!session.textReport) {
    session.textReport = generateTextReport(session);
  }

  renderPage(app, session, status);
})();

// ---------------------------------------------------------------------------
// Renderização principal
// ---------------------------------------------------------------------------

function renderPage(container, session, status) {
  const stats                       = getSessionStats(session.requests);
  const suggestions                 = generateSuggestions(session.requests);
  const { spServices, otherServices } = getServiceMap(session.requests);
  const relevant    = session.requests
    .filter((r) => r.classification?.category !== 'IRRELEVANTE')
    .sort((a, b) => (b.duration || 0) - (a.duration || 0));

  const criticals = session.requests.filter((r) => r.classification?.isCritical);
  const totalServices = spServices.length + otherServices.length;

  container.innerHTML = `
    <!-- Header -->
    <div class="page-header">
      <div>
        <h1>⬡ Sankhya Monitor — Relatório</h1>
        <div class="subtitle">
          Sessão: <strong>${escHtml(session.name || 'Sem nome')}</strong>
          ${session.startedAt ? ` · Início: ${new Date(session.startedAt).toLocaleString('pt-BR')}` : ''}
          ${session.finishedAt ? ` · Fim: ${new Date(session.finishedAt).toLocaleString('pt-BR')}` : ''}
          · <span style="color:var(--${status === 'monitoring' ? 'success' : 'muted'})">${statusLabel(status)}</span>
        </div>
      </div>
      <div class="export-btns">
        <button class="btn btn-ghost" id="btn-export-json">⬇ JSON</button>
        <button class="btn btn-ghost" id="btn-export-txt">⬇ TXT</button>
        <button class="btn btn-danger" id="btn-clear">↺ Nova Sessão</button>
      </div>
    </div>

    <!-- Stats -->
    <div class="stats-grid">
      <div class="stat-card sc-total">
        <span class="val">${stats.total}</span>
        <span class="lbl">Total Capturadas</span>
      </div>
      <div class="stat-card sc-relevant">
        <span class="val">${stats.relevant}</span>
        <span class="lbl">Relevantes</span>
      </div>
      <div class="stat-card sc-critical">
        <span class="val">${stats.critical}</span>
        <span class="lbl">Críticas</span>
      </div>
      <div class="stat-card sc-bottleneck">
        <span class="val">${stats.bottlenecks}</span>
        <span class="lbl">Gargalos (&gt;2s)</span>
      </div>
      <div class="stat-card sc-maxtime">
        <span class="val">${fmtDuration(stats.maxDuration)}</span>
        <span class="lbl">T. Máximo</span>
      </div>
      <div class="stat-card sc-avgtime">
        <span class="val">${fmtDuration(stats.avgDuration)}</span>
        <span class="lbl">T. Médio</span>
      </div>
      <div class="stat-card" style="border-color:#f59e0b">
        <span class="val" style="color:#f59e0b">${stats.spCount || 0}</span>
        <span class="lbl">Serviços SP</span>
      </div>
    </div>

    <!-- Category chips -->
    ${renderCategoryChips(stats.byCategory)}

    <!-- Tabs -->
    <div class="tabs">
      <button class="tab-btn active" data-tab="calls">Chamadas (${relevant.length})</button>
      <button class="tab-btn" data-tab="criticals">Críticas (${criticals.length})</button>
      <button class="tab-btn sp-tab" data-tab="services">★ Serviços SP (${spServices.length}/${totalServices})</button>
      <button class="tab-btn" data-tab="suggestions">Sugestões (${suggestions.length})</button>
      <button class="tab-btn" data-tab="textreport">Relatório Texto</button>
    </div>

    <!-- Tab: Chamadas -->
    <div class="tab-panel active" id="tab-calls">
      <div class="section">
        ${renderCallTable(relevant)}
      </div>
    </div>

    <!-- Tab: Críticas -->
    <div class="tab-panel" id="tab-criticals">
      <div class="section">
        ${criticals.length > 0
          ? renderCallTable(criticals)
          : '<p style="color:var(--muted);padding:20px 0">Nenhuma chamada crítica nesta sessão.</p>'
        }
      </div>
    </div>

    <!-- Tab: Serviços SP -->
    <div class="tab-panel" id="tab-services">
      <div class="section">
        ${renderServiceMap(spServices, otherServices)}
      </div>
    </div>

    <!-- Tab: Sugestões -->
    <div class="tab-panel" id="tab-suggestions">
      <div class="section">
        ${suggestions.length > 0
          ? `<ul class="suggestion-list">${suggestions.map((s) => `<li>${escHtml(s)}</li>`).join('')}</ul>`
          : '<p style="color:var(--muted);padding:20px 0">Nenhuma sugestão gerada.</p>'
        }
      </div>
    </div>

    <!-- Tab: Relatório Texto -->
    <div class="tab-panel" id="tab-textreport">
      <div class="section">
        <pre id="text-report">${escHtml(session.textReport)}</pre>
      </div>
    </div>
  `;

  // Wires up tabs
  container.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.tab-btn, .tab-panel').forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
      container.querySelector(`#tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // Wire up expandable rows
  wireExpandableRows(container, session.requests);

  // Wire up export buttons
  container.querySelector('#btn-export-json').addEventListener('click', () => exportJson(session));
  container.querySelector('#btn-export-txt').addEventListener('click', () => exportTxt(session));
  container.querySelector('#btn-clear').addEventListener('click', async () => {
    if (!confirm('Limpar a sessão? Os dados serão perdidos.')) return;
    await sendMsg({ action: 'CLEAR_SESSION' });
    window.close();
  });
}

// ---------------------------------------------------------------------------
// Renderização da tabela de chamadas
// ---------------------------------------------------------------------------

function renderCallTable(requests) {
  if (!requests.length) return '<p style="color:var(--muted);padding:16px 0">Nenhuma chamada para exibir.</p>';

  const rows = requests.map((req, i) => {
    const sn  = req.queryParams?.serviceName
             || req.parsedPayload?.businessFields?.serviceName
             || req.parsedPayload?.businessFields?.servicename
             || '—';
    const app = req.queryParams?.application
             || req.parsedPayload?.businessFields?.application
             || '—';
    const cat  = req.classification?.category || '—';
    const crit = req.classification?.isCritical;
    const bot  = req.classification?.isBottleneck;
    const dur  = fmtDuration(req.duration || 0);
    const tCls = timeClass(req.duration || 0);
    const mCls = 'method-' + ((['POST','GET','PUT','DELETE'].includes(req.method)) ? req.method : 'OTHER');

    let catCls = '';
    if (crit) catCls = 'critical';
    else if (bot) catCls = 'bottleneck';
    else if (cat === 'REGRA DE NEGÓCIO') catCls = 'business';
    else if (cat === 'PERSISTÊNCIA') catCls = 'persist';

    let pathname = req.url;
    try { pathname = new URL(req.url).pathname; } catch (_) { /* usa url completa */ }

    return `
      <tr class="expandable${crit ? ' critical' : ''}" data-idx="${i}" data-id="${escHtml(req.id)}">
        <td><span class="method-badge ${mCls}">${escHtml(req.method)}</span></td>
        <td>${escHtml(pathname)}</td>
        <td>${escHtml(sn)}</td>
        <td>${escHtml(app)}</td>
        <td><span class="time-badge time-${tCls}">${escHtml(dur)}</span></td>
        <td>${escHtml(String(req.status || '—'))}</td>
        <td><span class="cat-badge ${catCls}">${escHtml(cat)}${crit ? ' ⚠' : bot ? ' ⚡' : ''}</span></td>
      </tr>
      <tr class="detail-row" id="detail-row-${i}">
        <td colspan="7"></td>
      </tr>`;
  }).join('');

  return `
    <table class="call-table">
      <thead>
        <tr>
          <th>Método</th>
          <th>Path</th>
          <th>serviceName</th>
          <th>application</th>
          <th>Tempo</th>
          <th>Status</th>
          <th>Classificação</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * Habilita o padrão acórdeon nas linhas da tabela de chamadas.
 *
 * Cada `tr.expandable` (linha principal) tem um `tr.detail-row` imediatamente
 * abaixo com `colspan="7"` que começa oculto. Ao clicar na linha principal,
 * o detail-row é populado com buildDetailContent() e exibido.
 *
 * COMPORTAMENTO ACÓRDEON:
 *  Apenas UM detail-row fica visível por vez. Clicar numa linha já aberta
 *  a fecha. Clicar numa nova linha fecha a anterior e abre a nova.
 *  Isso evita que a tabela fique longa demais com vários detalhes abertos.
 */
function wireExpandableRows(container, allRequests) {
  container.querySelectorAll('tr.expandable').forEach((tr) => {
    tr.addEventListener('click', () => {
      const idx = tr.getAttribute('data-idx');
      const id  = tr.getAttribute('data-id');
      const detailRow = container.querySelector(`#detail-row-${idx}`);
      if (!detailRow) return;

      const isOpen = detailRow.classList.contains('visible');

      // Fecha todos os outros
      container.querySelectorAll('.detail-row.visible').forEach((r) => r.classList.remove('visible'));

      if (!isOpen) {
        const req = allRequests.find((r) => r.id === id);
        if (req) {
          detailRow.querySelector('td').innerHTML = buildDetailContent(req);
          detailRow.classList.add('visible');
        }
      }
    });
  });
}

/**
 * Constrói o HTML do painel de detalhes expandido de uma chamada.
 *
 * ESTRUTURA DO PAINEL (seções condicionais):
 *  [sempre]  Query Parameters — serviceName, application, resourceID, etc.
 *  [se tiver] Campos de Negócio — nunota, codparc, event, listener, etc.
 *  [sempre]  Classificação — categoria, flags isCritical/isBottleneck, motivos
 *  [se erro] Erro Detectado — mensagem de exceção Java ou erro Oracle
 *  [se tiver] Request Body — payload truncado (< 4096 bytes)
 *  [se tiver] Response — resumo do corpo da resposta
 *
 * Todos os valores são escapados com escHtml() antes de inserir no DOM
 * para prevenir XSS caso o Sankhya retorne conteúdo HTML em respostas de erro.
 */
function buildDetailContent(req) {
  const bf  = req.parsedPayload?.businessFields ?? {};
  const qp  = req.queryParams ?? {};

  const params = [
    ['serviceName',  qp.serviceName  || bf.serviceName || bf.servicename || '—'],
    ['application',  qp.application  || bf.application || '—'],
    ['resourceID',   qp.resourceID   || '—'],
    ['globalID',     qp.globalID     || '—'],
    ['mgeSession',   qp.mgeSession   || '—'],
    ['outputType',   qp.outputType   || '—'],
  ];

  // Campos de negócio extras
  const bizKeys = ['nunota','codemp','codparc','codprod','nuseq','entityName',
                   'action','event','listener','method'];
  const bizRows = bizKeys
    .filter((k) => bf[k] != null || bf[k.toLowerCase()] != null)
    .map((k) => [k, String(bf[k] ?? bf[k.toLowerCase()])]);

  const classDetails = [
    ['classificação', req.classification?.category || '—'],
    ['crítico',       req.classification?.isCritical ? '⚠ SIM' : 'não'],
    ['gargalo',       req.classification?.isBottleneck ? '⚡ SIM' : 'não'],
    ['motivos',       (req.classification?.reasons || []).join(' | ') || '—'],
    ['status HTTP',   req.status || '—'],
    ['duração',       fmtDuration(req.duration || 0)],
    ['timestamp',     new Date(req.timestamp || 0).toLocaleString('pt-BR')],
    ['fonte',         req.source || '—'],
  ];

  const kvList = (rows) => rows.map(([k, v]) =>
    `<li><span class="k">${escHtml(k)}</span><span class="v">${escHtml(String(v))}</span></li>`
  ).join('');

  const errorSection = req.parsedResponse?.hasError
    ? `<div class="detail-block">
        <h4>⚠ Erro Detectado</h4>
        <div class="code-block">${escHtml(req.parsedResponse.errorMessage || 'Erro sem mensagem')}</div>
      </div>`
    : '';

  const payloadSection = req.parsedPayload?.raw
    ? `<div class="detail-block">
        <h4>Request Body</h4>
        <div class="code-block">${escHtml(req.parsedPayload.raw)}</div>
      </div>`
    : '';

  const responseSection = req.parsedResponse?.summary
    ? `<div class="detail-block">
        <h4>Response (resumo)</h4>
        <div class="code-block">${escHtml(req.parsedResponse.summary)}</div>
      </div>`
    : '';

  return `
    <div class="detail-inner">
      <div class="detail-block">
        <h4>Query Parameters</h4>
        <ul class="kv-list">${kvList(params)}</ul>
      </div>
      ${bizRows.length ? `
      <div class="detail-block">
        <h4>Campos de Negócio</h4>
        <ul class="kv-list">${kvList(bizRows)}</ul>
      </div>` : ''}
      <div class="detail-block">
        <h4>Classificação</h4>
        <ul class="kv-list">${kvList(classDetails)}</ul>
      </div>
      ${errorSection}
      ${payloadSection}
      ${responseSection}
    </div>`;
}

// ---------------------------------------------------------------------------
// Mapa de serviços SP
// ---------------------------------------------------------------------------

/**
 * Renderiza o painel "Serviços SP" da página de relatório.
 *
 * SP services aparecem em destaque no topo (fundo diferenciado, badge ★).
 * Os demais serviços ficam abaixo em tabela compacta.
 *
 * @param {Object[]} spServices    entradas SP do getServiceMap
 * @param {Object[]} otherServices demais entradas do getServiceMap
 * @returns {string}  HTML
 */
function renderServiceMap(spServices, otherServices) {
  if (!spServices.length && !otherServices.length) {
    return '<p style="color:var(--muted);padding:20px 0">Nenhum serviço identificado nesta sessão.</p>';
  }

  let html = '';

  // ── Serviços SP em destaque ────────────────────────────────────────────
  if (spServices.length) {
    html += `<h3 style="color:#f59e0b;margin:0 0 12px">★ Serviços SP — Classe de Origem (${spServices.length})</h3>`;
    html += '<div class="sp-cards">';
    for (const e of spServices) {
      const apps  = [...e.applications].join(', ') || '—';
      const cats  = [...e.categories].join(' · ')  || '—';
      const critBadge = e.hasCritical   ? '<span class="cat-badge critical">⚠ CRÍTICO</span>' : '';
      const botBadge  = e.hasBottleneck ? '<span class="cat-badge bottleneck">⚡ GARGALO</span>' : '';
      html += `
        <div class="sp-card">
          <div class="sp-card-header">
            <span class="sp-badge">★ SP</span>
            <strong>${escHtml(e.serviceName)}</strong>
            ${critBadge}${botBadge}
          </div>
          <ul class="kv-list">
            <li><span class="k">Classe SP</span><span class="v">${escHtml(e.spClass)}</span></li>
            <li><span class="k">Método</span><span class="v">${escHtml(e.method)}</span></li>
            <li><span class="k">Classe origem</span><span class="v">${escHtml(apps)}</span></li>
            <li><span class="k">Categoria</span><span class="v">${escHtml(cats)}</span></li>
            <li><span class="k">Chamadas</span><span class="v">${e.callCount}</span></li>
            <li><span class="k">Tempo máx</span><span class="v">${fmtDuration(e.maxDuration)}</span></li>
            <li><span class="k">Tempo total</span><span class="v">${fmtDuration(e.totalDuration)}</span></li>
          </ul>
        </div>`;
    }
    html += '</div>';
  }

  // ── Demais serviços em tabela ──────────────────────────────────────────
  if (otherServices.length) {
    html += `<h3 style="margin:24px 0 12px;color:var(--muted)">Demais serviços (${otherServices.length})</h3>`;
    html += `
      <table class="call-table">
        <thead>
          <tr>
            <th>serviceName</th>
            <th>Classe origem</th>
            <th>Categoria</th>
            <th>Chamadas</th>
            <th>Tempo máx</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>`;
    for (const e of otherServices) {
      const apps  = [...e.applications].join(', ') || '—';
      const cats  = [...e.categories].join(' · ')  || '—';
      const flags = [e.hasCritical ? '⚠' : '', e.hasBottleneck ? '⚡' : ''].filter(Boolean).join(' ') || '—';
      html += `
          <tr>
            <td>${escHtml(e.serviceName)}</td>
            <td>${escHtml(apps)}</td>
            <td>${escHtml(cats)}</td>
            <td>${e.callCount}</td>
            <td>${fmtDuration(e.maxDuration)}</td>
            <td>${escHtml(flags)}</td>
          </tr>`;
    }
    html += '</tbody></table>';
  }

  return html;
}

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------

function renderCategoryChips(byCategory) {
  if (!byCategory || !Object.keys(byCategory).length) return '';
  const chips = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => `<div class="cat-chip"><strong>${count}</strong> ${escHtml(cat)}</div>`)
    .join('');
  return `<div class="cat-grid">${chips}</div>`;
}

// ---------------------------------------------------------------------------
// Exportação
// ---------------------------------------------------------------------------

function exportJson(session) {
  const json = JSON.stringify(session, null, 2);
  downloadText(json, `sankhya-monitor-${slugify(session.name)}.json`, 'application/json');
}

function exportTxt(session) {
  const txt = session.textReport || generateTextReport(session);
  downloadText(txt, `sankhya-monitor-${slugify(session.name)}.txt`, 'text/plain');
}

function downloadText(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function slugify(str) {
  return (str || 'sessao')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendMsg(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (response?.error) { reject(new Error(response.error)); return; }
      resolve(response);
    });
  });
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return '—';
  if (ms === 0) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms}ms`;
}

function timeClass(ms) {
  if (ms >= 2000) return 'slow';
  if (ms >= 500)  return 'medium';
  return 'fast';
}

function statusLabel(s) {
  return { idle: 'Inativo', monitoring: 'Monitorando', finished: 'Finalizada' }[s] || s;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
