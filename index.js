/**
 * SillyTavern - Simulation Manager
 *
 * 메인 RP에 영향 없이 시뮬레이션(OOC 요청)을 관리하는 확장.
 * - 채팅방별 시뮬 목록 관리
 * - 시뮬 프롬프트 저장/재사용
 * - 답변 여러 개 생성 & 화살표로 전환
 * - 100% 로컬, 서버 의존 없음
 */

import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import { eventSource, event_types, generateQuietPrompt, substituteParams, chat_metadata, saveChatDebounced, saveSettingsDebounced } from '../../../../script.js';
import { uuidv4 } from '../../../utils.js';

const EXTENSION_NAME = 'SillyTavern-SimulationManager';
const DEBUG_PREFIX = '[SimManager]';

// ============================================
// Default Settings
// ============================================
const defaultSettings = {
    savedPrompts: [],
    notificationsEnabled: true,
};

function ensureSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = structuredClone(defaultSettings);
    }
    const s = extension_settings[EXTENSION_NAME];
    if (!Array.isArray(s.savedPrompts)) s.savedPrompts = [];
    if (typeof s.notificationsEnabled !== 'boolean') s.notificationsEnabled = true;
}

function getSimulations() {
    if (!chat_metadata[EXTENSION_NAME]) {
        chat_metadata[EXTENSION_NAME] = { simulations: [] };
    }
    if (!Array.isArray(chat_metadata[EXTENSION_NAME].simulations)) {
        chat_metadata[EXTENSION_NAME].simulations = [];
    }
    return chat_metadata[EXTENSION_NAME].simulations;
}

function saveSimulations() {
    saveChatDebounced();
}

// ============================================
// State
// ============================================
let currentView = 'list'; // 'list' | 'create' | 'detail'
let currentSimId = null;

// ============================================
// HTML Builders
// ============================================
function buildPopupHTML() {
    return `
    <div id="sim-manager-popup">
        <div id="sim-manager-panel">
            <div class="sim-header">
                <h3><i class="fa-solid fa-flask"></i> 시뮬레이션 매니저</h3>
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

function buildSettingsHTML() {
    return `
    <div id="sim-manager-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>시뮬레이션 매니저</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div style="padding: 8px 0;">
                    <label style="font-size:13px; display:flex; align-items:center; gap:6px; margin-bottom:8px;">
                        <input type="checkbox" id="sim-notifications-toggle" />
                        시뮬 완료 시 알림 표시
                    </label>
                    <hr />
                    <h4 style="margin:8px 0 4px; font-size:14px;">저장된 시뮬 프롬프트</h4>
                    <select id="sim-prompt-select" style="width:100%; padding:8px 10px; border:1px solid var(--SmartThemeBorderColor,#444); border-radius:6px; background:var(--SmartThemeBlurTintColor,#0d1117); color:var(--SmartThemeBodyColor,#ddd); font-size:13px; margin-bottom:8px;"></select>
                    <div id="sim-prompt-edit-area" style="display:flex; flex-direction:column; gap:8px;">
                        <label style="font-size:12px; color:#aaa;">프롬프트 이름</label>
                        <input type="text" id="sim-new-prompt-name" placeholder="프롬프트 이름" style="width:100%; padding:8px 10px; border:1px solid var(--SmartThemeBorderColor,#444); border-radius:6px; background:var(--SmartThemeBlurTintColor,#0d1117); color:var(--SmartThemeBodyColor,#ddd); font-size:13px;" />
                        <label style="font-size:12px; color:#aaa;">프롬프트 내용</label>
                        <textarea id="sim-new-prompt-content" placeholder="프롬프트 내용" style="width:100%; min-height:100px; padding:10px; border:1px solid var(--SmartThemeBorderColor,#444); border-radius:6px; background:var(--SmartThemeBlurTintColor,#0d1117); color:var(--SmartThemeBodyColor,#ddd); font-size:13px; resize:vertical; font-family:inherit; line-height:1.5;"></textarea>
                        <div style="display:flex; gap:8px; justify-content:flex-end;">
                            <button class="sim-btn sim-btn-danger" id="sim-delete-prompt-btn" style="display:none;">삭제</button>
                            <button class="sim-btn sim-btn-primary" id="sim-save-prompt-btn">저장</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;
}

function buildWandButtonHTML() {
    return `
    <div id="sim-manager-wand-btn" class="list-group-item flex-container flexGap5" title="시뮬레이션 매니저 열기">
        <div class="fa-solid fa-flask extensionsMenuExtensionButton"></div>
        <span>시뮬레이션</span>
    </div>`;
}

