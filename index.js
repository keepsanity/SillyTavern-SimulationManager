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

import { extension_settings, saveMetadataDebounced, getContext } from '../../../extensions.js';
import { eventSource, event_types, generateQuietPrompt, substituteParams, chat_metadata, saveChatDebounced, saveSettingsDebounced, getRequestHeaders, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';
import { uuidv4 } from '../../../utils.js';
import { parseReasoningFromString } from '../../../reasoning.js';

const EXTENSION_NAME = 'SillyTavern-SimulationManager';
const DEBUG_PREFIX = '[SimManager]';

// ============================================
// Default Settings
// ============================================
const defaultSettings = {
    savedPrompts: [],
    notificationsEnabled: true,
    globalSimulations: {}, // { chatKey: { chatName, simulations: [...] } }
    // 번역 설정
    translationEnabled: false,
    translationTargetLang: '한국어',
    translationCustomPrompt: '',
    translationProfileId: '',
};

function ensureSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = structuredClone(defaultSettings);
    }
    const s = extension_settings[EXTENSION_NAME];
    if (!Array.isArray(s.savedPrompts)) s.savedPrompts = [];
    if (typeof s.notificationsEnabled !== 'boolean') s.notificationsEnabled = true;
    if (!s.globalSimulations || typeof s.globalSimulations !== 'object') s.globalSimulations = {};
    if (typeof s.translationEnabled !== 'boolean') s.translationEnabled = false;
    if (!s.translationTargetLang) s.translationTargetLang = '한국어';
    if (typeof s.translationCustomPrompt !== 'string') s.translationCustomPrompt = '';
    if (typeof s.translationProfileId !== 'string') s.translationProfileId = '';
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
    syncToGlobal();
}

// ============================================
// Global Simulation Store
// ============================================
function getCurrentChatKey() {
    try {
        const context = getContext();
        if (context.groupId) return `group_${context.groupId}`;
        // 캐릭터 이름 + 채팅 파일명 (스캔 키와 동일 형식)
        const charIdx = context.characterId;
        const characters = context.characters || [];
        const char = characters[charIdx];
        if (char) {
            // char.chat = 현재 열린 채팅 파일명 (확장자 없음)
            return `${char.name}_${char.chat || context.chatId || 0}`;
        }
        const charName = context.name2 || 'unknown';
        const chatId = context.chatId ?? 0;
        return `${charName}_${chatId}`;
    } catch {
        return null;
    }
}

function getCurrentChatDisplayName() {
    try {
        const context = getContext();
        if (context.groupId) {
            return context.name2 || '그룹 채팅';
        }
        const charIdx = context.characterId;
        const characters = context.characters || [];
        const char = characters[charIdx];
        const chatFile = char?.chat || context.chatId || '';
        if (chatFile) {
            return String(chatFile);
        }
        return context.name2 || '알 수 없는 채팅';
    } catch {
        return '알 수 없는 채팅';
    }
}

function syncToGlobal() {
    const chatKey = getCurrentChatKey();
    if (!chatKey) return;
    ensureSettings();
    const global = extension_settings[EXTENSION_NAME].globalSimulations;
    const sims = getSimulations();

    if (sims.length === 0) {
        delete global[chatKey];
    } else {
        global[chatKey] = {
            chatName: getCurrentChatDisplayName(),
            simulations: structuredClone(sims),
        };
    }
    saveSettingsDebounced();
}

// 전체 채팅방 스캔 → 글로벌 동기화
async function scanAllChatsForSimulations() {
    ensureSettings();
    const global = extension_settings[EXTENSION_NAME].globalSimulations;
    let totalFound = 0;

    try {
        const context = getContext();
        const headers = getRequestHeaders();

        // 1. 현재 채팅 먼저 동기화
        const currentKey = getCurrentChatKey();
        if (currentKey) {
            const currentSims = getSimulations();
            if (currentSims.length > 0) {
                global[currentKey] = {
                    chatName: getCurrentChatDisplayName(),
                    simulations: structuredClone(currentSims),
                };
                totalFound += currentSims.length;
            }
        }

        // 2. 모든 캐릭터의 모든 채팅 파일 스캔
        const characters = context.characters || [];
        for (const char of characters) {
            if (!char?.avatar) continue;

            let chatFiles = [];
            try {
                const listRes = await fetch('/api/characters/chats', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ avatar_url: char.avatar }),
                });
                if (!listRes.ok) continue;
                chatFiles = Object.values(await listRes.json());
            } catch (e) { continue; }

            if (!Array.isArray(chatFiles)) continue;

            for (const chatFile of chatFiles) {
                const fileName = chatFile.file_name;
                if (!fileName) continue;

                // 현재 열려있는 채팅이면 이미 동기화했으므로 스킵
                const scanKey = `${char.name}_${fileName.replace('.jsonl', '')}`;
                if (scanKey === currentKey) continue;

                try {
                    const chatRes = await fetch('/api/chats/get', {
                        method: 'POST',
                        headers,
                        cache: 'no-cache',
                        body: JSON.stringify({
                            ch_name: char.name,
                            file_name: fileName.replace('.jsonl', ''),
                            avatar_url: char.avatar,
                        }),
                    });
                    if (!chatRes.ok) continue;
                    const messages = await chatRes.json();

                    if (!Array.isArray(messages) || messages.length === 0) continue;

                    // JSONL 첫 번째 줄 = chat_metadata
                    const metadata = messages[0];
                    const extData = metadata?.[EXTENSION_NAME];

                    if (extData?.simulations?.length > 0) {
                        global[scanKey] = {
                            chatName: fileName.replace('.jsonl', ''),
                            simulations: structuredClone(extData.simulations),
                        };
                        totalFound += extData.simulations.length;
                    }
                } catch (e) { continue; }
            }
        }

        // 3. 그룹 채팅 스캔
        const groups = context.groups || [];
        for (const group of groups) {
            if (!group?.id) continue;

            try {
                const chatRes = await fetch('/api/chats/group/get', {
                    method: 'POST',
                    headers,
                    cache: 'no-cache',
                    body: JSON.stringify({ id: group.id }),
                });
                if (!chatRes.ok) continue;
                const messages = await chatRes.json();

                if (!Array.isArray(messages) || messages.length === 0) continue;

                const metadata = messages[0];
                const extData = metadata?.[EXTENSION_NAME];

                if (extData?.simulations?.length > 0) {
                    const groupKey = `group_${group.id}`;
                    global[groupKey] = {
                        chatName: group.name || '그룹 채팅',
                        simulations: structuredClone(extData.simulations),
                    };
                    totalFound += extData.simulations.length;
                }
            } catch (e) { continue; }
        }

        saveSettingsDebounced();
        return totalFound;
    } catch (e) {
        console.error(DEBUG_PREFIX, 'Scan failed:', e);
        return -1;
    }
}

