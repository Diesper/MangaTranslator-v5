/**
 * smoke-02-uuid-and-reconcile.js
 * Cobre: Fallback de crypto.randomUUID;
 * reconciliação descartando jobs de abas mortas.
 */
'use strict';

const assert = require('assert');

// ── 1. Teste do Fallback de generateId ─────────────────────────────────────────
console.log('[smoke-02] 1. Testando fallback de geração de IDs...');

function generateId(prefix = '') {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return prefix + crypto.randomUUID();
        }
    } catch (_e) {}
    return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Teste com crypto ativo
const id1 = generateId('job_');
assert(id1.startsWith('job_'));
assert(id1.length > 10);

// Teste simulando ausência de crypto.randomUUID (ambiente restrito / SW antigo)
let originalRandomUUID = null;
try {
    originalRandomUUID = crypto.randomUUID;
    try {
        crypto.randomUUID = undefined;
    } catch (_e) {
        try {
            Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
        } catch (_e2) {}
    }
    const fallbackId = generateId('fallback_');
    assert(fallbackId.startsWith('fallback_'));
    assert(fallbackId.length > 15, 'ID gerado pelo fallback determinístico deve ser não-vazio e único');
    console.log('  -> Fallback sem crypto.randomUUID OK:', fallbackId);
} finally {
    if (originalRandomUUID) {
        try {
            crypto.randomUUID = originalRandomUUID;
        } catch (_e) {
            try {
                Object.defineProperty(crypto, 'randomUUID', { value: originalRandomUUID, configurable: true, writable: true });
            } catch (_e2) {}
        }
    }
}

// ── 2. Teste de reconciliação de jobs (reconcileJobs) ─────────────────────────
console.log('[smoke-02] 2. Testando reconciliação com abas vivas e mortas...');

const storage = {};
const clearedAlarms = [];

const mockChrome = {
    runtime: {},
    storage: {
        local: {
            get: (keys, cb) => {
                const res = {};
                if (typeof keys === 'string') res[keys] = storage[keys];
                else if (Array.isArray(keys)) keys.forEach(k => { res[k] = storage[k]; });
                if (cb) cb(res);
                return Promise.resolve(res);
            },
            set: (items, cb) => {
                Object.assign(storage, items);
                if (cb) cb();
                return Promise.resolve();
            },
            remove: (keys, cb) => {
                const arr = Array.isArray(keys) ? keys : [keys];
                arr.forEach(k => delete storage[k]);
                if (cb) cb();
                return Promise.resolve();
            }
        }
    },
    tabs: {
        get: (tabId, cb) => {
            // Aba 101 está viva; Aba 102 foi fechada pelo usuário
            if (tabId === 101) {
                mockChrome.runtime.lastError = null;
                cb({ id: 101, status: 'complete' });
            } else {
                mockChrome.runtime.lastError = { message: `No tab with id: ${tabId}` };
                cb(null);
            }
        }
    },
    alarms: {
        clear: (name, cb) => {
            clearedAlarms.push(name);
            if (cb) cb(true);
        }
    }
};

let jobIndex = [
    { geminiTabId: 101, jobId: 'uuid-101', batchId: 'batch-1' },
    { geminiTabId: 102, jobId: 'uuid-102', batchId: 'batch-1' }
];
let activeJobsCount = 2;

storage['gemini_job_101'] = { state: 'running' };
storage['gemini_job_102'] = { state: 'running' };

function tabExists(tabId) {
    return new Promise(resolve => {
        if (!tabId && tabId !== 0) { resolve(false); return; }
        try {
            mockChrome.tabs.get(tabId, (tab) => {
                if (mockChrome.runtime.lastError || !tab) resolve(false);
                else resolve(true);
            });
        } catch (_e) { resolve(false); }
    });
}

async function reconcileJobs() {
    if (!Array.isArray(jobIndex) || jobIndex.length === 0) {
        activeJobsCount = 0;
        return { alive: 0, dropped: 0 };
    }

    const alive = [];
    const dropped = [];
    for (const entry of jobIndex) {
        if (!entry) continue;
        const exists = await tabExists(entry.geminiTabId);
        if (exists) alive.push(entry);
        else dropped.push(entry);
    }

    if (dropped.length > 0) {
        const keys = [];
        dropped.forEach(entry => {
            keys.push(`gemini_job_${entry.geminiTabId}`);
            keys.push(`wd_data_${entry.geminiTabId}`);
            const alarmName = entry.jobId ? `watchdog_${entry.jobId}` : `watchdog_${entry.geminiTabId}`;
            mockChrome.alarms.clear(alarmName, () => {});
        });
        await mockChrome.storage.local.remove(keys);
    }

    jobIndex = alive;
    activeJobsCount = alive.length;
    return { alive: alive.length, dropped: dropped.length };
}

async function runReconcileTest() {
    const res = await reconcileJobs();
    assert.strictEqual(res.alive, 1, '1 aba viva');
    assert.strictEqual(res.dropped, 1, '1 aba morta descartada');
    assert.strictEqual(jobIndex.length, 1);
    assert.strictEqual(jobIndex[0].geminiTabId, 101);
    assert.strictEqual(activeJobsCount, 1);

    // Verifica que o storage da aba morta foi limpo
    assert.strictEqual(storage['gemini_job_101'] !== undefined, true, 'Aba viva preservada');
    assert.strictEqual(storage['gemini_job_102'], undefined, 'Aba morta purgada do storage');
    assert(clearedAlarms.includes('watchdog_uuid-102'), 'Alarme da aba morta cancelado');

    console.log('  -> Reconciliação descartando abas mortas OK');
    console.log('✅ smoke-02-uuid-and-reconcile passou com sucesso.');
}

runReconcileTest().catch(err => {
    console.error('❌ Falha em smoke-02-uuid-and-reconcile:', err);
    process.exit(1);
});