// ============================================
// Render Views
// ============================================
function renderListView() {
    const sims = getSimulations();
    const container = document.getElementById('sim-content');
    if (!container) return;

    let html = `<div class="sim-list-view">`;
    html += `<button class="sim-new-btn" id="sim-go-create"><i class="fa-solid fa-plus"></i> 새 시뮬레이션</button>`;

    if (sims.length === 0) {
        html += `<div class="sim-empty"><i class="fa-solid fa-flask" style="font-size:32px; margin-bottom:12px; opacity:0.3;"></i><br>아직 시뮬레이션이 없습니다.<br>위 버튼을 눌러 새로 만들어보세요.</div>`;
    } else {
        // 최신순
        const sorted = [...sims].reverse();
        for (const sim of sorted) {
            const responseCount = sim.responses ? sim.responses.length : 0;
            const date = new Date(sim.createdAt).toLocaleString();
            const promptPreview = sim.promptText.length > 80
                ? sim.promptText.substring(0, 80) + '...'
                : sim.promptText;
            html += `
            <div class="sim-item" data-sim-id="${sim.id}">
                <div class="sim-item-prompt">${escapeHtml(promptPreview)}</div>
                <div class="sim-item-meta">
                    <span>${date}</span>
                    <span>답변 ${responseCount}개</span>
                </div>
            </div>`;
        }
    }
    html += `</div>`;
    container.innerHTML = html;

    // Footer 비우기
    const footer = document.getElementById('sim-footer');
    if (footer) { footer.innerHTML = ''; footer.classList.add('hidden'); }

    // 이벤트 바인딩
    document.getElementById('sim-go-create')?.addEventListener('click', () => {
        currentView = 'create';
        renderCreateView();
    });

    container.querySelectorAll('.sim-item').forEach(el => {
        el.addEventListener('click', () => {
            currentSimId = el.dataset.simId;
            currentView = 'detail';
            renderDetailView();
        });
    });
}

function renderCreateView() {
    const container = document.getElementById('sim-content');
    if (!container) return;

    ensureSettings();
    const savedPrompts = extension_settings[EXTENSION_NAME].savedPrompts;

    let selectOptions = `<option value="">-- 직접 입력 --</option>`;
    for (const p of savedPrompts) {
        selectOptions += `<option value="${p.id}">${escapeHtml(p.name)}</option>`;
    }

    const html = `
    <div class="sim-create-view">
        <button class="sim-btn" id="sim-back-to-list" style="align-self:flex-start;">
            <i class="fa-solid fa-arrow-left"></i> 목록으로
        </button>

        <label>저장된 프롬프트 불러오기</label>
        <select class="sim-saved-prompts-select" id="sim-load-prompt">
            ${selectOptions}
        </select>

        <label>시뮬레이션 내용</label>
        <textarea class="sim-prompt-textarea" id="sim-prompt-input" placeholder="프롬프트 내용"></textarea>
    </div>`;

    container.innerHTML = html;

    // Footer에 버튼
    const footer = document.getElementById('sim-footer');
    if (footer) {
        footer.classList.remove('hidden');
        footer.innerHTML = `
        <div class="sim-create-actions">
            <button class="sim-btn" id="sim-cancel-create">취소</button>
            <button class="sim-btn sim-btn-primary" id="sim-send-btn"><i class="fa-solid fa-paper-plane"></i> 시뮬 전송</button>
        </div>`;
    }

    // 이벤트 바인딩
    document.getElementById('sim-back-to-list')?.addEventListener('click', goToList);
    document.getElementById('sim-cancel-create')?.addEventListener('click', goToList);

    document.getElementById('sim-load-prompt')?.addEventListener('change', (e) => {
        const promptId = e.target.value;
        if (!promptId) return;
        const found = savedPrompts.find(p => p.id === promptId);
        if (found) {
            document.getElementById('sim-prompt-input').value = found.content;
        }
    });

    document.getElementById('sim-send-btn')?.addEventListener('click', handleSendSimulation);
}

