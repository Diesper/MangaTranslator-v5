const { IDBFactory } = require('fake-indexeddb');

const {
    createInMemoryRepository,
    createIndexedDbRepository,
    createGtcRuntimeHandler,
    normalizeHash,
} = require('../../../extension/gtc-indexeddb.js');

function uniqueDbName(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function openDb(factory, dbName) {
    return new Promise((resolve, reject) => {
        const request = factory.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('open failed'));
    });
}

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('request failed'));
    });
}

function createFailingIndexedDbFactory() {
    let attempts = 0;

    return {
        get attempts() {
            return attempts;
        },
        open() {
            attempts += 1;
            const attempt = attempts;
            const request = {};

            setTimeout(() => {
                request.error = new Error(`boom-${attempt}`);
                if (typeof request.onerror === 'function') {
                    request.onerror();
                }
            }, 0);

            return request;
        },
    };
}

function createAbortingReadwriteFactory() {
    const tx = {
        error: null,
        objectStore: jest.fn(),
        oncomplete: null,
        onerror: null,
        onabort: null,
    };
    const store = {
        put: jest.fn(() => {
            setTimeout(() => {
                tx.error = new Error('tx aborted');
                if (typeof tx.onabort === 'function') tx.onabort({ target: tx });
            }, 0);
            return {};
        }),
    };
    tx.objectStore.mockReturnValue(store);

    const db = {
        objectStoreNames: { contains: () => true },
        transaction: jest.fn(() => tx),
    };

    return {
        db,
        tx,
        store,
        open: jest.fn(() => {
            const request = {};
            setTimeout(() => {
                request.result = db;
                if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
            }, 0);
            return request;
        }),
    };
}

function callHandler(handler, request) {
    return new Promise((resolve) => {
        let settled = false;
        let returned = false;

        const sendResponse = (response) => {
            settled = true;
            resolve({ returned, response });
        };

        returned = handler(request, {}, sendResponse);
        if (returned === false && !settled) {
            resolve({ returned, response: undefined });
        }
    });
}