// ============================================
// State
// ============================================
let currentView = 'list'; // 'list' | 'create' | 'detail' | 'globalList' | 'globalSimList' | 'globalDetail'
let currentSimId = null;
let isEditingPrompt = false;
let isEditingResponse = false;

// Global viewer state
let globalViewChatKey = null;
let globalViewSimId = null;
let globalViewSimIndex = 0;
let isEditingGlobalPrompt = false;
let isEditingGlobalResponse = false;

// Translation state
let showTranslated = false; // true면 번역 보기, false면 원문 보기
let isTranslating = false;

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
                    <button class="sim-btn sim-btn-primary" id="sim-global-viewer-btn" style="width:100%; margin-bottom:12px; padding:10px;">
                        <i class="fa-solid fa-layer-group"></i> 시뮬레이션 모아보기
                    </button>
                    <hr />
                    <h4 style="margin:8px 0 4px; font-size:14px;">번역 설정</h4>
                    <label style="font-size:13px; display:flex; align-items:center; gap:6px; margin-bottom:8px;">
                        <input type="checkbox" id="sim-translation-toggle" />
                        응답 번역 기능 사용
                    </label>
                    <div id="sim-translation-settings" style="display:none; margin-bottom:8px;">
                        <label style="font-size:12px; color:#aaa;">Connection Profile</label>
                        <select id="sim-translation-profile" class="text_pole connection_profile" style="width:100%; padding:8px 10px; border:1px solid var(--SmartThemeBorderColor,#444); border-radius:6px; background:var(--SmartThemeBlurTintColor,#0d1117); color:var(--SmartThemeBodyColor,#ddd); font-size:13px; margin-bottom:8px;"></select>
                        <label style="font-size:12px; color:#aaa;">번역 대상 언어</label>
                        <input type="text" id="sim-translation-lang" placeholder="한국어" style="width:100%; padding:8px 10px; border:1px solid var(--SmartThemeBorderColor,#444); border-radius:6px; background:var(--SmartThemeBlurTintColor,#0d1117); color:var(--SmartThemeBodyColor,#ddd); font-size:13px; margin-bottom:8px;" />
                        <label style="font-size:12px; color:#aaa;">커스텀 번역 프롬프트 (선택)</label>
                        <textarea id="sim-translation-prompt" placeholder="비워두면 기본 프롬프트 사용" style="width:100%; min-height:60px; padding:10px; border:1px solid var(--SmartThemeBorderColor,#444); border-radius:6px; background:var(--SmartThemeBlurTintColor,#0d1117); color:var(--SmartThemeBodyColor,#ddd); font-size:13px; resize:vertical; font-family:inherit; line-height:1.5;"></textarea>
                    </div>
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
        ensureSettings();
        const savedPrompts = extension_settings[EXTENSION_NAME].savedPrompts;
        let needsSave = false;
        const sorted = [...sims].reverse();
        for (const sim of sorted) {
            const responseCount = sim.responses ? sim.responses.length : 0;
            const date = new Date(sim.createdAt).toLocaleString();
            const found = savedPrompts.find(p => p.content === sim.promptText);
            if (found && sim.promptName !== found.name) {
                sim.promptName = found.name; needsSave = true;
            }
            const displayName = sim.promptName || (sim.promptText.length > 80
                ? sim.promptText.substring(0, 80) + '...'
                : sim.promptText);
            html += `
            <div class="sim-item" data-sim-id="${sim.id}">
                <div class="sim-item-prompt">${escapeHtml(displayName)}</div>
                <div class="sim-item-meta">
                    <span>${date}</span>
                    <span>답변 ${responseCount}개</span>
                </div>
            </div>`;
        }
        if (needsSave) saveSimulations();
    }
    html += `</div>`;
    container.innerHTML = html;

    const footer = document.getElementById('sim-footer');
    if (footer) { footer.innerHTML = ''; footer.classList.add('hidden'); }

    document.getElementById('sim-go-create')?.addEventListener('click', () => {
        currentView = 'create';
        renderCreateView();
    });

    container.querySelectorAll('.sim-item').forEach(el => {
        el.addEventListener('click', () => {
            currentSimId = el.dataset.simId;
            currentView = 'detail';
            isEditingPrompt = false;
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

    const footer = document.getElementById('sim-footer');
    if (footer) {
        footer.classList.remove('hidden');
        footer.innerHTML = `
        <div class="sim-create-actions">
            <button class="sim-btn" id="sim-cancel-create">취소</button>
            <button class="sim-btn sim-btn-primary" id="sim-send-btn"><i class="fa-solid fa-paper-plane"></i> 시뮬 전송</button>
        </div>`;
    }

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

    // 프롬프트 영역: 수정 모드 vs 보기 모드
    let promptBoxContent;
    if (isEditingPrompt) {
        promptBoxContent = `
            <div class="sim-detail-prompt-label">시뮬 요청 <span style="font-size:10px; color:#888;">(수정 중)</span></div>
            <textarea class="sim-edit-prompt-textarea" id="sim-edit-prompt-input">${escapeHtml(sim.promptText)}</textarea>
            <div class="sim-edit-prompt-actions">
                <button class="sim-btn" id="sim-edit-cancel">취소</button>
                <button class="sim-btn sim-btn-primary" id="sim-edit-save">저장</button>
            </div>`;
    } else {
        promptBoxContent = `
            <details class="sim-prompt-toggle">
                <summary class="sim-detail-prompt-header">
                    <div class="sim-detail-prompt-label"><i class="fa-solid fa-chevron-right sim-prompt-arrow"></i> 시뮬 요청</div>
                    <button class="sim-btn-icon" id="sim-edit-prompt-btn" title="수정"><i class="fa-solid fa-pen"></i> 수정</button>
                </summary>
                <div class="sim-detail-prompt-text">${escapeHtml(sim.promptText)}</div>
            </details>`;
    }

    const html = `
    <div class="sim-detail-view">
        <button class="sim-btn" id="sim-back-to-list" style="align-self:flex-start;">
            <i class="fa-solid fa-arrow-left"></i> 목록으로
        </button>

        <div class="sim-detail-prompt-box">
            ${promptBoxContent}
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
            ${responseCount > 0 && !isEditingResponse ? `
            <div class="sim-response-actions-row">
                ${buildTranslateButtonHTML(sim, currentIdx)}
                <button class="sim-btn-icon" id="sim-edit-response-btn" title="응답 수정"><i class="fa-solid fa-pen"></i> 수정</button>
                ${responseCount > 1 ? `<button class="sim-btn-icon sim-btn-icon-danger" id="sim-delete-response" title="이 답변 삭제"><i class="fa-solid fa-xmark"></i> 삭제</button>` : ''}
            </div>
            ` : ''}
            ${isEditingResponse && responseCount > 0 ? `
                <textarea class="sim-edit-response-textarea" id="sim-edit-response-input">${escapeHtml(currentResponse)}</textarea>
                <div class="sim-edit-prompt-actions">
                    <button class="sim-btn" id="sim-edit-response-cancel">취소</button>
                    <button class="sim-btn sim-btn-primary" id="sim-edit-response-save">저장</button>
                </div>
            ` : `
                ${renderThinkingBlock(sim, currentIdx)}
                <div class="sim-response-text ${responseCount === 0 ? 'loading' : ''}" id="sim-response-display">
                    ${responseCount === 0 ? '아직 응답이 없습니다...' : renderResponseText(getDisplayResponse(sim, currentIdx))}
                </div>
            `}
        </div>
    </div>`;

    container.innerHTML = html;

    // Footer
    const footer = document.getElementById('sim-footer');
    if (footer) {
        footer.classList.remove('hidden');
        footer.innerHTML = `
        <div class="sim-detail-actions">
            <button class="sim-btn sim-btn-sm sim-btn-danger" id="sim-delete-sim"><i class="fa-solid fa-trash"></i> 시뮬 삭제</button>
            <button class="sim-btn sim-btn-sm sim-btn-primary" id="sim-regenerate"><i class="fa-solid fa-rotate-right"></i> 답변 추가 생성</button>
        </div>`;
    }

    // 이벤트 바인딩
    document.getElementById('sim-back-to-list')?.addEventListener('click', goToList);

    // 수정 관련 이벤트
    document.getElementById('sim-edit-prompt-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isEditingPrompt = true;
        renderDetailView();
    });

    document.getElementById('sim-edit-cancel')?.addEventListener('click', () => {
        isEditingPrompt = false;
        renderDetailView();
    });

    document.getElementById('sim-edit-save')?.addEventListener('click', () => {
        const textarea = document.getElementById('sim-edit-prompt-input');
        if (!textarea) return;
        const newText = textarea.value.trim();
        if (!newText) {
            alert('내용을 입력해주세요.');
            return;
        }
        sim.promptText = newText;
        isEditingPrompt = false;
        saveSimulations();
        renderDetailView();
        if (typeof toastr !== 'undefined') toastr.success('시뮬 내용이 수정되었습니다.', '시뮬 매니저');
    });

    // 응답 수정 관련 이벤트
    document.getElementById('sim-edit-response-btn')?.addEventListener('click', () => {
        isEditingResponse = true;
        renderDetailView();
    });

    document.getElementById('sim-edit-response-cancel')?.addEventListener('click', () => {
        isEditingResponse = false;
        renderDetailView();
    });

    document.getElementById('sim-edit-response-save')?.addEventListener('click', () => {
        const textarea = document.getElementById('sim-edit-response-input');
        if (!textarea) return;
        const newText = textarea.value.trim();
        if (!newText) {
            alert('내용을 입력해주세요.');
            return;
        }
        sim.responses[currentIdx] = newText;
        isEditingResponse = false;
        saveSimulations();
        renderDetailView();
        if (typeof toastr !== 'undefined') toastr.success('응답이 수정되었습니다.', '시뮬 매니저');
    });

    // 응답 네비게이션
    document.getElementById('sim-prev-response')?.addEventListener('click', () => {
        if (sim.currentIndex > 0) {
            sim.currentIndex--;
            isEditingResponse = false;
            showTranslated = false;
            saveSimulations();
            renderDetailView();
        }
    });

    document.getElementById('sim-next-response')?.addEventListener('click', () => {
        if (sim.currentIndex < sim.responses.length - 1) {
            sim.currentIndex++;
            isEditingResponse = false;
            showTranslated = false;
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
            // 번역도 삭제
            if (sim.translations) delete sim.translations[String(sim.currentIndex)];
            if (sim.currentIndex >= sim.responses.length) {
                sim.currentIndex = Math.max(0, sim.responses.length - 1);
            }
            saveSimulations();
            renderDetailView();
        }
    });

    // 번역 버튼
    container.querySelector('.sim-translate-btn')?.addEventListener('click', () => {
        translateResponse(sim, currentIdx, renderDetailView);
    });
    container.querySelector('.sim-retranslate-btn')?.addEventListener('click', () => {
        if (sim.translations) delete sim.translations[String(currentIdx)];
        showTranslated = false;
        translateResponse(sim, currentIdx, renderDetailView);
    });
}

// ============================================
// Global Viewer Views
// ============================================
function renderGlobalListView() {
    const container = document.getElementById('sim-content');
    if (!container) return;

    ensureSettings();
    const global = extension_settings[EXTENSION_NAME].globalSimulations;
    const chatKeys = Object.keys(global);

    let html = `<div class="sim-global-list-view">`;
    html += `<div class="sim-global-title">
        <span><i class="fa-solid fa-layer-group"></i> 전체 시뮬레이션 모아보기</span>
        <button class="sim-btn sim-btn-sm" id="sim-global-rescan" title="다시 스캔"><i class="fa-solid fa-arrows-rotate"></i> 새로고침</button>
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

    // 채팅방 클릭 → 해당 채팅의 시뮬 목록
    container.querySelectorAll('.sim-global-chat-item').forEach(el => {
        el.addEventListener('click', () => {
            globalViewChatKey = el.dataset.chatKey;
            currentView = 'globalSimList';
            renderGlobalSimListView();
        });
    });
}

function renderGlobalSimListView() {
    const container = document.getElementById('sim-content');
    if (!container) return;

    ensureSettings();
    const global = extension_settings[EXTENSION_NAME].globalSimulations;
    const chatData = global[globalViewChatKey];
    if (!chatData) {
        currentView = 'globalList';
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
            const displayName = sim.promptName || (sim.promptText.length > 60
                ? sim.promptText.substring(0, 60) + '...'
                : sim.promptText);
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
        currentView = 'globalList';
        renderGlobalListView();
    });

    // 시뮬 클릭 → 글로벌 디테일
    container.querySelectorAll('.sim-global-item').forEach(el => {
        el.addEventListener('click', () => {
            globalViewSimId = el.dataset.simId;
            globalViewSimIndex = 0;
            currentView = 'globalDetail';
            renderGlobalDetailView();
        });
    });
}

function renderGlobalDetailView() {
    const container = document.getElementById('sim-content');
    if (!container) return;

    ensureSettings();
    const global = extension_settings[EXTENSION_NAME].globalSimulations;
    const chatData = global[globalViewChatKey];
    if (!chatData) {
        currentView = 'globalList';
        renderGlobalListView();
        return;
    }

    const sim = chatData.simulations.find(s => s.id === globalViewSimId);
    if (!sim) {
        currentView = 'globalList';
        renderGlobalListView();
        return;
    }

    const responseCount = sim.responses ? sim.responses.length : 0;
    const currentIdx = globalViewSimIndex || 0;
    const currentResponse = responseCount > 0 ? sim.responses[currentIdx] : '';

    // 프롬프트 영역
    let promptBoxContent;
    if (isEditingGlobalPrompt) {
        promptBoxContent = `
            <div class="sim-detail-prompt-label">시뮬 요청 <span style="font-size:10px; color:#888;">(수정 중)</span></div>
            <textarea class="sim-edit-prompt-textarea" id="sim-gv-edit-prompt-input">${escapeHtml(sim.promptText)}</textarea>
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
                <div class="sim-detail-prompt-text">${escapeHtml(sim.promptText)}</div>
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
            ${responseCount > 0 && !isEditingGlobalResponse ? `
            <div class="sim-response-actions-row">
                ${buildTranslateButtonHTML(sim, currentIdx)}
                <button class="sim-btn-icon" id="sim-gv-edit-response-btn" title="응답 수정"><i class="fa-solid fa-pen"></i> 수정</button>
                ${responseCount > 1 ? `<button class="sim-btn-icon sim-btn-icon-danger" id="sim-gv-delete-response" title="이 답변 삭제"><i class="fa-solid fa-xmark"></i> 삭제</button>` : ''}
            </div>
            ` : ''}
            ${isEditingGlobalResponse && responseCount > 0 ? `
                <textarea class="sim-edit-response-textarea" id="sim-gv-edit-response-input">${escapeHtml(currentResponse)}</textarea>
                <div class="sim-edit-prompt-actions">
                    <button class="sim-btn" id="sim-gv-edit-response-cancel">취소</button>
                    <button class="sim-btn sim-btn-primary" id="sim-gv-edit-response-save">저장</button>
                </div>
            ` : `
                ${renderThinkingBlock(sim, currentIdx)}
                <div class="sim-response-text ${responseCount === 0 ? 'loading' : ''}">
                    ${responseCount === 0 ? '응답 없음' : renderResponseText(getDisplayResponse(sim, currentIdx))}
                </div>
            `}
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
        currentView = 'globalSimList';
        isEditingGlobalPrompt = false;
        isEditingGlobalResponse = false;
        renderGlobalSimListView();
    });

    document.getElementById('sim-gv-prev')?.addEventListener('click', () => {
        if (globalViewSimIndex > 0) {
            globalViewSimIndex--;
            isEditingGlobalResponse = false;
            showTranslated = false;
            renderGlobalDetailView();
        }
    });

    document.getElementById('sim-gv-next')?.addEventListener('click', () => {
        if (globalViewSimIndex < responseCount - 1) {
            globalViewSimIndex++;
            isEditingGlobalResponse = false;
            showTranslated = false;
            renderGlobalDetailView();
        }
    });

    // 프롬프트 수정
    document.getElementById('sim-gv-edit-prompt-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isEditingGlobalPrompt = true;
        renderGlobalDetailView();
    });

    document.getElementById('sim-gv-edit-cancel')?.addEventListener('click', () => {
        isEditingGlobalPrompt = false;
        renderGlobalDetailView();
    });

    document.getElementById('sim-gv-edit-save')?.addEventListener('click', () => {
        const textarea = document.getElementById('sim-gv-edit-prompt-input');
        if (!textarea) return;
        const newText = textarea.value.trim();
        if (!newText) { alert('내용을 입력해주세요.'); return; }
        sim.promptText = newText;
        isEditingGlobalPrompt = false;
        saveSettingsDebounced();
        renderGlobalDetailView();
        if (typeof toastr !== 'undefined') toastr.success('시뮬 내용이 수정되었습니다.', '시뮬 매니저');
    });

    // 응답 수정
    document.getElementById('sim-gv-edit-response-btn')?.addEventListener('click', () => {
        isEditingGlobalResponse = true;
        renderGlobalDetailView();
    });

    document.getElementById('sim-gv-edit-response-cancel')?.addEventListener('click', () => {
        isEditingGlobalResponse = false;
        renderGlobalDetailView();
    });

    document.getElementById('sim-gv-edit-response-save')?.addEventListener('click', () => {
        const textarea = document.getElementById('sim-gv-edit-response-input');
        if (!textarea) return;
        const newText = textarea.value.trim();
        if (!newText) { alert('내용을 입력해주세요.'); return; }
        sim.responses[currentIdx] = newText;
        isEditingGlobalResponse = false;
        saveSettingsDebounced();
        renderGlobalDetailView();
        if (typeof toastr !== 'undefined') toastr.success('응답이 수정되었습니다.', '시뮬 매니저');
    });

    // 답변 삭제
    document.getElementById('sim-gv-delete-response')?.addEventListener('click', () => {
        if (confirm('현재 보고 있는 답변을 삭제하시겠습니까?')) {
            sim.responses.splice(currentIdx, 1);
            if (sim.translations) delete sim.translations[String(currentIdx)];
            if (globalViewSimIndex >= sim.responses.length) {
                globalViewSimIndex = Math.max(0, sim.responses.length - 1);
            }
            saveSettingsDebounced();
            renderGlobalDetailView();
        }
    });

    // 번역 버튼
    container.querySelector('.sim-translate-btn')?.addEventListener('click', () => {
        translateResponse(sim, currentIdx, renderGlobalDetailView);
    });
    container.querySelector('.sim-retranslate-btn')?.addEventListener('click', () => {
        if (sim.translations) delete sim.translations[String(currentIdx)];
        showTranslated = false;
        translateResponse(sim, currentIdx, renderGlobalDetailView);
    });

    // 시뮬 삭제
    document.getElementById('sim-gv-delete-sim')?.addEventListener('click', () => {
        if (confirm('이 시뮬레이션을 삭제하시겠습니까?')) {
            const idx = chatData.simulations.findIndex(s => s.id === sim.id);
            if (idx !== -1) {
                chatData.simulations.splice(idx, 1);
                if (chatData.simulations.length === 0) {
                    delete global[globalViewChatKey];
                    currentView = 'globalList';
                    renderGlobalListView();
                } else {
                    currentView = 'globalSimList';
                    renderGlobalSimListView();
                }
                saveSettingsDebounced();
            }
        }
    });
}

