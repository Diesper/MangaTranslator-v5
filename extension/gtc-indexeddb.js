'use strict';

(function attachGtcIndexedDbApi(rootScope) {
    const DB_NAME    = 'manga_translator_gtc';
    const STORE_NAME = 'translations';

    // v2: campo dHash + índice by_dhash
    // v3: campos wHash, pHash, regionalHashes + índices by_whash, by_phash
    //     Upgrade v2→v3: apenas cria novos índices (dados existentes preservados)
    // v4: campos wHashCrop, pHashCrop + índices by_whash_crop, by_phash_crop
    const DB_VERSION = 4;

    function normalizeHash(hash) {
        return typeof hash === 'string' ? hash.trim().toLowerCase() : '';
    }

    function cloneValue(value) {
        if (value === null || value === undefined) return value;
        return JSON.parse(JSON.stringify(value));
    }

    function requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror  = () => reject(request.error || new Error('IndexedDB request failed'));
        });
    }

    function transactionToPromise(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error || new Error('IndexedDB transaction failed'));
            tx.onabort    = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        });
    }

    // ── Evidência contraditória ──────────────────────────────────────────────
    // A regra combinada aceita o match quando UM dos hashes bate, mesmo que o
    // outro esteja além do próprio limite de rejeição. Com os dois hashes
    // disponíveis isso é evidência contraditória — os dois vêm da MESMA imagem,
    // então um deles estar em outro universo indica colisão, não semelhança.
    // Nas consultas correlacionadas esse caso é vetado.
    function _hasContradictoryEvidence(decision, fpApi, relaxed) {
        if (!decision) return false;
        const wDist = decision.wDist;
        const pDist = decision.pDist;
        if (!(wDist >= 0) || !(pDist >= 0)) return false; // só vale com os dois
        const wReject = (relaxed ? fpApi.WHASH_REJECT_THRESHOLD_RELAXED : fpApi.WHASH_REJECT_THRESHOLD) || (relaxed ? 90 : 80);
        const pReject = (relaxed ? fpApi.PHASH_REJECT_THRESHOLD_RELAXED : fpApi.PHASH_REJECT_THRESHOLD) || (relaxed ? 82 : 70);
        return wDist > wReject || pDist > pReject;
    }

    function _isAspectCompatible(entry, queryWidth, queryHeight) {
        if (!entry.width || !entry.height || !queryWidth || !queryHeight) return true; // can't validate, allow
        const eRatio = entry.width / entry.height;
        const qRatio = queryWidth / queryHeight;
        return Math.abs(eRatio - qRatio) / Math.max(eRatio, qRatio) < 0.20; // 20% tolerance
    }

    // ─────────────────────────────────────────────────────────────────────────
    // In-Memory Repository (fallback quando IndexedDB não está disponível)
    // ─────────────────────────────────────────────────────────────────────────

    function createInMemoryRepository(now = () => Date.now()) {
        const store = new Map();

        return {
            async getMany(hashes) {
                const result = {};
                Array.from(new Set(hashes.map(normalizeHash).filter(Boolean))).forEach(hash => {
                    const entry = store.get(hash);
                    if (entry && entry.translatedDataUrl) result[hash] = entry.translatedDataUrl;
                });
                return result;
            },

            async getManyByDHash(dHashes) {
                const result  = {};
                const dHashSet = new Set(dHashes.map(normalizeHash).filter(Boolean));
                if (dHashSet.size === 0) return result;
                for (const [, entry] of store) {
                    if (entry.dHash && dHashSet.has(normalizeHash(entry.dHash)) && entry.translatedDataUrl) {
                        result[normalizeHash(entry.dHash)] = entry.translatedDataUrl;
                    }
                }
                return result;
            },

            // ── Lookup perceptual combinado wHash + pHash (visual-v3) ────────
            // Usa matchPerceptualHashes da API gtc-fingerprint para decisão.
            // O resultado inclui a imagem traduzida E o score de confiança para
            // que o content script possa aplicar confirmação regional opcional.
            async getManyByPerceptual(wHashes, pHashes, fpApi) {
                const result   = {};
                const wHashSet = new Set((wHashes || []).map(normalizeHash).filter(Boolean));
                const pHashSet = new Set((pHashes  || []).map(normalizeHash).filter(Boolean));

                for (const [, entry] of store) {
                    if (!entry.translatedDataUrl) continue;

                    const entryWHash = normalizeHash(entry.wHash || '');
                    const entryPHash = normalizeHash(entry.pHash || '');

                    for (const queryWHash of wHashSet) {
                        for (const queryPHash of pHashSet) {
                            if (!fpApi || typeof fpApi.matchPerceptualHashes !== 'function') continue;
                            const decision = fpApi.matchPerceptualHashes(queryWHash, queryPHash, entryWHash, entryPHash);
                            if (decision.match) {
                                // Chave de resultado: wHash da query (o caller sabe qual query usou)
                                const resultKey = `${queryWHash}:${queryPHash}`;
                                if (!result[resultKey] || decision.confidence > (result[resultKey].confidence || 0)) {
                                    result[resultKey] = {
                                        translatedDataUrl: entry.translatedDataUrl,
                                        confidence:        decision.confidence,
                                        reason:            decision.reason,
                                        wDist:             decision.wDist,
                                        pDist:             decision.pDist,
                                        regionalHashes:    entry.regionalHashes || null,
                                    };
                                }
                            }
                        }
                    }
                }
                return result;
            },

            async getManyByPerceptualCrop(wHashesCrop, pHashesCrop, fpApi) {
                const result   = {};
                const wHashSet = new Set((wHashesCrop || []).map(normalizeHash).filter(Boolean));
                const pHashSet = new Set((pHashesCrop || []).map(normalizeHash).filter(Boolean));

                if (!fpApi || typeof fpApi.matchPerceptualHashes !== 'function') return result;

                for (const [, entry] of store) {
                    if (!entry.translatedDataUrl || (!entry.wHashCrop && !entry.pHashCrop)) continue;

                    const entryWHashCrop = normalizeHash(entry.wHashCrop || '');
                    const entryPHashCrop = normalizeHash(entry.pHashCrop || '');

                    for (const queryWHashCrop of wHashSet) {
                        for (const queryPHashCrop of pHashSet) {
                            const decision = fpApi.matchPerceptualHashes(
                                queryWHashCrop,
                                queryPHashCrop,
                                entryWHashCrop,
                                entryPHashCrop
                            );
                            if (decision.match) {
                                const resultKey = `${queryWHashCrop}:${queryPHashCrop}`;
                                if (!result[resultKey] || decision.confidence > (result[resultKey].confidence || 0)) {
                                    result[resultKey] = {
                                        translatedDataUrl: entry.translatedDataUrl,
                                        confidence:        decision.confidence,
                                        reason:            `${decision.reason}_crop`,
                                        wDist:             decision.wDist,
                                        pDist:             decision.pDist,
                                        regionalHashes:    entry.regionalHashes || null,
                                    };
                                }
                            }
                        }
                    }
                }
                return result;
            },

            // ── queryPerceptual (v5.1.1) — consultas CORRELACIONADAS ────────
            // A API antiga recebia duas listas independentes (wHashes, pHashes)
            // e fazia produto cruzado: o wHash da página A podia ser combinado
            // com o pHash da página B, devolvendo a tradução errada.
            // Agora cada consulta carrega o SEU par, e o resultado é indexado
            // por queryId — nunca por hash isolado.
            async queryPerceptual(queries, fpApi, options = {}) {
                const mode = options.mode || 'strict';
                if (!fpApi) return {};
                const matcher = (mode === 'relaxed' && typeof fpApi.matchPerceptualHashesRelaxed === 'function')
                    ? fpApi.matchPerceptualHashesRelaxed.bind(fpApi)
                    : (typeof fpApi.matchPerceptualHashes === 'function' ? fpApi.matchPerceptualHashes.bind(fpApi) : null);
                if (!matcher) return {};

                const useCrop = mode === 'crop';
                const wField = useCrop ? 'wHashCrop' : 'wHash';
                const pField = useCrop ? 'pHashCrop' : 'pHash';

                const norm = (queries || []).map(q => ({
                    queryId: q && q.queryId,
                    wHash:   normalizeHash((q && q.wHash) || ''),
                    pHash:   normalizeHash((q && q.pHash) || ''),
                    width:   (q && q.width)  || 0,
                    height:  (q && q.height) || 0,
                })).filter(q => q.queryId !== undefined && q.queryId !== null && (q.wHash || q.pHash));

                const result = {};
                for (const [, entry] of store) {
                    if (!entry || !entry.translatedDataUrl) continue;
                    const entryW = normalizeHash(entry[wField] || '');
                    const entryP = normalizeHash(entry[pField] || '');
                    if (!entryW && !entryP) continue;

                    for (const q of norm) {
                        if (!_isAspectCompatible(entry, q.width, q.height)) continue;
                        const decision = matcher(q.wHash, q.pHash, entryW, entryP);
                        if (!decision.match) continue;
                        if (_hasContradictoryEvidence(decision, fpApi, mode === 'relaxed')) continue;
                        const prev = result[q.queryId];
                        if (!prev || decision.confidence > (prev.confidence || 0)) {
                            result[q.queryId] = {
                                translatedDataUrl: entry.translatedDataUrl,
                                confidence:        decision.confidence,
                                reason:            decision.reason + (useCrop ? '_crop' : ''),
                                wDist:             decision.wDist,
                                pDist:             decision.pDist,
                                regionalHashes:    entry.regionalHashes || null,
                            };
                        }
                    }
                }
                return result;
            },

            async put(entry) {
                const hash = normalizeHash(entry && entry.hash);
                if (!hash || !entry || !entry.translatedDataUrl) return { saved: false };

                store.set(hash, {
                    hash,
                    translatedDataUrl:  entry.translatedDataUrl,
                    dHash:              entry.dHash              || null,
                    wHash:              entry.wHash              || null,
                    pHash:              entry.pHash              || null,
                    wHashCrop:          entry.wHashCrop          || null,
                    pHashCrop:          entry.pHashCrop          || null,
                    regionalHashes:     entry.regionalHashes     || null,
                    cleanUrl:           entry.cleanUrl           || null,
                    width:              entry.width              || 0,
                    height:             entry.height             || 0,
                    fingerprintVersion: entry.fingerprintVersion || 'visual-v3',
                    mimeType:           entry.mimeType           || null,
                    updatedAt:          now(),
                });
                return { saved: true };
            },

            async putMany(entries) {
                for (const entry of entries || []) await this.put(entry);
                return { saved: true, count: Array.isArray(entries) ? entries.length : 0 };
            },

            async deleteByCleanUrl(cleanUrl) {
                const target = cleanUrl ? String(cleanUrl) : '';
                if (!target) return { deleted: 0 };
                let deleted = 0;
                for (const [hash, entry] of Array.from(store.entries())) {
                    if (entry && entry.cleanUrl === target) {
                        store.delete(hash);
                        deleted++;
                    }
                }
                return { deleted };
            },

            async clear() { store.clear(); },

            async stats() { return { count: store.size }; },
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // IndexedDB Repository
    //
    // Schema v3:
    //   store 'translations'
    //     keyPath: 'hash'  (SHA-256 do fingerprint visual)
    //     index 'updatedAt'    (limpeza por data)
    //     index 'by_dhash'     (v2: lookup dHash perceptual)
    //     index 'by_whash'     (v3 novo: lookup wHash Haar Wavelet)
    //     index 'by_phash'     (v3 novo: lookup pHash DCT)
    //
    // Campos adicionados em v3:
    //   wHash          string?  wHash 64-hex (256-bit, visual-v3)
    //   pHash          string?  pHash 64-hex (256-bit, visual-v3)
    //   regionalHashes object?  { topLeft, topRight, bottomLeft, bottomRight } — cada 16-hex
    //
    // Entradas v1/v2 sem wHash/pHash continuam funcionando:
    //   os índices by_whash e by_phash simplesmente não as indexam (valor null)
    //
    // Nota sobre lookup perceptual no IndexedDB:
    //   Os índices by_whash e by_phash permitem buscas por hash exato (O(log n)).
    //   Para matching aproximado (Hamming ≤ threshold), o caller deve:
    //     1. Buscar pelo hash exato primeiro (IDB index.get)
    //     2. Se não encontrar: usar cursor para varredura com filtro Hamming
    //        (O(n) — mas o banco raramente tem >1000 entradas em uso real)
    //   Esta é a aproximação prática: buscas exatas são O(log n) e cobrem o caso
    //   comum (mesma versão de scanlation), varredura linear cobre cross-language.
    // ─────────────────────────────────────────────────────────────────────────

    function createIndexedDbRepository({ indexedDbFactory, dbName = DB_NAME, now = () => Date.now() } = {}) {
        const indexedDBRef = indexedDbFactory || rootScope.indexedDB;
        if (!indexedDBRef || typeof indexedDBRef.open !== 'function') {
            return createInMemoryRepository(now);
        }

        let dbPromise = null;
        let _dbOpenAttempts = 0;
        const _DB_MAX_RETRIES = 3;

        function openDb() {
            if (dbPromise) return dbPromise;

            dbPromise = new Promise((resolve, reject) => {
                const request = indexedDBRef.open(dbName, DB_VERSION);

                request.onupgradeneeded = (event) => {
                    const db         = request.result;
                    const oldVersion = event.oldVersion;

                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        // Instalação limpa em v3
                        const s = db.createObjectStore(STORE_NAME, { keyPath: 'hash' });
                        s.createIndex('updatedAt', 'updatedAt', { unique: false });
                        s.createIndex('by_dhash',  'dHash',     { unique: false });
                        s.createIndex('by_whash',  'wHash',     { unique: false });
                        s.createIndex('by_phash',  'pHash',     { unique: false });
                        s.createIndex('by_whash_crop', 'wHashCrop', { unique: false });
                        s.createIndex('by_phash_crop', 'pHashCrop', { unique: false });
                    } else {
                        const existingStore = event.target.transaction.objectStore(STORE_NAME);

                        if (oldVersion < 2) {
                            // v1 → v2
                            if (!existingStore.indexNames.contains('by_dhash')) {
                                existingStore.createIndex('by_dhash', 'dHash', { unique: false });
                            }
                        }

                        if (oldVersion < 3) {
                            // v2 → v3: adicionar índices wHash e pHash
                            if (!existingStore.indexNames.contains('by_whash')) {
                                existingStore.createIndex('by_whash', 'wHash', { unique: false });
                            }
                            if (!existingStore.indexNames.contains('by_phash')) {
                                existingStore.createIndex('by_phash', 'pHash', { unique: false });
                            }
                        }

                        if (oldVersion < 4) {
                            if (!existingStore.indexNames.contains('by_whash_crop')) {
                                existingStore.createIndex('by_whash_crop', 'wHashCrop', { unique: false });
                            }
                            if (!existingStore.indexNames.contains('by_phash_crop')) {
                                existingStore.createIndex('by_phash_crop', 'pHashCrop', { unique: false });
                            }
                        }
                    }
                };

                request.onsuccess = () => {
                    _dbOpenAttempts = 0;
                    resolve(request.result);
                };

                request.onerror = () => {
                    const err = request.error || new Error('Failed to open IndexedDB');
                    dbPromise = null;
                    _dbOpenAttempts++;
                    if (_dbOpenAttempts >= _DB_MAX_RETRIES) {
                        dbPromise = Promise.reject(
                            new Error(`IndexedDB falhou após ${_DB_MAX_RETRIES} tentativas: ${err.message}`)
                        );
                    }
                    reject(err);
                };
            });

            return dbPromise;
        }

        async function withStore(mode, work) {
            const db    = await openDb();
            const tx    = db.transaction(STORE_NAME, mode);
            const store = tx.objectStore(STORE_NAME);
            const result = await work(store, tx);
            await transactionToPromise(tx);
            return result;
        }

        return {
            // ── SHA-256 lookup (chave primária) ──────────────────────────────
            async getMany(hashes) {
                const uniqueHashes = Array.from(new Set((hashes || []).map(normalizeHash).filter(Boolean)));
                if (uniqueHashes.length === 0) return {};

                return withStore('readonly', async (store) => {
                    const result = {};
                    await Promise.all(uniqueHashes.map(async hash => {
                        const entry = await requestToPromise(store.get(hash));
                        if (entry && entry.translatedDataUrl) result[hash] = entry.translatedDataUrl;
                    }));
                    return result;
                });
            },

            // ── dHash lookup (índice by_dhash, hash exato) ───────────────────
            async getManyByDHash(dHashes) {
                const uniqueDHashes = Array.from(new Set((dHashes || []).map(normalizeHash).filter(Boolean)));
                if (uniqueDHashes.length === 0) return {};

                return withStore('readonly', async (store) => {
                    const result = {};
                    const index  = store.index('by_dhash');
                    await Promise.all(uniqueDHashes.map(async dHash => {
                        const entry = await requestToPromise(index.get(dHash));
                        if (entry && entry.translatedDataUrl) {
                            result[dHash] = entry.translatedDataUrl;
                        }
                    }));
                    return result;
                });
            },

            // ── wHash + pHash lookup combinado (visual-v3) ───────────────────
            //
            // Estratégia em 2 fases:
            //   Fase 1 (rápida, O(log n)): busca por hash exato nos índices by_whash e by_phash
            //   Fase 2 (varredura, O(n)):  se fase 1 falhar, percorre o cursor com filtro Hamming
            //
            // A fase 2 é necessária para matching cross-language:
            //   ex: scanlação PT-BR tem wHash ligeiramente diferente da EN,
            //   mas ainda dentro do threshold (Hamming ≤ 40 bits de 256)
            //
            // O fpApi (MangaTranslatorGtcFingerprint) é passado pelo SW via
            // GTC_QUERY_BY_PERCEPTUAL para que matchPerceptualHashes seja invocado
            // sem reimplementar a lógica de thresholds aqui.
            async getManyByPerceptual(wHashes, pHashes, fpApi) {
                const normWHashes = Array.from(new Set((wHashes || []).map(normalizeHash).filter(Boolean)));
                const normPHashes = Array.from(new Set((pHashes  || []).map(normalizeHash).filter(Boolean)));

                if (normWHashes.length === 0 && normPHashes.length === 0) return {};
                if (!fpApi || typeof fpApi.matchPerceptualHashes !== 'function') return {};

                return withStore('readonly', async (store) => {
                    const result = {};

                    // ── Fase 1: Lookup por hash exato ────────────────────────
                    // Tenta wHash primeiro (maior discriminação para mangá)
                    const exactHits = new Set();

                    if (normWHashes.length > 0) {
                        const wIdx = store.index('by_whash');
                        await Promise.all(normWHashes.map(async queryWHash => {
                            const entries = await requestToPromise(wIdx.getAll(queryWHash));
                            for (const entry of (entries || [])) {
                                if (!entry || !entry.translatedDataUrl) continue;
                                if (!_isAspectCompatible(entry, undefined, undefined)) continue;
                                
                                // Confirmar com pHash se disponível
                                let confirmed = true;
                                if (normPHashes.length > 0 && entry.pHash && fpApi) {
                                    confirmed = normPHashes.some(queryPHash => {
                                        const d = fpApi.matchPerceptualHashes(
                                            queryWHash, queryPHash, entry.wHash || '', entry.pHash || ''
                                        );
                                        return d.match;
                                    });
                                }
                                if (confirmed) {
                                    const key = queryWHash;
                                    exactHits.add(entry.hash);
                                    if (!result[key] || 1 > (result[key].confidence || 0)) {
                                        result[key] = {
                                            translatedDataUrl: entry.translatedDataUrl,
                                            confidence:        1.0, // hash exato = máxima confiança
                                            reason:            'whash_exact',
                                            wDist:             0,
                                            pDist:             -1,
                                            regionalHashes:    entry.regionalHashes || null,
                                        };
                                    }
                                }
                            }
                        }));
                    }

                    if (normPHashes.length > 0) {
                        const pIdx = store.index('by_phash');
                        await Promise.all(normPHashes.map(async queryPHash => {
                            const entries = await requestToPromise(pIdx.getAll(queryPHash));
                            for (const entry of (entries || [])) {
                                if (!entry || !entry.translatedDataUrl) continue;
                                if (exactHits.has(entry.hash)) continue;
                                if (!_isAspectCompatible(entry, undefined, undefined)) continue;
                                
                                let confirmed = true;
                                if (normWHashes.length > 0 && entry.wHash && fpApi) {
                                    confirmed = normWHashes.some(queryWHash => {
                                        const d = fpApi.matchPerceptualHashes(
                                            queryWHash, queryPHash, entry.wHash || '', entry.pHash || ''
                                        );
                                        return d.match;
                                    });
                                }
                                if (confirmed) {
                                    const key = queryPHash;
                                    exactHits.add(entry.hash);
                                    if (!result[key]) {
                                        result[key] = {
                                            translatedDataUrl: entry.translatedDataUrl,
                                            confidence:        1.0,
                                            reason:            'phash_exact',
                                            wDist:             -1,
                                            pDist:             0,
                                            regionalHashes:    entry.regionalHashes || null,
                                        };
                                    }
                                }
                            }
                        }));
                    }

                    // ── Fase 2: Varredura com Hamming (cross-language) ────────
                    const missingKeys = new Set();
                    for (let i = 0; i < (wHashes || []).length; i++) {
                        const w = normalizeHash(wHashes[i]);
                        const p = normalizeHash((pHashes || [])[i] || '');
                        const exactKeyW = w;
                        const exactKeyP = p;
                        const comboKey = `${w}:${p}`;
                        
                        if (!result[exactKeyW] && !result[exactKeyP] && !result[comboKey]) {
                            missingKeys.add(comboKey);
                        }
                    }

                    if (missingKeys.size > 0) {
                        const cursorRequest = store.openCursor();
                        await new Promise((resolve, reject) => {
                            cursorRequest.onsuccess = (event) => {
                                const cursor = event.target.result;
                                if (!cursor) { resolve(); return; }

                                const entry = cursor.value;
                                if (entry && entry.translatedDataUrl && entry.wHash && entry.pHash) {
                                    if (_isAspectCompatible(entry, undefined, undefined)) {
                                        for (const queryWHash of normWHashes) {
                                            for (const queryPHash of normPHashes) {
                                                const key = `${queryWHash}:${queryPHash}`;
                                                if (!missingKeys.has(key)) continue;
                                                
                                                const decision = fpApi.matchPerceptualHashes(
                                                    queryWHash, queryPHash,
                                                    normalizeHash(entry.wHash),
                                                    normalizeHash(entry.pHash)
                                                );
                                                if (decision.match) {
                                                    if (!result[key] || decision.confidence > (result[key].confidence || 0)) {
                                                        result[key] = {
                                                            translatedDataUrl: entry.translatedDataUrl,
                                                            confidence:        decision.confidence,
                                                            reason:            decision.reason + '_scan',
                                                            wDist:             decision.wDist,
                                                            pDist:             decision.pDist,
                                                            regionalHashes:    entry.regionalHashes || null,
                                                        };
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }

                                cursor.continue();
                            };
                            cursorRequest.onerror = () => reject(cursorRequest.error);
                        });
                    }

                    return result;
                });
            },

            async getManyByPerceptualCrop(wHashesCrop, pHashesCrop, fpApi) {
                const normWHashes = Array.from(new Set((wHashesCrop || []).map(normalizeHash).filter(Boolean)));
                const normPHashes = Array.from(new Set((pHashesCrop || []).map(normalizeHash).filter(Boolean)));

                if (normWHashes.length === 0 && normPHashes.length === 0) return {};
                if (!fpApi || typeof fpApi.matchPerceptualHashes !== 'function') return {};

                return withStore('readonly', async (store) => {
                    const result = {};
                    const exactHits = new Set();

                    if (normWHashes.length > 0) {
                        const wIdx = store.index('by_whash_crop');
                        await Promise.all(normWHashes.map(async queryWHashCrop => {
                            const entries = await requestToPromise(wIdx.getAll(queryWHashCrop));
                            for (const entry of (entries || [])) {
                                if (!entry || !entry.translatedDataUrl) continue;
                                if (!_isAspectCompatible(entry, undefined, undefined)) continue;
                                
                                let confirmed = true;
                                if (normPHashes.length > 0 && entry.pHashCrop) {
                                    confirmed = normPHashes.some(queryPHashCrop => {
                                        const decision = fpApi.matchPerceptualHashes(
                                            queryWHashCrop,
                                            queryPHashCrop,
                                            normalizeHash(entry.wHashCrop || ''),
                                            normalizeHash(entry.pHashCrop || '')
                                        );
                                        return decision.match;
                                    });
                                }
                                if (confirmed) {
                                    exactHits.add(entry.hash);
                                    result[queryWHashCrop] = {
                                        translatedDataUrl: entry.translatedDataUrl,
                                        confidence:        1.0,
                                        reason:            'whash_crop_exact',
                                        wDist:             0,
                                        pDist:             -1,
                                        regionalHashes:    entry.regionalHashes || null,
                                    };
                                }
                            }
                        }));
                    }

                    if (normPHashes.length > 0) {
                        const pIdx = store.index('by_phash_crop');
                        await Promise.all(normPHashes.map(async queryPHashCrop => {
                            const entries = await requestToPromise(pIdx.getAll(queryPHashCrop));
                            for (const entry of (entries || [])) {
                                if (!entry || !entry.translatedDataUrl) continue;
                                if (exactHits.has(entry.hash)) continue;
                                if (!_isAspectCompatible(entry, undefined, undefined)) continue;
                                
                                let confirmed = true;
                                if (normWHashes.length > 0 && entry.wHashCrop) {
                                    confirmed = normWHashes.some(queryWHashCrop => {
                                        const decision = fpApi.matchPerceptualHashes(
                                            queryWHashCrop,
                                            queryPHashCrop,
                                            normalizeHash(entry.wHashCrop || ''),
                                            normalizeHash(entry.pHashCrop || '')
                                        );
                                        return decision.match;
                                    });
                                }
                                if (confirmed) {
                                    exactHits.add(entry.hash);
                                    result[queryPHashCrop] = {
                                        translatedDataUrl: entry.translatedDataUrl,
                                        confidence:        1.0,
                                        reason:            'phash_crop_exact',
                                        wDist:             -1,
                                        pDist:             0,
                                        regionalHashes:    entry.regionalHashes || null,
                                    };
                                }
                            }
                        }));
                    }

                    const missingKeys = new Set();
                    for (let i = 0; i < (wHashesCrop || []).length; i++) {
                        const w = normalizeHash(wHashesCrop[i]);
                        const p = normalizeHash((pHashesCrop || [])[i] || '');
                        const exactKeyW = w;
                        const exactKeyP = p;
                        const comboKey = `${w}:${p}`;
                        
                        if (!result[exactKeyW] && !result[exactKeyP] && !result[comboKey]) {
                            missingKeys.add(comboKey);
                        }
                    }

                    if (missingKeys.size > 0) {
                        const cursorRequest = store.openCursor();
                        await new Promise((resolve, reject) => {
                            cursorRequest.onsuccess = (event) => {
                                const cursor = event.target.result;
                                if (!cursor) { resolve(); return; }

                                const entry = cursor.value;
                                if (entry && entry.translatedDataUrl && entry.wHashCrop && entry.pHashCrop) {
                                    if (_isAspectCompatible(entry, undefined, undefined)) {
                                        for (const queryWHashCrop of normWHashes) {
                                            for (const queryPHashCrop of normPHashes) {
                                                const key = `${queryWHashCrop}:${queryPHashCrop}`;
                                                if (!missingKeys.has(key)) continue;
                                                
                                                const decision = fpApi.matchPerceptualHashes(
                                                    queryWHashCrop,
                                                    queryPHashCrop,
                                                    normalizeHash(entry.wHashCrop),
                                                    normalizeHash(entry.pHashCrop)
                                                );
                                                if (decision.match) {
                                                    if (!result[key] || decision.confidence > (result[key].confidence || 0)) {
                                                        result[key] = {
                                                            translatedDataUrl: entry.translatedDataUrl,
                                                            confidence:        decision.confidence,
                                                            reason:            `${decision.reason}_crop_scan`,
                                                            wDist:             decision.wDist,
                                                            pDist:             decision.pDist,
                                                            regionalHashes:    entry.regionalHashes || null,
                                                        };
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }

                                cursor.continue();
                            };
                            cursorRequest.onerror = () => reject(cursorRequest.error);
                        });
                    }

                    return result;
                });
            },

            // ── queryPerceptual (v5.1.1) — consultas CORRELACIONADAS ────────
            //
            // Corrige três defeitos da API por listas:
            //   1. produto cruzado entre wHash de uma página e pHash de outra;
            //   2. a varredura aproximada só rodava se NENHUMA query do lote
            //      tivesse hit exato — um acerto em A cegava a busca para B;
            //   3. índices não únicos usavam index.get(), que devolve um
            //      candidato arbitrário quando há colisão (agora getAll).
            //
            // Também exige compatibilidade de proporção entre consulta e entrada.
            async queryPerceptual(queries, fpApi, options = {}) {
                const mode = options.mode || 'strict';
                if (!fpApi) return {};
                const matcher = (mode === 'relaxed' && typeof fpApi.matchPerceptualHashesRelaxed === 'function')
                    ? fpApi.matchPerceptualHashesRelaxed.bind(fpApi)
                    : (typeof fpApi.matchPerceptualHashes === 'function' ? fpApi.matchPerceptualHashes.bind(fpApi) : null);
                if (!matcher) return {};

                const useCrop    = mode === 'crop';
                const wField     = useCrop ? 'wHashCrop'     : 'wHash';
                const pField     = useCrop ? 'pHashCrop'     : 'pHash';
                const wIndexName = useCrop ? 'by_whash_crop' : 'by_whash';
                const pIndexName = useCrop ? 'by_phash_crop' : 'by_phash';

                const norm = (queries || []).map(q => ({
                    queryId: q && q.queryId,
                    wHash:   normalizeHash((q && q.wHash) || ''),
                    pHash:   normalizeHash((q && q.pHash) || ''),
                    width:   (q && q.width)  || 0,
                    height:  (q && q.height) || 0,
                })).filter(q => q.queryId !== undefined && q.queryId !== null && (q.wHash || q.pHash));

                if (norm.length === 0) return {};

                return withStore('readonly', async (store) => {
                    const result = {};

                    const consider = (q, entry, decision, suffix) => {
                        if (!decision || !decision.match) return;
                        if (_hasContradictoryEvidence(decision, fpApi, mode === 'relaxed')) return;
                        const prev = result[q.queryId];
                        if (prev && (prev.confidence || 0) >= decision.confidence) return;
                        result[q.queryId] = {
                            translatedDataUrl: entry.translatedDataUrl,
                            confidence:        decision.confidence,
                            reason:            decision.reason + suffix,
                            wDist:             decision.wDist,
                            pDist:             decision.pDist,
                            regionalHashes:    entry.regionalHashes || null,
                        };
                    };

                    // ── Fase 1: hash exato, por consulta (O(log n)) ──────────
                    const wIdx = store.index(wIndexName);
                    const pIdx = store.index(pIndexName);

                    for (const q of norm) {
                        if (q.wHash) {
                            const entries = await requestToPromise(wIdx.getAll(q.wHash));
                            for (const entry of (entries || [])) {
                                if (!entry || !entry.translatedDataUrl) continue;
                                if (!_isAspectCompatible(entry, q.width, q.height)) continue;
                                const entryW = normalizeHash(entry[wField] || '');
                                const entryP = normalizeHash(entry[pField] || '');
                                if (q.pHash && entryP) {
                                    // pHash de AMBOS disponível: exige coerência do par
                                    consider(q, entry, matcher(q.wHash, q.pHash, entryW, entryP), '_exact');
                                } else {
                                    // Sem pHash dos dois lados não há como contradizer
                                    consider(q, entry, { match: true, confidence: 1, reason: 'whash_exact', wDist: 0, pDist: -1 }, '');
                                }
                            }
                        }

                        if (!result[q.queryId] && q.pHash) {
                            const entries = await requestToPromise(pIdx.getAll(q.pHash));
                            for (const entry of (entries || [])) {
                                if (!entry || !entry.translatedDataUrl) continue;
                                if (!_isAspectCompatible(entry, q.width, q.height)) continue;
                                const entryW = normalizeHash(entry[wField] || '');
                                const entryP = normalizeHash(entry[pField] || '');
                                if (q.wHash && entryW) {
                                    consider(q, entry, matcher(q.wHash, q.pHash, entryW, entryP), '_exact');
                                } else {
                                    consider(q, entry, { match: true, confidence: 1, reason: 'phash_exact', wDist: -1, pDist: 0 }, '');
                                }
                            }
                        }
                    }

                    // ── Fase 2: varredura Hamming, SÓ para quem não teve hit ─
                    const pending = norm.filter(q => !result[q.queryId]);
                    if (pending.length === 0) return result;

                    const cursorRequest = store.openCursor();
                    await new Promise((resolve, reject) => {
                        cursorRequest.onsuccess = (event) => {
                            const cursor = event.target.result;
                            if (!cursor) { resolve(); return; }

                            const entry = cursor.value;
                            if (entry && entry.translatedDataUrl) {
                                const entryW = normalizeHash(entry[wField] || '');
                                const entryP = normalizeHash(entry[pField] || '');
                                if (entryW || entryP) {
                                    for (const q of pending) {
                                        if (!_isAspectCompatible(entry, q.width, q.height)) continue;
                                        consider(q, entry, matcher(q.wHash, q.pHash, entryW, entryP), '_scan');
                                    }
                                }
                            }
                            cursor.continue();
                        };
                        cursorRequest.onerror = () => reject(cursorRequest.error);
                    });

                    return result;
                });
            },

            // ── Salvar entrada única ─────────────────────────────────────────
            async put(entry) {
                const hash = normalizeHash(entry && entry.hash);
                if (!hash || !entry || !entry.translatedDataUrl) return { saved: false };

                return withStore('readwrite', async (store) => {
                    store.put({
                        hash,
                        translatedDataUrl:  entry.translatedDataUrl,
                        dHash:              normalizeHash(entry.dHash || '') || null,
                        wHash:              normalizeHash(entry.wHash || '') || null,
                        pHash:              normalizeHash(entry.pHash || '') || null,
                        wHashCrop:          normalizeHash(entry.wHashCrop || '') || null,
                        pHashCrop:          normalizeHash(entry.pHashCrop || '') || null,
                        regionalHashes:     entry.regionalHashes     || null,
                        cleanUrl:           entry.cleanUrl           || null,
                        width:              entry.width              || 0,
                        height:             entry.height             || 0,
                        fingerprintVersion: entry.fingerprintVersion || 'visual-v3',
                        mimeType:           entry.mimeType           || null,
                        updatedAt:          now(),
                    });
                    return { saved: true };
                });
            },

            // ── Salvar múltiplas em uma transação ────────────────────────────
            async putMany(entries) {
                const payload = Array.isArray(entries) ? entries : [];
                return withStore('readwrite', async (store) => {
                    payload.forEach(entry => {
                        const hash = normalizeHash(entry && entry.hash);
                        if (!hash || !entry || !entry.translatedDataUrl) return;
                        store.put({
                            hash,
                            translatedDataUrl:  entry.translatedDataUrl,
                            dHash:              normalizeHash(entry.dHash || '') || null,
                            wHash:              normalizeHash(entry.wHash || '') || null,
                            pHash:              normalizeHash(entry.pHash || '') || null,
                            wHashCrop:          normalizeHash(entry.wHashCrop || '') || null,
                            pHashCrop:          normalizeHash(entry.pHashCrop || '') || null,
                            regionalHashes:     entry.regionalHashes     || null,
                            cleanUrl:           entry.cleanUrl           || null,
                            width:              entry.width              || 0,
                            height:             entry.height             || 0,
                            fingerprintVersion: entry.fingerprintVersion || 'visual-v3',
                            mimeType:           entry.mimeType           || null,
                            updatedAt:          now(),
                        });
                    });
                    return { saved: true, count: payload.length };
                });
            },

            async deleteByCleanUrl(cleanUrl) {
                const target = cleanUrl ? String(cleanUrl) : '';
                if (!target) return { deleted: 0 };

                return withStore('readwrite', async (store) => {
                    let deleted = 0;
                    await new Promise((resolve, reject) => {
                        const cursorRequest = store.openCursor();
                        cursorRequest.onsuccess = (event) => {
                            const cursor = event.target.result;
                            if (!cursor) {
                                resolve();
                                return;
                            }

                            const entry = cursor.value;
                            if (entry && entry.cleanUrl === target) {
                                const deleteRequest = cursor.delete();
                                deleteRequest.onsuccess = () => {
                                    deleted++;
                                    cursor.continue();
                                };
                                deleteRequest.onerror = () => reject(deleteRequest.error);
                                return;
                            }

                            cursor.continue();
                        };
                        cursorRequest.onerror = () => reject(cursorRequest.error);
                    });
                    return { deleted };
                });
            },

            async clear() {
                return withStore('readwrite', async (store) => { store.clear(); });
            },

            async stats() {
                return withStore('readonly', async (store) => {
                    const count = await requestToPromise(store.count());
                    return { count };
                });
            },
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Runtime Handler
    //
    // Actions tratadas:
    //   GTC_QUERY_MANY          lookup SHA-256 (existente)
    //   GTC_QUERY_BY_DHASH      lookup dHash (v2)
    //   GTC_QUERY_BY_PERCEPTUAL lookup wHash+pHash combinado (v3, novo)
    //   GTC_SAVE                salva entrada (aceita wHash, pHash, regionalHashes)
    //   GTC_SAVE_MANY           salva múltiplas
    //   GTC_DELETE_BY_CLEAN_URL remove entradas salvas para uma URL normalizada
    //   GTC_CLEAR_ALL           limpa o cache
    //   GTC_STATS               retorna count
    // ─────────────────────────────────────────────────────────────────────────

    function createGtcRuntimeHandler({ repository, logger = () => {}, fingerprintApi = null } = {}) {
        if (!repository) { return () => false; }

        return function onGtcRuntimeMessage(request, _sender, sendResponse) {
            if (!request || !request.action) return false;

            const startedAt = (typeof performance !== 'undefined' && performance.now)
                ? performance.now()
                : Date.now();

            const finalize = (payload) => {
                const finishedAt = (typeof performance !== 'undefined' && performance.now)
                    ? performance.now()
                    : Date.now();
                sendResponse({
                    ok: true,
                    durationMs: Math.max(0, finishedAt - startedAt),
                    ...payload,
                });
            };

            const fail = (error, action) => {
                logger('error', 'GTC_IDB_ERROR', `Falha no IndexedDB para ${action}`, {
                    error: error && error.message ? error.message : String(error),
                });
                sendResponse({
                    ok: false,
                    error: error && error.message ? error.message : String(error),
                });
            };

            // ── SHA-256 lookup ─────────────────────────────────────────────
            if (request.action === 'GTC_QUERY_MANY') {
                repository.getMany(request.hashes || [])
                    .then(entriesByHash => finalize({ entriesByHash }))
                    .catch(error => fail(error, request.action));
                return true;
            }

            // ── dHash lookup (v2) ──────────────────────────────────────────
            if (request.action === 'GTC_QUERY_BY_DHASH') {
                repository.getManyByDHash(request.dHashes || [])
                    .then(entriesByDHash => finalize({ entriesByDHash }))
                    .catch(error => fail(error, request.action));
                return true;
            }

            // ── wHash + pHash lookup combinado (v3) ────────────────────────
            //
            // O fingerprintApi (MangaTranslatorGtcFingerprint) é resolvido no SW
            // via self.MangaTranslatorGtcFingerprint (importado por importScripts).
            // Sem ele, o lookup perceptual retorna vazio mas não quebra o fluxo
            // (o content script tem fallbacks SHA-256 e dHash).
            if (request.action === 'GTC_QUERY_BY_PERCEPTUAL') {
                const fpApi = fingerprintApi
                    || (typeof self !== 'undefined' && self.MangaTranslatorGtcFingerprint)
                    || null;

                repository.getManyByPerceptual(
                    request.wHashes || [],
                    request.pHashes || [],
                    fpApi
                )
                    .then(entriesByPerceptual => finalize({ entriesByPerceptual }))
                    .catch(error => fail(error, request.action));
                return true;
            }

            if (request.action === 'GTC_QUERY_BY_PERCEPTUAL_CROP') {
                const fpApi = fingerprintApi
                    || (typeof self !== 'undefined' && self.MangaTranslatorGtcFingerprint)
                    || null;

                if (!repository.getManyByPerceptualCrop) {
                    finalize({ entriesByPerceptualCrop: {} });
                    return true;
                }

                repository.getManyByPerceptualCrop(
                    request.wHashesCrop || [],
                    request.pHashesCrop || [],
                    fpApi
                )
                    .then(entriesByPerceptualCrop => finalize({ entriesByPerceptualCrop }))
                    .catch(error => fail(error, request.action));
                return true;
            }

            if (request.action === 'GTC_QUERY_BY_PERCEPTUAL_RELAXED') {
                const baseFpApi = fingerprintApi
                    || (typeof self !== 'undefined' && self.MangaTranslatorGtcFingerprint)
                    || null;

                if (!baseFpApi || typeof baseFpApi.matchPerceptualHashesRelaxed !== 'function') {
                    sendResponse({ ok: false, error: 'matchPerceptualHashesRelaxed não disponível' });
                    return true;
                }

                repository.getManyByPerceptual(
                    request.wHashes || [],
                    request.pHashes || [],
                    { matchPerceptualHashes: baseFpApi.matchPerceptualHashesRelaxed.bind(baseFpApi) }
                )
                    .then(entriesByPerceptualRelaxed => finalize({ entriesByPerceptualRelaxed }))
                    .catch(error => fail(error, request.action));
                return true;
            }

            // ── Consulta perceptual correlacionada (v5.1.1) ────────────────
            // Substitui GTC_QUERY_BY_PERCEPTUAL/_CROP/_RELAXED por um contrato
            // único: cada consulta traz seu próprio par de hashes e dimensões,
            // e a resposta vem indexada por queryId.
            if (request.action === 'GTC_QUERY_PERCEPTUAL_V2') {
                const fpApi = fingerprintApi
                    || (typeof self !== 'undefined' && self.MangaTranslatorGtcFingerprint)
                    || null;

                if (!repository.queryPerceptual) {
                    finalize({ entriesByQueryId: {} });
                    return true;
                }

                repository.queryPerceptual(request.queries || [], fpApi, { mode: request.mode || 'strict' })
                    .then(entriesByQueryId => finalize({ entriesByQueryId }))
                    .catch(error => fail(error, request.action));
                return true;
            }

            // ── Save single ────────────────────────────────────────────────
            if (request.action === 'GTC_SAVE') {
                repository.put({
                    hash:               request.hash,
                    translatedDataUrl:  request.translatedDataUrl,
                    dHash:              request.dHash              || null,
                    wHash:              request.wHash              || null,
                    pHash:              request.pHash              || null,
                    wHashCrop:          request.wHashCrop          || null,
                    pHashCrop:          request.pHashCrop          || null,
                    regionalHashes:     request.regionalHashes     || null,
                    cleanUrl:           request.cleanUrl           || null,
                    width:              request.width              || 0,
                    height:             request.height             || 0,
                    fingerprintVersion: request.fingerprintVersion || 'visual-v3',
                    mimeType:           request.mimeType           || null,
                })
                    .then(result => finalize(result))
                    .catch(error => fail(error, request.action));
                return true;
            }

            // ── Save many ──────────────────────────────────────────────────
            if (request.action === 'GTC_SAVE_MANY') {
                repository.putMany(request.entries || [])
                    .then(result => finalize(result))
                    .catch(error => fail(error, request.action));
                return true;
            }

            if (request.action === 'GTC_DELETE_BY_CLEAN_URL') {
                if (!repository.deleteByCleanUrl) {
                    finalize({ deleted: 0 });
                    return true;
                }

                repository.deleteByCleanUrl(request.cleanUrl || '')
                    .then(result => finalize(result))
                    .catch(error => fail(error, request.action));
                return true;
            }

            if (request.action === 'GTC_CLEAR_ALL') {
                repository.clear()
                    .then(() => finalize({ cleared: true }))
                    .catch(error => fail(error, request.action));
                return true;
            }

            if (request.action === 'GTC_STATS') {
                repository.stats()
                    .then(stats => finalize({ stats }))
                    .catch(error => fail(error, request.action));
                return true;
            }

            return false;
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API pública
    // ─────────────────────────────────────────────────────────────────────────

    const api = {
        DB_NAME,
        STORE_NAME,
        DB_VERSION,
        createIndexedDbRepository,
        createInMemoryRepository,
        createGtcRuntimeHandler,
        normalizeHash,
        cloneValue,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    rootScope.MangaTranslatorGtcIndexedDb = api;
})(typeof self !== 'undefined' ? self : globalThis);
