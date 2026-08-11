/**
 * 모아보기: 전체 채팅방 목록 → 방별 시뮬 목록 → 시뮬 상세.
 */
import { extension_settings } from '../../../../extensions.js';
import {
    saveSettingsDebounced,
    chat,
} from '../../../../../script.js';
import { EXTENSION_NAME } from '../constants.js';
import {
    escapeHtml,
    normalizePromptText,
    copyTextToClipboard,
} from '../utils.js';
import { ensureSettings } from '../config.js';
import { S } from '../state.js';
import {
    getSimDisplayTitle,
    scanAllChatsForSimulations,
    exportSimBackup,
    cleanupGlobalCache,
} from '../store.js';
import { showPartRevisionDialog } from '../generation.js';
import { maybeResetContentScroll } from '../popup.js';
import { translatePart } from '../translate.js';
import {
    getPartText,
    renderResponseParts,
} from './detail.js';

export function renderGlobalListView() {
    const container = document.getElementById('sim-content');
    if (!container) return;
    maybeResetContentScroll('globalList');

    ensureSettings();
    const global = extension_settings[EXTENSION_NAME].globalSimulations;
    // 각 방의 가장 최근 시뮬 createdAt 기준 최신순 정렬
    const latestCreatedAt = (data) => {
        const sims = data?.simulations || [];
        let m = 0;
        for (const s of sims) {
            if (typeof s.createdAt === 'number' && s.createdAt > m) m = s.createdAt;
        }
        return m;
    };
    const chatKeys = Object.keys(global).sort((a, b) => latestCreatedAt(global[b]) - latestCreatedAt(global[a]));

    let html = `<div class="sim-global-list-view">`;
    html += `<div class="sim-global-title">
        <span><i class="fa-solid fa-layer-group"></i> 전체 시뮬레이션 모아보기</span>
        <span class="sim-global-actions">
            <button class="sim-btn sim-btn-sm" id="sim-global-export" title="전체 시뮬을 JSON 파일로 백업"><i class="fa-solid fa-download"></i> 백업</button>
            <button class="sim-btn sim-btn-sm" id="sim-global-cleanup" title="삭제된 채팅·빈 항목 정리"><i class="fa-solid fa-broom"></i> 정리</button>
            <button class="sim-btn sim-btn-sm" id="sim-global-rescan" title="다시 스캔"><i class="fa-solid fa-arrows-rotate"></i> 새로고침</button>
        </span>
    </div>`;

    if (chatKeys.length === 0) {
        html += `<div class="sim-empty"><i class="fa-solid fa-inbox" style="font-size:32px; margin-bottom:12px; opacity:0.3;"></i><br>저장된 시뮬레이션이 없습니다.</div>`;
    } else {
        for (const key of chatKeys) {
            const data = global[key];
            const simCount = data.simulations ? data.simulations.length : 0;
            if (simCount === 0) continue;

            html += `
            <div class="sim-global-chat-item" data-chat-key="${escapeHtml(key)}">
                <div class="sim-global-chat-name">
                    <i class="fa-solid fa-user"></i> ${escapeHtml(data.chatName)}
                </div>
                <div class="sim-global-chat-meta">
                    <span class="sim-global-chat-count">${simCount}개</span>
                    <i class="fa-solid fa-chevron-right"></i>
                </div>
            </div>`;
        }
    }
    html += `</div>`;
    container.innerHTML = html;

    const footer = document.getElementById('sim-footer');
    if (footer) { footer.innerHTML = ''; footer.classList.add('hidden'); }

    // 새로고침 버튼
    document.getElementById('sim-global-rescan')?.addEventListener('click', async () => {
        const btn = document.getElementById('sim-global-rescan');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 스캔 중...';
        }
        const result = await scanAllChatsForSimulations();
        if (result >= 0 && typeof toastr !== 'undefined') {
            toastr.info(`${result}개의 시뮬레이션을 찾았습니다.`, '시뮬 매니저');
        }
        renderGlobalListView();
    });

    // 백업(내보내기) 버튼
    document.getElementById('sim-global-export')?.addEventListener('click', async () => {
        const btn = document.getElementById('sim-global-export');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 백업 중...';
        }
        const count = await exportSimBackup();
        if (typeof toastr !== 'undefined') {
            if (count >= 0) toastr.success(`${count}개 시뮬을 백업 파일로 내보냈습니다.`, '시뮬 매니저');
            else toastr.error('백업에 실패했습니다.', '시뮬 매니저');
        }
        renderGlobalListView();
    });

    // 정리(캐시 클린업) 버튼
    document.getElementById('sim-global-cleanup')?.addEventListener('click', async () => {
        const btn = document.getElementById('sim-global-cleanup');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 정리 중...';
        }
        const { removedEmpty, removedGone, prunedGone } = await cleanupGlobalCache();
        if (typeof toastr !== 'undefined') {
            const total = removedEmpty + removedGone;
            if (total === 0) {
                toastr.info('정리할 항목이 없습니다.', '시뮬 매니저');
            } else {
                let msg = `${total}개 항목 정리됨 (빈 항목 ${removedEmpty}, 삭제된 채팅 ${removedGone})`;
                if (!prunedGone) msg += ' · 일부 채팅 목록을 못 읽어 유령 항목 정리는 건너뜀';
                toastr.success(msg, '시뮬 매니저');
            }
        }
        renderGlobalListView();
    });

    // 채팅방 클릭 → 해당 채팅의 시뮬 목록
    container.querySelectorAll('.sim-global-chat-item').forEach(el => {
        el.addEventListener('click', () => {
            S.globalViewChatKey = el.dataset.chatKey;
            S.currentView = 'globalSimList';
            renderGlobalSimListView();
        });
    });
}

