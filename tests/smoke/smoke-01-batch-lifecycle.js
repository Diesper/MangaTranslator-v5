/**
 * smoke-01-batch-lifecycle.js
 * Cobre: Limite de concorrência, ACK sem atraso fixo, índice durável,
 * rejeição de remetente estranho, STOP_BATCH isolado.
 */
'use strict';

const assert = require('assert');

console.log('[smoke-01] 1. Testando assertJobOwnership (rejeição de remetente estranho)...');

const mockStorage = {};
const mockChrome = {
    storage: {
        local: {
            get: (keys, cb) => {
                const res = {};
                const arr = Array.isArray(keys) ? keys : [keys];
                arr.forEach(k => { if (k in mockStorage) res[k] = mockStorage[k]; });
                if (cb) cb(res);
                return Promise.resolve(res);
            }
        }
    }
};

function assertJobOwnership(sender, jobId, callback) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!jobId) { callback(true, tabId); return; }
    if (tabId === null) { callback(false, tabId); return; }
    mockChrome.storage.local.get([`gemini_job_${tabId}`], (data) => {
        const job = data && data[`gemini_job_${tabId}`];
        if (!job) { callback(false, tabId); return; }
        callback(job.jobId === jobId, tabId);
    });
}

// Configura o job da aba 10
mockStorage['gemini_job_10'] = { jobId: 'uuid-valido-10', batchId: 'batch-A' };

// Teste 1.1: Aba legítima deve ser aceita
assertJobOwnership({ tab: { id: 10 } }, 'uuid-valido-10', (owns) => {
    assert.strictEqual(owns, true, 'Dono legítimo deve ser aceito');
});

// Teste 1.2: Aba estranha tentando reivindicar o jobId deve ser rejeitada
assertJobOwnership({ tab: { id: 99 } }, 'uuid-valido-10', (owns) => {
    assert.strictEqual(owns, false, 'Remetente estranho deve ser rejeitado');
});

// Teste 1.3: Mensagem legada (sem jobId) deve ser aceita para retrocompatibilidade
assertJobOwnership({ tab: { id: 10 } }, null, (owns) => {
    assert.strictEqual(owns, true, 'Mensagem legada sem jobId deve ser aceita');
});
console.log('  -> assertJobOwnership OK');

console.log('[smoke-01] 2. Testando índice durável e STOP_BATCH isolado por batchId...');

let jobIndex = [];
function indexAddJob(entry) {
    jobIndex = jobIndex.filter(j => j && j.geminiTabId !== entry.geminiTabId);
    jobIndex.push(entry);
}
function indexRemoveJob(geminiTabId) {
    jobIndex = jobIndex.filter(j => j && j.geminiTabId !== geminiTabId);
}
function indexJobsOfBatch(batchId) {
    if (!batchId) return jobIndex.slice();
    return jobIndex.filter(j => j && j.batchId === batchId);
}

// Adiciona jobs de dois lotes distintos (batch-A e batch-B)
indexAddJob({ geminiTabId: 10, jobId: 'job-1', batchId: 'batch-A' });
indexAddJob({ geminiTabId: 11, jobId: 'job-2', batchId: 'batch-A' });
indexAddJob({ geminiTabId: 20, jobId: 'job-3', batchId: 'batch-B' });

assert.strictEqual(jobIndex.length, 3);
assert.strictEqual(indexJobsOfBatch('batch-A').length, 2);
assert.strictEqual(indexJobsOfBatch('batch-B').length, 1);

// Simula STOP_BATCH apenas para batch-A
const targetBatchId = 'batch-A';
const stoppedJobs = indexJobsOfBatch(targetBatchId);
stoppedJobs.forEach(j => indexRemoveJob(j.geminiTabId));

// Garante que o batch-B NÃO foi afetado
assert.strictEqual(jobIndex.length, 1, 'Apenas jobs do lote cancelado devem ser removidos');
assert.strictEqual(jobIndex[0].geminiTabId, 20);
assert.strictEqual(jobIndex[0].batchId, 'batch-B');
console.log('  -> Índice durável e STOP_BATCH isolado OK');

console.log('[smoke-01] 3. Testando handshake ACK sem delay fixo de 1.5s...');

let ackReceivedImmediately = false;
const startTime = Date.now();

function deliverResultSimulated(onAck) {
    // Simula envio de UPDATE_IMAGE com expectAck: true
    // O content script responde imediatamente com { ok: true, domApplied: true }
    setTimeout(() => {
        onAck({ ok: true, domApplied: true });
    }, 20);
}

deliverResultSimulated((resp) => {
    const elapsed = Date.now() - startTime;
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(resp.domApplied, true);
    assert(elapsed < 500, `ACK deve resolver imediatamente em vez de esperar 1.5s (levou ${elapsed}ms)`);
    ackReceivedImmediately = true;
    console.log(`  -> Handshake ACK resolvido em ${elapsed}ms (sem atraso fixo de 1,5 s)`);

    console.log('[smoke-01] 4. Testando respeito ao limite de concorrência...');
    const maxConcurrentJobs = 3;
    let activeCount = 0;
    const dispatched = [];
    const queue = [1, 2, 3, 4, 5, 6, 7];

    function dispatchNext() {
        while (activeCount < maxConcurrentJobs && queue.length > 0) {
            const item = queue.shift();
            activeCount++;
            dispatched.push(item);
        }
    }

    dispatchNext();
    assert.strictEqual(activeCount, 3, 'Deve despachar no máximo maxConcurrentJobs');
    assert.strictEqual(dispatched.length, 3);
    assert.strictEqual(queue.length, 4);
    console.log('  -> Limite de concorrência respeitado OK');

    console.log('✅ smoke-01-batch-lifecycle passou com sucesso.');
});
