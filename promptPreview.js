/**
 * SillyTavern - Simulation Manager
 * 전송 전 프롬프트 확인.
 *
 * 시뮬 생성이 실제로 API 로 나가기 직전, 조립이 끝난 최종 프롬프트를 그대로 보여주고
 * [전송] / [취소] 를 고르게 한다. 판정·분석은 하지 않는다 — 내용을 눈으로 보는 게 전부.
 *
 * 동작 원리: eventSource.emit 은 async 리스너를 await 하므로, *_PROMPT_READY 핸들러에서
 * 모달을 await 하면 생성이 모달 닫을 때까지 멈춘다. 취소 시 stopGeneration() 으로 중단.
 * dry-run 이 아닌 "진짜 전송" 이벤트만 잡으므로 생성 인터셉터(Vector 등) 주입까지 포함된다.
 */

import { eventSource, event_types, main_api, stopGeneration } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { promptManager, oai_settings } from '../../../openai.js';
import { EXTENSION_NAME, DEBUG_PREFIX, SIM_POSITION_LABELS } from './constants.js';
import { escapeHtml, copyTextToClipboard } from './utils.js';
import { getCurrentPresetName } from './preset.js';

// 현재 인터셉트 대상 생성의 메타. null 이면 이 확장이 띄운 생성이 아니므로 무시.
let armedMeta = null;
let listenersBound = false;

export const PROMPT_INTERCEPT_CANCELLED = 'SIM_PROMPT_INTERCEPT_CANCELLED';

/** 프롬프트 항목(identifier) → 사람이 읽는 짧은 이름 */
const IDENTIFIER_LABELS = {
    main: '메인 프롬프트',
    nsfw: 'NSFW 프롬프트',
    jailbreak: '제일브레이크',
    enhanceDefinitions: 'Enhance Definitions',
    charDescription: '캐릭터 설명',
    charPersonality: '캐릭터 성격',
    scenario: '시나리오',
    personaDescription: '페르소나',
    worldInfoBefore: '로어북 (앞)',
    worldInfoAfter: '로어북 (뒤)',
    dialogueExamples: '대화 예시',
    chatHistory: '채팅 기록',
    newMainChat: '채팅 시작 표시',
    newExampleChat: '예시 시작 표시',
    groupNudge: '그룹 넛지',
    quietPrompt: '시뮬 요청',
    bias: '바이어스',
    impersonate: '임퍼스네이트',
    sim_manager_directive: '시뮬 지시문',
    sim_manager_ooc: '시뮬 요청',
};

/** 이름을 못 찾았을 때 (내부 ID 는 노출하지 않는다) */
const FALLBACK_LABELS = {
    system: '프롬프트',
    user: '유저 메시지',
    assistant: '캐릭터 메시지',
    tool: '툴 결과',
};

export function isPromptInterceptEnabled() {
    return !!extension_settings[EXTENSION_NAME]?.promptIntercept;
}

/**
 * fn 이 실행되는 동안(=시뮬 생성 1회) 프롬프트 확인 모달을 무장한다.
 * meta: { kind, position, onCancel }
 */
export async function withPromptIntercept(meta, fn) {
    if (!isPromptInterceptEnabled()) return await fn();
    bindInterceptListeners();
    const mine = { ...meta, cancelled: false };
    armedMeta = mine;
    try {
        const result = await fn();
        // 취소 시 generateQuietPrompt 가 throw 할지 빈 값을 돌려줄지 API 마다 다르므로
        // 여기서 확실히 실패로 만든다 (호출부는 기존 catch 에서 '취소' 안내를 탄다).
        if (mine.cancelled) throw new Error(PROMPT_INTERCEPT_CANCELLED);
        return result;
    } finally {
        if (armedMeta === mine) armedMeta = null;
    }
}

// 활성 API 가 실제 프롬프트를 싣고 오는 이벤트.
// (챗 컴플리션에서도 GENERATE_AFTER_COMBINE_PROMPTS 가 뜨지만 내용이 비어 있으므로 분기 필수)
function getPromptEventType() {
    return main_api === 'openai'
        ? event_types.CHAT_COMPLETION_PROMPT_READY
        : event_types.GENERATE_AFTER_COMBINE_PROMPTS;
}

function bindInterceptListeners() {
    if (listenersBound) return;
    listenersBound = true;

    const makeHandler = (evtName) => async (data) => {
        if (!armedMeta) return;                      // 시뮬 생성이 아닐 때는 관여 안 함
        if (getPromptEventType() !== evtName) return; // 비활성 API 쪽 이벤트 무시
        if (!data || data.dryRun) return;             // 진짜 전송만

        // 한 생성당 한 번만 (툴콜 재귀 등으로 재조립돼도 다시 묻지 않음)
        const meta = armedMeta;
        armedMeta = null;

        let view;
        try {
            view = buildPreviewModel(data, meta);
        } catch (e) {
            console.error(DEBUG_PREFIX, 'Prompt preview build failed:', e);
            return;
        }
        if (!view.messages.length) return;

        const action = await showPromptPreviewModal(view);
        if (action !== 'send') {
            meta.cancelled = true;
            try { meta.onCancel?.(); } catch (e) { console.error(DEBUG_PREFIX, e); }
            try { await stopGeneration(); } catch (e) { /* noop */ }
        }
    };

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, makeHandler(event_types.CHAT_COMPLETION_PROMPT_READY));
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, makeHandler(event_types.GENERATE_AFTER_COMBINE_PROMPTS));
}

