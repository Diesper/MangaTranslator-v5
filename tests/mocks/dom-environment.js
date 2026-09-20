/**
 * Configura o ambiente JSDOM para mockar APIs que o jsdom não fornece por padrão.
 * Usado como setupFile no Jest para testes que envolvem DOM.
 */

// ── Codecs de texto (necessários para alguns módulos Node/JSDOM) ───
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// ── Mocks de APIs de navegador ─────────────────────────────────────
if (typeof window !== 'undefined') {
  // Scroll
  window.scrollTo = jest.fn();

  // Canvas
  if (window.HTMLCanvasElement && !window.HTMLCanvasElement.prototype.getContext?.__mangaTranslatorMock) {
    const defaultCanvasContext = {
      drawImage: jest.fn(),
      getImageData: () => {
        throw new DOMException('Canvas pixels unavailable in test environment.', 'SecurityError');
      },
    };

    const getContextMock = jest.fn(() => defaultCanvasContext);
    getContextMock.__mangaTranslatorMock = true;

    Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
      value: getContextMock,
      configurable: true,
      writable: true,
    });

    Object.defineProperty(window.HTMLCanvasElement.prototype, 'toDataURL', {
      value: jest.fn(() => 'data:image/png;base64,TEST_CANVAS'),
      configurable: true,
      writable: true,
    });
  }

  // Animation frame
  window.requestAnimationFrame  = jest.fn(cb => setTimeout(() => cb(performance.now()), 0));
  window.cancelAnimationFrame   = jest.fn(id => clearTimeout(id));

  // IntersectionObserver
  class IntersectionObserver {
    observe()    {}
    unobserve()  {}
    disconnect() {}
  }
  window.IntersectionObserver = IntersectionObserver;

  // ResizeObserver
  class ResizeObserver {
    observe()    {}
    unobserve()  {}
    disconnect() {}
  }
  window.ResizeObserver = ResizeObserver;
}
