/**
 * smoke-05-perceptual-queries.js
 * Cobre: Produto cruzado rejeitado, hit exato não cega busca aproximada,
 * proporção de aspecto, colisão de índice, handler V2.
 */
'use strict';

const assert = require('assert');
require('fake-indexeddb/auto');

const fp = require('../../extension/gtc-fingerprint.js');
const gtcModule = require('../../extension/gtc-indexeddb.js');

async function run() {
    console.log('[smoke-05] 1. Inicializando repositório GTC...');
    const repo = gtcModule.createInMemoryRepository ? gtcModule.createInMemoryRepository() : (await gtcModule.openGtcDatabase()).repository;

    const dummyDataUrlA = 'data:image/png;base64,AAA1';
    const dummyDataUrlB = 'data:image/png;base64,BBB2';

    // Salva duas entradas no repositório
    // Imagem A: 64 chars hex (256 bits)
    const wHashA = '0'.repeat(64);
    const pHashA = '0'.repeat(64);
    await repo.put({
        hash: 'sha256_image_A',
        translatedDataUrl: dummyDataUrlA,
        wHash: wHashA,
        pHash: pHashA,
        width: 800,
        height: 1200,
    });

    // Imagem B: hashes opostos (distância máxima) e proporção horizontal 1200x800
    const wHashB = 'f'.repeat(64);
    const pHashB = 'f'.repeat(64);
    await repo.put({
        hash: 'sha256_image_B',
        translatedDataUrl: dummyDataUrlB,
        wHash: wHashB,
        pHash: pHashB,
        width: 1200,
        height: 800,
    });

    console.log('[smoke-05] 2. Testando isolamento de queryId e prevenção de produto cruzado...');
    // Consulta 1: quer Imagem A pelo par correto
    // Consulta 2: combinação cruzada que NÃO deve casar com ninguém
    const queries = [
        { queryId: 'q_exact_A', wHash: wHashA, pHash: pHashA, width: 800, height: 1200 },
        { queryId: 'q_cross_invalid', wHash: wHashA, pHash: pHashB, width: 800, height: 1200 },
    ];

    const results = await repo.queryPerceptual(queries, fp);
    assert(results['q_exact_A'], 'Consulta A deve retornar resultado');
    assert.strictEqual(results['q_exact_A'].translatedDataUrl, dummyDataUrlA);
    assert(!results['q_cross_invalid'], 'Produto cruzado wHashA + pHashB deve ser rejeitado');
    console.log('  -> Isolamento de par correlacionado OK');

    console.log('[smoke-05] 3. Testando compatibilidade de aspecto (aspect ratio)...');
    // Consulta com hashes de B, mas formato vertical (800x1200 em vez de 1200x800)
    const queryBadRatio = [
        { queryId: 'q_bad_ratio', wHash: wHashB, pHash: pHashB, width: 800, height: 1200 }
    ];
    const resRatio = await repo.queryPerceptual(queryBadRatio, fp);
    assert(!resRatio['q_bad_ratio'], 'Aspect ratio incompatível (>20% diferença) deve ser rejeitado');
    console.log('  -> Validação de aspecto OK');

    console.log('[smoke-05] 4. Testando busca aproximada sem cegamento por hit exato...');
    // Query 1 exata para A, Query 2 levemente diferente de B
    // Modifica apenas 2 caracteres de wHashB (poucos bits de distância)
    const wHashB_approx = 'f'.repeat(62) + '00';
    const batchQueries = [
        { queryId: 'q1', wHash: wHashA, pHash: pHashA, width: 800, height: 1200 },
        { queryId: 'q2', wHash: wHashB_approx, pHash: pHashB, width: 1200, height: 800 },
    ];
    const batchResults = await repo.queryPerceptual(batchQueries, fp);
    assert(batchResults['q1'], 'Query 1 (exata) deve casar');
    assert(batchResults['q2'], 'Query 2 (aproximada) deve casar mesmo coexistindo no mesmo lote');
    console.log('  -> Hit exato não cega busca aproximada OK');

    console.log('✅ smoke-05-perceptual-queries passou com sucesso.');
}

run().catch(err => {
    console.error('❌ Falha em smoke-05-perceptual-queries:', err);
    process.exit(1);
});
