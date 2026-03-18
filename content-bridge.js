/**
 * content-bridge.js — Content Script (world: "ISOLATED", padrão)
 *
 * Atua como ponte entre o interceptor do MAIN world (content-main.js) e
 * o background service worker.
 *
 * Fluxo:
 *   content-main.js (MAIN)
 *       │  window.postMessage({ type: '__SNKY_MON_CAPTURE__', data })
 *       ▼
 *   content-bridge.js (ISOLATED)   ← este arquivo
 *       │  chrome.runtime.sendMessage({ action: 'REQUEST_CAPTURED', request })
 *       ▼
 *   background.js (Service Worker)
 *
 * Segurança:
 *  - Verifica event.source === window para rejeitar mensagens de frames externos
 *  - Verifica o tipo de mensagem antes de processar
 *  - Só repassa ao background quando isMonitoring === true, evitando
 *    tráfego desnecessário fora de uma sessão ativa
 */
(function () {
  'use strict';

  // Deve ser idêntico ao usado em content-main.js
  const MSG_TYPE = '__SNKY_MON_CAPTURE__';

  // Estado local de monitoramento — sincronizado com o background
  let isMonitoring = false;

  // ---------------------------------------------------------------------------
  // Guarda do contexto da extensão
  // ---------------------------------------------------------------------------
  // Quando a extensão é recarregada (ex: durante desenvolvimento), o Chrome
  // invalida o contexto do content script. A partir desse momento, qualquer
  // chamada a chrome.runtime.* lança "Extension context invalidated".
  // O listener window.addEventListener continua ativo e o Sankhya gera muitos
  // XHR, causando uma cascata de erros por segundo.
  //
  // Solução: flag `contextValid` que é setado para false ao primeiro erro de
  // contexto inválido. O listener verifica a flag antes de fazer qualquer
  // coisa e se auto-remove para parar de processar mensagens futuras.
  let contextValid = true;

  function handleContextInvalidated() {
    contextValid = false;
    isMonitoring = false;
    // Remove o listener para parar a cascata de erros imediatamente
    window.removeEventListener('message', onMessage);
  }

  function isContextError(err) {
    return err && typeof err.message === 'string' &&
      err.message.includes('Extension context invalidated');
  }

  // ---------------------------------------------------------------------------
  // INICIALIZAÇÃO EM DUAS FASES
  // ---------------------------------------------------------------------------
  // Fase 1 — consulta imediata:
  //   Ao injetar o script, verificamos se há uma sessão ativa no background.
  //
  // Fase 2 — sincronização reativa via storage.onChanged:
  //   Após a init, escutamos mudanças no storage para atualizar isMonitoring
  //   em tempo real quando o usuário clicar em Iniciar/Finalizar no popup.
  //   Isso é mais eficiente do que consultar o background a cada mensagem.
  try {
    chrome.runtime.sendMessage({ action: 'GET_MONITORING_STATE' }, (response) => {
      // O try/catch externo não cobre este callback (execução assíncrona).
      // Quando o contexto é invalidado, chrome.runtime.lastError ao ser lido
      // aqui pode lançar — por isso o try/catch interno.
      try {
        if (chrome.runtime.lastError) return;
        isMonitoring = Boolean(response?.isMonitoring);
      } catch (e) {
        if (isContextError(e)) handleContextInvalidated();
      }
    });
  } catch (e) {
    if (isContextError(e)) handleContextInvalidated();
  }

  // ---------------------------------------------------------------------------
  // Sincronização de estado via storage.onChanged
  // ---------------------------------------------------------------------------

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (!contextValid) return;
      if (area !== 'local') return;
      if ('sankhya_monitor_state' in changes) {
        isMonitoring = changes.sankhya_monitor_state.newValue === 'monitoring';
      }
    });
  } catch (e) {
    if (isContextError(e)) handleContextInvalidated();
  }

  // ---------------------------------------------------------------------------
  // Batching de requests — reduz acordadas do service worker
  // ---------------------------------------------------------------------------
  //
  // PROBLEMA: cada requisição capturada disparava um chrome.runtime.sendMessage
  // individual. Em rajadas (carregamento de página com 20+ XHRs), isso acordava
  // o service worker repetidamente com overhead de IPC por mensagem.
  //
  // SOLUÇÃO: acumular requests por até BATCH_DELAY_MS antes de enviar ao
  // background em um único sendMessage com o array completo. O background
  // processa o lote via REQUEST_CAPTURED_BATCH.
  // O delay é imperceptível para diagnóstico (50ms) mas reduz drasticamente
  // o número de acordadas do SW em rajadas.

  const BATCH_DELAY_MS = 50;
  const _batchQueue = [];
  let   _batchTimer = null;

  function flushBatch() {
    const batch = _batchQueue.splice(0); // esvazia a fila
    if (!batch.length) return;
    try {
      chrome.runtime.sendMessage({
        action:   'REQUEST_CAPTURED_BATCH',
        requests: batch,
      }).catch((err) => {
        if (isContextError(err)) handleContextInvalidated();
      });
    } catch (e) {
      if (isContextError(e)) handleContextInvalidated();
    }
  }

  // ---------------------------------------------------------------------------
  // Listener de mensagens vindas do MAIN world
  // ---------------------------------------------------------------------------

  function onMessage(event) {
    // Contexto da extensão foi invalidado (extensão recarregada) — para tudo
    if (!contextValid) return;

    // Valida que a mensagem veio da mesma janela (rejeita iframes externos)
    if (event.source !== window) return;

    // Valida o tipo de mensagem
    if (!event.data || event.data.type !== MSG_TYPE) return;

    // Não processa se a sessão não estiver ativa
    if (!isMonitoring) return;

    const requestData = event.data.data;
    if (!requestData || !requestData.url) return;

    // Adiciona ao lote e agenda flush se ainda não agendado
    _batchQueue.push(requestData);
    if (!_batchTimer) {
      _batchTimer = setTimeout(() => {
        _batchTimer = null;
        flushBatch();
      }, BATCH_DELAY_MS);
    }
  }

  window.addEventListener('message', onMessage);

})();
