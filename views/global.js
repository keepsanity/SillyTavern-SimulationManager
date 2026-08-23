/**
 * 모아보기: 전체 채팅방 목록 → 방별 시뮬 목록 → 시뮬 상세.
 *
 * 읽기 전용이다. 목록은 설정에 저장된 인덱스(방 이름·개수·최신시각)만 보고 그리고,
 * 시뮬 본문은 방을 펼칠 때 그 채팅 파일 하나만 읽어 온다.
 */
import { EXTENSION_NAME } from '../constants.js';
import {
    escapeHtml,
    normalizePromptText,
    copyTextToClipboard,
} from '../utils.js';
import { extension_settings } from '../../../../extensions.js';
import { ensureSettings } from '../config.js';
import { S } from '../state.js';
import {
    getSimDisplayTitle,
    getGlobalIndex,
    loadSimsForChat,
    scanAllChatsForSimulations,
    exportSimBackup,
    cleanupGlobalCache,
} from '../store.js';
import { maybeResetContentScroll } from '../popup.js';
import {
    getPartText,
    renderResponseParts,
} from './detail.js';

/**
 * 지금 펼쳐 놓은 방의 시뮬 본문. 목록 → 상세를 오갈 때 매번 다시 읽지 않으려고 붙들어 둔다.
 * 방을 벗어나면 버린다 (설정에는 절대 안 들어간다).
 */
let viewSims = [];
let viewSimsKey = null;

function releaseViewSims() {
    viewSims = [];
    viewSimsKey = null;
}

function renderLoading(message) {
    const container = document.getElementById('sim-content');
    if (container) {
        container.innerHTML = `
            <div class="sim-empty">
                <i class="fa-solid fa-spinner fa-spin" style="font-size:28px; margin-bottom:12px; opacity:0.5;"></i>
                <br>${escapeHtml(message)}
            </div>`;
    }
    const footer = document.getElementById('sim-footer');
    if (footer) { footer.innerHTML = ''; footer.classList.add('hidden'); }
}

function withBusyButton(id, label, fn) {
    const btn = document.getElementById(id);
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`;
    }
    return fn();
}

/**
 * 스캔 한 번 돌리고 결과를 알린다. 모아보기의 새로고침 버튼과 설정 패널의 첫 진입이
 * 같은 문구를 써야 해서 여기 모아 둔다.
 * 일부 채팅을 못 읽었으면 그 사실을 알린다 — 조용히 넘기면 방이 비어 보이는 이유를 알 수 없다.
 */
export async function rescanWithFeedback() {
    const { total, complete } = await scanAllChatsForSimulations();
    if (typeof toastr === 'undefined') return;

    if (total < 0) {
        toastr.error('스캔에 실패했습니다.', '시뮬 매니저');
    } else if (complete) {
        toastr.info(`${total}개의 시뮬레이션을 찾았습니다.`, '시뮬 매니저');
    } else {
        toastr.warning(`${total}개를 찾았지만 일부 채팅을 읽지 못했습니다. 비어 보이는 방은 새로고침으로 다시 시도해 주세요.`, '시뮬 매니저');
    }
}

// ============================================
// 1단계: 채팅방 목록
// ============================================
export function renderGlobalListView() {
    const container = document.getElementById('sim-content');
    if (!container) return;
    maybeResetContentScroll('globalList');
    releaseViewSims();

    const index = getGlobalIndex();
    // 각 방의 가장 최근 시뮬 시각 기준 최신순
    const chatKeys = Object.keys(index)
        .filter(k => (index[k]?.count || 0) > 0)
        .sort((a, b) => (index[b]?.lastAt || 0) - (index[a]?.lastAt || 0));

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
            const data = index[key];
            html += `
            <div class="sim-global-chat-item" data-chat-key="${escapeHtml(key)}">
                <div class="sim-global-chat-name">
                    <i class="fa-solid fa-user"></i> ${escapeHtml(data.chatName || key)}
                </div>
                <div class="sim-global-chat-meta">
                    <span class="sim-global-chat-count">${data.count}개</span>
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
    document.getElementById('sim-global-rescan')?.addEventListener('click', () =>
        withBusyButton('sim-global-rescan', '스캔 중...', async () => {
            await rescanWithFeedback();
            renderGlobalListView();
        }));

    // 백업(내보내기) 버튼
    document.getElementById('sim-global-export')?.addEventListener('click', () =>
        withBusyButton('sim-global-export', '백업 중...', async () => {
            const count = await exportSimBackup();
            if (typeof toastr !== 'undefined') {
                if (count >= 0) toastr.success(`${count}개 시뮬을 백업 파일로 내보냈습니다.`, '시뮬 매니저');
                else toastr.error('백업에 실패했습니다.', '시뮬 매니저');
            }
            renderGlobalListView();
        }));

    // 정리(인덱스 클린업) 버튼
    document.getElementById('sim-global-cleanup')?.addEventListener('click', () =>
        withBusyButton('sim-global-cleanup', '정리 중...', async () => {
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
        }));

    // 채팅방 클릭 → 해당 채팅의 시뮬 목록
    container.querySelectorAll('.sim-global-chat-item').forEach(el => {
        el.addEventListener('click', () => {
            S.globalViewChatKey = el.dataset.chatKey;
            S.currentView = 'globalSimList';
            renderGlobalSimListView();
        });
    });
}

