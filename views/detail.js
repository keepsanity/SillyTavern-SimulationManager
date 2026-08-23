/**
 * 시뮬 상세 뷰와 응답 파트 렌더러.
 */
import { extension_settings } from '../../../../extensions.js';
import { chat } from '../../../../../script.js';
import {
    EXTENSION_NAME,
    SIM_POSITION_LABELS,
} from '../constants.js';
import {
    normalizeSimPosition,
    escapeHtml,
    normalizePromptText,
    getFullResponseText,
    copyTextToClipboard,
    renderResponseText,
} from '../utils.js';
import { ensureSettings } from '../config.js';
import {
    getAvailablePresetNames,
    getCurrentPresetName,
    isCustomPresetTogglesEnabled,
    getTogglePresetNames,
} from '../preset.js';
import { S } from '../state.js';
import {
    getSimDisplayTitle,
    getSimulations,
    saveSimulations,
} from '../store.js';
import {
    handleContinueSimulation,
    handleRegenerateSimulation,
    showInsertToChatDialog,
    showNewChatDialog,
    showPartRevisionDialog,
    stopSimGeneration,
} from '../generation.js';
import { openLoreEntryDialogForSim } from '../lorebook.js';
import {
    goToList,
    maybeResetContentScroll,
} from '../popup.js';
import { translatePart } from '../translate.js';

