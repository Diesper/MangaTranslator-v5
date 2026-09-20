const fs = require('fs');
const path = require('path');
const Module = require('module');

function buildStateGetter() {
    return `
function __getState() {
    return {
        jobQueue,
        isProcessing,
        stopRequested,
        activeMangaTabId,
        extractionTabs,
        totalJobs,
        completedJobs,
        activeJobsCount,
        _cachedMaxCon,
        _logQueue,
        _logFlushing,
        _finalizedTabs: Array.from(_finalizedTabs),
    };
}
`;
}

function buildStateSetter() {
    return `
function __setState(next = {}) {
    const has = (key) => Object.prototype.hasOwnProperty.call(next, key);
    if (has('jobQueue')) jobQueue = next.jobQueue;
    if (has('isProcessing')) isProcessing = next.isProcessing;
    if (has('stopRequested')) stopRequested = next.stopRequested;
    if (has('activeMangaTabId')) activeMangaTabId = next.activeMangaTabId;
    if (has('extractionTabs')) extractionTabs = next.extractionTabs;
    if (has('totalJobs')) totalJobs = next.totalJobs;
    if (has('completedJobs')) completedJobs = next.completedJobs;
    if (has('activeJobsCount')) activeJobsCount = next.activeJobsCount;
    if (has('_cachedMaxCon')) _cachedMaxCon = next._cachedMaxCon;
    if (has('_logQueue')) _logQueue = next._logQueue;
    if (has('_logFlushing')) _logFlushing = next._logFlushing;
    if (has('_finalizedTabs')) {
        _finalizedTabs.clear();
        (next._finalizedTabs || []).forEach(id => _finalizedTabs.add(id));
    }
    return __getState();
}
`;
}

function buildExports() {
    return `
module.exports = {
    restoreState,
    syncState,
    log,
    _flushLog,
    clearWatchdog,
    armWatchdog,
    sendProgress,
    buildGeminiJobUrl,
    deleteGeminiConversation,
    _refreshMaxCon,
    processNextJob,
    finalizeJob,
    waitForDownload,
    downloadImagesAndShow,
    handleMarkerAndShow,
    __getState,
    __setState,
};
`;
}

function loadBackgroundModule(backgroundPath) {
    const source = fs.readFileSync(backgroundPath, 'utf8');
    const instrumentedSource = [
        source,
        buildStateGetter(),
        buildStateSetter(),
        buildExports(),
    ].join('\n');
    const localRequire = Module.createRequire(backgroundPath);
    const backgroundModule = { exports: {} };
    const runner = new Function(
        'chrome',
        'fetch',
        'FileReader',
        'require',
        'module',
        'exports',
        '__filename',
        '__dirname',
        instrumentedSource
    );

    runner(
        globalThis.chrome || global.chrome,
        global.fetch,
        global.FileReader,
        localRequire,
        backgroundModule,
        backgroundModule.exports,
        backgroundPath,
        path.dirname(backgroundPath)
    );

    return backgroundModule.exports;
}

module.exports = {
    loadBackgroundModule,
};
