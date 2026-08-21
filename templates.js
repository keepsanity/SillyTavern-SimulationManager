/**
 * 팝업/설정 패널/지팡이 버튼의 정적 HTML 빌더와 브랜딩 반영.
 */
import { escapeHtml } from './utils.js';
import {
    getDisplayName,
    getDisplayIcon,
} from './config.js';

export function buildPopupHTML() {
    return `
    <div id="sim-manager-popup">
        <div id="sim-manager-panel">
            <div class="sim-header">
                <h3><i class="fa-solid ${getDisplayIcon()}"></i> ${escapeHtml(getDisplayName())}</h3>
                <div class="sim-header-actions">
                    <button class="sim-close-btn" id="sim-close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="sim-content" id="sim-content">
            </div>
            <div class="sim-footer" id="sim-footer">
            </div>
        </div>
    </div>`;
}

export function buildSettingsHTML() {
    return `
    <div id="sim-manager-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>시뮬레이션 매니저</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="sim-settings-body">
                    <h4 class="sim-settings-title">표시 설정</h4>
                    <div class="sim-settings-block">
                        <label class="sim-settings-label" for="sim-display-name">이름 (지팡이 버튼 · 헤더 공통)</label>
                        <input type="text" id="sim-display-name" class="text_pole" placeholder="시뮬레이션" maxlength="20" />
                    </div>
                    <div class="sim-settings-block">
                        <label class="sim-settings-label">아이콘</label>
                        <div id="sim-icon-grid" class="sim-icon-grid"></div>
                    </div>

                    <hr class="sim-settings-hr" />

                    <label class="checkbox_label sim-settings-checkbox">
                        <input type="checkbox" id="sim-notifications-toggle" />
                        시뮬 완료 시 알림 표시
                    </label>
                    <label class="checkbox_label sim-settings-checkbox">
                        <input type="checkbox" id="sim-prompt-intercept-toggle" />
                        전송 전 프롬프트 확인
                    </label>
                    <div class="sim-settings-hint">
                        켜면 시뮬 전송·재생성·이어쓰기·통제광 직전에 조립이 끝난 최종 프롬프트를 보여주고
                        전송할지 물어봅니다. (여러 방에 보내기는 제외)
                    </div>

                    <hr class="sim-settings-hr" />

                    <button class="sim-btn sim-btn-primary sim-settings-wide-btn" id="sim-global-viewer-btn">
                        <i class="fa-solid fa-layer-group"></i> 시뮬레이션 모아보기
                    </button>

                    <hr class="sim-settings-hr" />

                    <h4 class="sim-settings-title">기본 주입 위치</h4>
                    <div class="sim-settings-block">
                        <label class="sim-settings-label">새 시뮬 생성 시 기본 선택값</label>
                        <select id="sim-default-position" class="text_pole"></select>
                    </div>

                    <hr class="sim-settings-hr" />

                    <h4 class="sim-settings-title">번역 설정</h4>
                    <label class="checkbox_label sim-settings-checkbox">
                        <input type="checkbox" id="sim-translation-toggle" />
                        응답 번역 기능 사용
                    </label>
                    <div id="sim-translation-settings" class="sim-settings-subblock" style="display:none;">
                        <div class="sim-settings-block">
                            <label class="sim-settings-label">Connection Profile</label>
                            <select id="sim-translation-profile" class="text_pole connection_profile"></select>
                        </div>
                        <div class="sim-settings-block">
                            <label class="sim-settings-label">Vertex AI Auth Mode (Vertex AI 프로필만 해당)</label>
                            <select id="sim-vertex-auth-mode" class="text_pole">
                                <option value="express">Express (API Key)</option>
                                <option value="full">Full (Service Account JSON)</option>
                            </select>
                        </div>
                        <div class="sim-settings-block">
                            <label class="sim-settings-label">번역 대상 언어</label>
                            <input type="text" id="sim-translation-lang" class="text_pole" placeholder="한국어" />
                        </div>
                        <div class="sim-settings-block">
                            <label class="sim-settings-label">커스텀 번역 프롬프트 (선택)</label>
                            <textarea id="sim-translation-prompt" class="text_pole sim-settings-textarea" placeholder="비워두면 기본 프롬프트 사용"></textarea>
                        </div>
                    </div>

                    <hr class="sim-settings-hr" />

                    <h4 class="sim-settings-title">로어북 엔트리 생성</h4>
                    <div class="sim-settings-hint">
                        시뮬 상세 화면의 [로어북] 버튼으로 만들 엔트리의 기본값입니다.
                        만들 때마다 팝업에서 바꿀 수 있습니다.
                    </div>
                    <div class="sim-settings-block">
                        <label class="sim-settings-label">기본 활성화 방식</label>
                        <select id="sim-lore-default-activation" class="text_pole"></select>
                    </div>
                    <div class="sim-settings-block">
                        <label class="sim-settings-label">기본 위치</label>
                        <select id="sim-lore-default-position" class="text_pole"></select>
                    </div>
                    <div class="sim-settings-block" id="sim-lore-default-depth-block">
                        <label class="sim-settings-label">기본 깊이</label>
                        <input type="number" id="sim-lore-default-depth" class="text_pole" min="0" max="999" />
                    </div>
                    <div class="sim-settings-block">
                        <label class="sim-settings-label">요약 프롬프트 (선택)</label>
                        <textarea id="sim-lore-prompt" class="text_pole sim-settings-textarea" placeholder="비워두면 기본 프롬프트 사용"></textarea>
                    </div>
                    <button class="sim-btn sim-settings-wide-btn" id="sim-lore-prompt-default-btn">
                        <i class="fa-solid fa-rotate-left"></i> 기본 프롬프트 불러오기
                    </button>
                    <div class="sim-settings-hint">
                        시뮬 응답이 들어갈 자리는 <code>{{response}}</code> 입니다.
                        빠뜨리면 프롬프트 끝에 자동으로 붙습니다.
                    </div>

                    <hr class="sim-settings-hr" />

                    <button class="sim-btn sim-btn-primary sim-settings-wide-btn" id="sim-open-prompt-manager-btn">
                        <i class="fa-solid fa-bookmark"></i> 저장된 프롬프트 관리
                    </button>
                </div>
            </div>
        </div>
    </div>`;
}

export function buildWandButtonHTML() {
    return `
    <div id="sim-manager-wand-btn" class="list-group-item flex-container flexGap5" title="${escapeHtml(getDisplayName())} 열기">
        <div class="fa-solid ${getDisplayIcon()} extensionsMenuExtensionButton"></div>
        <span>${escapeHtml(getDisplayName())}</span>
    </div>`;
}

// 설정 변경 시 이미 그려진 헤더/지팡이 버튼에 이름·아이콘 즉시 반영
export function applyBranding() {
    const name = getDisplayName();
    const icon = getDisplayIcon();

    const headerH3 = document.querySelector('#sim-manager-panel .sim-header h3');
    if (headerH3) {
        headerH3.innerHTML = `<i class="fa-solid ${icon}"></i> ${escapeHtml(name)}`;
    }

    const wandBtn = document.getElementById('sim-manager-wand-btn');
    if (wandBtn) {
        wandBtn.title = `${name} 열기`;
        const wandIcon = wandBtn.querySelector('.extensionsMenuExtensionButton');
        if (wandIcon) wandIcon.className = `fa-solid ${icon} extensionsMenuExtensionButton`;
        const wandSpan = wandBtn.querySelector('span');
        if (wandSpan) wandSpan.textContent = name;
    }
}
