const { execFileSync } = require('child_process');
const path = require('path');

describe('background.js - carregamento isolado do Service Worker', () => {
    test('BG-STRICT-01: carrega em strict mode sem depender de globals vazados por outros testes', () => {
        const backgroundPath = path.resolve(__dirname, '../../../extension/background.js');

        const bootstrap = `
const fs = require('fs');

global.chrome = {
    runtime: {
        id: 'test-extension',
        lastError: null,
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onConnect: { addListener() {} },
        onMessage: { addListener() {} },
    },
    alarms: {
        onAlarm: { addListener() {} },
        create() {},
        clear(_name, cb) { if (cb) cb(); },
    },
    storage: {
        local: {
            async get() { return {}; },
            async set() {},
            async remove() {},
        },
    },
    tabs: {},
    windows: {},
    downloads: {
        onChanged: {
            addListener() {},
            removeListener() {},
        },
    },
};

global.importScripts = function() {};

const source = fs.readFileSync(process.argv[1], 'utf8');
new Function(source)();
`;

        expect(() => {
            execFileSync(process.execPath, ['-e', bootstrap, backgroundPath], {
                stdio: 'pipe',
                env: { ...process.env },
            });
        }).not.toThrow();
    });
});
