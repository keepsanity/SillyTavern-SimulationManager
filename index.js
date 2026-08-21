/**
 * SillyTavern - Simulation Manager
 *
 * 메인 RP에 영향 없이 시뮬레이션(OOC 요청)을 관리하는 확장.
 * - 채팅방별 시뮬 목록 관리
 * - 시뮬 프롬프트 저장/재사용
 * - 답변 여러 개 생성 & 화살표로 전환
 * - 시뮬 내용 수정
 * - 전체 채팅방 시뮬 모아보기
 * - 100% 로컬, 서버 의존 없음
 */

import {
    extension_settings,
    getContext,
} from '../../../extensions.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../../script.js';
import {
    EXTENSION_NAME,
    DEBUG_PREFIX,
    SIM_ICON_PRESETS,
    SIM_POSITION_LABELS,
    LORE_ACTIVATION_LABELS,
    LORE_POSITION_LABELS,
    LORE_POSITIONS,
    LORE_SUMMARY_PROMPT,
} from './constants.js';
import {
    normalizeSimPosition,
    escapeHtml,
} from './utils.js';
import {
    ensureSettings,
    getDisplayName,
    getDisplayIcon,
    getDefaultInjectPosition,
    normalizeLoreDepth,
} from './config.js';
import { S } from './state.js';
import {
    getSimulations,
    getCurrentChatKey,
    syncToGlobal,
} from './store.js';
import { setupMessageCapture } from './capture.js';
import {
    closePopup,
    openPopup,
} from './popup.js';
import {
    bindSettingsEvents,
    renderSettingsSavedPrompts,
} from './settingsPanel.js';
import { registerSlashCommands } from './slashCommands.js';
import {
    applyBranding,
    buildPopupHTML,
    buildSettingsHTML,
    buildWandButtonHTML,
} from './templates.js';

