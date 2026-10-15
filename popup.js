/**
 * 팝업 셸: 열기/닫기/모바일 높이 보정/뷰 전환 스크롤 리셋, 그리고 생성 완료 알림.
 */
import { extension_settings } from '../../../extensions.js';
import { playMessageSound } from '../../../power-user.js';
import {
    EXTENSION_NAME,
    DEBUG_PREFIX,
} from './constants.js';
import { ensureSettings } from './config.js';
import { S } from './state.js';
import { renderDetailView } from './views/detail.js';
import { renderListView } from './views/list.js';

// 뷰 전환 시에만 sim-content 스크롤을 맨 위로. 같은 뷰의 인-플레이스 재렌더는 스크롤 보존.
export function maybeResetContentScroll(viewKey, simId = null) {
    if (S.lastRenderedView !== viewKey || S.lastRenderedSimId !== simId) {
        const container = document.getElementById('sim-content');
        if (container) container.scrollTop = 0;
        S.lastRenderedView = viewKey;
        S.lastRenderedSimId = simId;
    }
}

export function goToList() {
    if (S.simGenerating) return;
    S.currentView = 'list';
    S.currentSimId = null;
    S.tempSim = null;
    S.isEditingPrompt = false;
    S.isEditingTitle = false;
    S.editingPartIdx = null;
    renderListView();
}

export function fixMobileHeight() {
    const popup = document.getElementById('sim-manager-popup');
    if (popup) {
        // window.innerHeight 는 주소창은 반영하되, 소프트 키패드가 떠도 줄지 않는
        // 레이아웃 뷰포트 높이. visualViewport.height 를 쓰면 키패드만큼 모달이 줄어
        // 푸터가 중간으로 튀어 오르므로 innerHeight 를 사용한다. (키패드는 모달 위에 겹쳐 뜸)
        popup.style.height = window.innerHeight + 'px';
    }
}

export function openPopup() {
    const popup = document.getElementById('sim-manager-popup');
    if (popup) {
        popup.classList.add('active');
        fixMobileHeight();
        // globalList인 경우 renderGlobalListView가 별도 호출됨
        if (S.currentView !== 'globalList' && S.currentView !== 'globalSimList' && S.currentView !== 'globalDetail') {
            if (S.currentView === 'detail') renderDetailView();
            else renderListView();
        }
    }
}

export function closePopup() {
    const popup = document.getElementById('sim-manager-popup');
    if (popup) {
        popup.classList.remove('active');
    }
}

window.addEventListener('resize', () => {
    const popup = document.getElementById('sim-manager-popup');
    if (popup && popup.classList.contains('active')) {
        fixMobileHeight();
    }
});

// 소프트 키패드 열림/닫힘 감지 (resize 이벤트가 안 뜨는 브라우저 대응)
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        const popup = document.getElementById('sim-manager-popup');
        if (popup && popup.classList.contains('active')) {
            fixMobileHeight();
        }
    });
}

export function openPopupToSim(simId) {
    S.currentSimId = simId;
    S.currentView = 'detail';
    S.isEditingPrompt = false;
    S.isEditingTitle = false;
    openPopup();
    renderDetailView();
}

// ============================================
// 생성 완료 알림 (클릭하면 해당 시뮬로 바로 진입)
// ============================================
export function showSimNotification(sim) {
    ensureSettings();
    if (!extension_settings[EXTENSION_NAME].notificationsEnabled) return;

    if (typeof toastr !== 'undefined') {
        toastr.success(
            `시뮬 응답이 도착했습니다!`,
            '시뮬레이션 매니저',
            { timeOut: 4000, onclick: () => openPopupToSim(sim.id) },
        );
    }

    try { playMessageSound(); } catch (e) { console.error(DEBUG_PREFIX, 'playMessageSound failed:', e); }
}
