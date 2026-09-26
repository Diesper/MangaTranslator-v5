// options.js — Manga Translator

document.addEventListener('DOMContentLoaded', () => {
    const manifest = typeof chrome !== 'undefined'
        && chrome.runtime
        && typeof chrome.runtime.getManifest === 'function'
        ? chrome.runtime.getManifest()
        : null;
    const runtimeVersion = manifest && manifest.version ? String(manifest.version) : '';
    const appTitleEl = document.getElementById('app-title');

    if (runtimeVersion) {
        const versionedName = `Manga Translator v${runtimeVersion}`;
        document.title = `Opções - ${versionedName}`;
        if (appTitleEl) appTitleEl.textContent = versionedName;
    }

    const promptEl = document.getElementById('prompt');
    const statusEl = document.getElementById('status');
    const sitesList = document.getElementById('sites-list');
    const autoRestoreEnabledEl = document.getElementById('auto-restore-enabled');
    const btnRefreshAutoImages = document.getElementById('btn-refresh-auto-images');
    const btnClearAutoBlocks = document.getElementById('btn-clear-auto-blocks');
    const expandedOptionSites = new Set();

    const geminiModeStatusEl = document.getElementById('gemini-mode-status');
    const tempRadioEl = document.getElementById('gemini-mode-temp');
    const minRadioEl = document.getElementById('gemini-mode-minimized');
    const deleteRadioEl = document.getElementById('gemini-mode-delete');

    chrome.storage.local.get(['customPrompt', 'defaultPrompt', 'autoRestoreEnabled', 'geminiExecutionMode'], (result) => {
        promptEl.value = result.customPrompt || result.defaultPrompt || "";
        autoRestoreEnabledEl.checked = result.autoRestoreEnabled !== false;
        const mode = result.geminiExecutionMode || 'temp_chat';
        if (mode === 'minimized_window') {
            if (minRadioEl) minRadioEl.checked = true;
        } else if (mode === 'background_delete') {
            if (deleteRadioEl) deleteRadioEl.checked = true;
        } else {
            if (tempRadioEl) tempRadioEl.checked = true;
        }
    });

    function showStatus(msg, color = '#4CAF50') {
        statusEl.style.color = color;
        statusEl.textContent = msg;
        setTimeout(() => { statusEl.textContent = ''; }, 3000);
    }

    function getSiteMeta(hostname) {
        return new Promise(resolve => {
            chrome.storage.local.get([`siteMeta_${hostname}`], data => {
                resolve(data[`siteMeta_${hostname}`] || null);
            });
        });
    }

    // ── Ponte com o armazenamento do background ──────────────────────────────
    // As páginas traduzidas vivem no IndexedDB da extensão (storage-manager.js),
    // gravadas pelo background. Esta página só consulta metadados — nunca puxa
    // Base64 para montar listas.
    /**
     * Une o armazenamento novo com o legado dos capítulos ainda não migrados,
     * para que nada desapareça da lista antes do usuário revisitar o capítulo.
     */
    document.getElementById('btn-save').addEventListener('click', () => {
        chrome.storage.local.set({ customPrompt: promptEl.value }, () => {
            showStatus('✔ Salvo com sucesso!');
        });
    });

    document.getElementById('btn-restore').addEventListener('click', () => {
        if (!confirm('Restaurar o prompt padrão? O texto atual será perdido.')) return;
        chrome.storage.local.get(['defaultPrompt'], (result) => {
            const HD_PROMPT = typeof DEFAULT_HD_PROMPT !== 'undefined'
                ? DEFAULT_HD_PROMPT
                : "Objetivo primário: voce vai criar uma imagem , exata da imagem fornecida e traduzir ela pro português brasileiro . \nNão altere nenhum pixel fora das áreas de texto e Remova o texto original dos balões de fala, preenchendo o fundo com a cor correspondente. \nConverta os diálogos para PT-BR, mantendo a informalidade do contexto. Tipografia: Renderize o novo texto em caixa alta, fonte padrão de HQ (sans-serif), alinhamento centralizado.\nEfeitos Sonoros: Traduza e recrie as onomatopeias  mantendo as fontes estilizadas, cores, contornos e inclinação originais. lembre-se que todas as palavras devem sem traduzidas sem exceção";
            promptEl.value = result.defaultPrompt || HD_PROMPT;
            chrome.storage.local.set({ defaultPrompt: HD_PROMPT, customPrompt: HD_PROMPT }, () => {
                showStatus('✔ Prompt restaurado para o padrão.');
            });
        });
    });

    autoRestoreEnabledEl.addEventListener('change', () => {
        chrome.storage.local.set({ autoRestoreEnabled: autoRestoreEnabledEl.checked }, () => {
            showStatus(
                autoRestoreEnabledEl.checked
                    ? 'Auto-substituição ativada.'
                    : 'Auto-substituição desligada globalmente.',
                autoRestoreEnabledEl.checked ? '#4CAF50' : '#FF9800'
            );
        });
    });

    function showGeminiModeStatus(msg, color = '#4CAF50') {
        if (!geminiModeStatusEl) return;
        geminiModeStatusEl.style.color = color;
        geminiModeStatusEl.textContent = msg;
        setTimeout(() => { geminiModeStatusEl.textContent = ''; }, 3500);
    }

    document.querySelectorAll('input[name="gemini-execution-mode"]').forEach(radio => {
        radio.addEventListener('change', () => {
            if (radio.checked) {
                const val = radio.value;
                chrome.storage.local.set({ geminiExecutionMode: val }, () => {
                    const label = val === 'minimized_window'
                        ? 'Janela Minimizada'
                        : val === 'background_delete'
                            ? 'Conversa Normal com Exclusão Segura'
                            : 'Conversa Temporária (Segundo Plano)';
                    showGeminiModeStatus(`✔ Modo alterado para: ${label}`);
                });
            }
        });
    });

    function createAutoImageItem(entry, blockedImages) {
        const isBlocked = !!blockedImages[entry.cleanUrl];
        const item = document.createElement('div');
        item.className = 'options-image-item';
        item.style.cssText = 'display:grid; grid-template-columns:72px 1fr auto auto; gap:10px; align-items:center; padding:10px; background:#111; border-radius:6px; border:1px solid #333;';

        const preview = document.createElement('img');
        // Tenta a URL remota original; só busca a imagem gravada se falhar.
        preview.src = entry.sourceUrl || entry.legacyDataUrl || '';
        preview.alt = '';
        preview.loading = 'lazy';
        preview.style.cssText = 'width:72px; height:96px; object-fit:contain; background:#050505; border-radius:4px;';
        let previewFallbackTried = false;
        preview.onerror = async () => {
            if (previewFallbackTried) return;
            previewFallbackTried = true;
            if (entry.legacyDataUrl) { preview.src = entry.legacyDataUrl; return; }
            if (!entry.assetId) return;
            const resp = await smRequest({ action: 'SM_GET_ASSET', assetId: entry.assetId });
            if (resp && resp.ok && resp.dataUrl) preview.src = resp.dataUrl;
        };

        const info = document.createElement('div');
        info.style.cssText = 'min-width:0;';
        info.innerHTML = `
            <div style="font-weight:bold; color:#fff; margin-bottom:3px;">${escapeHTML(entry.chapterTitle)}</div>
            <div style="color:#aaa; font-size:12px;">${entry.index !== undefined ? `página ${entry.index}` : 'sem número de página'}</div>
            <div title="${escapeHTML(entry.cleanUrl)}" style="color:#666; font-size:11px; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHTML(entry.cleanUrl)}</div>
            <div style="color:${isBlocked ? '#FF9800' : '#4CAF50'}; font-size:12px; margin-top:4px;">${isBlocked ? 'Bloqueada para auto-substituição' : 'Permitida no auto-restore'}</div>
        `;

        const blockBtn = document.createElement('button');
        blockBtn.className = 'options-image-block-btn';
        blockBtn.textContent = isBlocked ? 'Permitir' : 'Bloquear';
        blockBtn.style.cssText = `background:${isBlocked ? '#2d7a38' : '#8a1c1c'}; border:none; padding:8px 10px; color:#fff; cursor:pointer;`;
        blockBtn.addEventListener('click', () => {
            chrome.storage.local.get(['autoRestoreBlockedImages'], d => {
                const current = normalizeBlockedImages(d.autoRestoreBlockedImages);
                if (current[entry.cleanUrl]) {
                    delete current[entry.cleanUrl];
                } else {
                    current[entry.cleanUrl] = {
                        cleanUrl: entry.cleanUrl,
                        host: entry.host,
                        sourceUrl: entry.sourceUrl,
                        chapterTitle: entry.chapterTitle,
                        blockedAt: Date.now(),
                    };
                }
                chrome.storage.local.set({ autoRestoreBlockedImages: current }, () => {
                    renderSites();
                    showStatus(current[entry.cleanUrl] ? 'Imagem bloqueada.' : 'Imagem permitida.', current[entry.cleanUrl] ? '#FF9800' : '#4CAF50');
                });
            });
        });

        const redoBtn = document.createElement('button');
        redoBtn.className = 'options-image-redo-btn';
        redoBtn.textContent = 'Refazer';
        redoBtn.style.cssText = 'background:#1a5fa8; border:none; padding:8px 10px; color:#fff; cursor:pointer;';
        redoBtn.addEventListener('click', () => deleteSavedTranslationForEntry(entry, {
            refresh: renderSites,
            showStatus,
        }));

        item.appendChild(preview);
        item.appendChild(info);
        item.appendChild(blockBtn);
        item.appendChild(redoBtn);
        return item;
    }

    // ── Refazer ──────────────────────────────────────────────────────────────
    // Purga a tradução em todos os lugares onde ela poderia voltar: armazenamento
    // novo (página + restore + asset), resíduos legados, bloqueio de
    // auto-substituição e cache global (GTC).
    function renderSites() {
        // Não puxa mais os restoreMaps de todos os capítulos (cada um carregava
        // as imagens Base64 inteiras só para montar a lista).
        chrome.storage.local.get(['enabledDomains', 'autoRestoreDisabledSites', 'autoRestoreBlockedImages', 'chapterList'], (baseData) => {
            const keysToFetch = [];
            const chapterList = baseData.chapterList || [];
            const domains = baseData.enabledDomains || [];
            domains.forEach(d => keysToFetch.push(`siteMeta_${d}`));

            chrome.storage.local.get(keysToFetch, async (chapterData) => {
                const data = { ...baseData, ...chapterData };

                const disabledSites = Array.isArray(data.autoRestoreDisabledSites) ? data.autoRestoreDisabledSites : [];
                const entries = await loadRestoreEntries(chapterList);
                const blockedImages = normalizeBlockedImages(data.autoRestoreBlockedImages);
                const entriesByHost = entries.reduce((acc, entry) => {
                    const host = entry.host || 'desconhecido';
                    if (!acc.has(host)) acc.set(host, []);
                    acc.get(host).push(entry);
                    return acc;
                }, new Map());
                const hosts = Array.from(new Set(domains));
                sitesList.innerHTML = '';

                if (hosts.length === 0) {
                    sitesList.innerHTML = '<div>Nenhum site permitido ainda.</div>';
                    return;
                }

                hosts.forEach(hostname => {
                    const meta = data[`siteMeta_${hostname}`] || null;
                    const siteEntries = entriesByHost.get(hostname) || [];
                    const isOpen = expandedOptionSites.has(hostname);
                    const item = document.createElement('div');
                    item.className = 'options-site-item';
                    item.classList.toggle('open', isOpen);
                    item.style.cssText = 'margin-bottom:12px; background:#111; border:1px solid #333; border-radius:6px; overflow:hidden;';

                    const header = document.createElement('div');
                    header.className = 'options-site-main';
                    header.setAttribute('role', 'button');
                    header.setAttribute('tabindex', '0');
                    header.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
                    header.style.cssText = 'display:grid; grid-template-columns:auto minmax(0,1fr) auto auto auto; gap:10px; align-items:center; padding:10px; cursor:pointer; user-select:none;';

                    const arrow = document.createElement('span');
                    arrow.className = 'options-site-arrow';
                    arrow.textContent = '▶';
                    arrow.setAttribute('aria-hidden', 'true');
                    arrow.style.cssText = `color:${isOpen ? '#FF4444' : '#aaa'}; transform:${isOpen ? 'rotate(90deg)' : 'none'}; transition:transform 0.15s ease; display:inline-block;`;

                    const displayName = meta?.title || hostname;
                    const nameEl = document.createElement('div');
                    nameEl.textContent = `${displayName} (${hostname})`;
                    nameEl.style.cssText = 'min-width:0; overflow:hidden; text-overflow:ellipsis;';

                    const countEl = document.createElement('div');
                    countEl.textContent = `${siteEntries.length} image${siteEntries.length === 1 ? 'm' : 'ns'}`;
                    countEl.style.cssText = 'color:#aaa; font-size:12px; white-space:nowrap;';

                    const autoLabel = document.createElement('label');
                    autoLabel.className = 'options-site-auto';
                    autoLabel.style.cssText = 'display:flex; align-items:center; gap:6px; color:#ccc; font-size:13px; cursor:pointer; white-space:nowrap;';
                    const autoCheck = document.createElement('input');
                    autoCheck.type = 'checkbox';
                    autoCheck.checked = !disabledSites.includes(hostname);
                    autoCheck.style.accentColor = '#FF4444';
                    autoCheck.addEventListener('click', event => event.stopPropagation());
                    autoCheck.addEventListener('change', (event) => {
                        event.stopPropagation();
                        chrome.storage.local.get(['autoRestoreDisabledSites'], d => {
                            const current = Array.isArray(d.autoRestoreDisabledSites) ? d.autoRestoreDisabledSites : [];
                            const next = autoCheck.checked
                                ? current.filter(h => h !== hostname)
                                : Array.from(new Set([...current, hostname]));
                            chrome.storage.local.set({ autoRestoreDisabledSites: next }, () => {
                                renderSites();
                                showStatus(
                                    autoCheck.checked
                                        ? `Auto-substituição ativada em ${hostname}.`
                                        : `Auto-substituição bloqueada em ${hostname}.`,
                                    autoCheck.checked ? '#4CAF50' : '#FF9800'
                                );
                            });
                        });
                    });
                    autoLabel.appendChild(autoCheck);
                    autoLabel.appendChild(document.createTextNode('Auto'));
                    autoLabel.addEventListener('click', event => event.stopPropagation());

                    const revokeBtn = document.createElement('button');
                    revokeBtn.textContent = 'Revogar';
                    revokeBtn.style.cssText = 'background:#FF4444; border:none; padding:6px 10px; color:#fff; cursor:pointer;';
                    revokeBtn.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (!confirm(`Remover permissão do site "${hostname}"?`)) return;
                        chrome.storage.local.get(['enabledDomains', 'autoRestoreDisabledSites'], (d) => {
                            const updated = (d.enabledDomains || []).filter(h => h !== hostname);
                            const updatedDisabled = (d.autoRestoreDisabledSites || []).filter(h => h !== hostname);
                            chrome.storage.local.set({
                                enabledDomains: updated,
                                autoRestoreDisabledSites: updatedDisabled,
                            }, () => {
                                expandedOptionSites.delete(hostname);
                                chrome.storage.local.remove([`siteMeta_${hostname}`], () => {
                                    renderSites();
                                    showStatus('✔ Permissão revogada.', '#FF9800');
                                });
                            });
                        });
                    });

                    function toggleSite() {
                        if (expandedOptionSites.has(hostname)) expandedOptionSites.delete(hostname);
                        else expandedOptionSites.add(hostname);
                        renderSites();
                    }
                    header.addEventListener('click', toggleSite);
                    header.addEventListener('keydown', event => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        toggleSite();
                    });

                    header.appendChild(arrow);
                    header.appendChild(nameEl);
                    header.appendChild(countEl);
                    header.appendChild(autoLabel);
                    header.appendChild(revokeBtn);
                    item.appendChild(header);

                    const imagesWrap = document.createElement('div');
                    imagesWrap.className = 'options-site-images';
                    imagesWrap.style.cssText = `${isOpen ? 'display:flex;' : 'display:none;'} flex-direction:column; gap:10px; padding:10px; border-top:1px solid #333; background:#171717; max-height:320px; overflow-y:auto; overflow-x:hidden; overscroll-behavior:contain;`;

                    const imagesTitle = document.createElement('div');
                    imagesTitle.textContent = 'Imagens específicas';
                    imagesTitle.style.cssText = 'color:#aaa; font-size:12px; font-weight:bold; text-transform:uppercase;';
                    imagesWrap.appendChild(imagesTitle);

                    if (siteEntries.length === 0) {
                        const empty = document.createElement('div');
                        empty.textContent = 'Nenhuma imagem salva para este site ainda.';
                        empty.style.cssText = 'color:#666; font-size:13px;';
                        imagesWrap.appendChild(empty);
                    } else {
                        siteEntries.forEach(entry => {
                            imagesWrap.appendChild(createAutoImageItem(entry, blockedImages));
                        });
                    }

                    item.appendChild(imagesWrap);
                    sitesList.appendChild(item);
                });
            });
        });
    }

    function renderAutoImages() {
        renderSites();
    }

    btnRefreshAutoImages.addEventListener('click', renderAutoImages);
    btnClearAutoBlocks.addEventListener('click', () => {
        if (!confirm('Remover todos os bloqueios de imagens específicas?')) return;
        chrome.storage.local.set({ autoRestoreBlockedImages: {} }, () => {
            renderAutoImages();
            showStatus('Bloqueios de imagem removidos.', '#FF9800');
        });
    });

    renderSites();
});

