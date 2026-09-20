const fs = require('fs');
const path = require('path');

describe('manifest surface reduction', () => {
    const manifest = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, '../../../extension/manifest.json'),
        'utf8'
    ));

    test('does not expose static content scripts or the internal reader to web pages', () => {
        const exposedResources = (manifest.web_accessible_resources || [])
            .flatMap((entry) => entry.resources || []);

        expect(exposedResources).not.toEqual(expect.arrayContaining([
            'inject.js',
            'reader.html',
            'reader.js',
        ]));
    });

    test('uses the all-URLs host permission without a redundant Gemini entry', () => {
        expect(manifest.host_permissions).toEqual(['<all_urls>']);
    });
});
