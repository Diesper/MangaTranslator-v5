const fs = require('fs');
const path = require('path');

function findRoot(dir) {
    if (fs.existsSync(path.join(dir, 'extension', 'manifest.json'))) return dir;
    const parent = path.dirname(dir);
    return parent === dir ? process.cwd() : findRoot(parent);
}

const ROOT = findRoot(__dirname);

function stripExternalScripts(html) {
    return html.replace(/<script\b[^>]*src=["'][^"']+["'][^>]*>\s*<\/script>/gi, '');
}

function delay(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function flushAsyncTasks(rounds = 4) {
    for (let i = 0; i < rounds; i++) {
        await delay(0);
    }
}

async function loadExtensionPage({
    htmlPath,
    scriptPath,
    url = 'https://extension.test/',
    fireDOMContentLoaded = false,
} = {}) {
    const html = fs.readFileSync(path.join(ROOT, htmlPath), 'utf8');
    const nextUrl = new URL(url, 'https://extension.test');

    window.history.replaceState({}, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    document.open();
    document.write(stripExternalScripts(html));
    document.close();

    if (fireDOMContentLoaded) {
        const originalAddEventListener = document.addEventListener.bind(document);
        const domReadyCallbacks = [];

        document.addEventListener = (type, listener, options) => {
            if (type === 'DOMContentLoaded') {
                domReadyCallbacks.push(listener);
                return;
            }
            return originalAddEventListener(type, listener, options);
        };

        try {
            jest.isolateModules(() => {
                require(path.join(ROOT, scriptPath));
            });
        } finally {
            document.addEventListener = originalAddEventListener;
        }

        for (const listener of domReadyCallbacks) {
            await listener(new Event('DOMContentLoaded', { bubbles: true }));
        }
    } else {
        jest.isolateModules(() => {
            require(path.join(ROOT, scriptPath));
        });
    }

    await flushAsyncTasks();
}

module.exports = {
    ROOT,
    delay,
    flushAsyncTasks,
    loadExtensionPage,
};