export function renderGlobalSimListView() {
    const container = document.getElementById('sim-content');
    if (!container) return;
    maybeResetContentScroll('globalSimList', S.globalViewChatKey);

    ensureSettings();
    const global = extension_settings[EXTENSION_NAME].globalSimulations;
    const chatData = global[S.globalViewChatKey];
    if (!chatData) {
        S.currentView = 'globalList';
        renderGlobalListView();
        return;
    }

    let html = `<div class="sim-global-list-view">`;
    html += `<button class="sim-btn" id="sim-back-to-global-list" style="align-self:flex-start;">
        <i class="fa-solid fa-arrow-left"></i> 채팅 목록으로
    </button>`;
    html += `<div class="sim-global-chat-badge">
        <i class="fa-solid fa-user"></i> ${escapeHtml(chatData.chatName)}
    </div>`;

    const sorted = [...chatData.simulations].reverse();
    if (sorted.length === 0) {
        html += `<div class="sim-empty">시뮬레이션이 없습니다.</div>`;
    } else {
        ensureSettings();
        const savedPrompts = extension_settings[EXTENSION_NAME].savedPrompts;
        for (const sim of sorted) {
            const responseCount = sim.responses ? sim.responses.length : 0;
            const date = new Date(sim.createdAt).toLocaleString();
            const found = savedPrompts.find(p => p.content === sim.promptText);
            if (found && sim.promptName !== found.name) {
                sim.promptName = found.name;
            }
            const displayName = getSimDisplayTitle(sim);
            html += `
                <div class="sim-item sim-global-item" data-sim-id="${sim.id}">
                    <div class="sim-item-prompt">${escapeHtml(displayName)}</div>
                    <div class="sim-item-meta">
                        <span>${date}</span>
                        <span>답변 ${responseCount}개</span>
                    </div>
                </div>`;
        }
    }
    html += `</div>`;
    container.innerHTML = html;

    const footer = document.getElementById('sim-footer');
    if (footer) { footer.innerHTML = ''; footer.classList.add('hidden'); }

    // 뒤로가기
    document.getElementById('sim-back-to-global-list')?.addEventListener('click', () => {
        S.currentView = 'globalList';
        renderGlobalListView();
    });

    // 시뮬 클릭 → 글로벌 디테일
    container.querySelectorAll('.sim-global-item').forEach(el => {
        el.addEventListener('click', () => {
            S.globalViewSimId = el.dataset.simId;
            S.globalViewSimIndex = 0;
            S.currentView = 'globalDetail';
            renderGlobalDetailView();
        });
    });
}

