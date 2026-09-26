const path = require('path');

const CONTENT_GEMINI_PATH = path.resolve(__dirname, '../../extension/content_gemini.js');
const GEMINI_SELECTORS_PATH = path.resolve(__dirname, '../../extension/gemini/selectors.js');
const GEMINI_DOM_PATH = path.resolve(__dirname, '../../extension/gemini/dom.js');
const GEMINI_OBSERVER_PATH = path.resolve(__dirname, '../../extension/gemini/observer.js');
const GEMINI_EDITOR_PATH = path.resolve(__dirname, '../../extension/gemini/editor.js');
const GEMINI_ATTACHMENT_PATH = path.resolve(__dirname, '../../extension/gemini/attachment.js');
const GEMINI_TEMP_CHAT_PATH = path.resolve(__dirname, '../../extension/gemini/temporary-chat.js');
const GEMINI_RESULT_EXTRACTOR_PATH = path.resolve(__dirname, '../../extension/gemini/result-extractor.js');
const GEMINI_DELETION_PATH = path.resolve(__dirname, '../../extension/gemini/deletion.js');
const GEMINI_JOB_RUNNER_PATH = path.resolve(__dirname, '../../extension/gemini/job-runner.js');

function loadContentGeminiModule() {
    require(GEMINI_SELECTORS_PATH);
    require(GEMINI_DOM_PATH);
    require(GEMINI_OBSERVER_PATH);
    require(GEMINI_EDITOR_PATH);
    require(GEMINI_ATTACHMENT_PATH);
    require(GEMINI_TEMP_CHAT_PATH);
    require(GEMINI_RESULT_EXTRACTOR_PATH);
    require(GEMINI_DELETION_PATH);
    require(GEMINI_JOB_RUNNER_PATH);

    delete require.cache[require.resolve(CONTENT_GEMINI_PATH)];
    return require(CONTENT_GEMINI_PATH);
}

module.exports = {
    CONTENT_GEMINI_PATH,
    loadContentGeminiModule,
};