export function renderDetailView() {
    const container = document.getElementById('sim-content');
    if (!container) return;

    const sims = getSimulations();
    const sim = (S.tempSim && S.tempSim.id === S.currentSimId) ? S.tempSim : sims.find(s => s.id === S.currentSimId);
    if (!sim) {
        goToList();
        return;
    }
    maybeResetContentScroll('detail', sim.id);

    const responseCount = sim.responses ? sim.responses.length : 0;
    const currentIdx = sim.currentIndex || 0;

    // 프롬프트 영역: 수정 모드 vs 보기 모드
    let promptBoxContent;
    if (S.isEditingPrompt) {
        promptBoxContent = `
            <div class="sim-detail-prompt-label">시뮬 요청 <span style="font-size:10px; color:#888;">(수정 중)</span></div>
            <textarea class="sim-edit-prompt-textarea" id="sim-edit-prompt-input">${escapeHtml(normalizePromptText(sim.promptText))}</textarea>
            <div class="sim-edit-prompt-actions">
                <button class="sim-btn" id="sim-edit-cancel">취소</button>
                <button class="sim-btn sim-btn-primary" id="sim-edit-save">저장</button>
            </div>`;
    } else {
        promptBoxContent = `
            <details class="sim-prompt-toggle">
                <summary class="sim-detail-prompt-header">
                    <div class="sim-detail-prompt-label"><i class="fa-solid fa-chevron-right sim-prompt-arrow"></i> 시뮬 요청</div>
                    <button class="sim-btn-icon" id="sim-edit-prompt-btn" title="수정"><i class="fa-solid fa-pen"></i> 수정</button>
                </summary>
                <div class="sim-detail-prompt-text">${escapeHtml(normalizePromptText(sim.promptText))}</div>
            </details>`;
    }

    // ===== 제목 (사용자 지정 가능) =====
    let titleBlock;
    if (S.isEditingTitle) {
        titleBlock = `
            <div class="sim-detail-title-row">
                <input type="text" class="sim-title-edit-input" id="sim-title-edit-input"
                    value="${escapeHtml(sim.customTitle || getSimDisplayTitle(sim))}"
                    placeholder="비우면 기본 제목으로" />
                <button class="sim-btn-icon" id="sim-title-edit-save" title="저장"><i class="fa-solid fa-check"></i></button>
                <button class="sim-btn-icon" id="sim-title-edit-cancel" title="취소"><i class="fa-solid fa-xmark"></i></button>
            </div>`;
    } else {
        titleBlock = `
            <div class="sim-detail-title-row">
                <div class="sim-detail-title" title="${escapeHtml(getSimDisplayTitle(sim))}">${escapeHtml(getSimDisplayTitle(sim))}</div>
                <button class="sim-btn-icon" id="sim-edit-title-btn" title="제목 수정"><i class="fa-solid fa-pen"></i></button>
            </div>`;
    }

    // ===== 설정 요약 & 편집 패널 =====
    const simPresetLabel = sim.presetName || getCurrentPresetName() || '(없음)';
    const simTogglePresetRaw = sim.togglePresetName || 'default';
    const simTogglePresetLabel = simTogglePresetRaw === 'default' ? '기본' : simTogglePresetRaw;
    const togglesEnabledForDetail = isCustomPresetTogglesEnabled();
    const simPosition = normalizeSimPosition(sim.injectPosition);
    const positionSelectOptions = Object.entries(SIM_POSITION_LABELS).map(([v, l]) =>
        `<option value="${v}"${v === simPosition ? ' selected' : ''}>${escapeHtml(l)}</option>`
    ).join('');

    const summaryParts = [];
    summaryParts.push(`프리셋 <b>${escapeHtml(simPresetLabel)}</b>`);
    if (togglesEnabledForDetail) summaryParts.push(`토글 <b>${escapeHtml(simTogglePresetLabel)}</b>`);
    summaryParts.push(`위치 <b>${escapeHtml(SIM_POSITION_LABELS[simPosition])}</b>`);
    const swapBits = [];
    if (sim.swapCharUser) swapBits.push('{{char}}↔{{user}}');
    if (sim.swapPronouns) swapBits.push('대명사');
    if (swapBits.length) summaryParts.push(`<span style="color:var(--SmartThemeQuoteColor, #7c83ff);">✓ 스왑: <b>${swapBits.join(' + ')}</b></span>`);

    const settingsBoxContent = `
        <div class="sim-detail-prompt-header" id="sim-edit-settings-btn" style="cursor:pointer;">
            <div class="sim-detail-prompt-label" style="display:flex; align-items:center; gap:6px;">
                <i class="fa-solid fa-chevron-right sim-settings-arrow" id="sim-settings-arrow"></i>
                <span id="sim-detail-settings-summary">⚙ ${summaryParts.join(' / ')}</span>
            </div>
        </div>
        <div class="sim-detail-settings-edit" id="sim-detail-settings-edit" style="display:none; padding:8px 4px 4px; flex-direction:column; gap:8px;">
            <div>
                <label style="font-size:11px;">프리셋</label>
                <select class="sim-saved-prompts-select" id="sim-detail-preset-select"></select>
            </div>
            ${togglesEnabledForDetail ? `
            <div>
                <label style="font-size:11px;">토글 프리셋</label>
                <select class="sim-saved-prompts-select" id="sim-detail-toggle-preset-select"></select>
            </div>
            ` : ''}
            <div>
                <label style="font-size:11px;">주입 위치</label>
                <select class="sim-saved-prompts-select" id="sim-detail-position-select">
                    ${positionSelectOptions}
                </select>
            </div>
            <label class="sim-checkbox-label" style="display:flex; align-items:center; gap:6px; font-size:12px;">
                <input type="checkbox" id="sim-detail-swap-charuser" ${sim.swapCharUser ? 'checked' : ''} />
                <span>{{char}} ↔ {{user}} 교체</span>
            </label>
            <label class="sim-checkbox-label" style="display:flex; align-items:center; gap:6px; font-size:12px;">
                <input type="checkbox" id="sim-detail-swap-pronouns" ${sim.swapPronouns ? 'checked' : ''} />
                <span>대명사 교체 (he/she, him/her, ...)</span>
            </label>
        </div>`;

    const html = `
    <div class="sim-detail-view">
        <div class="sim-detail-topbar">
            <button class="sim-btn" id="sim-back-to-list">
                <i class="fa-solid fa-arrow-left"></i> 목록으로
            </button>
            ${titleBlock}
        </div>

        <div class="sim-detail-prompt-box">
            ${promptBoxContent}
        </div>

        <div class="sim-detail-prompt-box">
            ${settingsBoxContent}
        </div>

        <div class="sim-response-area">
            <div class="sim-response-header">
                <span style="font-size:12px; font-weight:600; color:var(--SmartThemeQuoteColor, #7c83ff);">응답</span>
                ${responseCount > 0 ? `
                <div class="sim-response-nav">
                    <button id="sim-prev-response" ${currentIdx <= 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>
                    <span class="sim-response-counter">${currentIdx + 1} / ${responseCount}</span>
                    <button id="sim-next-response" ${currentIdx >= responseCount - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button>
                </div>
                ` : ''}
            </div>
            ${responseCount > 0 ? `
            <div class="sim-response-actions-row">
                <button class="sim-btn-icon" id="sim-new-chat-btn" title="이 응답으로 새 챗 시작"><i class="fa-solid fa-comment-dots"></i> 새 챗</button>
                <button class="sim-btn-icon" id="sim-insert-chat-btn" title="이 응답을 기존 챗에 삽입"><i class="fa-solid fa-file-import"></i> 기존 챗</button>
                <button class="sim-btn-icon" id="sim-lorebook-btn" title="이 응답을 요약해 로어북 엔트리로"><i class="fa-solid fa-book"></i> 로어북</button>
                ${responseCount > 1 ? `<button class="sim-btn-icon sim-btn-icon-danger" id="sim-delete-response" title="이 답변 삭제"><i class="fa-solid fa-xmark"></i> 삭제</button>` : ''}
            </div>
            ` : ''}
            <div class="sim-response-text mes_text ${responseCount === 0 ? 'loading' : ''}" id="sim-response-display">
                ${responseCount === 0 ? '아직 응답이 없습니다...' : renderResponseParts(sim, currentIdx, S.editingPartIdx, false)}
            </div>
        </div>
    </div>`;

    container.innerHTML = html;

    // Footer
    const footer = document.getElementById('sim-footer');
    if (footer) {
        footer.classList.remove('hidden');
        footer.innerHTML = `
        <div class="sim-detail-actions">
            <button class="sim-btn sim-btn-sm sim-btn-danger" id="sim-delete-sim"><i class="fa-solid fa-trash"></i> 시뮬 삭제</button>
            ${responseCount > 0 ? `<button class="sim-btn sim-btn-sm" id="sim-continue"><i class="fa-solid fa-forward"></i> 이어쓰기</button>` : ''}
            <button class="sim-btn sim-btn-sm sim-btn-primary" id="sim-regenerate"><i class="fa-solid fa-rotate-right"></i> 답변 재생성</button>
        </div>`;
    }

    // 이벤트 바인딩
    document.getElementById('sim-back-to-list')?.addEventListener('click', goToList);

    // 설정 박스: 모든 변경 즉시 반영

    // 수정 관련 이벤트
    document.getElementById('sim-edit-prompt-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        S.isEditingPrompt = true;
        renderDetailView();
    });

    document.getElementById('sim-edit-cancel')?.addEventListener('click', () => {
        S.isEditingPrompt = false;
        renderDetailView();
    });

    document.getElementById('sim-edit-save')?.addEventListener('click', () => {
        const textarea = document.getElementById('sim-edit-prompt-input');
        if (!textarea) return;
        const newText = normalizePromptText(textarea.value.trim());
        if (!newText) {
            alert('내용을 입력해주세요.');
            return;
        }
        sim.promptText = newText;
        S.isEditingPrompt = false;
        saveSimulations();
        renderDetailView();
        if (typeof toastr !== 'undefined') toastr.success('시뮬 내용이 수정되었습니다.', '시뮬 매니저');
    });

    // ===== 제목 수정 =====
    document.getElementById('sim-edit-title-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        S.isEditingTitle = true;
        renderDetailView();
        const titleInput = document.getElementById('sim-title-edit-input');
        if (titleInput) {
            titleInput.focus();
            titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length);
        }
    });

    const saveTitle = () => {
        const input = document.getElementById('sim-title-edit-input');
        if (!input) return;
        const val = input.value.trim();
        if (val) sim.customTitle = val;
        else delete sim.customTitle; // 비우면 기존 프롬프트 제목으로 복귀
        S.isEditingTitle = false;
        if (!S.tempSim || S.tempSim.id !== sim.id) saveSimulations();
        renderDetailView();
        if (typeof toastr !== 'undefined') toastr.success('제목이 변경되었습니다.', '시뮬 매니저');
    };
    document.getElementById('sim-title-edit-save')?.addEventListener('click', saveTitle);
    document.getElementById('sim-title-edit-cancel')?.addEventListener('click', () => {
        S.isEditingTitle = false;
        renderDetailView();
    });
    document.getElementById('sim-title-edit-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); saveTitle(); }
        else if (e.key === 'Escape') { e.preventDefault(); S.isEditingTitle = false; renderDetailView(); }
    });

    // ===== 통합 설정 패널 =====
    const settingsEditBtn = document.getElementById('sim-edit-settings-btn');
    const settingsEditPanel = document.getElementById('sim-detail-settings-edit');
    const detailPresetSelect = document.getElementById('sim-detail-preset-select');
    const detailTogglePresetSelect = document.getElementById('sim-detail-toggle-preset-select');
    const detailPositionSelect = document.getElementById('sim-detail-position-select');
    const detailSwapCharUser = document.getElementById('sim-detail-swap-charuser');
    const detailSwapPronouns = document.getElementById('sim-detail-swap-pronouns');

    const saveSimIfNotTemp = () => { if (!S.tempSim || S.tempSim.id !== sim.id) saveSimulations(); };
    const refreshSummary = () => {
        const target = document.getElementById('sim-detail-settings-summary');
        if (!target) return;
        const parts = [];
        const presetLbl = sim.presetName || getCurrentPresetName() || '(없음)';
        parts.push(`프리셋 <b>${escapeHtml(presetLbl)}</b>`);
        if (togglesEnabledForDetail) {
            const tgl = sim.togglePresetName || 'default';
            parts.push(`토글 <b>${escapeHtml(tgl === 'default' ? '기본' : tgl)}</b>`);
        }
        const pos = normalizeSimPosition(sim.injectPosition);
        parts.push(`위치 <b>${escapeHtml(SIM_POSITION_LABELS[pos])}</b>`);
        const bits = [];
        if (sim.swapCharUser) bits.push('{{char}}↔{{user}}');
        if (sim.swapPronouns) bits.push('대명사');
        if (bits.length) parts.push(`<span style="color:var(--SmartThemeQuoteColor, #7c83ff);">✓ 스왑: <b>${bits.join(' + ')}</b></span>`);
        target.innerHTML = `⚙ ${parts.join(' / ')}`;
    };

    function fillDetailPresetOptions() {
        if (!detailPresetSelect) return;
        const presetNames = getAvailablePresetNames();
        const target = sim.presetName || getCurrentPresetName();
        detailPresetSelect.innerHTML = '';
        for (const n of presetNames) {
            const opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n;
            if (n === target) opt.selected = true;
            detailPresetSelect.appendChild(opt);
        }
    }
    function fillDetailTogglePresetOptions() {
        if (!detailTogglePresetSelect) return;
        const chosen = detailPresetSelect?.value || getCurrentPresetName();
        const names = getTogglePresetNames(chosen);
        const target = (chosen === (sim.presetName || getCurrentPresetName()))
            ? (sim.togglePresetName || 'default')
            : 'default';
        detailTogglePresetSelect.innerHTML = '';
        for (const n of names) {
            const opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n === 'default' ? '기본' : n;
            if (n === target) opt.selected = true;
            detailTogglePresetSelect.appendChild(opt);
        }
    }

    // 패널 토글 (화살표 포함)
    const settingsArrow = document.getElementById('sim-settings-arrow');
    settingsEditBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!settingsEditPanel) return;
        const isOpen = settingsEditPanel.style.display !== 'none';
        if (isOpen) {
            settingsEditPanel.style.display = 'none';
            if (settingsArrow) settingsArrow.classList.remove('fa-chevron-down'), settingsArrow.classList.add('fa-chevron-right');
            return;
        }
        fillDetailPresetOptions();
        fillDetailTogglePresetOptions();
        settingsEditPanel.style.display = 'flex';
        if (settingsArrow) settingsArrow.classList.remove('fa-chevron-right'), settingsArrow.classList.add('fa-chevron-down');
    });

    // 프리셋 변경 → 즉시 저장 + 토글 옵션 재갱신
    detailPresetSelect?.addEventListener('change', () => {
        sim.presetName = detailPresetSelect.value || '';
        // 프리셋이 바뀌면 토글은 default 로 초기화 (선택한 프리셋의 옵션이 달라지므로)
        sim.togglePresetName = 'default';
        fillDetailTogglePresetOptions();
        saveSimIfNotTemp();
        refreshSummary();
    });
    detailTogglePresetSelect?.addEventListener('change', () => {
        sim.togglePresetName = detailTogglePresetSelect.value || 'default';
        saveSimIfNotTemp();
        refreshSummary();
    });
    detailPositionSelect?.addEventListener('change', () => {
        sim.injectPosition = normalizeSimPosition(detailPositionSelect.value);
        saveSimIfNotTemp();
        refreshSummary();
    });
    detailSwapCharUser?.addEventListener('change', () => {
        sim.swapCharUser = !!detailSwapCharUser.checked;
        saveSimIfNotTemp();
        refreshSummary();
    });
    detailSwapPronouns?.addEventListener('change', () => {
        sim.swapPronouns = !!detailSwapPronouns.checked;
        saveSimIfNotTemp();
        refreshSummary();
    });

    // 새 챗으로 시작
    document.getElementById('sim-new-chat-btn')?.addEventListener('click', async () => {
        const responseText = getFullResponseText(sim, sim.currentIndex || 0);
        if (!responseText) return;
        showNewChatDialog(sim.promptText, responseText);
    });

    // 기존 챗에 삽입
    document.getElementById('sim-insert-chat-btn')?.addEventListener('click', async () => {
        const responseText = getFullResponseText(sim, sim.currentIndex || 0);
        if (!responseText) return;
        showInsertToChatDialog(sim.promptText, responseText);
    });

    // 로어북 엔트리로 저장
    document.getElementById('sim-lorebook-btn')?.addEventListener('click', () => {
        openLoreEntryDialogForSim(sim);
    });

    // 파트별 이벤트 위임 (수정/번역/삭제)
    const responseDisplay = document.getElementById('sim-response-display');
    if (responseDisplay) {
        responseDisplay.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const partIdx = parseInt(btn.dataset.part, 10);
            const key = String(currentIdx);

            switch (action) {
                case 'part-edit':
                    S.editingPartIdx = partIdx;
                    renderDetailView();
                    break;
                case 'part-edit-cancel':
                    S.editingPartIdx = null;
                    renderDetailView();
                    break;
                case 'part-edit-save': {
                    const textarea = document.getElementById(`sim-part-${partIdx}-edit-input`);
                    if (!textarea) return;
                    const newText = textarea.value.trim();
                    if (!newText) { alert('내용을 입력해주세요.'); return; }
                    if (partIdx === 0) {
                        sim.responses[currentIdx] = newText;
                    } else {
                        if (sim.continuations?.[key]) sim.continuations[key][partIdx - 1] = newText;
                    }
                    // 해당 파트 번역 캐시 무효화
                    if (sim.partTranslations?.[key]) delete sim.partTranslations[key][String(partIdx)];
                    S.editingPartIdx = null;
                    saveSimulations();
                    renderDetailView();
                    toastr.success('파트가 수정되었습니다.', '시뮬 매니저');
                    break;
                }
                case 'part-revision':
                    showPartRevisionDialog(sim, currentIdx, partIdx);
                    break;
                case 'part-copy':
                    copyTextToClipboard(getPartText(sim, currentIdx, partIdx));
                    break;
                case 'part-translate':
                    translatePart(sim, currentIdx, partIdx, renderDetailView);
                    break;
                case 'part-retranslate':
                    if (sim.partTranslations?.[key]) delete sim.partTranslations[key][String(partIdx)];
                    S.showTranslated = false;
                    translatePart(sim, currentIdx, partIdx, renderDetailView);
                    break;
                case 'part-delete': {
                    if (partIdx === 0) return; // base는 삭제 불가
                    if (!confirm('이 이어쓰기 파트를 삭제하시겠습니까?')) return;
                    const contIdx = partIdx - 1;
                    if (sim.continuations?.[key]) sim.continuations[key].splice(contIdx, 1);
                    if (sim.partTranslations?.[key]) delete sim.partTranslations[key][String(partIdx)];
                    saveSimulations();
                    renderDetailView();
                    toastr.success('파트가 삭제되었습니다.', '시뮬 매니저');
                    break;
                }
            }
        });
    }

    // 응답 네비게이션
    document.getElementById('sim-prev-response')?.addEventListener('click', () => {
        if (sim.currentIndex > 0) {
            sim.currentIndex--;
            S.editingPartIdx = null;
            S.showTranslated = false;
            saveSimulations();
            renderDetailView();
        }
    });

    document.getElementById('sim-next-response')?.addEventListener('click', () => {
        if (sim.currentIndex < sim.responses.length - 1) {
            sim.currentIndex++;
            S.editingPartIdx = null;
            S.showTranslated = false;
            saveSimulations();
            renderDetailView();
        }
    });

    document.getElementById('sim-continue')?.addEventListener('click', (e) => {
        if (e.currentTarget.dataset.simStop === '1') { stopSimGeneration(); return; }
        handleContinueSimulation(sim, sim.currentIndex || 0);
    });

    document.getElementById('sim-regenerate')?.addEventListener('click', (e) => {
        if (e.currentTarget.dataset.simStop === '1') { stopSimGeneration(); return; }
        handleRegenerateSimulation(sim);
    });

    document.getElementById('sim-delete-sim')?.addEventListener('click', () => {
        if (confirm('이 시뮬레이션을 삭제하시겠습니까?')) {
            const idx = sims.findIndex(s => s.id === sim.id);
            if (idx !== -1) {
                sims.splice(idx, 1);
                saveSimulations();
                goToList();
            }
        }
    });

    document.getElementById('sim-delete-response')?.addEventListener('click', () => {
        if (confirm('현재 보고 있는 답변을 삭제하시겠습니까?')) {
            const delKey = String(sim.currentIndex);
            sim.responses.splice(sim.currentIndex, 1);
            if (sim.translations) delete sim.translations[delKey];
            if (sim.continuations) delete sim.continuations[delKey];
            if (sim.partTranslations) delete sim.partTranslations[delKey];
            if (sim.currentIndex >= sim.responses.length) {
                sim.currentIndex = Math.max(0, sim.responses.length - 1);
            }
            saveSimulations();
            renderDetailView();
        }
    });

}