export function renderGlobalDetailView() {
    const container = document.getElementById('sim-content');
    if (!container) return;

    ensureSettings();
    const global = extension_settings[EXTENSION_NAME].globalSimulations;
    const chatData = global[S.globalViewChatKey];
    if (!chatData) {
        S.currentView = 'globalList';
        renderGlobalListView();
        return;
    }

    const sim = chatData.simulations.find(s => s.id === S.globalViewSimId);
    if (!sim) {
        S.currentView = 'globalList';
        renderGlobalListView();
        return;
    }
    maybeResetContentScroll('globalDetail', sim.id);

    const responseCount = sim.responses ? sim.responses.length : 0;
    const currentIdx = S.globalViewSimIndex || 0;

    // 프롬프트 영역
    let promptBoxContent;
    if (S.isEditingGlobalPrompt) {
        promptBoxContent = `
            <div class="sim-detail-prompt-label">시뮬 요청 <span style="font-size:10px; color:#888;">(수정 중)</span></div>
            <textarea class="sim-edit-prompt-textarea" id="sim-gv-edit-prompt-input">${escapeHtml(normalizePromptText(sim.promptText))}</textarea>
            <div class="sim-edit-prompt-actions">
                <button class="sim-btn" id="sim-gv-edit-cancel">취소</button>
                <button class="sim-btn sim-btn-primary" id="sim-gv-edit-save">저장</button>
            </div>`;
    } else {
        promptBoxContent = `
            <details class="sim-prompt-toggle">
                <summary class="sim-detail-prompt-header">
                    <div class="sim-detail-prompt-label"><i class="fa-solid fa-chevron-right sim-prompt-arrow"></i> 시뮬 요청</div>
                    <button class="sim-btn-icon" id="sim-gv-edit-prompt-btn" title="수정"><i class="fa-solid fa-pen"></i> 수정</button>
                </summary>
                <div class="sim-detail-prompt-text">${escapeHtml(normalizePromptText(sim.promptText))}</div>
            </details>`;
    }

    const html = `
    <div class="sim-detail-view">
        <button class="sim-btn" id="sim-back-to-global-simlist" style="align-self:flex-start;">
            <i class="fa-solid fa-arrow-left"></i> 시뮬 목록으로
        </button>

        <div class="sim-global-chat-badge">
            <i class="fa-solid fa-user"></i> ${escapeHtml(chatData.chatName)}
        </div>

        <div class="sim-detail-prompt-box">
            ${promptBoxContent}
        </div>

        <div class="sim-response-area">
            <div class="sim-response-header">
                <span style="font-size:12px; font-weight:600; color:var(--SmartThemeQuoteColor, #7c83ff);">응답</span>
                ${responseCount > 0 ? `
                <div class="sim-response-nav">
                    <button id="sim-gv-prev" ${currentIdx <= 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>
                    <span class="sim-response-counter">${currentIdx + 1} / ${responseCount}</span>
                    <button id="sim-gv-next" ${currentIdx >= responseCount - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button>
                </div>
                ` : ''}
            </div>
            ${responseCount > 1 ? `
            <div class="sim-response-actions-row">
                <button class="sim-btn-icon sim-btn-icon-danger" id="sim-gv-delete-response" title="이 답변 삭제"><i class="fa-solid fa-xmark"></i> 삭제</button>
            </div>
            ` : ''}
            <div class="sim-response-text mes_text ${responseCount === 0 ? 'loading' : ''}" id="sim-gv-response-display">
                ${responseCount === 0 ? '응답 없음' : renderResponseParts(sim, currentIdx, S.editingGlobalPartIdx, true)}
            </div>
        </div>
    </div>`;

    container.innerHTML = html;

    // Footer - 시뮬 삭제만
    const footer = document.getElementById('sim-footer');
    if (footer) {
        footer.classList.remove('hidden');
        footer.innerHTML = `
        <div class="sim-detail-actions">
            <button class="sim-btn sim-btn-sm sim-btn-danger" id="sim-gv-delete-sim"><i class="fa-solid fa-trash"></i> 시뮬 삭제</button>
        </div>`;
    }

    // 이벤트
    document.getElementById('sim-back-to-global-simlist')?.addEventListener('click', () => {
        S.currentView = 'globalSimList';
        S.isEditingGlobalPrompt = false;
        S.editingGlobalPartIdx = null;
        renderGlobalSimListView();
    });

    document.getElementById('sim-gv-prev')?.addEventListener('click', () => {
        if (S.globalViewSimIndex > 0) {
            S.globalViewSimIndex--;
            S.editingGlobalPartIdx = null;
            S.showTranslated = false;
            renderGlobalDetailView();
        }
    });

    document.getElementById('sim-gv-next')?.addEventListener('click', () => {
        if (S.globalViewSimIndex < responseCount - 1) {
            S.globalViewSimIndex++;
            S.editingGlobalPartIdx = null;
            S.showTranslated = false;
            renderGlobalDetailView();
        }
    });

    // 프롬프트 수정
    document.getElementById('sim-gv-edit-prompt-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        S.isEditingGlobalPrompt = true;
        renderGlobalDetailView();
    });

    document.getElementById('sim-gv-edit-cancel')?.addEventListener('click', () => {
        S.isEditingGlobalPrompt = false;
        renderGlobalDetailView();
    });

    document.getElementById('sim-gv-edit-save')?.addEventListener('click', () => {
        const textarea = document.getElementById('sim-gv-edit-prompt-input');
        if (!textarea) return;
        const newText = normalizePromptText(textarea.value.trim());
        if (!newText) { alert('내용을 입력해주세요.'); return; }
        sim.promptText = newText;
        S.isEditingGlobalPrompt = false;
        saveSettingsDebounced();
        renderGlobalDetailView();
        if (typeof toastr !== 'undefined') toastr.success('시뮬 내용이 수정되었습니다.', '시뮬 매니저');
    });

    // 파트별 이벤트 위임 (글로벌)
    const gvResponseDisplay = document.getElementById('sim-gv-response-display');
    if (gvResponseDisplay) {
        gvResponseDisplay.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const partIdx = parseInt(btn.dataset.part, 10);
            const key = String(currentIdx);

            switch (action) {
                case 'part-edit':
                    S.editingGlobalPartIdx = partIdx;
                    renderGlobalDetailView();
                    break;
                case 'part-edit-cancel':
                    S.editingGlobalPartIdx = null;
                    renderGlobalDetailView();
                    break;
                case 'part-edit-save': {
                    const textarea = document.getElementById(`sim-gv-part-${partIdx}-edit-input`);
                    if (!textarea) return;
                    const newText = textarea.value.trim();
                    if (!newText) { alert('내용을 입력해주세요.'); return; }
                    if (partIdx === 0) {
                        sim.responses[currentIdx] = newText;
                    } else {
                        if (sim.continuations?.[key]) sim.continuations[key][partIdx - 1] = newText;
                    }
                    if (sim.partTranslations?.[key]) delete sim.partTranslations[key][String(partIdx)];
                    S.editingGlobalPartIdx = null;
                    saveSettingsDebounced();
                    renderGlobalDetailView();
                    toastr.success('파트가 수정되었습니다.', '시뮬 매니저');
                    break;
                }
                case 'part-revision':
                    showPartRevisionDialog(sim, currentIdx, partIdx, true);
                    break;
                case 'part-copy':
                    copyTextToClipboard(getPartText(sim, currentIdx, partIdx));
                    break;
                case 'part-translate':
                    translatePart(sim, currentIdx, partIdx, renderGlobalDetailView);
                    break;
                case 'part-retranslate':
                    if (sim.partTranslations?.[key]) delete sim.partTranslations[key][String(partIdx)];
                    S.showTranslated = false;
                    translatePart(sim, currentIdx, partIdx, renderGlobalDetailView);
                    break;
                case 'part-delete': {
                    if (partIdx === 0) return;
                    if (!confirm('이 이어쓰기 파트를 삭제하시겠습니까?')) return;
                    const contIdx = partIdx - 1;
                    if (sim.continuations?.[key]) sim.continuations[key].splice(contIdx, 1);
                    if (sim.partTranslations?.[key]) delete sim.partTranslations[key][String(partIdx)];
                    saveSettingsDebounced();
                    renderGlobalDetailView();
                    toastr.success('파트가 삭제되었습니다.', '시뮬 매니저');
                    break;
                }
            }
        });
    }

    // 답변 삭제
    document.getElementById('sim-gv-delete-response')?.addEventListener('click', () => {
        if (confirm('현재 보고 있는 답변을 삭제하시겠습니까?')) {
            sim.responses.splice(currentIdx, 1);
            if (sim.translations) delete sim.translations[String(currentIdx)];
            if (sim.continuations) delete sim.continuations[String(currentIdx)];
            if (sim.partTranslations) delete sim.partTranslations[String(currentIdx)];
            if (S.globalViewSimIndex >= sim.responses.length) {
                S.globalViewSimIndex = Math.max(0, sim.responses.length - 1);
            }
            saveSettingsDebounced();
            renderGlobalDetailView();
        }
    });

    // 시뮬 삭제
    document.getElementById('sim-gv-delete-sim')?.addEventListener('click', () => {
        if (confirm('이 시뮬레이션을 삭제하시겠습니까?')) {
            const idx = chatData.simulations.findIndex(s => s.id === sim.id);
            if (idx !== -1) {
                chatData.simulations.splice(idx, 1);
                if (chatData.simulations.length === 0) {
                    delete global[S.globalViewChatKey];
                    S.currentView = 'globalList';
                    renderGlobalListView();
                } else {
                    S.currentView = 'globalSimList';
                    renderGlobalSimListView();
                }
                saveSettingsDebounced();
            }
        }
    });
}
