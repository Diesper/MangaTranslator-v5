'use strict';
// gemini/deletion.js — exclusão segura/idempotente e recovery da conversa Gemini.

(function(scope) {
  function createDeletionController({
    root = scope.document || null,
    pageWindow = scope.window || null,
    storage = scope.chrome?.storage?.local || null,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    sendLog = function() {},
    now = () => Date.now(),
    getComputedStyleImpl = scope.getComputedStyle
      ? scope.getComputedStyle.bind(scope)
      : null,
  } = {}) {
    let deletionInProgress = false;

    function getElementText(element) {
      if (!element) return '';
      return [
        element.innerText,
        element.textContent,
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('mattooltip'),
        element.getAttribute?.('title'),
        element.getAttribute?.('data-test-id'),
        element.getAttribute?.('data-testid'),
      ].filter(Boolean).join(' ').toLowerCase().trim();
    }

    function escapeCssAttributeValue(value) {
      const input = String(value || '');
      const css = scope.CSS || pageWindow?.CSS;
      if (css && typeof css.escape === 'function') return css.escape(input);
      return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function getCurrentChatId() {
      const pathname = String(pageWindow?.location?.pathname || '');
      const match = pathname.match(/\/app\/([a-z0-9_-]+)/i);
      return match && match[1] ? match[1] : null;
    }

    function getRecoveryKey(tabId) {
      return `gemini_delete_recovery_${tabId}`;
    }

    function storageGet(keys) {
      if (!storage || typeof storage.get !== 'function') {
        return Promise.resolve({});
      }
      return new Promise(resolve => {
        try {
          storage.get(keys, data => resolve(data || {}));
        } catch (_e) {
          resolve({});
        }
      });
    }

    function storageSet(values) {
      if (!storage || typeof storage.set !== 'function') return Promise.resolve();
      return new Promise((resolve, reject) => {
        try {
          const maybe = storage.set(values, () => {
            const lastError = scope.chrome?.runtime?.lastError;
            if (lastError) reject(new Error(lastError.message || 'Falha ao persistir recovery'));
            else resolve();
          });
          if (maybe && typeof maybe.then === 'function') {
            maybe.then(resolve, reject);
          }
        } catch (error) {
          reject(error);
        }
      });
    }

    function storageRemove(keys) {
      if (!storage || typeof storage.remove !== 'function') return Promise.resolve();
      return new Promise((resolve, reject) => {
        try {
          const maybe = storage.remove(keys, () => {
            const lastError = scope.chrome?.runtime?.lastError;
            if (lastError) reject(new Error(lastError.message || 'Falha ao remover recovery'));
            else resolve();
          });
          if (maybe && typeof maybe.then === 'function') {
            maybe.then(resolve, reject);
          }
        } catch (error) {
          reject(error);
        }
      });
    }

    async function waitForElementToSettle(element, samples = 3, interval = 300) {
      if (!element || element.isConnected === false) return false;

      let previous = null;
      for (let sample = 0; sample < samples; sample += 1) {
        if (element.isConnected === false) return false;

        let rect;
        try {
          rect = element.getBoundingClientRect();
        } catch (_e) {
          return false;
        }

        const position = [
          Math.round(rect.top || 0),
          Math.round(rect.left || 0),
          Math.round(rect.width || 0),
          Math.round(rect.height || 0),
        ].join(':');

        if (previous !== null && position !== previous) {
          // Reinicia a janela de estabilidade sem criar recursão/timer extra.
          sample = -1;
        }
        previous = position;
        await sleep(interval);
      }

      return element.isConnected !== false;
    }

    function findDeleteMenuItemCandidate() {
      if (!root || typeof root.querySelectorAll !== 'function') {
        return { item: null, candidateCount: 0 };
      }

      const candidates = Array.from(root.querySelectorAll(
        'div[role="menuitem"], [role="menu"] button, .mat-mdc-menu-item, button'
      ));

      const item = candidates.find(element =>
        /^(excluir|delete)$/i.test(String(element.textContent || '').trim())
      ) || null;

      return { item, candidateCount: candidates.length };
    }

    async function waitForDeleteMenuItem(timeout = 2000, interval = 100) {
      const startedAt = now();
      do {
        const result = findDeleteMenuItemCandidate();
        if (result.item) return result.item;
        if (now() - startedAt >= timeout) return null;
        await sleep(interval);
      } while (now() - startedAt < timeout);
      return null;
    }

    function findConfirmButtonCandidate(excludeElement = null) {
      if (!root || typeof root.querySelectorAll !== 'function') {
        return { item: null, candidateCount: 0 };
      }

      const dialogs = Array.from(root.querySelectorAll(
        '[role="dialog"], mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane'
      ));
      const scopes = dialogs.length > 0 ? dialogs : [root];

      const candidates = scopes.flatMap(scopeElement =>
        Array.from(scopeElement.querySelectorAll('button, [role="button"]'))
      ).filter(element =>
        element !== excludeElement &&
        !(excludeElement?.contains?.(element)) &&
        element.getAttribute?.('role') !== 'menuitem'
      );

      const matches = candidates.filter(element =>
        /^(excluir|delete)$/i.test(String(element.textContent || '').trim())
      );

      return {
        item: matches.length ? matches[matches.length - 1] : null,
        candidateCount: candidates.length,
      };
    }

    async function waitForConfirmButton(excludeElement = null, timeout = 5000, interval = 200) {
      const startedAt = now();
      do {
        const result = findConfirmButtonCandidate(excludeElement);
        if (result.item) return result.item;
        if (now() - startedAt >= timeout) return null;
        await sleep(interval);
      } while (now() - startedAt < timeout);
      return null;
    }

    function createScrollLock(rowContainer) {
      if (!pageWindow || !root) return () => {};

      const targets = [root.scrollingElement];
      if (getComputedStyleImpl) {
        for (
          let parent = rowContainer?.parentElement;
          parent && parent !== root.body;
          parent = parent.parentElement
        ) {
          try {
            const style = getComputedStyleImpl(parent);
            if (/(auto|scroll)/.test(String(style?.overflowY || ''))) {
              targets.push(parent);
            }
          } catch (_e) {}
        }
      }

      const cleanups = [...new Set(targets.filter(Boolean))].map(target => {
        const top = target.scrollTop;
        const left = target.scrollLeft;
        const restore = () => {
          target.scrollTop = top;
          target.scrollLeft = left;
        };
        target.addEventListener?.('scroll', restore, { passive: true });
        return () => target.removeEventListener?.('scroll', restore);
      });

      const preventScrollInput = event => event.preventDefault();
      pageWindow.addEventListener?.('wheel', preventScrollInput, { passive: false });
      pageWindow.addEventListener?.('touchmove', preventScrollInput, { passive: false });

      return () => {
        cleanups.forEach(cleanup => {
          try { cleanup(); } catch (_e) {}
        });
        pageWindow.removeEventListener?.('wheel', preventScrollInput);
        pageWindow.removeEventListener?.('touchmove', preventScrollInput);
      };
    }

    async function deleteCurrentConversation({ lockScroll = false } = {}) {
      if (deletionInProgress) return false;
      deletionInProgress = true;

      let releaseScrollLock = () => {};

      try {
        const debugData = await storageGet(['debugMode']);
        if (debugData.debugMode === true) {
          sendLog('info', 'DEBUG_MODE_SKIP', 'Modo debug ativo, pulando deleção da conversa');
          return true;
        }

        const chatId = getCurrentChatId();
        if (!chatId) {
          throw new Error('A URL não possui o ID da conversa ativa.');
        }

        const escapedChatId = escapeCssAttributeValue(chatId);
        const linkSelector = `a[href*="${escapedChatId}"]`;

        const sidebarToggle = root.querySelector(
          'button[data-test-id="side-nav-toggle"], button[aria-label*="menu" i], button[aria-label*="barra lateral" i]'
        );

        if (!root.querySelector(linkSelector) && sidebarToggle) {
          sidebarToggle.click();
          await sleep(700);
        }

        let activeLink = null;
        for (let attempt = 0; attempt < 16; attempt += 1) {
          activeLink = root.querySelector(linkSelector);
          if (activeLink) break;
          await sleep(250);
        }
        if (!activeLink) {
          throw new Error('A conversa ativa não foi localizada na barra lateral.');
        }

        activeLink.scrollIntoView?.({ block: 'center', behavior: 'instant' });
        await sleep(700);
        if (!await waitForElementToSettle(activeLink)) {
          throw new Error('A conversa alvo não estabilizou na barra lateral.');
        }

        let rowContainer = activeLink;
        while (rowContainer.parentElement) {
          const parent = rowContainer.parentElement;
          if (parent.querySelectorAll('a[href*="/app/"]').length > 1) break;
          rowContainer = parent;
        }

        if (lockScroll) {
          releaseScrollLock = createScrollLock(rowContainer);
        }

        const rowButtons = Array.from(
          rowContainer.querySelectorAll('button, [role="button"]')
        ).filter(button =>
          button !== activeLink &&
          !activeLink.contains?.(button)
        );

        const menuButton = rowButtons.find(button =>
          button.hasAttribute?.('aria-haspopup') ||
          button.hasAttribute?.('aria-expanded')
        ) || rowButtons[rowButtons.length - 1];

        if (!menuButton) {
          throw new Error('Menu de opções da conversa não encontrado.');
        }

        await sleep(400);
        menuButton.click();
        await sleep(700);

        if (
          rowContainer.isConnected === false ||
          !rowContainer.querySelector(linkSelector)
        ) {
          throw new Error('A lista mudou enquanto o menu era aberto.');
        }

        const deleteItem = await waitForDeleteMenuItem(2000, 100);
        if (!deleteItem) {
          throw new Error('Opção Excluir não encontrada no menu.');
        }
        if (!await waitForElementToSettle(deleteItem, 2, 250)) {
          throw new Error('A opção Excluir não permaneceu estável no menu.');
        }

        const deleteTarget = deleteItem.closest?.('div[role="menuitem"], li, button') || deleteItem;
        deleteTarget.click();
        await sleep(800);

        const confirmButton = await waitForConfirmButton(deleteItem, 5000, 200);
        if (!confirmButton) {
          throw new Error('Confirmação da exclusão não encontrada.');
        }
        if (!await waitForElementToSettle(confirmButton, 2, 300)) {
          throw new Error('O botão de confirmação não estabilizou no diálogo.');
        }

        confirmButton.click();
        await sleep(1200);

        sendLog('success', 'DELETE_OK', 'Conversa excluída com segurança!', { chatId });
        return true;
      } catch (error) {
        sendLog('warn', 'DELETE_ERROR', `Erro na deleção: ${error.message}`, {});
        return false;
      } finally {
        try { releaseScrollLock(); } catch (_e) {}
        deletionInProgress = false;
      }
    }

    async function readRecovery(tabId) {
      const key = getRecoveryKey(tabId);
      const data = await storageGet([key]);
      return data[key] || null;
    }

    async function clearRecovery(tabId) {
      await storageRemove(getRecoveryKey(tabId));
    }

    async function saveRecovery(tabId, delivery) {
      const key = getRecoveryKey(tabId);
      const recovery = {
        chatId: getCurrentChatId(),
        delivery,
        createdAt: now(),
      };
      await storageSet({ [key]: recovery });
      return recovery;
    }

    async function recoverPending({ tabId, sendDelivery } = {}) {
      const recovery = await readRecovery(tabId);
      if (!recovery || !recovery.delivery) {
        return {
          handled: false,
          deleted: false,
          recovery: null,
        };
      }

      const deleted = await deleteCurrentConversation({ lockScroll: true });
      await clearRecovery(tabId);

      sendLog(
        deleted ? 'success' : 'warn',
        'DELETE_RECOVERY',
        deleted
          ? 'Conversa excluída após recarregar a aba.'
          : 'Exclusão continuou sem confirmação após a recuperação.',
        { chatId: recovery.chatId || null }
      );

      if (typeof sendDelivery === 'function') {
        await sendDelivery(recovery.delivery);
      }

      return {
        handled: true,
        deleted,
        recovery,
      };
    }

    async function deleteOrScheduleRecovery({
      tabId,
      delivery,
      reload = true,
    } = {}) {
      const deleted = await deleteCurrentConversation();
      if (deleted) {
        return {
          deleted: true,
          recoverySaved: false,
          reloadScheduled: false,
        };
      }

      await saveRecovery(tabId, delivery);

      let reloadScheduled = false;
      if (reload && pageWindow?.location && typeof pageWindow.location.reload === 'function') {
        pageWindow.location.reload();
        reloadScheduled = true;
      }

      return {
        deleted: false,
        recoverySaved: true,
        reloadScheduled,
      };
    }

    function isDeletionInProgress() {
      return deletionInProgress;
    }

    return {
      getElementText,
      escapeCssAttributeValue,
      getCurrentChatId,
      getRecoveryKey,
      waitForElementToSettle,
      findDeleteMenuItemCandidate,
      waitForDeleteMenuItem,
      findConfirmButtonCandidate,
      waitForConfirmButton,
      deleteCurrentConversation,
      readRecovery,
      saveRecovery,
      clearRecovery,
      recoverPending,
      deleteOrScheduleRecovery,
      isDeletionInProgress,
    };
  }

  const api = { createDeletionController };
  scope.MangaTranslatorGeminiDeletion = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