// ============================================
// 응답 파트 렌더러 (상세 뷰 + 모아보기 상세 뷰 공용)
// ============================================
/**
 * 원본 응답 + continuation 파트들을 각각 별도 div로 렌더링.
 * 각 파트마다 수정/번역/삭제 액션을 독립 제공.
 * @param {object} sim
 * @param {number} responseIdx
 * @param {number|null} currentEditPart - 현재 수정 중인 파트 인덱스
 * @param {boolean} isGlobal
 */
export function renderResponseParts(sim, responseIdx, currentEditPart = null, isGlobal = false) {
    const base = sim.responses[responseIdx] || '';
    const conts = sim.continuations?.[String(responseIdx)] || [];
    const parts = [base, ...conts];
    const prefix = isGlobal ? 'sim-gv' : 'sim';

    return parts.map((part, partIdx) => {
        const isCont = partIdx > 0;
        const partKey = `${prefix}-part-${partIdx}`;

        // 모아보기는 읽기 전용이라 수정 모드로 들어오지 않는다.
        if (!isGlobal && currentEditPart === partIdx) {
            // 수정 모드
            return `<div class="sim-response-part" data-part-idx="${partIdx}">
                <textarea class="sim-edit-response-textarea" id="${partKey}-edit-input">${escapeHtml(part)}</textarea>
                <div class="sim-edit-prompt-actions">
                    <button class="sim-btn" data-action="part-edit-cancel" data-part="${partIdx}">취소</button>
                    <button class="sim-btn sim-btn-primary" data-action="part-edit-save" data-part="${partIdx}">저장</button>
                </div>
            </div>`;
        }

        // 파트별 번역 텍스트 확인
        const partTranslations = sim.partTranslations?.[String(responseIdx)];
        const hasTranslation = partTranslations?.[String(partIdx)];
        const displayText = (S.showTranslated && hasTranslation) ? hasTranslation : part;

        // 액션 버튼
        ensureSettings();
        const translationOn = extension_settings[EXTENSION_NAME].translationEnabled;
        const isThisPartTranslating = S.isTranslating && S.translatingPartIdx === partIdx;
        let translateBtn = '';
        if (translationOn) {
            if (isThisPartTranslating) {
                translateBtn = `<button class="sim-btn-icon sim-btn-icon-sm" disabled><i class="fa-solid fa-spinner fa-spin"></i> 번역 중</button>`;
            } else if (hasTranslation) {
                translateBtn = `
                    <button class="sim-btn-icon sim-btn-icon-sm" data-action="part-translate" data-part="${partIdx}" title="${S.showTranslated ? '원문 보기' : '번역 보기'}"><i class="fa-solid fa-language"></i> ${S.showTranslated ? '원문' : '번역'}</button>
                    <button class="sim-btn-icon sim-btn-icon-sm" data-action="part-retranslate" data-part="${partIdx}" title="재번역"><i class="fa-solid fa-rotate-right"></i> 재번역</button>`;
            } else {
                translateBtn = `<button class="sim-btn-icon sim-btn-icon-sm" data-action="part-translate" data-part="${partIdx}" title="번역"><i class="fa-solid fa-language"></i></button>`;
            }
        }
        // 모아보기(isGlobal)는 읽기 전용 — 내용을 바꾸는 버튼은 내보내지 않는다.
        // 예전엔 isGlobal 이 id 접두사만 바꿔서, 디테일 뷰에 파트 기능을 추가할 때마다
        // 모아보기에도 그대로 딸려 들어갔다. 거기서 한 수정은 채팅 파일에 안 남는다.
        // 이미 저장돼 있는 번역문을 보는 건 수정이 아니라 읽기 전용에서도 허용한다.
        // (새로 번역하는 part-translate 만 뺀다 — 그 결과는 채팅 파일에 안 남으니까)
        const viewTranslationBtn = hasTranslation
            ? `<button class="sim-btn-icon sim-btn-icon-sm" data-action="part-view-translation" data-part="${partIdx}" title="${S.showTranslated ? '원문 보기' : '번역 보기'}"><i class="fa-solid fa-language"></i> ${S.showTranslated ? '원문' : '번역'}</button>`
            : '';
        const actions = isGlobal
            ? `<div class="sim-part-actions">
            ${viewTranslationBtn}
            <button class="sim-btn-icon sim-btn-icon-sm" data-action="part-copy" data-part="${partIdx}" title="복사"><i class="fa-solid fa-copy"></i></button>
        </div>`
            : `<div class="sim-part-actions">
            <button class="sim-btn-icon sim-btn-icon-sm" data-action="part-edit" data-part="${partIdx}" title="수정"><i class="fa-solid fa-pen"></i></button>
            <button class="sim-btn-icon sim-btn-icon-sm" data-action="part-revision" data-part="${partIdx}" title="통제광"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
            <button class="sim-btn-icon sim-btn-icon-sm" data-action="part-copy" data-part="${partIdx}" title="복사"><i class="fa-solid fa-copy"></i></button>
            ${translateBtn}
            ${isCont ? `<button class="sim-btn-icon sim-btn-icon-sm sim-btn-icon-danger" data-action="part-delete" data-part="${partIdx}" title="삭제"><i class="fa-solid fa-xmark"></i></button>` : ''}
        </div>`;

        return `<div class="sim-response-part" data-part-idx="${partIdx}">
            ${actions}
            <div class="sim-response-part-text">${renderResponseText(displayText)}</div>
        </div>`;
    }).join('');
}

/**
 * 특정 파트의 텍스트 반환. 번역 보기 상태면 번역문, 아니면 원문.
 */
export function getPartText(sim, responseIdx, partIdx) {
    const base = sim.responses[responseIdx] || '';
    const conts = sim.continuations?.[String(responseIdx)] || [];
    const parts = [base, ...conts];
    const original = parts[partIdx] || '';
    const translated = sim.partTranslations?.[String(responseIdx)]?.[String(partIdx)];
    return (S.showTranslated && translated) ? translated : original;
}