function renderDetailView() {
    const container = document.getElementById('sim-content');
    if (!container) return;

    const sims = getSimulations();
    const sim = sims.find(s => s.id === currentSimId);
    if (!sim) {
        goToList();
        return;
    }

    const responseCount = sim.responses ? sim.responses.length : 0;
    const currentIdx = sim.currentIndex || 0;
    const currentResponse = responseCount > 0 ? sim.responses[currentIdx] : '';

    const html = `
    <div class="sim-detail-view">
        <button class="sim-btn" id="sim-back-to-list" style="align-self:flex-start;">
            <i class="fa-solid fa-arrow-left"></i> 목록으로
        </button>

        <div class="sim-detail-prompt-box">
            <div class="sim-detail-prompt-label">시뮬 요청</div>
            <div class="sim-detail-prompt-text">${escapeHtml(sim.promptText)}</div>
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
            <div class="sim-response-text ${responseCount === 0 ? 'loading' : ''}" id="sim-response-display">
                ${responseCount === 0 ? '아직 응답이 없습니다...' : renderResponseText(currentResponse)}
            </div>
        </div>

    </div>`;

    container.innerHTML = html;

    // Footer에 버튼 배치 (스크롤 영역 밖, 항상 보임)
    const footer = document.getElementById('sim-footer');
    if (footer) {
        footer.classList.remove('hidden');
        footer.innerHTML = `
        <div class="sim-detail-actions">
            <div class="sim-detail-left-actions">
                <button class="sim-btn sim-btn-danger" id="sim-delete-sim"><i class="fa-solid fa-trash"></i> 시뮬 삭제</button>
                ${responseCount > 1 ? `<button class="sim-btn sim-btn-danger" id="sim-delete-response"><i class="fa-solid fa-xmark"></i> 이 답변 삭제</button>` : ''}
            </div>
            <div class="sim-detail-right-actions">
                <button class="sim-btn sim-btn-primary" id="sim-regenerate"><i class="fa-solid fa-rotate-right"></i> 답변 추가 생성</button>
            </div>
        </div>`;
    }

    // 이벤트 바인딩
    document.getElementById('sim-back-to-list')?.addEventListener('click', goToList);

    document.getElementById('sim-prev-response')?.addEventListener('click', () => {
        if (sim.currentIndex > 0) {
            sim.currentIndex--;
            saveSimulations();
            renderDetailView();
        }
    });

    document.getElementById('sim-next-response')?.addEventListener('click', () => {
        if (sim.currentIndex < sim.responses.length - 1) {
            sim.currentIndex++;
            saveSimulations();
            renderDetailView();
        }
    });

    document.getElementById('sim-regenerate')?.addEventListener('click', () => {
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
            sim.responses.splice(sim.currentIndex, 1);
            if (sim.currentIndex >= sim.responses.length) {
                sim.currentIndex = Math.max(0, sim.responses.length - 1);
            }
            saveSimulations();
            renderDetailView();
        }
    });
}

// ============================================
// Actions
// ============================================
async function handleSendSimulation() {
    const promptInput = document.getElementById('sim-prompt-input');
    if (!promptInput) return;

    const rawPrompt = promptInput.value.trim();
    if (!rawPrompt) {
        alert('시뮬레이션 내용을 입력해주세요.');
        return;
    }

    // 매크로 치환
    const resolvedPrompt = substituteParams(rawPrompt);

    // 시뮬 데이터 생성
    const sim = {
        id: `sim_${uuidv4()}`,
        promptText: rawPrompt,
        responses: [],
        currentIndex: 0,
        createdAt: Date.now(),
    };

    const sims = getSimulations();
    sims.push(sim);
    saveSimulations();

    // 보낸 프롬프트 자동 저장 (중복 방지)
    ensureSettings();
    const savedPrompts = extension_settings[EXTENSION_NAME].savedPrompts;
    const alreadySaved = savedPrompts.some(p => p.content === rawPrompt);
    if (!alreadySaved) {
        savedPrompts.push({
            id: `prompt_${uuidv4()}`,
            name: rawPrompt.length > 20 ? rawPrompt.substring(0, 20) + '...' : rawPrompt,
            content: rawPrompt,
        });
        saveSettingsDebounced();
        renderSettingsSavedPrompts();
    }

    // 디테일 뷰로 이동
    currentSimId = sim.id;
    currentView = 'detail';
    renderDetailView();

    // 백그라운드 생성
    try {
        console.log(DEBUG_PREFIX, 'Generating simulation response...');
        const sendBtn = document.getElementById('sim-regenerate');
        if (sendBtn) sendBtn.disabled = true;

        const systemPrompt = buildSimulationSystemPrompt(resolvedPrompt);
        const response = await generateQuietPrompt({ quietPrompt: systemPrompt });

        sim.responses.push(response);
        sim.currentIndex = 0;
        saveSimulations();

        // 뷰 갱신
        if (currentView === 'detail' && currentSimId === sim.id) {
            renderDetailView();
        }

        // 알림
        showSimNotification(sim);

        console.log(DEBUG_PREFIX, 'Simulation response received.');
    } catch (err) {
        console.error(DEBUG_PREFIX, 'Generation failed:', err);
        toastr.error('시뮬레이션 생성에 실패했습니다.', '시뮬 매니저');
    }
}