// ============================================
// 모델 구성
// ============================================
function normalizeMessageContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object') {
                if (typeof part.text === 'string') return part.text;
                if (part.type === 'image_url') return '[이미지]';
                return '';
            }
            return '';
        }).filter(Boolean).join('\n');
    }
    if (content == null) return '';
    return String(content);
}

/**
 * 내부 identifier 를 사람이 읽는 이름으로.
 * 프리셋에 정의된 프롬프트는 프리셋에 적힌 이름을 그대로 쓰고,
 * 못 찾으면 내부 ID 대신 역할 기반 이름으로 떨어진다.
 */
function resolveLabel(identifier, role) {
    if (identifier) {
        if (IDENTIFIER_LABELS[identifier]) return IDENTIFIER_LABELS[identifier];
        try {
            const name = promptManager?.getPromptById?.(identifier)?.name;
            if (name) return String(name).trim();
        } catch { /* ignore */ }
    }
    return FALLBACK_LABELS[role] || '프롬프트';
}

/**
 * data.chat 의 각 메시지에 이름과 토큰수를 붙인다.
 * promptManager.messages 는 emit 직전 setChatCompletion 으로 세팅된 같은 객체라
 * flatten() 결과가 getChat() 과 같은 순서/필터를 가진다. 어긋나면 이름만 포기.
 *
 * 주의: '시스템 메시지 합치기' 가 켜져 있으면 연속된 시스템 항목이 한 메시지로 뭉쳐지고
 * 맨 앞 항목의 ID 만 남는다. 그 이름을 그대로 쓰면 거짓말이 되므로 그냥 '프롬프트' 로 둔다.
 */
function collectMessages(chatArr) {
    let flat = [];
    try { flat = promptManager?.messages?.flatten?.() ?? []; } catch { flat = []; }
    const labeled = flat.filter(m => m && (m.content || m.tool_calls));
    const aligned = labeled.length === chatArr.length;
    const squashed = !!oai_settings?.squash_system_messages;

    return chatArr.map((m, i) => {
        const src = aligned ? labeled[i] : null;
        const role = m?.role || 'unknown';
        const trustId = !(squashed && role === 'system');
        return {
            role,
            name: m?.name || '',
            content: normalizeMessageContent(m?.content),
            label: resolveLabel(trustId ? src?.identifier : '', role),
            tokens: typeof src?.tokens === 'number' ? src.tokens : null,
        };
    });
}

function buildPreviewModel(data, meta) {
    if (Array.isArray(data?.chat)) {
        return { isChat: true, meta, messages: collectMessages(data.chat) };
    }
    // 텍스트 컴플리션 계열: 통짜 문자열 하나
    const text = String(data?.prompt ?? '');
    return {
        isChat: false,
        meta,
        messages: [{ role: 'prompt', name: '', content: text, label: '최종 프롬프트', tokens: null }],
    };
}

// ============================================
// 모달
// ============================================
function highlight(text, query) {
    const escaped = escapeHtml(text);
    if (!query) return escaped;
    const q = escapeHtml(query);
    try {
        const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        return escaped.replace(re, (m) => `<mark class="sim-preview-hit">${m}</mark>`);
    } catch {
        return escaped;
    }
}

function countHits(text, query) {
    if (!query) return 0;
    const lower = text.toLowerCase();
    const q = query.toLowerCase();
    let count = 0, idx = 0;
    while ((idx = lower.indexOf(q, idx)) !== -1) { count++; idx += q.length; }
    return count;
}

/**
 * 모달을 띄우고 'send' | 'cancel' 로 resolve.
 * emit 이 이 Promise 를 await 하므로 그동안 생성이 멈춘다.
 */