// ============================================
// Translation
// ============================================
function buildTranslationPrompt(text) {
    ensureSettings();
    const s = extension_settings[EXTENSION_NAME];
    const targetLang = s.translationTargetLang || '한국어';
    const customPrompt = s.translationCustomPrompt?.trim();

    if (customPrompt) {
        return `${customPrompt}\n\nTarget language: ${targetLang}\n\nText to translate:\n${text}`;
    }

    return `[System: Translate the following text into ${targetLang}. Output ONLY the translated text, without any additional commentary, explanation, or notes. Preserve the original formatting, line breaks, and markdown syntax exactly.]\n\n${text}`;
}

async function translateResponse(sim, responseIndex, renderFn) {
    if (isTranslating) return;

    if (!sim.translations) sim.translations = {};
    const key = String(responseIndex);

    // 이미 번역이 있으면 토글만
    if (sim.translations[key]) {
        showTranslated = !showTranslated;
        renderFn();
        return;
    }

    const responseText = sim.responses[responseIndex];
    if (!responseText) return;

    ensureSettings();
    const s = extension_settings[EXTENSION_NAME];
    const profileId = s.translationProfileId;

    if (!profileId) {
        if (typeof toastr !== 'undefined') toastr.warning('번역 프로필을 설정해주세요.', '시뮬 매니저');
        return;
    }

    const context = getContext();
    if (!context.ConnectionManagerRequestService) {
        if (typeof toastr !== 'undefined') toastr.error('Connection Manager가 필요합니다.', '시뮬 매니저');
        return;
    }

    isTranslating = true;
    renderFn(); // 로딩 UI 반영

    try {
        const prompt = buildTranslationPrompt(responseText);
        const messages = [
            { role: 'system', content: 'You are a professional translator. Output ONLY the translated text without any commentary.' },
            { role: 'user', content: prompt },
        ];

        const response = await context.ConnectionManagerRequestService.sendRequest(
            profileId,
            messages,
            8192,
            { stream: false, extractData: true, includePreset: false, includeInstruct: false },
        );

        let translated = '';
        if (typeof response === 'string') {
            translated = response;
        } else if (response?.choices?.[0]?.message) {
            translated = response.choices[0].message.content || '';
        } else {
            translated = response?.content || response?.message || '';
        }

        if (!translated) throw new Error('번역 결과가 비어있습니다.');

        if (!sim.translations) sim.translations = {};
        sim.translations[key] = translated;
        showTranslated = true;

        // 저장
        if (currentView === 'detail') {
            saveSimulations();
        } else {
            saveSettingsDebounced();
        }

        if (typeof toastr !== 'undefined') toastr.success('번역 완료!', '시뮬 매니저');
    } catch (err) {
        console.error(DEBUG_PREFIX, 'Translation failed:', err);
        if (typeof toastr !== 'undefined') toastr.error(`번역 실패: ${err.message}`, '시뮬 매니저');
    } finally {
        isTranslating = false;
        renderFn();
    }
}

