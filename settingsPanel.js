/**
 * 확장 설정 패널의 버튼 이벤트 바인딩.
 */
import { extension_settings } from '../../../extensions.js';
import { EXTENSION_NAME } from './constants.js';
import { ensureSettings } from './config.js';
import { S } from './state.js';
import { openPopup } from './popup.js';
import { renderGlobalListView, rescanWithFeedback } from './views/global.js';
import { renderPromptManagerView } from './views/prompts.js';

export function bindSettingsEvents() {
    // 프롬프트 관리 버튼
    document.getElementById('sim-open-prompt-manager-btn')?.addEventListener('click', () => {
        S.currentView = 'promptManager';
        openPopup();
        renderPromptManagerView();
    });

    // 모아보기 버튼
    document.getElementById('sim-global-viewer-btn')?.addEventListener('click', async () => {
        S.currentView = 'globalList';
        openPopup();

        ensureSettings();
        const s = extension_settings[EXTENSION_NAME];
        const hasIndex = Object.keys(s.globalIndex).length > 0;

        if (hasIndex && !s.globalIndexStale) {
            // 인덱스가 있으면 바로 표시 (본문은 방을 펼칠 때 읽는다)
            renderGlobalListView();
        } else {
            // 첫 실행이거나, 구버전에서 넘어와 인덱스에 출처 정보가 없을 때만 스캔
            const container = document.getElementById('sim-content');
            if (container) {
                container.innerHTML = `
                    <div class="sim-empty">
                        <i class="fa-solid fa-spinner fa-spin" style="font-size:28px; margin-bottom:12px; opacity:0.5;"></i>
                        <br>전체 채팅방 스캔 중...
                    </div>`;
            }
            const footer = document.getElementById('sim-footer');
            if (footer) { footer.innerHTML = ''; footer.classList.add('hidden'); }

            await rescanWithFeedback();
            renderGlobalListView();
        }
    });
}
