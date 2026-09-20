const path = require('path');

const BACKGROUND_PATH = path.resolve(__dirname, '../../extension/background.js');

function delay(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function flush(rounds = 6) {
    for (let i = 0; i < rounds; i++) {
        // eslint-disable-next-line no-await-in-loop
        await delay(0);
    }
}

async function waitFor(assertion, { timeout = 3000, interval = 10 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        // eslint-disable-next-line no-await-in-loop
        const result = await assertion();
        if (result) return result;
        // eslint-disable-next-line no-await-in-loop
        await delay(interval);
    }
    throw new Error('Timeout aguardando condição assíncrona');
}

function getBackgroundListener(runtimeMock) {
    const listeners = runtimeMock._messageListeners || [];
    if (listeners.length !== 1) {
        throw new Error(`Esperava 1 listener do background, recebi ${listeners.length}`);
    }
    return listeners[0];
}

function dispatchToBackground(runtimeMock, request, sender = { tab: null }) {
    return new Promise((resolve) => {
        let settled = false;
        let keepAlive = false;

        const sendResponse = (response) => {
            settled = true;
            resolve({ keepAlive, response });
        };

        keepAlive = getBackgroundListener(runtimeMock)(request, sender, sendResponse);
        if (keepAlive === false && !settled) {
            resolve({ keepAlive, response: undefined });
        }
    });
}

module.exports = {
    BACKGROUND_PATH,
    delay,
    flush,
    waitFor,
    getBackgroundListener,
    dispatchToBackground,
};
