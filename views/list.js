import { getSavedPrompts } from '../prompt-storage.js';
/**
 * 목록 뷰 + 새 시뮬 작성 뷰.
 */
import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import {
    EXTENSION_NAME,
    SIM_POSITION_LABELS,
} from '../constants.js';
import { escapeHtml } from '../utils.js';
import {
    PROMPT_SORT_ORDERS,
    ensureSettings,
    getDefaultInjectPosition,
} from '../config.js';
import {
    getAvailablePresetNames,
    getCurrentPresetName,
    isCustomPresetTogglesEnabled,
    getTogglePresetNames,
    getCurrentActiveTogglePresetName,
    isSamePresetName,
} from '../preset.js';
import { S } from '../state.js';
import {
    getSimDisplayTitle,
    getSimulations,
    saveSimulations,
    getCurrentChatKey,
    getCurrentChatDisplayName,
    exportCurrentChatBackup,
    readBackupFile,
    importSimsIntoCurrentChat,
    deleteAllSimsInCurrentChat,
} from '../store.js';
import { handleSendSimulation } from '../generation.js';
import { setupMultiSendDrawer } from '../multiSend.js';
import {
    goToList,
    maybeResetContentScroll,
} from '../popup.js';
import { renderDetailView } from './detail.js';

export function renderListView() {
    const sims = getSimulations();
    const container = document.getElementById('sim-content');
    if (!container) return;
    maybeResetContentScroll('list');

    let html = `<div class="sim-list-view">`;
    html += `
    <div class="sim-list-toolbar">
        <button class="sim-new-btn" id="sim-go-create"><i class="fa-solid fa-plus"></i> 새 시뮬레이션</button>
        <div class="sim-more-wrap">
            <button class="sim-more-btn" id="sim-list-more" aria-label="이 방 시뮬 관리"><i class="fa-solid fa-ellipsis-vertical"></i></button>
            <div class="sim-more-menu hidden" id="sim-list-more-menu">
                <button class="sim-more-item" data-action="export"><i class="fa-solid fa-download"></i> 이 방 백업</button>
                <button class="sim-more-item" data-action="import"><i class="fa-solid fa-file-import"></i> 가져오기</button>
                <button class="sim-more-item sim-more-item-danger" data-action="delete-all"><i class="fa-solid fa-trash"></i> 전체 삭제</button>
            </div>
            <input type="file" id="sim-list-import-file" accept=".json,.zip,application/json,application/zip" style="display:none" />
        </div>
    </div>`;

    if (sims.length === 0) {
        html += `<div class="sim-empty"><i class="fa-solid fa-flask" style="font-size:32px; margin-bottom:12px; opacity:0.3;"></i><br>아직 시뮬레이션이 없습니다.<br>위 버튼을 눌러 새로 만들어보세요.</div>`;
    } else {
        ensureSettings();
        const savedPrompts = getSavedPrompts();
        let needsSave = false;
        const sorted = [...sims].reverse();
        for (const sim of sorted) {
            const responseCount = sim.responses ? sim.responses.length : 0;
            const date = new Date(sim.createdAt).toLocaleString();
            const found = savedPrompts.find(p => p.content === sim.promptText);
            if (found && sim.promptName !== found.name) {
                sim.promptName = found.name; needsSave = true;
            }
            const displayName = getSimDisplayTitle(sim);
            html += `
            <div class="sim-item" data-sim-id="${sim.id}">
                <div class="sim-item-prompt">${escapeHtml(displayName)}</div>
                <div class="sim-item-meta">
                    <span>${date}</span>
                    <span>답변 ${responseCount}개</span>
                </div>
            </div>`;
        }
        if (needsSave) saveSimulations();
    }
    html += `</div>`;
    container.innerHTML = html;

    const footer = document.getElementById('sim-footer');
    if (footer) { footer.innerHTML = ''; footer.classList.add('hidden'); }

    setupListMoreMenu(container);

    document.getElementById('sim-go-create')?.addEventListener('click', () => {
        if (S.simGenerating) return;
        S.pendingCreateDraft = S.createDrafts[getCurrentChatKey()] || null;
        S.currentView = 'create';
        renderCreateView();
    });

    container.querySelectorAll('.sim-item').forEach(el => {
        el.addEventListener('click', () => {
            S.currentSimId = el.dataset.simId;
            S.currentView = 'detail';
            S.isEditingPrompt = false;
            S.isEditingTitle = false;
            renderDetailView();
        });
    });
}