async function handleRegenerateSimulation(sim) {
    const resolvedPrompt = substituteParams(sim.promptText);
    const systemPrompt = buildSimulationSystemPrompt(resolvedPrompt);

    const btn = document.getElementById('sim-regenerate');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 생성 중...';
    }

    try {
        const response = await generateQuietPrompt({ quietPrompt: systemPrompt });
        sim.responses.push(response);
        sim.currentIndex = sim.responses.length - 1;
        saveSimulations();

        if (currentView === 'detail' && currentSimId === sim.id) {
            renderDetailView();
        }

        showSimNotification(sim);
    } catch (err) {
        console.error(DEBUG_PREFIX, 'Regeneration failed:', err);
        toastr.error('답변 추가 생성에 실패했습니다.', '시뮬 매니저');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> 답변 추가 생성';
        }
    }
}

function buildSimulationSystemPrompt(resolvedPrompt) {
    return `[System: The user has requested a simulation/what-if scenario outside the main roleplay. Generate a response based on the following request. Stay in character and maintain the established setting, personality, and tone. This is a standalone simulation and should NOT affect the main conversation.]\n\nUser's simulation request: ${resolvedPrompt}`;
}

// ============================================
// Notification
// ============================================
function showSimNotification(sim) {
    ensureSettings();
    if (!extension_settings[EXTENSION_NAME].notificationsEnabled) return;

    // toastr 사용 (SillyTavern에 내장)
    if (typeof toastr !== 'undefined') {
        toastr.success(
            `시뮬 응답이 도착했습니다!`,
            '시뮬레이션 매니저',
            { timeOut: 4000, onclick: () => openPopupToSim(sim.id) },
        );
    }
}

// ============================================
// Settings Panel
// ============================================
let selectedPromptId = null; // null = 새로 생성 모드

function renderSettingsSavedPrompts() {
    ensureSettings();
    const select = document.getElementById('sim-prompt-select');
    const nameInput = document.getElementById('sim-new-prompt-name');
    const contentInput = document.getElementById('sim-new-prompt-content');
    const deleteBtn = document.getElementById('sim-delete-prompt-btn');
    if (!select) return;

    const prompts = extension_settings[EXTENSION_NAME].savedPrompts;

    // 셀렉트박스 옵션 구성
    let options = '<option value="">-- 새로 생성하기 --</option>';
    for (const p of prompts) {
        const selected = selectedPromptId === p.id ? 'selected' : '';
        options += `<option value="${p.id}" ${selected}>${escapeHtml(p.name)}</option>`;
    }
    select.innerHTML = options;

    // 선택 상태에 따라 입력칸 채우기
    if (selectedPromptId) {
        const found = prompts.find(p => p.id === selectedPromptId);
        if (found && nameInput && contentInput) {
            nameInput.value = found.name;
            contentInput.value = found.content;
        }
        if (deleteBtn) deleteBtn.style.display = '';
    } else {
        if (nameInput) nameInput.value = '';
        if (contentInput) contentInput.value = '';
        if (deleteBtn) deleteBtn.style.display = 'none';
    }
}

function bindSettingsEvents() {
    const select = document.getElementById('sim-prompt-select');
    const saveBtn = document.getElementById('sim-save-prompt-btn');
    const deleteBtn = document.getElementById('sim-delete-prompt-btn');

    select?.addEventListener('change', () => {
        selectedPromptId = select.value || null;
        renderSettingsSavedPrompts();
    });

    saveBtn?.addEventListener('click', () => {
        const nameInput = document.getElementById('sim-new-prompt-name');
        const contentInput = document.getElementById('sim-new-prompt-content');
        const name = nameInput?.value.trim();
        const content = contentInput?.value.trim();

        if (!name || !content) {
            alert('이름과 내용을 모두 입력해주세요.');
            return;
        }

        ensureSettings();
        const prompts = extension_settings[EXTENSION_NAME].savedPrompts;

        if (selectedPromptId) {
            // 수정
            const found = prompts.find(p => p.id === selectedPromptId);
            if (found) {
                found.name = name;
                found.content = content;
            }
        } else {
            // 새로 생성
            const newId = `prompt_${uuidv4()}`;
            prompts.push({ id: newId, name, content });
            selectedPromptId = newId;
        }

        saveSettingsDebounced();
        renderSettingsSavedPrompts();
        if (typeof toastr !== 'undefined') toastr.success('저장되었습니다.', '시뮬 매니저');
    });

    deleteBtn?.addEventListener('click', () => {
        if (!selectedPromptId) return;
        if (!confirm('이 프롬프트를 삭제하시겠습니까?')) return;

        ensureSettings();
        const prompts = extension_settings[EXTENSION_NAME].savedPrompts;
        const idx = prompts.findIndex(p => p.id === selectedPromptId);
        if (idx !== -1) {
            prompts.splice(idx, 1);
            saveSettingsDebounced();
        }
        selectedPromptId = null;
        renderSettingsSavedPrompts();
        if (typeof toastr !== 'undefined') toastr.info('삭제되었습니다.', '시뮬 매니저');
    });
}

