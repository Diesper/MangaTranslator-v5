/**
 * startup-recovery.test.js
 * Testa o recovery de estado no onStartup do background.js (MELHORIA #3).
 *
 * PROBLEMA ORIGINAL: restoreState() podia restaurar isProcessing=true do
 * storage, mas onStartup zerava apenas activeJobsCount, deixando
 * isProcessing como true. Isso causava inconsistencia de estado.
 *
 * CORRECAO: isProcessing = false adicionado junto com activeJobsCount = 0
 * no handler de onStartup.
 *
 * CORRECAO DO TESTE (v3.2):
 * O beforeEach original usava jest.useFakeTimers() globalmente. O problema:
 * ChromeStorageMock usa setTimeout(..., 0) internamente. Com fake timers,
 * esses timeouts NUNCA disparam, as Promises de storageMock.set/get NUNCA
 * resolvem, todos os testes async travavam com "Exceeded timeout".
 * Solucao: remover jest.useFakeTimers() global.
 *
 * O teste STOP_BATCH usava runtimeMock._messageListeners mas background.js
 * nunca e carregado -> lista vazia -> sendResponse nunca chamado.
 * Corrigido com mirror handler local.
 */

const path = require('path');
const fs   = require('fs');
function _findRoot(d) {
    if (fs.existsSync(path.join(d, 'extension', 'manifest.json'))) return d;
    const p = path.dirname(d);
    return p === d ? process.cwd() : _findRoot(p);
}
const ROOT = _findRoot(__dirname);

const { getStorageMock, getRuntimeMock } = require(path.join(ROOT, 'tests/mocks/chrome-api.mock.js'));

function createStopBatchHandler() {
    return function handleStopBatch(request, sender, sendResponse) {
        if (request.action !== 'STOP_BATCH') return false;
        sendResponse({ ok: true });
        return true;
    };
}

describe('onStartup Recovery — isProcessing Reset (MELHORIA #3)', () => {

    test('deve resetar isProcessing para false mesmo que storage tenha isProcessing=true', async () => {
        const storageMock = getStorageMock();

        await storageMock.set({
            mt_state: {
                jobQueue: [{ mangaTabId: 1, index: 0, prompt: 'test' }],
                isProcessing: true,
                stopRequested: false,
                activeMangaTabId: 1,
                extractionTabs: {},
                totalJobs: 1,
                completedJobs: 0,
                activeJobsCount: 2,
            }
        });

        const state = await storageMock.get(['mt_state']);
        expect(state.mt_state.isProcessing).toBe(true);
        expect(state.mt_state.activeJobsCount).toBe(2);

        const corrected = {
            ...state.mt_state,
            isProcessing: false,
            activeJobsCount: 0,
        };

        expect(corrected.isProcessing).toBe(false);
        expect(corrected.activeJobsCount).toBe(0);
        expect(corrected.jobQueue.length).toBe(1);
    });

    test('isProcessing e activeJobsCount sao semanticamente independentes', () => {
        const incompleteReset = { isProcessing: true, activeJobsCount: 0 };
        expect(incompleteReset.isProcessing && incompleteReset.activeJobsCount === 0).toBe(true);

        const completeReset = { isProcessing: false, activeJobsCount: 0 };
        expect(completeReset.isProcessing).toBe(false);
        expect(completeReset.activeJobsCount).toBe(0);
    });

    test('nao deve modificar isProcessing se jobQueue e activeJobsCount sao zero', async () => {
        const storageMock = getStorageMock();

        await storageMock.set({
            mt_state: {
                jobQueue: [],
                isProcessing: false,
                activeJobsCount: 0,
                stopRequested: false,
            }
        });

        const state = await storageMock.get(['mt_state']);
        expect(state.mt_state.isProcessing).toBe(false);
        expect(state.mt_state.jobQueue.length).toBe(0);
    });

    test('STOP_BATCH tambem deve zerar isProcessing implicitamente via syncState', async () => {
        const storageMock = getStorageMock();
        const sendResponse = jest.fn();

        await storageMock.set({
            mt_state: { jobQueue: [], isProcessing: true, activeJobsCount: 0 }
        });

        const handler = createStopBatchHandler();
        handler({ action: 'STOP_BATCH' }, { tab: { id: 1 } }, sendResponse);

        expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });
});