function buildTranslateButtonHTML(sim, responseIndex) {
    ensureSettings();
    if (!extension_settings[EXTENSION_NAME].translationEnabled) return '';

    if (!sim.translations) sim.translations = {};
    const hasTranslation = !!sim.translations[String(responseIndex)];

    if (isTranslating) {
        return `<button class="sim-btn-icon sim-translate-btn" disabled><i class="fa-solid fa-spinner fa-spin"></i> 번역 중...</button>`;
    }

    if (hasTranslation) {
        return `
            <button class="sim-btn-icon sim-translate-btn" title="번역">
                <i class="fa-solid fa-language"></i> ${showTranslated ? '원문 보기' : '번역 보기'}
            </button>
            <button class="sim-btn-icon sim-retranslate-btn" title="다시 번역">
                <i class="fa-solid fa-rotate-right"></i> 재번역
            </button>`;
    }

    return `<button class="sim-btn-icon sim-translate-btn" title="번역"><i class="fa-solid fa-language"></i> 번역</button>`;
}

function getDisplayResponse(sim, responseIndex) {
    if (!sim.translations) return sim.responses[responseIndex] || '';
    const translated = sim.translations[String(responseIndex)];
    if (showTranslated && translated) return translated;
    return sim.responses[responseIndex] || '';
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

    const resolvedPrompt = substituteParams(rawPrompt);

    // 프롬프트 이름 자동 매칭
    ensureSettings();
    const savedPrompts = extension_settings[EXTENSION_NAME].savedPrompts;
    const matchedPrompt = savedPrompts.find(p => p.content === rawPrompt);
    const promptName = matchedPrompt ? matchedPrompt.name : '';

    const sim = {
        id: `sim_${uuidv4()}`,
        promptText: rawPrompt,
        promptName: promptName,
        responses: [],
        currentIndex: 0,
        createdAt: Date.now(),
    };

    const sims = getSimulations();
    sims.push(sim);
    saveSimulations();

    // 보낸 프롬프트 자동 저장
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

    currentSimId = sim.id;
    currentView = 'detail';
    isEditingPrompt = false;
    renderDetailView();

    try {
        console.log(DEBUG_PREFIX, 'Generating simulation response...');
        const sendBtn = document.getElementById('sim-regenerate');
        if (sendBtn) sendBtn.disabled = true;

        setupSimPrompt(resolvedPrompt);
        let rawResponse;
        try {
            rawResponse = await generateQuietPrompt({ quietPrompt: '', quietToLoud: true });
        } finally {
            clearSimPrompt();
        }
        console.log(DEBUG_PREFIX, 'Raw response length:', rawResponse?.length);
        const { thinking, content } = separateThinkingContent(rawResponse);
        console.log(DEBUG_PREFIX, 'Thinking length:', thinking?.length, 'Content length:', content?.length);

        if (!sim.reasonings) sim.reasonings = [];
        sim.responses.push(content);
        sim.reasonings.push(thinking);
        sim.currentIndex = 0;
        saveSimulations();

        if (currentView === 'detail' && currentSimId === sim.id) {
            renderDetailView();
        }

        showSimNotification(sim);
        console.log(DEBUG_PREFIX, 'Simulation response received.');
    } catch (err) {
        console.error(DEBUG_PREFIX, 'Generation failed:', err);
        toastr.error('시뮬레이션 생성에 실패했습니다.', '시뮬 매니저');
    }
}

