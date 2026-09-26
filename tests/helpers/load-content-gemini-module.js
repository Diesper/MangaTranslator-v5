const fs = require('fs');
const path = require('path');

const CONTENT_GEMINI_PATH = path.resolve(__dirname, '../../extension/content_gemini.js');
const GEMINI_SELECTORS_PATH = path.resolve(__dirname, '../../extension/gemini/selectors.js');
const GEMINI_DOM_PATH = path.resolve(__dirname, '../../extension/gemini/dom.js');
const GEMINI_OBSERVER_PATH = path.resolve(__dirname, '../../extension/gemini/observer.js');
const GEMINI_EDITOR_PATH = path.resolve(__dirname, '../../extension/gemini/editor.js');

function loadContentGeminiModule({ skipAutoProcess = true } = {}) {
    require(GEMINI_SELECTORS_PATH);
    require(GEMINI_DOM_PATH);
    require(GEMINI_OBSERVER_PATH);
    require(GEMINI_EDITOR_PATH);
    const source = fs.readFileSync(CONTENT_GEMINI_PATH, 'utf8');
    const instrumented = source.replace(
        'processGeminiJob();',
        'if (!globalThis.__MT_SKIP_GEMINI_AUTO_PROCESS__) processGeminiJob();'
    );

    const previousFlag = globalThis.__MT_SKIP_GEMINI_AUTO_PROCESS__;
    globalThis.__MT_SKIP_GEMINI_AUTO_PROCESS__ = skipAutoProcess;

    try {
        const mod = { exports: {} };
        const factory = new Function(
            'module',
            'exports',
            'require',
            `${instrumented}
            module.exports = {
                sleep,
                dataURLtoFile,
                waitForElement,
                getExpectedGeminiJobId,
                claimGeminiJob,
                openKeepAlive,
                closeKeepAlive,
                processGeminiJob,
                deleteCurrentConversation,
                TemporaryChatActivator,
                createGeminiManualPanel,
                removeGeminiManualPanel,
                setManualGeminiResultUrl,
                findGeneratedResultImages,
                isManualSelectableImage,
                imageElementToDataUrl,
                fetchImageThroughGeminiPage,
                fetchGeminiImageThroughExtension,
                extractImageInGeminiTab,
                extractResultImage,
                extractResultImageWithRetry,
                getExtractionFailureKind,
                shouldKeepConversationForDebug,
                waitForElementToSettle,
                escapeCssAttributeValue,
                __getDeletionInProgress: () => _deletionInProgress,
            };`
        );

        factory(mod, mod.exports, require);
        return mod.exports;
    } finally {
        if (previousFlag === undefined) delete globalThis.__MT_SKIP_GEMINI_AUTO_PROCESS__;
        else globalThis.__MT_SKIP_GEMINI_AUTO_PROCESS__ = previousFlag;
    }
}

module.exports = {
    CONTENT_GEMINI_PATH,
    loadContentGeminiModule,
};