function showPromptPreviewModal(view) {
    return new Promise((resolve) => {
        const { meta, messages } = view;
        const totalChars = messages.reduce((s, m) => s + m.content.length, 0);
        const totalTokens = messages.reduce((s, m) => s + (m.tokens || 0), 0);
        const positionLabel = SIM_POSITION_LABELS[meta.position] || '';
        const presetName = getCurrentPresetName();

        const chips = [
            meta.kind ? `<span class="sim-preview-chip">${escapeHtml(meta.kind)}</span>` : '',
            presetName ? `<span class="sim-preview-chip">${escapeHtml(presetName)}</span>` : '',
            positionLabel ? `<span class="sim-preview-chip">주입: ${escapeHtml(positionLabel)}</span>` : '',
            `<span class="sim-preview-chip">${messages.length}개 · ${totalChars.toLocaleString()}자${totalTokens ? ` · 약 ${totalTokens.toLocaleString()}t` : ''}</span>`,
        ].filter(Boolean).join('');

        const overlay = document.createElement('div');
        overlay.className = 'sim-preview-overlay';
        overlay.innerHTML = `
        <div class="sim-preview-box">
            <div class="sim-preview-head">
                <div class="sim-preview-title"><i class="fa-solid fa-magnifying-glass"></i> 전송 전 프롬프트 확인</div>
                <div class="sim-preview-chips">${chips}</div>
            </div>
            <div class="sim-preview-toolbar">
                <input type="text" id="sim-preview-search" class="sim-preview-search" placeholder="내용 검색" />
                <span class="sim-preview-search-info" id="sim-preview-search-info"></span>
                <button class="sim-btn sim-btn-mini" id="sim-preview-expand"><i class="fa-solid fa-angles-down"></i> 모두 펼치기</button>
                <button class="sim-btn sim-btn-mini" id="sim-preview-copy"><i class="fa-solid fa-copy"></i> 복사</button>
            </div>
            <div class="sim-preview-body" id="sim-preview-body"></div>
            <div class="sim-preview-foot">
                <button class="sim-btn" id="sim-preview-cancel">취소</button>
                <button class="sim-btn sim-btn-primary" id="sim-preview-send"><i class="fa-solid fa-paper-plane"></i> 전송</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);

        const body = overlay.querySelector('#sim-preview-body');
        const searchInput = overlay.querySelector('#sim-preview-search');
        const searchInfo = overlay.querySelector('#sim-preview-search-info');
        const expandBtn = overlay.querySelector('#sim-preview-expand');
        let allExpanded = false;

        const render = () => {
            const query = searchInput.value.trim();
            let hitMsgs = 0, hitTotal = 0;
            const cards = messages.map((m, i) => {
                const hits = countHits(m.content, query);
                if (query) {
                    if (!hits) return '';
                    hitMsgs++; hitTotal += hits;
                }
                const expanded = allExpanded || !!query;
                return `
                <div class="sim-preview-msg" data-idx="${i}">
                    <div class="sim-preview-msg-head">
                        <span class="sim-preview-role sim-preview-role-${escapeHtml(m.role)}">${escapeHtml(m.role)}</span>
                        <span class="sim-preview-label">${escapeHtml(m.label)}</span>
                        ${m.name ? `<span class="sim-preview-name">${escapeHtml(m.name)}</span>` : ''}
                        <span class="sim-preview-size">${m.content.length.toLocaleString()}자${m.tokens ? ` · ${m.tokens.toLocaleString()}t` : ''}</span>
                        ${hits ? `<span class="sim-preview-hitcount">${hits}건</span>` : ''}
                        <i class="fa-solid fa-chevron-down sim-preview-caret"></i>
                    </div>
                    <div class="sim-preview-msg-body${expanded ? '' : ' collapsed'}">${highlight(m.content, query)}</div>
                </div>`;
            }).join('');

            body.innerHTML = cards || '<div class="sim-preview-empty">일치하는 내용이 없습니다.</div>';
            searchInfo.textContent = query ? `${hitMsgs}개 / ${hitTotal}건` : '';
        };
        render();

        body.addEventListener('click', (e) => {
            const head = e.target.closest('.sim-preview-msg-head');
            if (!head) return;
            head.parentElement.querySelector('.sim-preview-msg-body')?.classList.toggle('collapsed');
        });

        let searchTimer = null;
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(render, 150);
        });

        expandBtn.addEventListener('click', () => {
            allExpanded = !allExpanded;
            expandBtn.innerHTML = allExpanded
                ? '<i class="fa-solid fa-angles-up"></i> 모두 접기'
                : '<i class="fa-solid fa-angles-down"></i> 모두 펼치기';
            render();
        });

        overlay.querySelector('#sim-preview-copy').addEventListener('click', () => {
            const text = view.isChat
                ? messages.map(m => `--- [${m.role}] ${m.label} ---\n${m.content}`).join('\n\n')
                : messages[0].content;
            copyTextToClipboard(text);
        });

        // 모바일 주소창 때문에 100vh 가 실제 화면보다 커진다. 메인 팝업과 같은 방식으로
        // 픽셀 높이를 직접 잡아준다 (소프트 키패드에 반응하지 않도록 innerHeight 사용).
        const syncHeight = () => { overlay.style.height = window.innerHeight + 'px'; };
        syncHeight();
        window.addEventListener('resize', syncHeight);
        window.addEventListener('orientationchange', syncHeight);

        let settled = false;
        const finish = (action) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('resize', syncHeight);
            window.removeEventListener('orientationchange', syncHeight);
            overlay.remove();
            resolve(action);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('cancel'); }
        };
        document.addEventListener('keydown', onKey, true);

        overlay.querySelector('#sim-preview-cancel').addEventListener('click', () => finish('cancel'));
        overlay.querySelector('#sim-preview-send').addEventListener('click', () => finish('send'));
        // 바깥 클릭은 실수 방지를 위해 닫지 않음 (취소/전송 버튼으로만 종료)
    });
}