async function handleRegenerateSimulation(sim) {
    const resolvedPrompt = substituteParams(sim.promptText);

    const btn = document.getElementById('sim-regenerate');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 생성 중...';
    }

    try {
        setupSimPrompt(resolvedPrompt);
        let rawResponse;
        try {
            rawResponse = await generateQuietPrompt({ quietPrompt: '', quietToLoud: true });
        } finally {
            clearSimPrompt();
        }
        const { thinking, content } = separateThinkingContent(rawResponse);
        if (!sim.reasonings) sim.reasonings = [];
        sim.responses.push(content);
        sim.reasonings.push(thinking);
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

const SIM_SYSTEM_INSTRUCTION = 'The user has requested a simulation/what-if scenario outside the main roleplay. Generate a response based on the following request. Stay in character and maintain the established setting, personality, and tone. This is a standalone simulation and should NOT affect the main conversation.';
const SIM_INJECT_KEY = 'sim_manager_inject';

const SIM_INJECT_KEY_USER = 'sim_manager_inject_user';

function setupSimPrompt(resolvedPrompt) {
    // depth 1, system role → 먼저 (시스템 지시)
    setExtensionPrompt(SIM_INJECT_KEY, SIM_SYSTEM_INSTRUCTION, extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);
    // depth 1, user role → 나중에 (시뮬 프롬프트)
    setExtensionPrompt(SIM_INJECT_KEY_USER, resolvedPrompt, extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.USER);
}

function clearSimPrompt() {
    setExtensionPrompt(SIM_INJECT_KEY, '', extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(SIM_INJECT_KEY_USER, '', extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.USER);
}

// ============================================
// Notification
// ============================================
function showSimNotification(sim) {
    ensureSettings();
    if (!extension_settings[EXTENSION_NAME].notificationsEnabled) return;

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
let selectedPromptId = null;

function renderSettingsSavedPrompts() {
    ensureSettings();
    const select = document.getElementById('sim-prompt-select');
    const nameInput = document.getElementById('sim-new-prompt-name');
    const contentInput = document.getElementById('sim-new-prompt-content');
    const deleteBtn = document.getElementById('sim-delete-prompt-btn');
    if (!select) return;

    const prompts = extension_settings[EXTENSION_NAME].savedPrompts;

    let options = '<option value="">-- 새로 생성하기 --</option>';
    for (const p of prompts) {
        const selected = selectedPromptId === p.id ? 'selected' : '';
        options += `<option value="${p.id}" ${selected}>${escapeHtml(p.name)}</option>`;
    }
    select.innerHTML = options;

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
            const found = prompts.find(p => p.id === selectedPromptId);
            if (found) {
                found.name = name;
                found.content = content;
            }
        } else {
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

    // 모아보기 버튼
    document.getElementById('sim-global-viewer-btn')?.addEventListener('click', async () => {
        currentView = 'globalList';
        openPopup();

        ensureSettings();
        const global = extension_settings[EXTENSION_NAME].globalSimulations;
        const hasData = Object.keys(global).length > 0;

        if (hasData) {
            // 이미 스캔된 데이터가 있으면 바로 표시
            renderGlobalListView();
        } else {
            // 첫 스캔만 자동 실행
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

            const result = await scanAllChatsForSimulations();
            if (result >= 0 && typeof toastr !== 'undefined') {
                toastr.info(`${result}개의 시뮬레이션을 찾았습니다.`, '시뮬 매니저');
            }
            renderGlobalListView();
        }
    });
}

// ============================================
// Navigation Helpers
// ============================================
function goToList() {
    currentView = 'list';
    currentSimId = null;
    isEditingPrompt = false;
    isEditingResponse = false;
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
        // globalList인 경우 renderGlobalListView가 별도 호출됨
        if (currentView !== 'globalList' && currentView !== 'globalSimList' && currentView !== 'globalDetail') {
            renderListView();
        }
    }
}

function closePopup() {
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

function openPopupToSim(simId) {
    currentSimId = simId;
    currentView = 'detail';
    isEditingPrompt = false;
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

/**
 * thinking과 본문을 분리하여 반환
 * @returns {{ thinking: string, content: string }}
 */
function separateThinkingContent(text) {
    if (!text) return { thinking: '', content: text || '' };
    let thinking = '';
    let content = text;

    // 1. SillyTavern 내장 파서 시도 (prefix/suffix 기반)
    try {
        if (typeof parseReasoningFromString === 'function') {
            const parsed = parseReasoningFromString(content, { strict: false });
            if (parsed && parsed.content && parsed.content.trim().length > 0) {
                thinking = parsed.reasoning || '';
                content = parsed.content;
                return { thinking: thinking.trim(), content: content.trim() };
            }
        }
    } catch (e) { /* fallback */ }

    // 2. <think>...</think> 패턴
    const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/i);
    if (thinkMatch) {
        thinking = thinkMatch[1];
        content = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
        return { thinking: thinking.trim(), content: content.trim() };
    }

    // 3. <Thinking>...</Thinking> 패턴
    const thinkingMatch = content.match(/<Thinking>([\s\S]*?)<\/Thinking>/i);
    if (thinkingMatch) {
        thinking = thinkingMatch[1];
        content = content.replace(/<Thinking>[\s\S]*?<\/Thinking>/gi, '');
        return { thinking: thinking.trim(), content: content.trim() };
    }

    // 4. "think\n..." Gemini 패턴 (빈 줄 2개로 본문 시작)
    const geminiMatch = content.match(/^think\n([\s\S]*?)\n\n/i);
    if (geminiMatch) {
        thinking = geminiMatch[1];
        content = content.replace(/^think\n[\s\S]*?\n\n/i, '');
        return { thinking: thinking.trim(), content: content.trim() };
    }

    return { thinking: '', content: content.trim() };
}

function renderThinkingBlock(sim, index) {
    // reasonings 배열에서 가져오기
    let thinking = sim.reasonings?.[index] || '';

    // reasonings 배열이 없는 기존 데이터는 응답에서 추출 시도
    if (!thinking && sim.responses?.[index]) {
        const separated = separateThinkingContent(sim.responses[index]);
        thinking = separated.thinking;
    }

    if (!thinking) return '';

    const thinkingHtml = escapeHtml(thinking).replace(/\n/g, '<br>');
    return `<details class="sim-thinking-block">
        <summary class="sim-thinking-summary">
            <i class="fa-solid fa-brain"></i> Thinking
            <i class="fa-solid fa-chevron-down sim-thinking-arrow"></i>
        </summary>
        <div class="sim-thinking-content">${thinkingHtml}</div>
    </details>`;
}

function renderResponseText(text) {
    // 기존 데이터에 thinking이 섞여 있을 수 있으므로 본문만 추출
    const separated = separateThinkingContent(text);
    text = separated.content;
    try {
        const context = getContext();
        if (typeof context.messageFormatting === 'function') {
            const result = context.messageFormatting(text, '', false, false, -1);
            if (result && result.length > 0) return result;
        }
    } catch (e) { /* fallback */ }

    let html = escapeHtml(text);
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    html = html.replace(/(^&gt; (.+)$\n?)+/gm, (match) => {
        const lines = match.trim().split('\n').map(l => l.replace(/^&gt; /, '')).join('<br>');
        return `<blockquote>${lines}</blockquote>`;
    });
    html = html.replace(/^---$/gm, '<hr>');
    html = html.replace(/\n/g, '<br>');
    return html;
}

// ============================================
// Initialization
// ============================================
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

        const toggle = document.getElementById('sim-notifications-toggle');
        if (toggle) {
            toggle.checked = extension_settings[EXTENSION_NAME].notificationsEnabled;
            toggle.addEventListener('change', () => {
                extension_settings[EXTENSION_NAME].notificationsEnabled = toggle.checked;
                saveSettingsDebounced();
            });
        }

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

        bindSettingsEvents();
        renderSettingsSavedPrompts();
    }

    // 3. 지팡이 메뉴에 버튼 추가
    const wandMenu = document.getElementById('extensionsMenu');
    if (wandMenu) {
        wandMenu.insertAdjacentHTML('beforeend', buildWandButtonHTML());
        document.getElementById('sim-manager-wand-btn')?.addEventListener('click', () => {
            currentView = 'list';
            openPopup();
            wandMenu.style.display = 'none';
        });
    }

    // 4. 채팅 변경 시 뷰 초기화 + 글로벌 동기화
    eventSource.on(event_types.CHAT_CHANGED, () => {
        currentView = 'list';
        currentSimId = null;
        isEditingPrompt = false;

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

    console.log(DEBUG_PREFIX, 'Simulation Manager loaded successfully.');
})();