// ============================================
// 점세개 메뉴: 이 방 백업 · 가져오기 · 전체 삭제
// ============================================
function setupListMoreMenu(container) {
    const btn = document.getElementById('sim-list-more');
    const menu = document.getElementById('sim-list-more-menu');
    const fileInput = document.getElementById('sim-list-import-file');
    if (!btn || !menu || !fileInput) return;

    const close = () => menu.classList.add('hidden');
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('hidden');
    });
    container.addEventListener('click', (e) => {
        if (!menu.contains(e.target)) close();
    });

    menu.querySelectorAll('.sim-more-item').forEach(item => {
        item.addEventListener('click', async (e) => {
            e.stopPropagation();
            close();
            if (S.simGenerating) {
                toastr.warning('생성이 끝난 뒤에 할 수 있습니다.', '시뮬 매니저');
                return;
            }
            const action = item.dataset.action;
            if (action === 'export') handleExportRoom();
            else if (action === 'import') fileInput.click();
            else if (action === 'delete-all') await handleDeleteAllRoom();
        });
    });

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (file) await handleImportRoom(file);
    });
}

function handleExportRoom() {
    const count = exportCurrentChatBackup();
    if (count > 0) toastr.success(`이 방 시뮬 ${count}개를 백업 파일로 내보냈습니다.`, '시뮬 매니저');
    else toastr.info('백업할 시뮬이 없습니다.', '시뮬 매니저');
}

async function handleImportRoom(file) {
    const chatKey = getCurrentChatKey();
    try {
        const rooms = await readBackupFile(file);
        if (!rooms.length) throw new Error('가져올 시뮬이 없습니다.');
        const room = rooms.length === 1 ? rooms[0] : await pickBackupRoom(rooms, chatKey);
        if (!room) return;
        if (getCurrentChatKey() !== chatKey) throw new Error('채팅방이 바뀌어 가져오기를 중단했습니다.');
        const { added, skipped } = await importSimsIntoCurrentChat(room.simulations);
        if (added === 0) toastr.info(`이미 있는 시뮬 ${skipped}개라 새로 추가된 게 없습니다.`, '시뮬 매니저');
        else toastr.success(`${added}개 가져옴${skipped ? ` · 중복 ${skipped}개 건너뜀` : ''}`, '시뮬 매니저');
        if (S.currentView === 'list') renderListView();
    } catch (e) {
        console.error('[SimManager] Import failed:', e);
        toastr.error(e.message || '파일을 읽지 못했습니다.', '가져오기 실패');
    }
}

