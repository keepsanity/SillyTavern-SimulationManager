/**
 * 채팅 메시지를 시뮬 항목으로 캡처하는 메시지 액션 버튼.
 */
import {
    eventSource,
    event_types,
    chat,
} from '../../../../script.js';
import { uuidv4 } from '../../../utils.js';
import { SIM_SAVE_BTN_CLASS } from './constants.js';
import { getDefaultInjectPosition } from './config.js';
import { getCurrentPresetName } from './preset.js';
import {
    getSimulations,
    saveSimulations,
} from './store.js';
import { openPopupToSim } from './popup.js';


/**
 * 채팅 메시지 하나를 현재 챗의 시뮬 목록에 새 항목으로 저장.
 *  - responses[0] = 그 메시지 본문
 *  - promptText  = 바로 앞(가장 가까운) 유저 메시지 (없으면 빈 값)
 */
export function captureMessageToSim(mesId) {
    const idx = Number(mesId);
    if (!Number.isInteger(idx) || idx < 0 || idx >= chat.length) return;
    const msg = chat[idx];
    if (!msg) return;

    const responseText = msg.mes ?? '';
    if (!responseText.trim()) {
        toastr.warning('빈 메시지는 저장할 수 없습니다.', '시뮬 매니저');
        return;
    }

    // 바로 앞 유저 메시지 찾기 (시뮬 이어쓰기/재생성 시 <original_request> 로 사용)
    let promptText = '';
    for (let i = idx - 1; i >= 0; i--) {
        if (chat[i]?.is_user) { promptText = chat[i].mes ?? ''; break; }
    }

    const snippet = responseText.replace(/\s+/g, ' ').trim().slice(0, 40);

    const sims = getSimulations();
    const sim = {
        id: `sim_${uuidv4()}`,
        promptText: promptText,
        promptName: `📥 ${snippet}${responseText.trim().length > 40 ? '…' : ''}`,
        responses: [responseText],
        currentIndex: 0,
        createdAt: Date.now(),
        presetName: getCurrentPresetName(),
        togglePresetName: '',
        injectPosition: getDefaultInjectPosition(),
        swapCharUser: false,
        swapPronouns: false,
        importedFrom: 'message', // 메시지에서 캡처했음을 표시
    };
    sims.push(sim);
    saveSimulations();

    if (typeof toastr !== 'undefined') {
        toastr.success('시뮬 목록에 저장했습니다.', '시뮬 매니저', {
            timeOut: 4000,
            onclick: () => openPopupToSim(sim.id),
        });
    }
}

/** 메시지 액션 버튼 줄에 '시뮬로 저장' 버튼 주입 (AI 메시지에만, 중복 방지) */
export function injectSaveButton(mesEl) {
    if (!mesEl) return;
    // 유저 메시지엔 달지 않음 (저장해도 의미 없는 시뮬이 됨)
    if (mesEl.getAttribute('is_user') === 'true') return;
    const extra = mesEl.querySelector('.extraMesButtons');
    if (!extra || extra.querySelector('.' + SIM_SAVE_BTN_CLASS)) return;
    const btn = document.createElement('div');
    btn.className = `mes_button ${SIM_SAVE_BTN_CLASS} fa-solid fa-flask`;
    btn.title = '시뮬로 저장';
    extra.insertBefore(btn, extra.firstChild);
}

/** 현재 채팅에 표시된 모든 메시지에 버튼 주입 */
export function refreshSaveButtons() {
    document.querySelectorAll('#chat .mes').forEach(injectSaveButton);
}

/** 버튼 주입 + 클릭 위임 + 렌더 이벤트 바인딩 (init 1회) */
export function setupMessageCapture() {
    // 클릭 위임 (document 1회) — 재렌더에도 살아있음
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.' + SIM_SAVE_BTN_CLASS);
        if (!btn) return;
        const mesEl = btn.closest('.mes');
        if (!mesEl) return;
        captureMessageToSim(mesEl.getAttribute('mesid'));
    });

    // 새로 렌더되는 메시지에도 버튼 주입
    const reinject = () => refreshSaveButtons();
    eventSource.on(event_types.CHAT_CHANGED, reinject);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, reinject);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, reinject);
    eventSource.on(event_types.MESSAGE_SWIPED, reinject);
    eventSource.on(event_types.MORE_MESSAGES_LOADED, reinject);
    eventSource.on(event_types.MESSAGE_UPDATED, reinject);

    // 이미 열려 있는 채팅에 즉시 주입
    refreshSaveButtons();
}