(function init() {
    ensureSettings();

    // 기존 채팅 데이터 → 글로벌로 초기 동기화
    try {
        const chatKey = getCurrentChatKey();
        if (chatKey) {
            const sims = getSimulations();
            if (sims.length > 0) {
                syncToGlobal();
            }
        }
    } catch (e) { /* 채팅 미로드 상태에서는 무시 */ }

    // 1. 팝업 추가
    document.body.insertAdjacentHTML('beforeend', buildPopupHTML());

    document.getElementById('sim-close')?.addEventListener('click', closePopup);
    document.getElementById('sim-manager-popup')?.addEventListener('click', (e) => {
        if (e.target.id === 'sim-manager-popup') closePopup();
    });

    // 2. 확장 설정 패널 추가
    const settingsContainer = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (settingsContainer) {
        settingsContainer.insertAdjacentHTML('beforeend', buildSettingsHTML());

        // 표시 설정 (이름 + 아이콘)
        const nameInput = document.getElementById('sim-display-name');
        if (nameInput) {
            nameInput.value = getDisplayName();
            nameInput.addEventListener('input', () => {
                const v = nameInput.value.trim();
                extension_settings[EXTENSION_NAME].displayName = v === '' ? '시뮬레이션' : v;
                saveSettingsDebounced();
                applyBranding();
            });
        }

        const iconGrid = document.getElementById('sim-icon-grid');
        if (iconGrid) {
            const renderIconGrid = () => {
                const current = getDisplayIcon();
                iconGrid.innerHTML = SIM_ICON_PRESETS.map((ic) =>
                    `<button type="button" class="sim-icon-option${ic === current ? ' selected' : ''}" data-icon="${ic}" title="${ic}"><i class="fa-solid ${ic}"></i></button>`
                ).join('');
            };
            renderIconGrid();
            iconGrid.addEventListener('click', (e) => {
                const btn = e.target.closest('.sim-icon-option');
                if (!btn) return;
                extension_settings[EXTENSION_NAME].displayIcon = btn.dataset.icon;
                saveSettingsDebounced();
                renderIconGrid();
                applyBranding();
            });
        }

        const toggle = document.getElementById('sim-notifications-toggle');
        if (toggle) {
            toggle.checked = extension_settings[EXTENSION_NAME].notificationsEnabled;
            toggle.addEventListener('change', () => {
                extension_settings[EXTENSION_NAME].notificationsEnabled = toggle.checked;
                saveSettingsDebounced();
            });
        }

        // 전송 전 프롬프트 확인 (인터셉트)
        const interceptToggle = document.getElementById('sim-prompt-intercept-toggle');
        if (interceptToggle) {
            interceptToggle.checked = !!extension_settings[EXTENSION_NAME].promptIntercept;
            interceptToggle.addEventListener('change', () => {
                extension_settings[EXTENSION_NAME].promptIntercept = interceptToggle.checked;
                saveSettingsDebounced();
            });
        }

        // 기본 주입 위치
        const defaultPosSelect = document.getElementById('sim-default-position');
        if (defaultPosSelect) {
            defaultPosSelect.innerHTML = Object.entries(SIM_POSITION_LABELS).map(([v, l]) =>
                `<option value="${v}">${escapeHtml(l)}</option>`
            ).join('');
            defaultPosSelect.value = getDefaultInjectPosition();
            defaultPosSelect.addEventListener('change', () => {
                extension_settings[EXTENSION_NAME].defaultInjectPosition = normalizeSimPosition(defaultPosSelect.value);
                saveSettingsDebounced();
            });
        }

        // 로어북 엔트리 기본값
        const loreActSelect = document.getElementById('sim-lore-default-activation');
        const lorePosSelect = document.getElementById('sim-lore-default-position');
        const loreDepthBlock = document.getElementById('sim-lore-default-depth-block');
        const loreDepthInput = document.getElementById('sim-lore-default-depth');
        const lorePromptArea = document.getElementById('sim-lore-prompt');

        // 깊이는 '@ 깊이' 위치일 때만 의미가 있다.
        const refreshLoreDepthBlock = () => {
            if (!loreDepthBlock || !lorePosSelect) return;
            loreDepthBlock.style.display =
                Number(lorePosSelect.value) === LORE_POSITIONS.AT_DEPTH ? '' : 'none';
        };

        if (loreActSelect) {
            loreActSelect.innerHTML = Object.entries(LORE_ACTIVATION_LABELS).map(([v, l]) =>
                `<option value="${v}">${escapeHtml(l)}</option>`
            ).join('');
            loreActSelect.value = extension_settings[EXTENSION_NAME].loreDefaultActivation;
            loreActSelect.addEventListener('change', () => {
                extension_settings[EXTENSION_NAME].loreDefaultActivation = loreActSelect.value;
                saveSettingsDebounced();
            });
        }

        if (lorePosSelect) {
            lorePosSelect.innerHTML = Object.entries(LORE_POSITION_LABELS).map(([v, l]) =>
                `<option value="${v}">${escapeHtml(l)}</option>`
            ).join('');
            lorePosSelect.value = String(extension_settings[EXTENSION_NAME].loreDefaultPosition);
            lorePosSelect.addEventListener('change', () => {
                extension_settings[EXTENSION_NAME].loreDefaultPosition = Number(lorePosSelect.value);
                saveSettingsDebounced();
                refreshLoreDepthBlock();
            });
        }
        refreshLoreDepthBlock();

        if (loreDepthInput) {
            loreDepthInput.value = extension_settings[EXTENSION_NAME].loreDefaultDepth;
            loreDepthInput.addEventListener('change', () => {
                const v = normalizeLoreDepth(loreDepthInput.value);
                extension_settings[EXTENSION_NAME].loreDefaultDepth = v;
                loreDepthInput.value = v;   // 이상한 값을 넣었으면 정규화된 값으로 되돌려 보여준다
                saveSettingsDebounced();
            });
        }

        if (lorePromptArea) {
            lorePromptArea.value = extension_settings[EXTENSION_NAME].loreSummaryPrompt;
            lorePromptArea.addEventListener('input', () => {
                extension_settings[EXTENSION_NAME].loreSummaryPrompt = lorePromptArea.value;
                saveSettingsDebounced();
            });
        }

        document.getElementById('sim-lore-prompt-default-btn')?.addEventListener('click', () => {
            if (!lorePromptArea) return;
            lorePromptArea.value = LORE_SUMMARY_PROMPT;
            extension_settings[EXTENSION_NAME].loreSummaryPrompt = LORE_SUMMARY_PROMPT;
            saveSettingsDebounced();
            if (typeof toastr !== 'undefined') toastr.info('기본 프롬프트를 불러왔습니다.', '시뮬 매니저');
        });

        // 번역 설정 초기화
        const transToggle = document.getElementById('sim-translation-toggle');
        const transSettings = document.getElementById('sim-translation-settings');
        const transLang = document.getElementById('sim-translation-lang');
        const transPrompt = document.getElementById('sim-translation-prompt');

        if (transToggle) {
            transToggle.checked = extension_settings[EXTENSION_NAME].translationEnabled;
            if (transSettings) transSettings.style.display = transToggle.checked ? '' : 'none';
            transToggle.addEventListener('change', () => {
                extension_settings[EXTENSION_NAME].translationEnabled = transToggle.checked;
                if (transSettings) transSettings.style.display = transToggle.checked ? '' : 'none';
                if (!transToggle.checked) S.showTranslated = false;
                saveSettingsDebounced();
            });
        }
        if (transLang) {
            transLang.value = extension_settings[EXTENSION_NAME].translationTargetLang || '한국어';
            transLang.addEventListener('input', () => {
                extension_settings[EXTENSION_NAME].translationTargetLang = transLang.value.trim() || '한국어';
                saveSettingsDebounced();
            });
        }
        if (transPrompt) {
            transPrompt.value = extension_settings[EXTENSION_NAME].translationCustomPrompt || '';
            transPrompt.addEventListener('input', () => {
                extension_settings[EXTENSION_NAME].translationCustomPrompt = transPrompt.value;
                saveSettingsDebounced();
            });
        }

        // Connection Profile 드롭다운 초기화
        try {
            const context = getContext();
            if (context.ConnectionManagerRequestService) {
                context.ConnectionManagerRequestService.handleDropdown(
                    '#sim-translation-profile',
                    extension_settings[EXTENSION_NAME].translationProfileId || '',
                    (profile) => {
                        extension_settings[EXTENSION_NAME].translationProfileId = profile?.id ?? '';
                        saveSettingsDebounced();
                        console.log(DEBUG_PREFIX, '번역 프로필 변경:', profile?.name || '없음');
                    },
                );
            }
        } catch (e) {
            console.warn(DEBUG_PREFIX, 'Connection Manager not available:', e);
        }

        // Vertex AI auth mode 초기화
        const vertexAuthSelect = document.getElementById('sim-vertex-auth-mode');
        if (vertexAuthSelect) {
            vertexAuthSelect.value = extension_settings[EXTENSION_NAME].translationVertexAuthMode || 'express';
            vertexAuthSelect.addEventListener('change', () => {
                extension_settings[EXTENSION_NAME].translationVertexAuthMode = vertexAuthSelect.value;
                saveSettingsDebounced();
            });
        }

        bindSettingsEvents();
        renderSettingsSavedPrompts();
    }

    // 3. 지팡이 메뉴에 버튼 추가
    const wandMenu = document.getElementById('extensionsMenu');
    if (wandMenu) {
        wandMenu.insertAdjacentHTML('beforeend', buildWandButtonHTML());
        document.getElementById('sim-manager-wand-btn')?.addEventListener('click', () => {
            S.currentView = 'list';
            openPopup();
            wandMenu.style.display = 'none';
        });
    }

    // 4. 채팅 변경 시 뷰 초기화 + 글로벌 동기화
    eventSource.on(event_types.CHAT_CHANGED, () => {
        S.currentView = 'list';
        S.currentSimId = null;
        S.isEditingPrompt = false;

        // 새 채팅 로드 후 글로벌 동기화
        setTimeout(() => {
            try {
                const chatKey = getCurrentChatKey();
                if (chatKey) {
                    const sims = getSimulations();
                    if (sims.length > 0) {
                        syncToGlobal();
                    }
                }
            } catch (e) { /* ignore */ }
        }, 500);
    });

    // 5. 채팅 메시지 → 시뮬로 저장 버튼
    setupMessageCapture();

    // 6. 슬래시 명령 (/sim) — Quick Reply 에서 버튼 하나로 쓰기 위한 진입점
    try {
        registerSlashCommands();
    } catch (e) {
        console.error(DEBUG_PREFIX, 'Failed to register slash commands:', e);
    }

    console.log(DEBUG_PREFIX, 'Simulation Manager loaded successfully.');
})();

