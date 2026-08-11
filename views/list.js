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
} from '../preset.js';
import { S } from '../state.js';
import {
    getSimDisplayTitle,
    getSimulations,
    saveSimulations,
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
    html += `<button class="sim-new-btn" id="sim-go-create"><i class="fa-solid fa-plus"></i> 새 시뮬레이션</button>`;

    if (sims.length === 0) {
        html += `<div class="sim-empty"><i class="fa-solid fa-flask" style="font-size:32px; margin-bottom:12px; opacity:0.3;"></i><br>아직 시뮬레이션이 없습니다.<br>위 버튼을 눌러 새로 만들어보세요.</div>`;
    } else {
        ensureSettings();
        const savedPrompts = extension_settings[EXTENSION_NAME].savedPrompts;
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

    document.getElementById('sim-go-create')?.addEventListener('click', () => {
        S.pendingCreateDraft = null; // 목록에서 새로 들어온 경우는 빈 화면으로
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

/**
 * '저장된 프롬프트 불러오기' 드롭다운 옵션 HTML 생성.
 * 검색어로 필터 + 설정된 정렬(최신/오래된/이름) 적용.
 */
export function buildLoadPromptOptions(query = '') {
    ensureSettings();
    const s = extension_settings[EXTENSION_NAME];
    const q = (query || '').toLowerCase().trim();
    let list = s.savedPrompts.filter(p => !q || p.name.toLowerCase().includes(q) || p.content.toLowerCase().includes(q));

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

    ensureSettings();
    const savedPrompts = extension_settings[EXTENSION_NAME].savedPrompts;

    const selectOptions = buildLoadPromptOptions();

    // 프리셋 셀렉트 옵션 (현재 프리셋이 기본 선택)
    const currentPresetName = getCurrentPresetName();
    const presetNames = getAvailablePresetNames();
    let presetOptions = '';
    for (const name of presetNames) {
        const sel = name === currentPresetName ? ' selected' : '';
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
    if (S.pendingCreateDraft) {
        const d = S.pendingCreateDraft;
        S.pendingCreateDraft = null;

        const setVal = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
        const setChecked = (id, value) => { const el = document.getElementById(id); if (el) el.checked = !!value; };

        setVal('sim-title-input', d.customTitle || '');
        setVal('sim-prompt-input', d.rawPrompt || '');
        setVal('sim-position-select', d.chosenPosition);
        setChecked('sim-swap-charuser', d.chosenSwapCharUser);
        setChecked('sim-swap-pronouns', d.chosenSwapPronouns);
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
    }
}
