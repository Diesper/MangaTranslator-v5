'use strict';
// gemini/selectors.js — Seletores centralizados da UI do Google Gemini.
//
// Ordem de preferência: seletor específico -> acessível -> fallback semântico.
// Deep scan continua disponível no adapter DOM, mas nunca deve ser a primeira
// fonte de verdade para estados críticos.

(function(scope) {
  const SELECTORS = Object.freeze({
    INPUT: [
      'rich-textarea [contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      '.ql-editor[contenteditable="true"]',
      '[contenteditable="true"]',
    ].join(', '),

    EDITOR_ROOT: [
      'rich-textarea',
      '.ql-editor',
      '[contenteditable="true"]',
    ].join(', '),

    SEND: [
      'button.send-button',
      'button[aria-label="Send"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Enviar"]',
      'button[aria-label="Enviar mensagem"]',
      'button[aria-label*="Send message" i]',
      'button[aria-label*="Enviar mensagem" i]',
      '[data-test-id="send-button"]',
      '[data-testid="send-button"]',
    ].join(', '),

    STOP: [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Parar" i]',
      'button[aria-label*="Interromper" i]',
      '[data-test-id="stop-generating-button"]',
      '[data-testid="stop-generating-button"]',
    ].join(', '),

    RESPONSE: [
      'model-response',
      '[data-test-id*="model-response"]',
      '[data-testid*="model-response"]',
      '[data-message-author="model"]',
      'bard-model-response',
      'div[data-turn-role="model"]',
      '.model-response-container',
      '.model-response-text',
      '.response-container',
      '.model-turn',
      'message-content.model',
      '.presented-turn-content',
    ].join(', '),

    ERROR: [
      '.message-error',
      '.error-text',
      '[role="alert"]',
    ].join(', '),

    FILE_INPUT: 'input[type="file"]',

    ATTACHMENT_CONTAINER: [
      'file-preview',
      'attachment-card',
      '[data-test-id*="attachment"]',
      '[data-testid*="attachment"]',
      '[data-test-id*="preview"]',
      '[data-testid*="preview"]',
      '.file-preview',
      '.attachment-preview',
      '.image-preview',
      '.attachment-container',
    ].join(', '),

    INPUT_AREA: [
      'rich-textarea',
      '.input-area',
      'chat-window',
      '.chat-input-container',
      '.chat-input',
      'input-area',
    ].join(', '),
  });

  const api = { SELECTORS };
  scope.MangaTranslatorGeminiSelectors = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