/** 백업에 방이 여럿이면 어느 방을 넣을지 고른다. 현재 방과 키가 같은 게 있으면 그걸 기본 선택. */
function pickBackupRoom(rooms, currentKey) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'sim-dialog-overlay';
        const options = rooms.map((r, i) =>
            `<option value="${i}"${r.key === currentKey ? ' selected' : ''}>${escapeHtml(r.chatName)} (${r.simulations.length}개)</option>`).join('');
        overlay.innerHTML = `
        <div class="sim-dialog-box">
            <div class="sim-dialog-title"><i class="fa-solid fa-file-import"></i> 가져올 방 선택</div>
            <div class="sim-dialog-desc">백업에 방이 ${rooms.length}개 있습니다. 고른 방의 시뮬을 <b>${escapeHtml(getCurrentChatDisplayName())}</b>에 넣습니다.</div>
            <select class="sim-saved-prompts-select" id="sim-import-room-select">${options}</select>
            <div class="sim-dialog-buttons">
                <button class="sim-btn" id="sim-import-cancel">취소</button>
                <button class="sim-btn sim-btn-primary" id="sim-import-ok">가져오기</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        const done = (value) => { overlay.remove(); resolve(value); };
        overlay.querySelector('#sim-import-cancel').addEventListener('click', () => done(null));
        overlay.querySelector('#sim-import-ok').addEventListener('click', () => {
            const idx = Number(overlay.querySelector('#sim-import-room-select').value);
            done(rooms[idx] || null);
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    });
}

async function handleDeleteAllRoom() {
    const count = getSimulations().length;
    if (count === 0) {
        toastr.info('삭제할 시뮬이 없습니다.', '시뮬 매니저');
        return;
    }
    if (!confirm(`이 방의 시뮬 ${count}개를 모두 삭제하시겠습니까?\n되돌릴 수 없습니다. 필요하면 먼저 백업하세요.`)) return;
    try {
        const removed = await deleteAllSimsInCurrentChat();
        toastr.success(`시뮬 ${removed}개를 삭제했습니다.`, '시뮬 매니저');
    } catch (e) {
        console.error('[SimManager] Delete all failed:', e);
        toastr.error(e.message || '삭제 저장에 실패했습니다.', '삭제 실패');
    }
    if (S.currentView === 'list') renderListView();
}

/**
 * '저장된 프롬프트 불러오기' 드롭다운 옵션 HTML 생성.
 * 검색어로 필터 + 설정된 정렬(최신/오래된/이름) 적용.
 */
export function buildLoadPromptOptions(query = '') {
    ensureSettings();
    const s = extension_settings[EXTENSION_NAME];
    const q = (query || '').toLowerCase().trim();
    let list = getSavedPrompts().filter(p => !q || p.name.toLowerCase().includes(q) || p.content.toLowerCase().includes(q));

    const order = s.promptSortOrder || 'newest';
    if (order === 'newest') {
        list = list.slice().reverse();          // 배열 순서 = 저장순 → 뒤집으면 최신순
    } else if (order === 'name') {
        list = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    }
    // 'oldest' = 원래 배열 순서 그대로

    let options = `<option value="">-- 직접 입력 --</option>`;
    for (const p of list) {
        options += `<option value="${p.id}">${escapeHtml(p.name)}</option>`;
    }
    return options;
}

export function renderCreateView() {
    const container = document.getElementById('sim-content');
    if (!container) return;
    maybeResetContentScroll('create');
    const draftChatKey = getCurrentChatKey();

    ensureSettings();
    const savedPrompts = getSavedPrompts();

    const selectOptions = buildLoadPromptOptions();

    // 프리셋 셀렉트 옵션 (현재 프리셋이 기본 선택)
    const currentPresetName = getCurrentPresetName();
    const presetNames = getAvailablePresetNames();
    let presetOptions = '';
    for (const name of presetNames) {
        const sel = isSamePresetName(name, currentPresetName) ? ' selected' : '';
        presetOptions += `<option value="${escapeHtml(name)}"${sel}>${escapeHtml(name)}</option>`;
    }

    // 토글 프리셋 영역 (CustomPreset 설치 + 활성화 시만)
    const togglesEnabled = isCustomPresetTogglesEnabled();
    const togglePresetField = togglesEnabled ? `
        <div class="sim-field">
            <label>토글 프리셋 (선택)</label>
            <select class="sim-saved-prompts-select" id="sim-toggle-preset-select"></select>
        </div>
    ` : '';

    const positionOptions = Object.entries(SIM_POSITION_LABELS).map(([v, l]) =>
        `<option value="${v}"${v === getDefaultInjectPosition() ? ' selected' : ''}>${escapeHtml(l)}</option>`
    ).join('');

    const html = `
    <div class="sim-create-view sim-create-view-v2">
        <div class="sim-create-toolbar">
            <button class="sim-btn" id="sim-back-to-list">
                <i class="fa-solid fa-arrow-left"></i> 목록으로
            </button>
        </div>

        <div class="sim-card sim-card-main">
            <h4 class="sim-card-title"><i class="fa-solid fa-flask"></i> 새 시뮬레이션</h4>
            <div class="sim-field">
                <label>제목</label>
                <input type="text" class="sim-prompt-search" id="sim-title-input" placeholder="제목 (비우면 프롬프트 앞글자 사용)" />
            </div>
            <div class="sim-field">
                <label>내용</label>
                <textarea class="sim-prompt-textarea sim-prompt-textarea-lg" id="sim-prompt-input" placeholder="프롬프트 내용"></textarea>
                <small>생성·재생성은 현재 채팅 내용을 사용합니다. 생성 당시 대화는 따로 고정되지 않습니다.</small>
            </div>
        </div>

        <details class="sim-drawer">
            <summary>
                <span class="sim-drawer-title"><i class="fa-solid fa-bookmark"></i> 저장된 프롬프트 불러오기</span>
                <i class="fa-solid fa-chevron-down sim-drawer-arrow"></i>
            </summary>
            <div class="sim-drawer-body">
                <input type="text" class="sim-prompt-search" id="sim-prompt-search" placeholder="프롬프트 검색 (제목/내용)" />
                <select class="sim-saved-prompts-select sim-prompt-sort" id="sim-prompt-sort">
                    <option value="newest">최신순</option>
                    <option value="oldest">오래된순</option>
                    <option value="name">이름순</option>
                </select>
                <select class="sim-saved-prompts-select" id="sim-load-prompt">
                    ${selectOptions}
                </select>
                <span class="sim-create-hint" id="sim-overwrite-hint" style="display:none;">제목이나 내용을 수정하면 새 프롬프트로 저장됩니다.</span>
            </div>
        </details>

        <details class="sim-drawer">
            <summary>
                <span class="sim-drawer-title"><i class="fa-solid fa-sliders"></i> 실행 옵션</span>
                <i class="fa-solid fa-chevron-down sim-drawer-arrow"></i>
            </summary>
            <div class="sim-drawer-body">
                <div class="sim-field">
                    <label>프리셋</label>
                    <select class="sim-saved-prompts-select" id="sim-preset-select">
                        ${presetOptions}
                    </select>
                </div>
                ${togglePresetField}
                <div class="sim-field">
                    <label>주입 위치</label>
                    <select class="sim-saved-prompts-select" id="sim-position-select">
                        ${positionOptions}
                    </select>
                </div>
            </div>
        </details>

        <details class="sim-drawer">
            <summary>
                <span class="sim-drawer-title"><i class="fa-solid fa-arrows-rotate"></i> 변환 옵션</span>
                <i class="fa-solid fa-chevron-down sim-drawer-arrow"></i>
            </summary>
            <div class="sim-drawer-body">
                <label class="sim-checkbox-label">
                    <input type="checkbox" id="sim-swap-charuser" />
                    <span>{{char}} ↔ {{user}} 교체</span>
                </label>
                <label class="sim-checkbox-label">
                    <input type="checkbox" id="sim-swap-pronouns" />
                    <span>대명사 교체 (he/she, him/her, ...)</span>
                </label>
                <div class="sim-field">
                    <label>{{char}} 대신 쓸 단어</label>
                    <input type="text" class="sim-prompt-search" id="sim-char-alias" placeholder="비우면 원래 이름" />
                </div>
                <div class="sim-field">
                    <label>{{user}} 대신 쓸 단어</label>
                    <input type="text" class="sim-prompt-search" id="sim-user-alias" placeholder="비우면 원래 이름" />
                </div>
                <span class="sim-create-hint">교체 체크가 끝난 결과에 적용됩니다. 여러 방에 보낼 때는 현재 방에만 적용됩니다.</span>
            </div>
        </details>

        <details class="sim-drawer">
            <summary>
                <span class="sim-drawer-title"><i class="fa-solid fa-floppy-disk"></i> 저장 옵션</span>
                <i class="fa-solid fa-chevron-down sim-drawer-arrow"></i>
            </summary>
            <div class="sim-drawer-body">
                <label class="sim-checkbox-label">
                    <input type="checkbox" id="sim-no-save-prompt" />
                    <span>이 프롬프트 저장 안 하기</span>
                </label>
            </div>
        </details>

        <details class="sim-drawer" id="sim-multisend-drawer">
            <summary>
                <span class="sim-drawer-title"><i class="fa-solid fa-tower-broadcast"></i> 여러 방에 보내기</span>
                <i class="fa-solid fa-chevron-down sim-drawer-arrow"></i>
            </summary>
            <div class="sim-drawer-body">
                <span class="sim-create-hint">현재 방은 기본 포함됩니다. 다른 방을 추가로 선택하면 함께 전송하고, 현재 방을 빼려면 (현재) 항목 체크를 해제하세요. 선택한 방마다 차례로 열어 같은 시뮬을 생성·저장하며, 끝나면 원래 방으로 돌아옵니다.</span>
                <input type="text" class="sim-prompt-search" id="sim-multisend-search" placeholder="채팅방 검색 (이름)" />
                <label class="sim-checkbox-label sim-multisend-allrow">
                    <input type="checkbox" id="sim-multisend-all" />
                    <span>보이는 항목 전체 선택</span>
                </label>
                <div id="sim-multisend-list" class="sim-multisend-list"></div>
            </div>
        </details>
    </div>`;

    container.innerHTML = html;

    const footer = document.getElementById('sim-footer');
    if (footer) {
        footer.classList.remove('hidden');
        footer.innerHTML = `
        <div class="sim-create-actions">
            <button class="sim-btn" id="sim-cancel-create">취소</button>
            <button class="sim-btn sim-btn-primary" id="sim-send-btn"><i class="fa-solid fa-paper-plane"></i> 시뮬 전송</button>
        </div>`;
    }

    document.getElementById('sim-back-to-list')?.addEventListener('click', goToList);
    document.getElementById('sim-cancel-create')?.addEventListener('click', goToList);

    const rebuildLoadPrompt = () => {
        const select = document.getElementById('sim-load-prompt');
        if (!select) return;
        const query = document.getElementById('sim-prompt-search')?.value || '';
        select.innerHTML = buildLoadPromptOptions(query);
    };

    document.getElementById('sim-prompt-search')?.addEventListener('input', rebuildLoadPrompt);

    const sortSelect = document.getElementById('sim-prompt-sort');
    if (sortSelect) {
        sortSelect.value = extension_settings[EXTENSION_NAME].promptSortOrder || 'newest';
        sortSelect.addEventListener('change', () => {
            extension_settings[EXTENSION_NAME].promptSortOrder = PROMPT_SORT_ORDERS.includes(sortSelect.value) ? sortSelect.value : 'newest';
            saveSettingsDebounced();
            rebuildLoadPrompt();
        });
    }

    document.getElementById('sim-load-prompt')?.addEventListener('change', (e) => {
        const promptId = e.target.value;
        const hint = document.getElementById('sim-overwrite-hint');
        if (!promptId) {
            if (hint) hint.style.display = 'none';
            return;
        }
        const found = savedPrompts.find(p => p.id === promptId);
        if (found) {
            document.getElementById('sim-prompt-input').value = found.content;
            document.getElementById('sim-title-input').value = found.name;
            if (hint) hint.style.display = '';
        }
    });

    document.getElementById('sim-send-btn')?.addEventListener('click', handleSendSimulation);

    setupMultiSendDrawer();

    // 프리셋 / 토글 프리셋 셀렉트 초기화 & 연동
    const presetSelect = document.getElementById('sim-preset-select');
    const togglePresetSelect = document.getElementById('sim-toggle-preset-select');

    function refreshTogglePresetOptions() {
        if (!togglePresetSelect) return;
        const chosenPreset = presetSelect?.value || getCurrentPresetName();
        const names = getTogglePresetNames(chosenPreset);
        // 선택된 프리셋이 현재 프리셋과 같으면 현재 활성 토글을, 다르면 default 선택
        const preselect = (chosenPreset === getCurrentPresetName())
            ? getCurrentActiveTogglePresetName(chosenPreset)
            : 'default';
        togglePresetSelect.innerHTML = '';
        for (const n of names) {
            const opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n === 'default' ? '기본' : n;
            if (n === preselect) opt.selected = true;
            togglePresetSelect.appendChild(opt);
        }
        // preselect 가 목록에 없으면 첫 항목이 selected 로 남음 (브라우저 기본)
    }
    refreshTogglePresetOptions();
    presetSelect?.addEventListener('change', refreshTogglePresetOptions);

    // 전송 취소로 돌아온 경우: 방금 보냈던 입력값 복원 (한 번만 적용)
    if (S.pendingCreateDraft || S.createDrafts[draftChatKey]) {
        const d = S.pendingCreateDraft || S.createDrafts[draftChatKey];
        S.pendingCreateDraft = null;

        const setVal = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
        const setChecked = (id, value) => { const el = document.getElementById(id); if (el) el.checked = !!value; };

        setVal('sim-title-input', d.customTitle || '');
        setVal('sim-prompt-input', d.rawPrompt || '');
        setVal('sim-position-select', d.chosenPosition);
        setChecked('sim-swap-charuser', d.chosenSwapCharUser);
        setChecked('sim-swap-pronouns', d.chosenSwapPronouns);
        setVal('sim-char-alias', d.chosenCharAlias || '');
        setVal('sim-user-alias', d.chosenUserAlias || '');
        setChecked('sim-no-save-prompt', d.noSavePrompt);

        // 프리셋을 먼저 되돌린 뒤 토글 목록을 다시 만들어야 토글 선택값이 살아난다
        if (presetSelect && d.chosenPresetName) {
            presetSelect.value = d.chosenPresetName;
            refreshTogglePresetOptions();
        }
        if (togglePresetSelect && d.chosenTogglePresetName) {
            togglePresetSelect.value = d.chosenTogglePresetName;
        }

        // 불러온 프롬프트 선택 상태 (목록에 남아 있을 때만)
        const loadSelect = document.getElementById('sim-load-prompt');
        if (loadSelect && d.loadedPromptId && loadSelect.querySelector(`option[value="${d.loadedPromptId}"]`)) {
            loadSelect.value = d.loadedPromptId;
        }
        if (d.multiSendKeys) {
            S.multiSendSelKeys = new Set(d.multiSendKeys);
            container.querySelectorAll('.sim-multisend-cb').forEach(cb => { cb.checked = S.multiSendSelKeys.has(cb.dataset.key); });
        }
    }

    const saveDraft = () => {
        const value = id => document.getElementById(id)?.value || '';
        const checked = id => !!document.getElementById(id)?.checked;
        S.createDrafts[draftChatKey] = {
            rawPrompt: value('sim-prompt-input'), customTitle: value('sim-title-input'),
            chosenPresetName: value('sim-preset-select'), chosenTogglePresetName: value('sim-toggle-preset-select'),
            chosenPosition: value('sim-position-select'), chosenSwapCharUser: checked('sim-swap-charuser'),
            chosenSwapPronouns: checked('sim-swap-pronouns'), noSavePrompt: checked('sim-no-save-prompt'),
            chosenCharAlias: value('sim-char-alias'), chosenUserAlias: value('sim-user-alias'),
            loadedPromptId: value('sim-load-prompt'), multiSendKeys: [...S.multiSendSelKeys],
        };
    };
    const form = container.querySelector('.sim-create-view');
    form.addEventListener('input', saveDraft);
    form.addEventListener('change', saveDraft);
}