describe('gtc-indexeddb.js', () => {
    describe('normalizeHash()', () => {
        test('IDB-02/IDB-03 normaliza uppercase, espacos e valores invalidos', () => {
            expect(normalizeHash('  ABC123  ')).toBe('abc123');
            expect(normalizeHash('')).toBe('');
            expect(normalizeHash(null)).toBe('');
        });
    });

    describe('createInMemoryRepository()', () => {
        test('IDB-01/IDB-03 salva e recupera entradas pelo hash normalizado', async () => {
            const repo = createInMemoryRepository();

            await repo.put({
                hash: '  ABC123  ',
                translatedDataUrl: 'data:image/png;base64,AAA',
                cleanUrl: 'https://reader.test/panel-001.png',
                width: 800,
                height: 1200,
            });

            await expect(repo.getMany(['abc123'])).resolves.toEqual({
                abc123: 'data:image/png;base64,AAA',
            });
        });

        test('IDB-04/IDB-05/IDB-06/IDB-07/IDB-09/IDB-10/IDB-11 cobrem getMany, putMany, invalidas, stats e clear', async () => {
            const repo = createInMemoryRepository();

            await expect(repo.putMany([
                { hash: 'hash-1', translatedDataUrl: 'data:1' },
                { hash: 'hash-2', translatedDataUrl: 'data:2' },
                { hash: null, translatedDataUrl: 'data:ignored' },
            ])).resolves.toEqual({ saved: true, count: 3 });

            await expect(repo.stats()).resolves.toEqual({ count: 2 });
            await expect(repo.getMany(['hash-1', 'hash-2', 'missing'])).resolves.toEqual({
                'hash-1': 'data:1',
                'hash-2': 'data:2',
            });

            await repo.clear();
            await expect(repo.getMany(['hash-1', 'hash-2'])).resolves.toEqual({});
        });

        test('IDB-08 retorna count 0 para putMany com array vazio', async () => {
            const repo = createInMemoryRepository();
            await expect(repo.putMany([])).resolves.toEqual({ saved: true, count: 0 });
            await expect(repo.stats()).resolves.toEqual({ count: 0 });
        });

        test('IDB-12 sobrescreve uma entrada existente mantendo a chave', async () => {
            const repo = createInMemoryRepository();

            await repo.put({ hash: 'dup', translatedDataUrl: 'data:v1' });
            await repo.put({ hash: 'dup', translatedDataUrl: 'data:v2' });

            await expect(repo.getMany(['dup'])).resolves.toEqual({ dup: 'data:v2' });
            await expect(repo.stats()).resolves.toEqual({ count: 1 });
        });

        test('IDB-v4 deleteByCleanUrl remove somente entradas da URL normalizada no fallback em memoria', async () => {
            const repo = createInMemoryRepository();

            await repo.putMany([
                {
                    hash: 'wrong-a',
                    translatedDataUrl: 'data:wrong-a',
                    cleanUrl: 'https://reader.test/wrong.png',
                },
                {
                    hash: 'wrong-b',
                    translatedDataUrl: 'data:wrong-b',
                    cleanUrl: 'https://reader.test/wrong.png',
                },
                {
                    hash: 'keep',
                    translatedDataUrl: 'data:keep',
                    cleanUrl: 'https://reader.test/keep.png',
                },
            ]);

            await expect(repo.deleteByCleanUrl('https://reader.test/wrong.png')).resolves.toEqual({ deleted: 2 });
            await expect(repo.getMany(['wrong-a', 'wrong-b', 'keep'])).resolves.toEqual({
                keep: 'data:keep',
            });
            await expect(repo.deleteByCleanUrl('')).resolves.toEqual({ deleted: 0 });
        });

        test('IDB-v2/v3 consulta por dHash perceptual no fallback em memoria', async () => {
            const repo = createInMemoryRepository();

            await repo.put({
                hash: 'sha-visual-1',
                dHash: 'D_HASH_001',
                translatedDataUrl: 'data:image/png;base64,DHASH_HIT',
            });

            await expect(repo.getManyByDHash(['d_hash_001', 'missing'])).resolves.toEqual({
                d_hash_001: 'data:image/png;base64,DHASH_HIT',
            });
        });

        test('IDB-v4 consulta center-crop no fallback em memoria', async () => {
            const repo = createInMemoryRepository();
            const fingerprintApi = {
                matchPerceptualHashes: jest.fn((queryW, queryP, entryW, entryP) => ({
                    match: queryW === entryW && queryP === entryP,
                    confidence: 1,
                    reason: 'both_match',
                    wDist: 0,
                    pDist: 0,
                })),
            };

            await repo.put({
                hash: 'sha-crop-1',
                wHashCrop: 'WHASH_CROP_001',
                pHashCrop: 'PHASH_CROP_001',
                regionalHashes: { topLeft: 'tl' },
                translatedDataUrl: 'data:image/png;base64,CROP_HIT',
            });

            await expect(
                repo.getManyByPerceptualCrop(['whash_crop_001'], ['phash_crop_001'], fingerprintApi)
            ).resolves.toEqual({
                'whash_crop_001:phash_crop_001': expect.objectContaining({
                    translatedDataUrl: 'data:image/png;base64,CROP_HIT',
                    confidence: 1,
                    reason: 'both_match_crop',
                    regionalHashes: { topLeft: 'tl' },
                }),
            });
            expect(fingerprintApi.matchPerceptualHashes).toHaveBeenCalledWith(
                'whash_crop_001',
                'phash_crop_001',
                'whash_crop_001',
                'phash_crop_001'
            );
        });
    });

    describe('createIndexedDbRepository()', () => {
        test('IDB-14/IDB-17 opera com fake-indexeddb como o repositorio em memoria e usa readonly em getMany', async () => {
            const factory = new IDBFactory();
            const repo = createIndexedDbRepository({
                indexedDbFactory: factory,
                dbName: uniqueDbName('gtc-real'),
            });

            await repo.putMany([
                { hash: 'hash-1', translatedDataUrl: 'data:1' },
                { hash: 'hash-2', translatedDataUrl: 'data:2' },
            ]);

            await expect(repo.getMany(['hash-1', 'hash-2', 'missing'])).resolves.toEqual({
                'hash-1': 'data:1',
                'hash-2': 'data:2',
            });
            await expect(repo.stats()).resolves.toEqual({ count: 2 });

            await repo.clear();
            await expect(repo.getMany(['hash-1', 'hash-2'])).resolves.toEqual({});
        });

        test('IDB-13 persiste updatedAt no registro salvo', async () => {
            const now = () => 1700000000000;
            const factory = new IDBFactory();
            const dbName = uniqueDbName('gtc-updated-at');
            const repo = createIndexedDbRepository({
                indexedDbFactory: factory,
                dbName,
                now,
            });

            await repo.put({
                hash: 'time-hash',
                translatedDataUrl: 'data:image/png;base64,TIME',
                cleanUrl: 'https://reader.test/time.png',
                width: 1200,
                height: 1800,
            });

            const db = await openDb(factory, dbName);
            const tx = db.transaction('translations', 'readonly');
            const store = tx.objectStore('translations');
            const entry = await requestToPromise(store.get('time-hash'));

            expect(entry.updatedAt).toBe(now());
            expect(entry.cleanUrl).toBe('https://reader.test/time.png');
            expect(entry.width).toBe(1200);
            expect(entry.height).toBe(1800);
        });

        test('IDB-v4 deleteByCleanUrl remove entradas pelo cursor no IndexedDB real', async () => {
            const factory = new IDBFactory();
            const repo = createIndexedDbRepository({
                indexedDbFactory: factory,
                dbName: uniqueDbName('gtc-delete-clean-url'),
            });

            await repo.putMany([
                {
                    hash: 'sha-delete-1',
                    translatedDataUrl: 'data:delete-1',
                    cleanUrl: 'https://reader.test/wrong.png',
                },
                {
                    hash: 'sha-delete-2',
                    translatedDataUrl: 'data:delete-2',
                    cleanUrl: 'https://reader.test/wrong.png',
                },
                {
                    hash: 'sha-keep',
                    translatedDataUrl: 'data:keep',
                    cleanUrl: 'https://reader.test/keep.png',
                },
            ]);

            await expect(repo.deleteByCleanUrl('https://reader.test/wrong.png')).resolves.toEqual({ deleted: 2 });
            await expect(repo.getMany(['sha-delete-1', 'sha-delete-2', 'sha-keep'])).resolves.toEqual({
                'sha-keep': 'data:keep',
            });
            await expect(repo.stats()).resolves.toEqual({ count: 1 });
        });

        test('IDB-15 faz fallback transparente para memoria quando indexedDB nao existe', async () => {
            const repo = createIndexedDbRepository({ indexedDbFactory: null });

            await repo.put({ hash: 'fallback', translatedDataUrl: 'data:fallback' });

            await expect(repo.getMany(['fallback'])).resolves.toEqual({
                fallback: 'data:fallback',
            });
        });

        test('IDB-16 promove a falha definitiva apos tres erros consecutivos de abertura', async () => {
            const failingFactory = createFailingIndexedDbFactory();
            const repo = createIndexedDbRepository({
                indexedDbFactory: failingFactory,
                dbName: uniqueDbName('gtc-open-fail'),
            });

            await expect(repo.getMany(['hash'])).rejects.toThrow('boom-1');
            await expect(repo.getMany(['hash'])).rejects.toThrow('boom-2');
            await expect(repo.getMany(['hash'])).rejects.toThrow('boom-3');
            await expect(repo.getMany(['hash'])).rejects.toThrow(
                'IndexedDB falhou após 3 tentativas: boom-3'
            );
            expect(failingFactory.attempts).toBe(3);
        });

        test('IDB-18 rejeita put quando uma transaction readwrite e abortada', async () => {
            const abortingFactory = createAbortingReadwriteFactory();
            const repo = createIndexedDbRepository({
                indexedDbFactory: abortingFactory,
                dbName: uniqueDbName('gtc-tx-abort'),
            });

            await expect(repo.put({
                hash: 'tx-abort',
                translatedDataUrl: 'data:image/png;base64,ABORT',
            })).rejects.toThrow('tx aborted');

            expect(abortingFactory.db.transaction).toHaveBeenCalledWith('translations', 'readwrite');
            expect(abortingFactory.store.put).toHaveBeenCalledWith(expect.objectContaining({
                hash: 'tx-abort',
                translatedDataUrl: 'data:image/png;base64,ABORT',
            }));
        });

        test('IDB-19 compartilha a mesma abertura de banco em chamadas concorrentes', async () => {
            const factory = new IDBFactory();
            const openSpy = jest.spyOn(factory, 'open');
            const repo = createIndexedDbRepository({
                indexedDbFactory: factory,
                dbName: uniqueDbName('gtc-concurrent-open'),
            });

            const results = await Promise.all([
                repo.getMany(['hash-1']),
                repo.getMany(['hash-2']),
                repo.getMany(['hash-3']),
                repo.getMany(['hash-4']),
                repo.getMany(['hash-5']),
            ]);

            expect(results).toEqual([{}, {}, {}, {}, {}]);
            expect(openSpy).toHaveBeenCalledTimes(1);
        });

        test('IDB-v2 consulta por dHash no indice secundario by_dhash', async () => {
            const factory = new IDBFactory();
            const repo = createIndexedDbRepository({
                indexedDbFactory: factory,
                dbName: uniqueDbName('gtc-dhash'),
            });

            await repo.put({
                hash: 'sha-dhash-1',
                dHash: 'AABBCCDDEEFF0011',
                translatedDataUrl: 'data:image/png;base64,DHASH_INDEX_HIT',
            });

            await expect(repo.getManyByDHash(['aabbccddeeff0011', 'not-found'])).resolves.toEqual({
                aabbccddeeff0011: 'data:image/png;base64,DHASH_INDEX_HIT',
            });
        });

        test('IDB-v3 consulta perceptual por wHash/pHash exato e por varredura aproximada', async () => {
            const factory = new IDBFactory();
            const repo = createIndexedDbRepository({
                indexedDbFactory: factory,
                dbName: uniqueDbName('gtc-perceptual'),
            });
            const fingerprintApi = {
                matchPerceptualHashes: jest.fn((queryWHash, queryPHash, entryWHash, entryPHash) => {
                    const exact = queryWHash === entryWHash && queryPHash === entryPHash;
                    const scanHit = queryWHash === 'whash-scan' && entryWHash === 'whash-near-entry';
                    return {
                        match: exact || scanHit,
                        confidence: scanHit ? 0.82 : 1,
                        reason: scanHit ? 'hamming_near' : 'exact',
                        wDist: scanHit ? 12 : 0,
                        pDist: scanHit ? 18 : 0,
                    };
                }),
            };

            await repo.putMany([
                {
                    hash: 'sha-perceptual-exact',
                    wHash: 'whash-exact',
                    pHash: 'phash-exact',
                    translatedDataUrl: 'data:image/png;base64,EXACT_HIT',
                },
                {
                    hash: 'sha-perceptual-scan',
                    wHash: 'whash-near-entry',
                    pHash: 'phash-near-entry',
                    translatedDataUrl: 'data:image/png;base64,SCAN_HIT',
                },
            ]);

            await expect(
                repo.getManyByPerceptual(['whash-exact'], ['phash-exact'], fingerprintApi)
            ).resolves.toEqual({
                'whash-exact': expect.objectContaining({
                    translatedDataUrl: 'data:image/png;base64,EXACT_HIT',
                    confidence: 1,
                    reason: 'whash_exact',
                }),
            });

            await expect(
                repo.getManyByPerceptual(['whash-scan'], ['phash-scan'], fingerprintApi)
            ).resolves.toEqual({
                'whash-scan:phash-scan': expect.objectContaining({
                    translatedDataUrl: 'data:image/png;base64,SCAN_HIT',
                    confidence: 0.82,
                    reason: 'hamming_near_scan',
                    wDist: 12,
                    pDist: 18,
                }),
            });
        });

        test('IDB-v4 cria indices crop e consulta wHashCrop/pHashCrop pelo IndexedDB real', async () => {
            const factory = new IDBFactory();
            const dbName = uniqueDbName('gtc-crop-v4');
            const repo = createIndexedDbRepository({
                indexedDbFactory: factory,
                dbName,
            });
            const fingerprintApi = {
                matchPerceptualHashes: jest.fn((queryW, queryP, entryW, entryP) => ({
                    match: queryW === entryW && queryP === entryP,
                    confidence: 1,
                    reason: 'crop_exact',
                    wDist: 0,
                    pDist: 0,
                })),
            };

            await repo.put({
                hash: 'sha-idb-crop',
                wHashCrop: 'WHASH_IDB_CROP',
                pHashCrop: 'PHASH_IDB_CROP',
                translatedDataUrl: 'data:image/png;base64,IDB_CROP',
            });

            const db = await openDb(factory, dbName);
            expect(db.version).toBe(4);
            const tx = db.transaction('translations', 'readonly');
            const store = tx.objectStore('translations');
            expect(Array.from(store.indexNames)).toEqual(expect.arrayContaining([
                'by_whash_crop',
                'by_phash_crop',
            ]));

            await expect(
                repo.getManyByPerceptualCrop(['whash_idb_crop'], ['phash_idb_crop'], fingerprintApi)
            ).resolves.toEqual({
                whash_idb_crop: expect.objectContaining({
                    translatedDataUrl: 'data:image/png;base64,IDB_CROP',
                    confidence: 1,
                    reason: 'whash_crop_exact',
                }),
            });
        });
    });

    describe('createGtcRuntimeHandler()', () => {
        test('IDB-20/IDB-21/IDB-22/IDB-24/IDB-25/IDB-26/IDB-28 respondem aos handlers validos com payload esperado', async () => {
            const repo = createInMemoryRepository();
            const handler = createGtcRuntimeHandler({ repository: repo });

            const save = await callHandler(handler, {
                action: 'GTC_SAVE',
                hash: 'ABC',
                translatedDataUrl: 'data:image/png;base64,ABC',
                cleanUrl: 'https://reader.test/001.png',
                width: 800,
                height: 1200,
            });
            expect(save.returned).toBe(true);
            expect(save.response).toEqual(expect.objectContaining({
                ok: true,
                saved: true,
                durationMs: expect.any(Number),
            }));

            const query = await callHandler(handler, {
                action: 'GTC_QUERY_MANY',
                hashes: ['abc', 'missing'],
            });
            expect(query.response).toEqual(expect.objectContaining({
                ok: true,
                entriesByHash: {
                    abc: 'data:image/png;base64,ABC',
                },
            }));

            const stats = await callHandler(handler, { action: 'GTC_STATS' });
            expect(stats.response).toEqual(expect.objectContaining({
                ok: true,
                stats: { count: 1 },
            }));

            const clear = await callHandler(handler, { action: 'GTC_CLEAR_ALL' });
            expect(clear.response).toEqual(expect.objectContaining({
                ok: true,
                cleared: true,
            }));
        });

        test('IDB-v4 runtime GTC_DELETE_BY_CLEAN_URL limpa uma imagem especifica para permitir refazer traducao', async () => {
            const repo = createInMemoryRepository();
            const handler = createGtcRuntimeHandler({ repository: repo });

            await callHandler(handler, {
                action: 'GTC_SAVE',
                hash: 'wrong',
                translatedDataUrl: 'data:wrong',
                cleanUrl: 'https://reader.test/wrong.png',
            });
            await callHandler(handler, {
                action: 'GTC_SAVE',
                hash: 'keep',
                translatedDataUrl: 'data:keep',
                cleanUrl: 'https://reader.test/keep.png',
            });

            const remove = await callHandler(handler, {
                action: 'GTC_DELETE_BY_CLEAN_URL',
                cleanUrl: 'https://reader.test/wrong.png',
            });
            expect(remove.returned).toBe(true);
            expect(remove.response).toEqual(expect.objectContaining({
                ok: true,
                deleted: 1,
                durationMs: expect.any(Number),
            }));

            const query = await callHandler(handler, {
                action: 'GTC_QUERY_MANY',
                hashes: ['wrong', 'keep'],
            });
            expect(query.response.entriesByHash).toEqual({
                keep: 'data:keep',
            });
        });

        test('IDB-23 responde saved:false quando GTC_SAVE chega sem hash valido', async () => {
            const handler = createGtcRuntimeHandler({ repository: createInMemoryRepository() });

            const result = await callHandler(handler, {
                action: 'GTC_SAVE',
                hash: null,
                translatedDataUrl: 'data:image/png;base64,NOHASH',
            });

            expect(result.response).toEqual(expect.objectContaining({
                ok: true,
                saved: false,
                durationMs: expect.any(Number),
            }));
        });

        test('IDB-27 retorna false para acao desconhecida sem responder', async () => {
            const handler = createGtcRuntimeHandler({ repository: createInMemoryRepository() });
            const result = await callHandler(handler, { action: 'FOOBAR' });

            expect(result).toEqual({ returned: false, response: undefined });
        });

        test('IDB-29 retorna um no-op quando repository nao existe', () => {
            const handler = createGtcRuntimeHandler({ repository: null });
            expect(handler({ action: 'GTC_STATS' }, {}, jest.fn())).toBe(false);
        });

        test('IDB-30 converte erro interno do repositorio em resposta ok:false e faz log', async () => {
            const logger = jest.fn();
            const handler = createGtcRuntimeHandler({
                repository: {
                    getMany: jest.fn().mockRejectedValue(new Error('repo exploded')),
                },
                logger,
            });

            const result = await callHandler(handler, {
                action: 'GTC_QUERY_MANY',
                hashes: ['abc'],
            });

            expect(result.response).toEqual({
                ok: false,
                error: 'repo exploded',
            });
            expect(logger).toHaveBeenCalledWith(
                'error',
                'GTC_IDB_ERROR',
                'Falha no IndexedDB para GTC_QUERY_MANY',
                { error: 'repo exploded' }
            );
        });

        test('IDB-v4 runtime responde crop e relaxed usando handlers reais', async () => {
            const repo = createInMemoryRepository();
            const fingerprintApi = {
                matchPerceptualHashes: jest.fn((queryW, queryP, entryW, entryP) => ({
                    match: queryW === entryW && queryP === entryP,
                    confidence: 1,
                    reason: 'strict_exact',
                    wDist: 0,
                    pDist: 0,
                })),
                matchPerceptualHashesRelaxed: jest.fn((queryW, queryP, entryW, entryP) => ({
                    match: queryW === entryW && queryP === entryP,
                    confidence: 0.75,
                    reason: 'relaxed_exact',
                    wDist: 44,
                    pDist: 40,
                })),
            };
            const handler = createGtcRuntimeHandler({ repository: repo, fingerprintApi });

            await callHandler(handler, {
                action: 'GTC_SAVE',
                hash: 'sha-v4-runtime',
                translatedDataUrl: 'data:image/png;base64,V4_RUNTIME',
                wHash: 'WHASH_MAIN',
                pHash: 'PHASH_MAIN',
                wHashCrop: 'WHASH_CROP',
                pHashCrop: 'PHASH_CROP',
                fingerprintVersion: 'visual-v4',
            });

            const crop = await callHandler(handler, {
                action: 'GTC_QUERY_BY_PERCEPTUAL_CROP',
                wHashesCrop: ['whash_crop'],
                pHashesCrop: ['phash_crop'],
            });
            expect(crop.returned).toBe(true);
            expect(crop.response).toEqual(expect.objectContaining({
                ok: true,
                entriesByPerceptualCrop: {
                    'whash_crop:phash_crop': expect.objectContaining({
                        translatedDataUrl: 'data:image/png;base64,V4_RUNTIME',
                        reason: 'strict_exact_crop',
                    }),
                },
            }));

            const relaxed = await callHandler(handler, {
                action: 'GTC_QUERY_BY_PERCEPTUAL_RELAXED',
                wHashes: ['whash_main'],
                pHashes: ['phash_main'],
            });
            expect(relaxed.response).toEqual(expect.objectContaining({
                ok: true,
                entriesByPerceptualRelaxed: {
                    'whash_main:phash_main': expect.objectContaining({
                        translatedDataUrl: 'data:image/png;base64,V4_RUNTIME',
                        confidence: 0.75,
                        reason: 'relaxed_exact',
                    }),
                },
            }));
            expect(fingerprintApi.matchPerceptualHashesRelaxed).toHaveBeenCalled();
        });
    });
});