// ============================================
// 2단계: 방별 시뮬 목록 (여기서 본문을 읽어 온다)
// ============================================
export async function renderGlobalSimListView() {
    const container = document.getElementById('sim-content');
    if (!container) return;

    const chatKey = S.globalViewChatKey;
    const entry = getGlobalIndex()[chatKey];
    if (!entry) {
        S.currentView = 'globalList';
        renderGlobalListView();
        return;
    }

    if (viewSimsKey !== chatKey) {
        renderLoading(`${entry.chatName || chatKey} 불러오는 중...`);
        const sims = await loadSimsForChat(chatKey);
        // 로딩 도중 사용자가 다른 데로 갔으면 그 화면을 덮지 않는다.
        if (S.globalViewChatKey !== chatKey || S.currentView !== 'globalSimList') return;
        viewSims = sims;
        viewSimsKey = chatKey;
    }

    maybeResetContentScroll('globalSimList', chatKey);

    let html = `<div class="sim-global-list-view">`;
    html += `<button class="sim-btn" id="sim-back-to-global-list" style="align-self:flex-start;">
        <i class="fa-solid fa-arrow-left"></i> 채팅 목록으로
    </button>`;
    html += `<div class="sim-global-chat-badge">
        <i class="fa-solid fa-user"></i> ${escapeHtml(entry.chatName || chatKey)}
    </div>`;

    const sorted = [...viewSims].reverse();
    if (sorted.length === 0) {
        html += `<div class="sim-empty">시뮬레이션을 불러오지 못했습니다.<br>새로고침으로 다시 스캔해 주세요.</div>`;
    } else {
        ensureSettings();
        const savedPrompts = extension_settings[EXTENSION_NAME].savedPrompts;
        for (const sim of sorted) {
            const responseCount = sim.responses ? sim.responses.length : 0;
            const date = new Date(sim.createdAt).toLocaleString();
            const found = savedPrompts.find(p => p.content === sim.promptText);
            const displayName = getSimDisplayTitle(found && !sim.customTitle ? { ...sim, promptName: found.name } : sim);
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

// ============================================
// 3단계: 시뮬 상세 (읽기 전용)
// ============================================
export function renderGlobalDetailView() {
    const container = document.getElementById('sim-content');
    if (!container) return;

    const chatKey = S.globalViewChatKey;
    const entry = getGlobalIndex()[chatKey];
    if (!entry || viewSimsKey !== chatKey) {
        S.currentView = 'globalList';
        renderGlobalListView();
        return;
    }

    const sim = viewSims.find(s => s.id === S.globalViewSimId);
    if (!sim) {
        S.currentView = 'globalSimList';
        renderGlobalSimListView();
        return;
    }
    maybeResetContentScroll('globalDetail', sim.id);

    const responseCount = sim.responses ? sim.responses.length : 0;
    const currentIdx = S.globalViewSimIndex || 0;

    const html = `
    <div class="sim-detail-view">
        <button class="sim-btn" id="sim-back-to-global-simlist" style="align-self:flex-start;">
            <i class="fa-solid fa-arrow-left"></i> 시뮬 목록으로
        </button>

        <div class="sim-global-chat-badge">
            <i class="fa-solid fa-user"></i> ${escapeHtml(entry.chatName || chatKey)}
        </div>

        <div class="sim-detail-prompt-box">
            <details class="sim-prompt-toggle">
                <summary class="sim-detail-prompt-header">
                    <div class="sim-detail-prompt-label"><i class="fa-solid fa-chevron-right sim-prompt-arrow"></i> 시뮬 요청</div>
                </summary>
                <div class="sim-detail-prompt-text">${escapeHtml(normalizePromptText(sim.promptText))}</div>
            </details>
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
            <div class="sim-response-text mes_text ${responseCount === 0 ? 'loading' : ''}" id="sim-gv-response-display">
                ${responseCount === 0 ? '응답 없음' : renderResponseParts(sim, currentIdx, null, true)}
            </div>
        </div>

        <div class="sim-readonly-note">
            <i class="fa-solid fa-circle-info"></i> 모아보기는 읽기 전용입니다. 수정하려면 해당 채팅방에서 여세요.
        </div>
    </div>`;

    container.innerHTML = html;

    const footer = document.getElementById('sim-footer');
    if (footer) { footer.innerHTML = ''; footer.classList.add('hidden'); }

    // 이벤트
    document.getElementById('sim-back-to-global-simlist')?.addEventListener('click', () => {
        S.currentView = 'globalSimList';
        renderGlobalSimListView();
    });

    document.getElementById('sim-gv-prev')?.addEventListener('click', () => {
        if (S.globalViewSimIndex > 0) {
            S.globalViewSimIndex--;
            renderGlobalDetailView();
        }
    });

    document.getElementById('sim-gv-next')?.addEventListener('click', () => {
        if (S.globalViewSimIndex < responseCount - 1) {
            S.globalViewSimIndex++;
            renderGlobalDetailView();
        }
    });

    // 읽기 전용 — 복사와, 이미 저장돼 있는 번역문 보기만.
    document.getElementById('sim-gv-response-display')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const partIdx = parseInt(btn.dataset.part, 10);

        switch (btn.dataset.action) {
            case 'part-copy':
                copyTextToClipboard(getPartText(sim, currentIdx, partIdx));
                break;
            case 'part-view-translation':
                // 저장된 번역문 ↔ 원문 전환. 새로 번역하지는 않는다.
                S.showTranslated = !S.showTranslated;
                renderGlobalDetailView();
                break;
        }
    });
}
