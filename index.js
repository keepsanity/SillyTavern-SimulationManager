import { initPromptStorage, reportPromptStorageError } from './prompt-storage.js';
import { initCustomPresetStorage } from './preset.js';
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
    saveChatDebounced,
    chat_metadata,
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
    saveSimulations,
    syncToGlobal,
    migrateLegacyGlobalStore,
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
import { renderListView } from './views/list.js';
import {
    applyBranding,
    buildPopupHTML,
    buildSettingsHTML,
    buildWandButtonHTML,
} from './templates.js';

/**
 * 1.5.0 저장 구조 변경 마이그레이션. 결과가 있을 때만 알린다.
 * 백업이 실패하면 store.js 가 아무것도 지우지 않으므로 다음 실행에서 다시 시도된다.
 */
async function runLegacyStoreMigration() {
    try {
        const result = await migrateLegacyGlobalStore();
        if (!result || typeof toastr === 'undefined') return;
        toastr.info(
            `시뮬 기록을 설정 파일에서 분리했습니다 (시뮬 ${result.simCount}개 / 채팅 ${result.chatCount}개).<br>이전 사본은 <code>${escapeHtml(result.path)}</code> 에 백업해 뒀습니다.`,
            '시뮬 매니저',
            { timeOut: 20000, extendedTimeOut: 10000, escapeHtml: false },
        );
    } catch (e) {
        console.error(DEBUG_PREFIX, 'Legacy store migration failed:', e);
    }
}

/**
 * 브랜치/가져오기로 만든 채팅은 부모의 chat_metadata 를 통째로 물려받는다
 * (script.js 의 saveChat 이 `{ ...chat_metadata, ...withMetadata }` 로 저장).
 * 그래서 시뮬 기록까지 그대로 복제돼 채팅 파일이 두 배가 된다.
 * 브랜치 직전에 끼어들 훅이 없어서 막지는 못하고, 열렸을 때 비울지 물어본다.
 *
 * '다시 묻지 않음' 은 사용자가 결론을 냈을 때만 기록한다 — 비웠거나, 닫기(×)를 눌렀거나.
 * toastr 는 onclick 이 붙어 있으면 핸들러가 끝난 뒤 무조건 알림을 닫기 때문에
 * (`!E.onclick && E.tapToDismiss` — tapToDismiss 는 onclick 이 없을 때만 본다),
 * 알림을 띄우면서 미리 기록해 두면 결론을 못 낸 클릭 한 번에 기회가 영영 사라진다.
 */
function offerBranchSimCleanup() {
    try {
        const parent = chat_metadata?.main_chat;
        if (!parent) return;                                   // 브랜치가 아님
        const store = chat_metadata[EXTENSION_NAME];
        if (!Array.isArray(store?.simulations) || store.simulations.length === 0) return;
        // 부모 이름까지 같이 기록한다. 그냥 플래그면 손자 브랜치가 그것마저 물려받아
        // 한 번도 안 물어보게 된다.
        if (store.branchCheckedFor === parent) return;

        const count = store.simulations.length;
        // 이 알림이 가리키는 방. 알림은 저절로 안 사라지므로 클릭 시점에 대조해야 한다.
        const targetKey = getCurrentChatKey();

        /** 이 방에서는 다시 묻지 않음. store 는 그 방의 메타데이터라 방을 옮겼으면 손대면 안 된다. */
        const markResolved = () => {
            if (getCurrentChatKey() !== targetKey) return;
            store.branchCheckedFor = parent;
            saveChatDebounced();
        };

        if (typeof toastr === 'undefined') return;
        toastr.warning(
            `이 채팅은 브랜치라 부모의 시뮬 ${count}개를 그대로 물려받았습니다.<br>비우려면 이 알림을 누르세요 (부모 채팅은 그대로입니다).<br><small>닫기(×)를 누르면 이 방에서는 다시 묻지 않습니다.</small>`,
            '시뮬 매니저',
            {
                timeOut: 0,
                extendedTimeOut: 0,
                closeButton: true,
                escapeHtml: false,
                // × = 그냥 두겠다는 결론
                onCloseClick: markResolved,
                onclick: () => {
                    // 알림이 떠 있는 사이에 다른 채팅으로 옮겼을 수 있다.
                    // 그대로 비우면 엉뚱한 방의 기록을 지우게 된다.
                    // 결론으로 치지 않으니 그 브랜치를 다시 열면 알림이 또 뜬다.
                    if (getCurrentChatKey() !== targetKey) {
                        toastr.info('그 브랜치에서 나와 있어 취소했습니다. 다시 열면 또 물어봅니다.', '시뮬 매니저');
                        return;
                    }
                    // 알림이 떠 있는 동안 시뮬이 늘었을 수 있으니 지금 개수로 묻는다.
                    const sims = getSimulations();
                    const now = sims.length;
                    if (now === 0) return;
                    const ask = `이 브랜치의 시뮬 ${now}개를 비웁니다.\n부모 채팅의 기록은 그대로입니다. 계속할까요?`;
                    if (!confirm(ask)) return;   // 취소도 결론이 아니다 — 다시 열면 또 묻는다
                    sims.length = 0;
                    markResolved();
                    saveSimulations();
                    toastr.success(`시뮬 ${now}개를 비웠습니다.`, '시뮬 매니저');
                },
            },
        );
    } catch (e) {
        console.error(DEBUG_PREFIX, 'Branch check failed:', e);
    }
}

(async function init() {
    ensureSettings();
    try {
        await initPromptStorage();
        await initCustomPresetStorage();
    } catch (error) {
        reportPromptStorageError(error);
        return;
    }

    // 1.5.0: 설정 파일에 박혀 있던 시뮬 본문 사본을 백업하고 걷어낸다 (1회)
    runLegacyStoreMigration();

    // 기존 채팅 데이터 → 인덱스 초기 동기화
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

        // 요약용 Connection Profile 드롭다운 (없으면 조용히 넘어간다 — 현재 API 로 폴백되므로)
        try {
            const ctx = getContext();
            if (ctx.ConnectionManagerRequestService && document.getElementById('sim-lore-profile')) {
                ctx.ConnectionManagerRequestService.handleDropdown(
                    '#sim-lore-profile',
                    extension_settings[EXTENSION_NAME].loreProfileId || '',
                    (profile) => {
                        extension_settings[EXTENSION_NAME].loreProfileId = profile?.id ?? '';
                        saveSettingsDebounced();
                        console.log(DEBUG_PREFIX, '로어 요약 프로필 변경:', profile?.name || '없음 (현재 API 사용)');
                    },
                );
            }
        } catch (e) {
            console.warn(DEBUG_PREFIX, 'Lore profile dropdown unavailable:', e);
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
            if (!S.simGenerating) S.currentView = 'list';
            openPopup();
            wandMenu.style.display = 'none';
        });
    }

    // 4. 채팅 변경 시 뷰 초기화 + 글로벌 동기화
    eventSource.on(event_types.CHAT_CHANGED, () => {
        S.currentView = 'list';
        S.currentSimId = null;
        S.isEditingPrompt = false;
        S.pendingCreateDraft = null;
        S.tempSim = null;
        if (document.getElementById('sim-manager-popup')?.classList.contains('active')) renderListView();

        // 새 채팅 로드 후 인덱스 동기화 + 브랜치 중복 확인
        setTimeout(() => {
            try {
                const chatKey = getCurrentChatKey();
                if (chatKey) {
                    const sims = getSimulations();
                    if (sims.length > 0) {
                        syncToGlobal();
                    }
                }
                offerBranchSimCleanup();
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