// ============================================
// Navigation Helpers
// ============================================
function goToList() {
    currentView = 'list';
    currentSimId = null;
    renderListView();
}

function fixMobileHeight() {
    const popup = document.getElementById('sim-manager-popup');
    if (popup) {
        popup.style.height = window.innerHeight + 'px';
    }
}

function openPopup() {
    const popup = document.getElementById('sim-manager-popup');
    if (popup) {
        popup.classList.add('active');
        fixMobileHeight();
        renderListView();
    }
}

function closePopup() {
    const popup = document.getElementById('sim-manager-popup');
    if (popup) {
        popup.classList.remove('active');
    }
}

// 화면 리사이즈/회전 시 높이 재조정
window.addEventListener('resize', () => {
    const popup = document.getElementById('sim-manager-popup');
    if (popup && popup.classList.contains('active')) {
        fixMobileHeight();
    }
});

function openPopupToSim(simId) {
    currentSimId = simId;
    currentView = 'detail';
    openPopup();
    renderDetailView();
}

// ============================================
// Utils
// ============================================
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function renderResponseText(text) {
    // SillyTavern에 내장된 마크다운 라이브러리가 있으면 사용, 없으면 간이 파서
    if (typeof marked !== 'undefined' && marked.parse) {
        try {
            return DOMPurify ? DOMPurify.sanitize(marked.parse(text)) : marked.parse(text);
        } catch (e) { /* fallback */ }
    }

    // 간이 md -> html 변환
    let html = escapeHtml(text);

    // 코드블록 (```)
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    // 인라인 코드
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // 헤더
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // 볼드 + 이탤릭
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // 인용
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    // 수평선
    html = html.replace(/^---$/gm, '<hr>');
    // 줄바꿈
    html = html.replace(/\n/g, '<br>');

    return html;
}

// ============================================
// Initialization
// ============================================
(function init() {
    ensureSettings();

    // 1. 팝업 추가
    document.body.insertAdjacentHTML('beforeend', buildPopupHTML());

    // 팝업 이벤트
    document.getElementById('sim-close')?.addEventListener('click', closePopup);
    document.getElementById('sim-manager-popup')?.addEventListener('click', (e) => {
        if (e.target.id === 'sim-manager-popup') closePopup();
    });

    // 2. 확장 설정 패널 추가
    const settingsContainer = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (settingsContainer) {
        settingsContainer.insertAdjacentHTML('beforeend', buildSettingsHTML());

        // 알림 토글
        const toggle = document.getElementById('sim-notifications-toggle');
        if (toggle) {
            toggle.checked = extension_settings[EXTENSION_NAME].notificationsEnabled;
            toggle.addEventListener('change', () => {
                extension_settings[EXTENSION_NAME].notificationsEnabled = toggle.checked;
                saveSettingsDebounced();
            });
        }

        // 셀렉트박스 이벤트 바인딩
        bindSettingsEvents();
        renderSettingsSavedPrompts();
    }

    // 3. 지팡이 메뉴에 버튼 추가
    const wandMenu = document.getElementById('extensionsMenu');
    if (wandMenu) {
        wandMenu.insertAdjacentHTML('beforeend', buildWandButtonHTML());
        document.getElementById('sim-manager-wand-btn')?.addEventListener('click', () => {
            openPopup();
            // 지팡이 메뉴 닫기
            wandMenu.style.display = 'none';
        });
    }

    // 4. 채팅 변경 시 뷰 초기화
    eventSource.on(event_types.CHAT_CHANGED, () => {
        currentView = 'list';
        currentSimId = null;
    });

    console.log(DEBUG_PREFIX, 'Simulation Manager loaded successfully.');
})();
