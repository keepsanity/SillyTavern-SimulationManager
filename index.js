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
import { eventSource, event_types, generateQuietPrompt, substituteParams, chat_metadata, saveChatDebounced, saveSettingsDebounced, getRequestHeaders, setExtensionPrompt, extension_prompt_types, extension_prompt_roles, doNewChat, chat, saveChatConditional, printMessages } from '../../../../script.js';
import { uuidv4 } from '../../../utils.js';
import { getPresetManager } from '../../../preset-manager.js';
import { oai_settings, promptManager } from '../../../openai.js';

const EXTENSION_NAME = 'SillyTavern-SimulationManager';
const CUSTOM_PRESET_EXT = 'SillyTavern-CustomPreset';
const DEBUG_PREFIX = '[SimManager]';

// ============================================
// Preset Helpers
// ============================================
function getOpenAiPresetManager() {
    return getPresetManager('openai');
}

function getAvailablePresetNames() {
    const pm = getOpenAiPresetManager();
    if (!pm) return [];
    try { return pm.getAllPresets(); } catch { return []; }
}

function getCurrentPresetName() {
    return oai_settings?.preset_settings_openai || '';
}

function isCustomPresetTogglesEnabled() {
    const s = extension_settings[CUSTOM_PRESET_EXT];
    return !!(s && s.showTogglePresetFeature);
}

function getTogglePresetMap(presetName) {
    const s = extension_settings[CUSTOM_PRESET_EXT];
    if (!s || !s.togglePresets || !presetName) return null;
    const map = s.togglePresets[presetName];
    return (map && typeof map === 'object') ? map : null;
}

function getTogglePresetNames(presetName) {
    const map = getTogglePresetMap(presetName);
    if (!map) return [];
    const names = Object.keys(map);
    // 'default' 가 있으면 첫 번째로
    return ['default', ...names.filter(n => n !== 'default').sort()].filter(n => map[n]);
}

function getCurrentActiveTogglePresetName(presetName) {
    const s = extension_settings[CUSTOM_PRESET_EXT];
    if (!s || !s.activeTogglePreset || !presetName) return 'default';
    return s.activeTogglePreset[presetName] || 'default';
}

function captureToggleSnapshot() {
    const ss = promptManager?.serviceSettings;
    if (!ss?.prompt_order) return null;
    const entry = ss.prompt_order.find(e => e.character_id === 100001);
    if (!entry?.order) return null;
    const snap = {};
    for (const item of entry.order) snap[item.identifier] = !!item.enabled;
    return snap;
}

function applyToggleSnapshot(snapshot) {
    if (!snapshot) return false;
    const ss = promptManager?.serviceSettings;
    if (!ss?.prompt_order) return false;
    const entry = ss.prompt_order.find(e => e.character_id === 100001);
    if (!entry?.order) return false;
    let changed = false;
    for (const item of entry.order) {
        if (Object.prototype.hasOwnProperty.call(snapshot, item.identifier)) {
            const desired = !!snapshot[item.identifier];
            if (item.enabled !== desired) {
                item.enabled = desired;
                changed = true;
            }
        }
    }
    if (changed) {
        try { promptManager.saveServiceSettings(); } catch (e) { console.error(DEBUG_PREFIX, e); }
        try { promptManager.render(); } catch (e) { console.error(DEBUG_PREFIX, e); }
    }
    return true;
}

async function switchPresetTo(presetName) {
    const pm = getOpenAiPresetManager();
    if (!pm) return false;
    const value = pm.findPreset(presetName);
    if (value === undefined || value === null) return false;
    if (pm.getSelectedPresetName() === presetName) return true;
    const done = new Promise(resolve => {
        const onAfter = () => { eventSource.removeListener(event_types.OAI_PRESET_CHANGED_AFTER, onAfter); resolve(); };
        eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, onAfter);
        // 안전장치: 5초 내 응답 없으면 풀기
        setTimeout(() => { eventSource.removeListener(event_types.OAI_PRESET_CHANGED_AFTER, onAfter); resolve(); }, 5000);
    });
    pm.selectPreset(value);
    await done;
    return true;
}

/**
 * 시뮬레이션용 프리셋/토글 프리셋을 임시로 적용한 뒤 fn 실행, 끝나면 원복.
 * presetName / togglePresetName 가 비어있으면 해당 항목은 변경하지 않음.
 */
async function withSimulationPreset(presetName, togglePresetName, fn) {
    const pm = getOpenAiPresetManager();
    const prevPresetName = pm ? pm.getSelectedPresetName() : '';
    const prevToggleSnap = captureToggleSnapshot();
    const needPresetSwitch = !!presetName && pm && presetName !== prevPresetName;
    let presetSwitched = false;
    try {
        if (needPresetSwitch) {
            const ok = await switchPresetTo(presetName);
            if (!ok) {
                console.warn(DEBUG_PREFIX, `Preset "${presetName}" not found, using current.`);
                if (typeof toastr !== 'undefined') toastr.warning(`프리셋 "${presetName}" 을(를) 찾을 수 없어 현재 프리셋으로 진행합니다.`, '시뮬 매니저');
            } else {
                presetSwitched = true;
            }
        }
        // 토글 프리셋은 프리셋 전환 이후에 적용 (전환 시 토글 상태가 덮어써질 수 있음)
        if (togglePresetName) {
            const effectivePreset = presetSwitched ? presetName : prevPresetName;
            const map = getTogglePresetMap(effectivePreset);
            if (map && map[togglePresetName]) {
                applyToggleSnapshot(map[togglePresetName]);
            } else {
                console.warn(DEBUG_PREFIX, `Toggle preset "${togglePresetName}" not found for "${effectivePreset}".`);
            }
        }
        return await fn();
    } finally {
        // 원복: 프리셋 먼저, 토글 그 다음 (프리셋 전환이 토글을 다시 덮으므로)
        if (presetSwitched && prevPresetName) {
            try { await switchPresetTo(prevPresetName); } catch (e) { console.error(DEBUG_PREFIX, 'Restore preset failed:', e); }
        }
        if (prevToggleSnap) {
            try { applyToggleSnapshot(prevToggleSnap); } catch (e) { console.error(DEBUG_PREFIX, 'Restore toggles failed:', e); }
        }
    }
}

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
    translationVertexAuthMode: 'express', // 'express' | 'full'
    // 기본 주입 위치 ('last_message' | 'depth_1' | 'depth_0' | 'bottom')
    defaultInjectPosition: 'last_message',
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
    if (typeof s.translationVertexAuthMode !== 'string' || s.translationVertexAuthMode === '') s.translationVertexAuthMode = 'express';
    if (typeof s.defaultInjectPosition !== 'string') s.defaultInjectPosition = 'last_message';
}

function getDefaultInjectPosition() {
    ensureSettings();
    return normalizeSimPosition(extension_settings[EXTENSION_NAME].defaultInjectPosition);
}

// ============================================
// Char/User Swap & Pronoun Swap
// ============================================
// 대명사 매핑: 'her → him' 단방향 선택 (모호성 감수)
const PRONOUN_MAP = {
    he: 'she', she: 'he',
    him: 'her', her: 'him',
    his: 'her',             // "his" → "her" (소유격 his 도 목적격 her 로 간단히 뭉개기)
    himself: 'herself', herself: 'himself',
};
const PRONOUN_REGEX = /\b(he|she|him|her|his|himself|herself)\b/gi;

function preserveCase(sourceWord, targetWord) {
    if (!sourceWord) return targetWord;
    if (sourceWord === sourceWord.toUpperCase() && sourceWord !== sourceWord.toLowerCase()) {
        return targetWord.toUpperCase();
    }
    if (sourceWord[0] === sourceWord[0].toUpperCase() && sourceWord[0] !== sourceWord[0].toLowerCase()) {
        return targetWord[0].toUpperCase() + targetWord.slice(1).toLowerCase();
    }
    return targetWord.toLowerCase();
}

function applySwap(text, swapCharUser, swapPronouns) {
    if (!text) return text;
    let out = text;
    if (swapCharUser) {
        // {{char}} ↔ {{user}} 동시 교체
        out = out.replace(/\{\{(char|user)\}\}/g, (_, name) => (name === 'char' ? '{{user}}' : '{{char}}'));
    }
    if (swapPronouns) {
        out = out.replace(PRONOUN_REGEX, (match) => {
            const lower = match.toLowerCase();
            const replacement = PRONOUN_MAP[lower];
            return replacement ? preserveCase(match, replacement) : match;
        });
    }
    return out;
}

function getEffectivePromptText(sim) {
    return applySwap(sim?.promptText || '', !!sim?.swapCharUser, !!sim?.swapPronouns);
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
let tempSim = null; // 저장 안 하기 모드의 임시 sim
let isEditingPrompt = false;
let editingPartIdx = null; // null = 안 함, 0 = base, 1+ = continuation index+1

// Global viewer state
let globalViewChatKey = null;
let globalViewSimId = null;
let globalViewSimIndex = 0;
let isEditingGlobalPrompt = false;
let editingGlobalPartIdx = null;

// Translation state
let showTranslated = false; // true면 번역 보기, false면 원문 보기
let isTranslating = false;
let translatingPartIdx = null; // 현재 번역 중인 파트 인덱스

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
                    <h4 style="margin:8px 0 4px; font-size:14px;">기본 주입 위치</h4>
                    <label style="font-size:12px; color:#aaa;">새 시뮬 생성 시 기본 선택값</label>
                    <select id="sim-default-position" style="width:100%; padding:8px 10px; border:1px solid var(--SmartThemeBorderColor,#444); border-radius:6px; background:var(--SmartThemeBlurTintColor,#0d1117); color:var(--SmartThemeBodyColor,#ddd); font-size:13px; margin-bottom:8px;"></select>
                    <hr />
                    <h4 style="margin:8px 0 4px; font-size:14px;">번역 설정</h4>
                    <label style="font-size:13px; display:flex; align-items:center; gap:6px; margin-bottom:8px;">
                        <input type="checkbox" id="sim-translation-toggle" />
                        응답 번역 기능 사용
                    </label>
                    <div id="sim-translation-settings" style="display:none; margin-bottom:8px;">
                        <label style="font-size:12px; color:#aaa;">Connection Profile</label>
                        <select id="sim-translation-profile" class="text_pole connection_profile" style="width:100%; padding:8px 10px; border:1px solid var(--SmartThemeBorderColor,#444); border-radius:6px; background:var(--SmartThemeBlurTintColor,#0d1117); color:var(--SmartThemeBodyColor,#ddd); font-size:13px; margin-bottom:8px;"></select>
                        <label style="font-size:12px; color:#aaa;">Vertex AI Auth Mode (Vertex AI 프로필만 해당)</label>
                        <select id="sim-vertex-auth-mode" style="width:100%; padding:8px 10px; border:1px solid var(--SmartThemeBorderColor,#444); border-radius:6px; background:var(--SmartThemeBlurTintColor,#0d1117); color:var(--SmartThemeBodyColor,#ddd); font-size:13px; margin-bottom:8px;">
                            <option value="express">Express (API Key)</option>
                            <option value="full">Full (Service Account JSON)</option>
                        </select>
                        <label style="font-size:12px; color:#aaa;">번역 대상 언어</label>
                        <input type="text" id="sim-translation-lang" placeholder="한국어" style="width:100%; padding:8px 10px; border:1px solid var(--SmartThemeBorderColor,#444); border-radius:6px; background:var(--SmartThemeBlurTintColor,#0d1117); color:var(--SmartThemeBodyColor,#ddd); font-size:13px; margin-bottom:8px;" />
                        <label style="font-size:12px; color:#aaa;">커스텀 번역 프롬프트 (선택)</label>
                        <textarea id="sim-translation-prompt" placeholder="비워두면 기본 프롬프트 사용" style="width:100%; min-height:60px; padding:10px; border:1px solid var(--SmartThemeBorderColor,#444); border-radius:6px; background:var(--SmartThemeBlurTintColor,#0d1117); color:var(--SmartThemeBodyColor,#ddd); font-size:13px; resize:vertical; font-family:inherit; line-height:1.5;"></textarea>
                    </div>
                    <hr />
                    <h4 style="margin:8px 0 4px; font-size:14px;">저장된 시뮬 프롬프트</h4>
                    <input type="text" class="sim-prompt-search" id="sim-settings-prompt-search" placeholder="프롬프트 검색 (제목/내용)" />
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

    // 프리셋 셀렉트 옵션 (현재 프리셋이 기본 선택)
    const currentPresetName = getCurrentPresetName();
    const presetNames = getAvailablePresetNames();
    let presetOptions = '';
    for (const name of presetNames) {
        const sel = name === currentPresetName ? ' selected' : '';
        presetOptions += `<option value="${escapeHtml(name)}"${sel}>${escapeHtml(name)}</option>`;
    }

    // 토글 프리셋 영역 (CustomPreset 설치 + 활성화 시만)
    const togglesEnabled = isCustomPresetTogglesEnabled();
    const togglePresetBlock = togglesEnabled ? `
        <label>토글 프리셋 (선택)</label>
        <select class="sim-saved-prompts-select" id="sim-toggle-preset-select"></select>
    ` : '';

    const html = `
    <div class="sim-create-view">
        <button class="sim-btn" id="sim-back-to-list" style="align-self:flex-start;">
            <i class="fa-solid fa-arrow-left"></i> 목록으로
        </button>

        <label>저장된 프롬프트 불러오기</label>
        <input type="text" class="sim-prompt-search" id="sim-prompt-search" placeholder="프롬프트 검색 (제목/내용)" />
        <select class="sim-saved-prompts-select" id="sim-load-prompt">
            ${selectOptions}
        </select>

        <label>시뮬레이션 제목</label>
        <input type="text" class="sim-prompt-search" id="sim-title-input" placeholder="제목 (비우면 프롬프트 앞글자 사용)" />

        <label>시뮬레이션 내용</label>
        <textarea class="sim-prompt-textarea sim-prompt-textarea-lg" id="sim-prompt-input" placeholder="프롬프트 내용"></textarea>

        <label>프리셋 (선택)</label>
        <select class="sim-saved-prompts-select" id="sim-preset-select">
            ${presetOptions}
        </select>
        ${togglePresetBlock}

        <label>주입 위치</label>
        <select class="sim-saved-prompts-select" id="sim-position-select">
            ${Object.entries(SIM_POSITION_LABELS).map(([v, l]) =>
                `<option value="${v}"${v === getDefaultInjectPosition() ? ' selected' : ''}>${escapeHtml(l)}</option>`
            ).join('')}
        </select>

        <label class="sim-checkbox-label" style="display:flex; align-items:center; gap:6px; margin-top:6px;">
            <input type="checkbox" id="sim-swap-charuser" />
            <span>{{char}} ↔ {{user}} 교체</span>
        </label>
        <label class="sim-checkbox-label" style="display:flex; align-items:center; gap:6px;">
            <input type="checkbox" id="sim-swap-pronouns" />
            <span>대명사 교체 (he/she, him/her, ...)</span>
        </label>

        <div class="sim-create-options">`
            // <label class="sim-checkbox-label">
            //     <input type="checkbox" id="sim-no-save" />
            //     <span>이 시뮬레이션 저장 안 하기</span>
            // </label>
            +`<span class="sim-create-hint" id="sim-overwrite-hint" style="display:none;">제목이나 내용을 수정하면 새 프롬프트로 저장됩니다.</span>
        </div>
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

    document.getElementById('sim-prompt-search')?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        const select = document.getElementById('sim-load-prompt');
        if (!select) return;
        let options = `<option value="">-- 직접 입력 --</option>`;
        for (const p of savedPrompts) {
            if (!query || p.name.toLowerCase().includes(query) || p.content.toLowerCase().includes(query)) {
                options += `<option value="${p.id}">${escapeHtml(p.name)}</option>`;
            }
        }
        select.innerHTML = options;
    });

    document.getElementById('sim-load-prompt')?.addEventListener('change', (e) => {
        const promptId = e.target.value;
        const hint = document.getElementById('sim-overwrite-hint');
        if (!promptId) {
            if (hint) hint.style.display = 'none';
            return;
        }
        const found = savedPrompts.find(p => p.id === promptId);
        if (found) {
            document.getElementById('sim-prompt-input').value = found.content;
            document.getElementById('sim-title-input').value = found.name;
            if (hint) hint.style.display = '';
        }
    });

    document.getElementById('sim-send-btn')?.addEventListener('click', handleSendSimulation);

    // 프리셋 / 토글 프리셋 셀렉트 초기화 & 연동
    const presetSelect = document.getElementById('sim-preset-select');
    const togglePresetSelect = document.getElementById('sim-toggle-preset-select');

    function refreshTogglePresetOptions() {
        if (!togglePresetSelect) return;
        const chosenPreset = presetSelect?.value || getCurrentPresetName();
        const names = getTogglePresetNames(chosenPreset);
        // 선택된 프리셋이 현재 프리셋과 같으면 현재 활성 토글을, 다르면 default 선택
        const preselect = (chosenPreset === getCurrentPresetName())
            ? getCurrentActiveTogglePresetName(chosenPreset)
            : 'default';
        togglePresetSelect.innerHTML = '';
        for (const n of names) {
            const opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n === 'default' ? '기본' : n;
            if (n === preselect) opt.selected = true;
            togglePresetSelect.appendChild(opt);
        }
        // preselect 가 목록에 없으면 첫 항목이 selected 로 남음 (브라우저 기본)
    }
    refreshTogglePresetOptions();
    presetSelect?.addEventListener('change', refreshTogglePresetOptions);
}

function renderDetailView() {
    const container = document.getElementById('sim-content');
    if (!container) return;

    const sims = getSimulations();
    const sim = (tempSim && tempSim.id === currentSimId) ? tempSim : sims.find(s => s.id === currentSimId);
    if (!sim) {
        goToList();
        return;
    }

    const responseCount = sim.responses ? sim.responses.length : 0;
    const currentIdx = sim.currentIndex || 0;

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

    // ===== 설정 요약 & 편집 패널 =====
    const simPresetLabel = sim.presetName || getCurrentPresetName() || '(없음)';
    const simTogglePresetRaw = sim.togglePresetName || 'default';
    const simTogglePresetLabel = simTogglePresetRaw === 'default' ? '기본' : simTogglePresetRaw;
    const togglesEnabledForDetail = isCustomPresetTogglesEnabled();
    const simPosition = normalizeSimPosition(sim.injectPosition);
    const positionSelectOptions = Object.entries(SIM_POSITION_LABELS).map(([v, l]) =>
        `<option value="${v}"${v === simPosition ? ' selected' : ''}>${escapeHtml(l)}</option>`
    ).join('');

    const summaryParts = [];
    summaryParts.push(`프리셋 <b>${escapeHtml(simPresetLabel)}</b>`);
    if (togglesEnabledForDetail) summaryParts.push(`토글 <b>${escapeHtml(simTogglePresetLabel)}</b>`);
    summaryParts.push(`위치 <b>${escapeHtml(SIM_POSITION_LABELS[simPosition])}</b>`);
    const swapBits = [];
    if (sim.swapCharUser) swapBits.push('{{char}}↔{{user}}');
    if (sim.swapPronouns) swapBits.push('대명사');
    if (swapBits.length) summaryParts.push(`<span style="color:var(--SmartThemeQuoteColor, #7c83ff);">✓ 스왑: <b>${swapBits.join(' + ')}</b></span>`);

    const settingsBoxContent = `
        <div class="sim-detail-prompt-header" id="sim-edit-settings-btn" style="cursor:pointer;">
            <div class="sim-detail-prompt-label" style="font-size:12px; display:flex; align-items:center; gap:6px;">
                <i class="fa-solid fa-chevron-right sim-settings-arrow" id="sim-settings-arrow"></i>
                <span id="sim-detail-settings-summary">⚙ ${summaryParts.join(' / ')}</span>
            </div>
        </div>
        <div class="sim-detail-settings-edit" id="sim-detail-settings-edit" style="display:none; padding:8px 4px 4px; flex-direction:column; gap:8px;">
            <div>
                <label style="font-size:11px;">프리셋</label>
                <select class="sim-saved-prompts-select" id="sim-detail-preset-select"></select>
            </div>
            ${togglesEnabledForDetail ? `
            <div>
                <label style="font-size:11px;">토글 프리셋</label>
                <select class="sim-saved-prompts-select" id="sim-detail-toggle-preset-select"></select>
            </div>
            ` : ''}
            <div>
                <label style="font-size:11px;">주입 위치</label>
                <select class="sim-saved-prompts-select" id="sim-detail-position-select">
                    ${positionSelectOptions}
                </select>
            </div>
            <label class="sim-checkbox-label" style="display:flex; align-items:center; gap:6px; font-size:12px;">
                <input type="checkbox" id="sim-detail-swap-charuser" ${sim.swapCharUser ? 'checked' : ''} />
                <span>{{char}} ↔ {{user}} 교체</span>
            </label>
            <label class="sim-checkbox-label" style="display:flex; align-items:center; gap:6px; font-size:12px;">
                <input type="checkbox" id="sim-detail-swap-pronouns" ${sim.swapPronouns ? 'checked' : ''} />
                <span>대명사 교체 (he/she, him/her, ...)</span>
            </label>
        </div>`;

    const html = `
    <div class="sim-detail-view">
        <button class="sim-btn" id="sim-back-to-list" style="align-self:flex-start;">
            <i class="fa-solid fa-arrow-left"></i> 목록으로
        </button>

        <div class="sim-detail-prompt-box">
            ${promptBoxContent}
        </div>

        <div class="sim-detail-prompt-box">
            ${settingsBoxContent}
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
            ${responseCount > 0 ? `
            <div class="sim-response-actions-row">
                <button class="sim-btn-icon" id="sim-new-chat-btn" title="이 응답으로 새 챗 시작"><i class="fa-solid fa-comment-dots"></i> 새 챗</button>
                ${responseCount > 1 ? `<button class="sim-btn-icon sim-btn-icon-danger" id="sim-delete-response" title="이 답변 삭제"><i class="fa-solid fa-xmark"></i> 삭제</button>` : ''}
            </div>
            ` : ''}
            <div class="sim-response-text mes_text ${responseCount === 0 ? 'loading' : ''}" id="sim-response-display">
                ${responseCount === 0 ? '아직 응답이 없습니다...' : renderResponseParts(sim, currentIdx, editingPartIdx, false)}
            </div>
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
            ${responseCount > 0 ? `<button class="sim-btn sim-btn-sm" id="sim-continue"><i class="fa-solid fa-forward"></i> 이어쓰기</button>` : ''}
            <button class="sim-btn sim-btn-sm sim-btn-primary" id="sim-regenerate"><i class="fa-solid fa-rotate-right"></i> 답변 재생성</button>
        </div>`;
    }

    // 이벤트 바인딩
    document.getElementById('sim-back-to-list')?.addEventListener('click', goToList);

    // 설정 박스: 모든 변경 즉시 반영

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

    // ===== 통합 설정 패널 =====
    const settingsEditBtn = document.getElementById('sim-edit-settings-btn');
    const settingsEditPanel = document.getElementById('sim-detail-settings-edit');
    const detailPresetSelect = document.getElementById('sim-detail-preset-select');
    const detailTogglePresetSelect = document.getElementById('sim-detail-toggle-preset-select');
    const detailPositionSelect = document.getElementById('sim-detail-position-select');
    const detailSwapCharUser = document.getElementById('sim-detail-swap-charuser');
    const detailSwapPronouns = document.getElementById('sim-detail-swap-pronouns');

    const saveSimIfNotTemp = () => { if (!tempSim || tempSim.id !== sim.id) saveSimulations(); };
    const refreshSummary = () => {
        const target = document.getElementById('sim-detail-settings-summary');
        if (!target) return;
        const parts = [];
        const presetLbl = sim.presetName || getCurrentPresetName() || '(없음)';
        parts.push(`프리셋 <b>${escapeHtml(presetLbl)}</b>`);
        if (togglesEnabledForDetail) {
            const tgl = sim.togglePresetName || 'default';
            parts.push(`토글 <b>${escapeHtml(tgl === 'default' ? '기본' : tgl)}</b>`);
        }
        const pos = normalizeSimPosition(sim.injectPosition);
        parts.push(`위치 <b>${escapeHtml(SIM_POSITION_LABELS[pos])}</b>`);
        const bits = [];
        if (sim.swapCharUser) bits.push('{{char}}↔{{user}}');
        if (sim.swapPronouns) bits.push('대명사');
        if (bits.length) parts.push(`<span style="color:var(--SmartThemeQuoteColor, #7c83ff);">✓ 스왑: <b>${bits.join(' + ')}</b></span>`);
        target.innerHTML = `⚙ ${parts.join(' / ')}`;
    };

    function fillDetailPresetOptions() {
        if (!detailPresetSelect) return;
        const presetNames = getAvailablePresetNames();
        const target = sim.presetName || getCurrentPresetName();
        detailPresetSelect.innerHTML = '';
        for (const n of presetNames) {
            const opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n;
            if (n === target) opt.selected = true;
            detailPresetSelect.appendChild(opt);
        }
    }
    function fillDetailTogglePresetOptions() {
        if (!detailTogglePresetSelect) return;
        const chosen = detailPresetSelect?.value || getCurrentPresetName();
        const names = getTogglePresetNames(chosen);
        const target = (chosen === (sim.presetName || getCurrentPresetName()))
            ? (sim.togglePresetName || 'default')
            : 'default';
        detailTogglePresetSelect.innerHTML = '';
        for (const n of names) {
            const opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n === 'default' ? '기본' : n;
            if (n === target) opt.selected = true;
            detailTogglePresetSelect.appendChild(opt);
        }
    }

    // 패널 토글 (화살표 포함)
    const settingsArrow = document.getElementById('sim-settings-arrow');
    settingsEditBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!settingsEditPanel) return;
        const isOpen = settingsEditPanel.style.display !== 'none';
        if (isOpen) {
            settingsEditPanel.style.display = 'none';
            if (settingsArrow) settingsArrow.classList.remove('fa-chevron-down'), settingsArrow.classList.add('fa-chevron-right');
            return;
        }
        fillDetailPresetOptions();
        fillDetailTogglePresetOptions();
        settingsEditPanel.style.display = 'flex';
        if (settingsArrow) settingsArrow.classList.remove('fa-chevron-right'), settingsArrow.classList.add('fa-chevron-down');
    });

    // 프리셋 변경 → 즉시 저장 + 토글 옵션 재갱신
    detailPresetSelect?.addEventListener('change', () => {
        sim.presetName = detailPresetSelect.value || '';
        // 프리셋이 바뀌면 토글은 default 로 초기화 (선택한 프리셋의 옵션이 달라지므로)
        sim.togglePresetName = 'default';
        fillDetailTogglePresetOptions();
        saveSimIfNotTemp();
        refreshSummary();
    });
    detailTogglePresetSelect?.addEventListener('change', () => {
        sim.togglePresetName = detailTogglePresetSelect.value || 'default';
        saveSimIfNotTemp();
        refreshSummary();
    });
    detailPositionSelect?.addEventListener('change', () => {
        sim.injectPosition = normalizeSimPosition(detailPositionSelect.value);
        saveSimIfNotTemp();
        refreshSummary();
    });
    detailSwapCharUser?.addEventListener('change', () => {
        sim.swapCharUser = !!detailSwapCharUser.checked;
        saveSimIfNotTemp();
        refreshSummary();
    });
    detailSwapPronouns?.addEventListener('change', () => {
        sim.swapPronouns = !!detailSwapPronouns.checked;
        saveSimIfNotTemp();
        refreshSummary();
    });

    // 새 챗으로 시작
    document.getElementById('sim-new-chat-btn')?.addEventListener('click', async () => {
        const responseText = getFullResponseText(sim, sim.currentIndex || 0);
        if (!responseText) return;
        showNewChatDialog(sim.promptText, responseText);
    });

    // 파트별 이벤트 위임 (수정/번역/삭제)
    const responseDisplay = document.getElementById('sim-response-display');
    if (responseDisplay) {
        responseDisplay.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const partIdx = parseInt(btn.dataset.part, 10);
            const key = String(currentIdx);

            switch (action) {
                case 'part-edit':
                    editingPartIdx = partIdx;
                    renderDetailView();
                    break;
                case 'part-edit-cancel':
                    editingPartIdx = null;
                    renderDetailView();
                    break;
                case 'part-edit-save': {
                    const textarea = document.getElementById(`sim-part-${partIdx}-edit-input`);
                    if (!textarea) return;
                    const newText = textarea.value.trim();
                    if (!newText) { alert('내용을 입력해주세요.'); return; }
                    if (partIdx === 0) {
                        sim.responses[currentIdx] = newText;
                    } else {
                        if (sim.continuations?.[key]) sim.continuations[key][partIdx - 1] = newText;
                    }
                    // 해당 파트 번역 캐시 무효화
                    if (sim.partTranslations?.[key]) delete sim.partTranslations[key][String(partIdx)];
                    editingPartIdx = null;
                    saveSimulations();
                    renderDetailView();
                    toastr.success('파트가 수정되었습니다.', '시뮬 매니저');
                    break;
                }
                case 'part-revision':
                    showPartRevisionDialog(sim, currentIdx, partIdx, false);
                    break;
                case 'part-translate':
                    translatePart(sim, currentIdx, partIdx, renderDetailView);
                    break;
                case 'part-retranslate':
                    if (sim.partTranslations?.[key]) delete sim.partTranslations[key][String(partIdx)];
                    showTranslated = false;
                    translatePart(sim, currentIdx, partIdx, renderDetailView);
                    break;
                case 'part-delete': {
                    if (partIdx === 0) return; // base는 삭제 불가
                    if (!confirm('이 이어쓰기 파트를 삭제하시겠습니까?')) return;
                    const contIdx = partIdx - 1;
                    if (sim.continuations?.[key]) sim.continuations[key].splice(contIdx, 1);
                    if (sim.partTranslations?.[key]) delete sim.partTranslations[key][String(partIdx)];
                    saveSimulations();
                    renderDetailView();
                    toastr.success('파트가 삭제되었습니다.', '시뮬 매니저');
                    break;
                }
            }
        });
    }

    // 응답 네비게이션
    document.getElementById('sim-prev-response')?.addEventListener('click', () => {
        if (sim.currentIndex > 0) {
            sim.currentIndex--;
            editingPartIdx = null;
            showTranslated = false;
            saveSimulations();
            renderDetailView();
        }
    });

    document.getElementById('sim-next-response')?.addEventListener('click', () => {
        if (sim.currentIndex < sim.responses.length - 1) {
            sim.currentIndex++;
            editingPartIdx = null;
            showTranslated = false;
            saveSimulations();
            renderDetailView();
        }
    });

    document.getElementById('sim-continue')?.addEventListener('click', () => {
        handleContinueSimulation(sim, sim.currentIndex || 0, false);
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
            const delKey = String(sim.currentIndex);
            sim.responses.splice(sim.currentIndex, 1);
            if (sim.translations) delete sim.translations[delKey];
            if (sim.continuations) delete sim.continuations[delKey];
            if (sim.partTranslations) delete sim.partTranslations[delKey];
            if (sim.currentIndex >= sim.responses.length) {
                sim.currentIndex = Math.max(0, sim.responses.length - 1);
            }
            saveSimulations();
            renderDetailView();
        }
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
            ${responseCount > 1 ? `
            <div class="sim-response-actions-row">
                <button class="sim-btn-icon sim-btn-icon-danger" id="sim-gv-delete-response" title="이 답변 삭제"><i class="fa-solid fa-xmark"></i> 삭제</button>
            </div>
            ` : ''}
            <div class="sim-response-text mes_text ${responseCount === 0 ? 'loading' : ''}" id="sim-gv-response-display">
                ${responseCount === 0 ? '응답 없음' : renderResponseParts(sim, currentIdx, editingGlobalPartIdx, true)}
            </div>
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
        editingGlobalPartIdx = null;
        renderGlobalSimListView();
    });

    document.getElementById('sim-gv-prev')?.addEventListener('click', () => {
        if (globalViewSimIndex > 0) {
            globalViewSimIndex--;
            editingGlobalPartIdx = null;
            showTranslated = false;
            renderGlobalDetailView();
        }
    });

    document.getElementById('sim-gv-next')?.addEventListener('click', () => {
        if (globalViewSimIndex < responseCount - 1) {
            globalViewSimIndex++;
            editingGlobalPartIdx = null;
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

    // 파트별 이벤트 위임 (글로벌)
    const gvResponseDisplay = document.getElementById('sim-gv-response-display');
    if (gvResponseDisplay) {
        gvResponseDisplay.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const partIdx = parseInt(btn.dataset.part, 10);
            const key = String(currentIdx);

            switch (action) {
                case 'part-edit':
                    editingGlobalPartIdx = partIdx;
                    renderGlobalDetailView();
                    break;
                case 'part-edit-cancel':
                    editingGlobalPartIdx = null;
                    renderGlobalDetailView();
                    break;
                case 'part-edit-save': {
                    const textarea = document.getElementById(`sim-gv-part-${partIdx}-edit-input`);
                    if (!textarea) return;
                    const newText = textarea.value.trim();
                    if (!newText) { alert('내용을 입력해주세요.'); return; }
                    if (partIdx === 0) {
                        sim.responses[currentIdx] = newText;
                    } else {
                        if (sim.continuations?.[key]) sim.continuations[key][partIdx - 1] = newText;
                    }
                    if (sim.partTranslations?.[key]) delete sim.partTranslations[key][String(partIdx)];
                    editingGlobalPartIdx = null;
                    saveSettingsDebounced();
                    renderGlobalDetailView();
                    toastr.success('파트가 수정되었습니다.', '시뮬 매니저');
                    break;
                }
                case 'part-revision':
                    showPartRevisionDialog(sim, currentIdx, partIdx, true);
                    break;
                case 'part-translate':
                    translatePart(sim, currentIdx, partIdx, renderGlobalDetailView);
                    break;
                case 'part-retranslate':
                    if (sim.partTranslations?.[key]) delete sim.partTranslations[key][String(partIdx)];
                    showTranslated = false;
                    translatePart(sim, currentIdx, partIdx, renderGlobalDetailView);
                    break;
                case 'part-delete': {
                    if (partIdx === 0) return;
                    if (!confirm('이 이어쓰기 파트를 삭제하시겠습니까?')) return;
                    const contIdx = partIdx - 1;
                    if (sim.continuations?.[key]) sim.continuations[key].splice(contIdx, 1);
                    if (sim.partTranslations?.[key]) delete sim.partTranslations[key][String(partIdx)];
                    saveSettingsDebounced();
                    renderGlobalDetailView();
                    toastr.success('파트가 삭제되었습니다.', '시뮬 매니저');
                    break;
                }
            }
        });
    }

    // 답변 삭제
    document.getElementById('sim-gv-delete-response')?.addEventListener('click', () => {
        if (confirm('현재 보고 있는 답변을 삭제하시겠습니까?')) {
            sim.responses.splice(currentIdx, 1);
            if (sim.translations) delete sim.translations[String(currentIdx)];
            if (sim.continuations) delete sim.continuations[String(currentIdx)];
            if (sim.partTranslations) delete sim.partTranslations[String(currentIdx)];
            if (globalViewSimIndex >= sim.responses.length) {
                globalViewSimIndex = Math.max(0, sim.responses.length - 1);
            }
            saveSettingsDebounced();
            renderGlobalDetailView();
        }
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

/**
 * 파트별 번역. sim.partTranslations[responseIdx][partIdx]에 저장.
 */
async function translatePart(sim, responseIdx, partIdx, renderFn) {
    if (isTranslating) return;

    if (!sim.partTranslations) sim.partTranslations = {};
    const rKey = String(responseIdx);
    if (!sim.partTranslations[rKey]) sim.partTranslations[rKey] = {};
    const pKey = String(partIdx);

    // 이미 번역 있으면 토글
    if (sim.partTranslations[rKey][pKey]) {
        showTranslated = !showTranslated;
        renderFn();
        return;
    }

    // 파트 텍스트 가져오기
    const conts = sim.continuations?.[rKey] || [];
    const partText = partIdx === 0 ? sim.responses[responseIdx] : conts[partIdx - 1];
    if (!partText) return;

    ensureSettings();
    const s = extension_settings[EXTENSION_NAME];
    const profileId = s.translationProfileId;

    if (!profileId) {
        toastr.warning('번역 프로필을 설정해주세요.', '시뮬 매니저');
        return;
    }

    const context = getContext();
    if (!context.ConnectionManagerRequestService) {
        toastr.error('Connection Manager가 필요합니다.', '시뮬 매니저');
        return;
    }

    isTranslating = true;
    translatingPartIdx = partIdx;
    renderFn();

    try {
        const prompt = buildTranslationPrompt(partText);
        const messages = [
            { role: 'system', content: 'You are a professional translator. Output ONLY the translated text without any commentary.' },
            { role: 'user', content: prompt },
        ];

        const savedAuthMode = s.translationVertexAuthMode;
        const vertexAuthMode = savedAuthMode || 'express';
        const response = await context.ConnectionManagerRequestService.sendRequest(
            profileId,
            messages,
            32000,
            { stream: false, extractData: true, includePreset: false, includeInstruct: false },
            { vertexai_auth_mode: vertexAuthMode },
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

        sim.partTranslations[rKey][pKey] = translated;
        showTranslated = true;

        if (currentView === 'detail') {
            saveSimulations();
        } else {
            saveSettingsDebounced();
        }

        toastr.success('파트 번역 완료!', '시뮬 매니저');
    } catch (err) {
        console.error(DEBUG_PREFIX, 'Part translation failed:', err);
        toastr.error(`번역 실패: ${err.message}`, '시뮬 매니저');
    } finally {
        isTranslating = false;
        translatingPartIdx = null;
        renderFn();
    }
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

    const titleInput = document.getElementById('sim-title-input');
    const customTitle = titleInput ? titleInput.value.trim() : '';
    const noSave = document.getElementById('sim-no-save')?.checked || false;
    const loadedPromptId = document.getElementById('sim-load-prompt')?.value || '';
    const chosenPosition = normalizeSimPosition(document.getElementById('sim-position-select')?.value);
    const chosenSwapCharUser = !!document.getElementById('sim-swap-charuser')?.checked;
    const chosenSwapPronouns = !!document.getElementById('sim-swap-pronouns')?.checked;

    // 프리셋 선택값 캡처
    const chosenPresetName = document.getElementById('sim-preset-select')?.value || '';
    const chosenTogglePresetName = document.getElementById('sim-toggle-preset-select')?.value || '';

    // 스왑 먼저 적용한 뒤 substituteParams
    const resolvedPrompt = substituteParams(applySwap(rawPrompt, chosenSwapCharUser, chosenSwapPronouns));

    // 프롬프트 이름 결정
    ensureSettings();
    const savedPrompts = extension_settings[EXTENSION_NAME].savedPrompts;
    const matchedPrompt = savedPrompts.find(p => p.content === rawPrompt);
    const promptName = customTitle || (matchedPrompt ? matchedPrompt.name : '');


    const sims = getSimulations();
    let sim = null;

    if (!noSave) {
        sim = {
            id: `sim_${uuidv4()}`,
            promptText: rawPrompt,
            promptName: promptName,
            responses: [],
            currentIndex: 0,
            createdAt: Date.now(),
            presetName: chosenPresetName,
            togglePresetName: chosenTogglePresetName,
            injectPosition: chosenPosition,
            swapCharUser: chosenSwapCharUser,
            swapPronouns: chosenSwapPronouns,
        };

        sims.push(sim);
        saveSimulations();

        // 보낸 프롬프트 자동 저장
        {
            const loadedPrompt = loadedPromptId ? savedPrompts.find(p => p.id === loadedPromptId) : null;
            const titleChanged = customTitle && loadedPrompt && customTitle !== loadedPrompt.name;
            const contentChanged = !savedPrompts.some(p => p.content === rawPrompt);

            if (titleChanged || contentChanged) {
                savedPrompts.push({
                    id: `prompt_${uuidv4()}`,
                    name: customTitle || (rawPrompt.length > 20 ? rawPrompt.substring(0, 20) + '...' : rawPrompt),
                    content: rawPrompt,
                });
                saveSettingsDebounced();
                renderSettingsSavedPrompts();
            }
        }

        currentSimId = sim.id;
        currentView = 'detail';
        isEditingPrompt = false;
        renderDetailView();
    } else {
        // 저장 안 하기 모드: 임시 sim 객체 (메모리에만)
        currentSimId = `temp_${uuidv4()}`;
        tempSim = {
            id: currentSimId,
            promptText: rawPrompt,
            promptName: promptName,
            responses: [],
            currentIndex: 0,
            createdAt: Date.now(),
            presetName: chosenPresetName,
            togglePresetName: chosenTogglePresetName,
            injectPosition: chosenPosition,
            swapCharUser: chosenSwapCharUser,
            swapPronouns: chosenSwapPronouns,
        };
        currentView = 'detail';
        isEditingPrompt = false;
        renderDetailView();
    }

    try {
        console.log(DEBUG_PREFIX, 'Generating simulation response...');
        const sendBtn = document.getElementById('sim-regenerate');
        if (sendBtn) sendBtn.disabled = true;

        // 현재 처리 중인 sim 의 injectPosition 사용 + 프리셋/토글 프리셋 임시 적용
        const activeSim = (tempSim && tempSim.id === currentSimId) ? tempSim : sims.find(s => s.id === currentSimId) || sim;
        const rawResponse = await withSimulationPreset(chosenPresetName, chosenTogglePresetName, () =>
            runSimGeneration(SIM_SYSTEM_INSTRUCTION, resolvedPrompt, activeSim?.injectPosition)
        );
        console.log(DEBUG_PREFIX, 'Raw response length:', rawResponse?.length);

        // noSave 모드에서는 tempSim 사용
        const targetSim = (tempSim && tempSim.id === currentSimId) ? tempSim : sims.find(s => s.id === currentSimId) || sim;
        targetSim.responses.push(rawResponse);
        targetSim.currentIndex = 0;
        if (!tempSim || tempSim.id !== currentSimId) {
            saveSimulations();
        }

        if (currentView === 'detail' && currentSimId === targetSim.id) {
            renderDetailView();
        }

        showSimNotification(targetSim);
        console.log(DEBUG_PREFIX, 'Simulation response received.');
    } catch (err) {
        console.error(DEBUG_PREFIX, 'Generation failed:', err);
        toastr.error('시뮬레이션 생성에 실패했습니다.', '시뮬 매니저');
    }
}

async function handleRegenerateSimulation(sim) {
    const resolvedPrompt = substituteParams(getEffectivePromptText(sim));

    const btn = document.getElementById('sim-regenerate');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 생성 중...';
    }

    const simId = sim.id;
    try {
        const rawResponse = await withSimulationPreset(sim.presetName, sim.togglePresetName, () =>
            runSimGeneration(SIM_SYSTEM_INSTRUCTION, resolvedPrompt, sim.injectPosition)
        );
        // 생성 후에 live sim 을 다시 찾아서 push (preset 전환 중 chat_metadata 가 바뀌었을 수 있음)
        const liveSims = getSimulations();
        const targetSim = (tempSim && tempSim.id === simId) ? tempSim : liveSims.find(s => s.id === simId) || sim;
        if (!Array.isArray(targetSim.responses)) targetSim.responses = [];
        targetSim.responses.push(rawResponse);
        targetSim.currentIndex = targetSim.responses.length - 1;
        if (!tempSim || tempSim.id !== simId) saveSimulations();

        if (currentView === 'detail' && currentSimId === simId) {
            renderDetailView();
        }

        showSimNotification(targetSim);
    } catch (err) {
        console.error(DEBUG_PREFIX, 'Regeneration failed:', err);
        toastr.error('답변 재생성에 실패했습니다.', '시뮬 매니저');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> 답변 재생성';
        }
    }
}

async function handleContinueSimulation(sim, responseIdx, isGlobal = false) {
    const currentResponse = sim.responses[responseIdx];
    if (!currentResponse) {
        toastr.warning('이어쓸 응답이 없습니다.', '시뮬 매니저');
        return;
    }

    const continuePrompt = substituteParams(getEffectivePromptText(sim));

    const btn = document.getElementById(isGlobal ? 'sim-gv-continue' : 'sim-continue');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 이어쓰기 중...';
    }

    try {
        const fullResponse = getFullResponseText(sim, responseIdx);
        // 이어쓰기: 지시문은 system, ghost/inject 본문은 "원래 요청 + 지금까지의 응답"
        const continueDirective = SIM_CONTINUE_INSTRUCTION;
        const continueBody = `<original_request>\n${continuePrompt}\n</original_request>\n\n<response_so_far>\n${fullResponse}\n</response_so_far>`;
        const rawResponse = await withSimulationPreset(sim.presetName, sim.togglePresetName, () =>
            runSimGeneration(continueDirective, continueBody, sim.injectPosition)
        );
        // preset 전환 중 chat_metadata 가 바뀌었을 수 있으므로 live sim 재조회 (비글로벌만)
        let target = sim;
        if (!isGlobal) {
            const liveSims = getSimulations();
            target = (tempSim && tempSim.id === sim.id) ? tempSim : liveSims.find(s => s.id === sim.id) || sim;
        }
        // continuations 배열에 파트 분리 저장
        if (!target.continuations) target.continuations = {};
        const key = String(responseIdx);
        if (!Array.isArray(target.continuations[key])) target.continuations[key] = [];
        target.continuations[key].push(rawResponse);

        // 번역 캐시 무효화
        if (target.translations) delete target.translations[key];

        if (isGlobal) {
            saveSettingsDebounced();
            if (currentView === 'globalDetail') renderGlobalDetailView();
        } else {
            if (!tempSim || tempSim.id !== target.id) saveSimulations();
            if (currentView === 'detail' && currentSimId === target.id) renderDetailView();
        }

        toastr.success('응답이 이어쓰기되었습니다.', '시뮬 매니저');
    } catch (err) {
        console.error(DEBUG_PREFIX, 'Continue failed:', err);
        toastr.error('이어쓰기에 실패했습니다.', '시뮬 매니저');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-forward"></i> 이어쓰기';
        }
    }
}

const SIM_CONTINUE_INSTRUCTION = `<simulation_continue_directive priority="critical">
<rule>This is a CONTINUATION of a previous simulation response — NOT a regular roleplay turn.</rule>
<rule>Write the NEXT content that comes AFTER the existing response. The user wants to see WHAT HAPPENS NEXT.</rule>
<rule>Do NOT refine, rewrite, polish, or expand the existing response. The existing response is already finalized — move FORWARD from it.</rule>
<rule>Continue from EXACTLY where the previous response ended. Do NOT repeat any part of the existing response.</rule>
<rule>Stay focused on the ORIGINAL simulation request. Do NOT drift into generic roleplay narration or wrap-up prose.</rule>
<rule>Maintain the same tone, style, and context as the existing response.</rule>
<rule>Output ONLY the continuation text. Do NOT include any meta-commentary or acknowledgment.</rule>
</simulation_continue_directive>`;

const SIM_SYSTEM_INSTRUCTION = `<simulation_directive priority="critical">
<rule>This is a STANDALONE SIMULATION requested by the user.</rule>
<rule>FOLLOW OOC REQUEST ONLY. Generate a response based ONLY on the user's simulation request below.</rule>
<rule>Stay in character and maintain the established setting, personality, and tone.</rule>
</simulation_directive>`;
// ============================================
// Sim Inject Position
// ============================================
const SIM_POSITIONS = {
    LAST_MESSAGE: 'last_message', // chat 의 마지막 user 메시지 자리 (ghost push) — 기본
    DEPTH_1: 'depth_1',           // IN_CHAT depth 1 USER — 진짜 마지막 메시지 앞
    DEPTH_0: 'depth_0',           // IN_CHAT depth 0 USER — 진짜 마지막 메시지 뒤 (history 안)
    BOTTOM: 'bottom',             // quietPrompt — </history> 밖, 프롬프트 맨 끝
};
const SIM_POSITION_LABELS = {
    [SIM_POSITIONS.LAST_MESSAGE]: '마지막 메시지 (기본)',
    [SIM_POSITIONS.DEPTH_1]: '깊이 1',
    [SIM_POSITIONS.DEPTH_0]: '깊이 0',
    [SIM_POSITIONS.BOTTOM]: '맨 밑',
};
const SIM_DIRECTIVE_KEY = 'sim_manager_directive';
const SIM_OOC_KEY = 'sim_manager_ooc';

function normalizeSimPosition(v) {
    return Object.values(SIM_POSITIONS).includes(v) ? v : SIM_POSITIONS.LAST_MESSAGE;
}

function setSimDirectiveSystem(directive) {
    setExtensionPrompt(SIM_DIRECTIVE_KEY, directive, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
}
function clearSimDirectiveSystem() {
    setExtensionPrompt(SIM_DIRECTIVE_KEY, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
}

function setSimOocInChat(oocContent, depth) {
    setExtensionPrompt(SIM_OOC_KEY, oocContent, extension_prompt_types.IN_CHAT, depth, false, extension_prompt_roles.USER);
}
function clearSimOocInChat() {
    setExtensionPrompt(SIM_OOC_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.USER);
}

function pushSimGhostMessage(content) {
    const ctx = getContext();
    const ghost = {
        name: ctx?.name1 || 'User',
        is_user: true,
        is_system: false,
        send_date: Date.now(),
        mes: content,
        extra: { sim_manager_ghost: true },
    };
    chat.push(ghost);
    return ghost;
}
function popSimGhostMessage(ghost) {
    if (!ghost) return;
    const idx = chat.lastIndexOf(ghost);
    if (idx !== -1) chat.splice(idx, 1);
}

/**
 * 시뮬 생성 공통 래퍼.
 *  - directive: 시스템 지시문 (SIM_SYSTEM_INSTRUCTION / SIM_CONTINUE_INSTRUCTION)
 *  - ooc:       OOC 본문 (유저가 입력한 시뮬 프롬프트 등)
 *  - position:  SIM_POSITIONS.* 중 하나 (sim 별 저장값)
 */
async function runSimGeneration(directive, ooc, position = SIM_POSITIONS.LAST_MESSAGE) {
    position = normalizeSimPosition(position);
    let ghost = null;
    let quietPromptArg = '';

    try {
        switch (position) {
            case SIM_POSITIONS.LAST_MESSAGE:
                setSimDirectiveSystem(directive);
                ghost = pushSimGhostMessage(ooc);
                break;
            case SIM_POSITIONS.DEPTH_1:
                setSimDirectiveSystem(directive);
                setSimOocInChat(ooc, 1);
                break;
            case SIM_POSITIONS.DEPTH_0:
                setSimDirectiveSystem(directive);
                setSimOocInChat(ooc, 0);
                break;
            case SIM_POSITIONS.BOTTOM:
                // 맨 밑: 지시문 + OOC 를 quietPrompt 로 함께 (controlPrompts, </history> 밖)
                quietPromptArg = `${directive}\n\n${ooc}`;
                break;
        }
        return await generateQuietPrompt({ quietPrompt: quietPromptArg, quietToLoud: true });
    } finally {
        popSimGhostMessage(ghost);
        clearSimDirectiveSystem();
        clearSimOocInChat();
    }
}



function showPartRevisionDialog(sim, responseIdx, partIdx, isGlobal = false) {
    const key = String(responseIdx);
    const conts = sim.continuations?.[key] || [];
    const partText = partIdx === 0 ? sim.responses[responseIdx] : conts[partIdx - 1];
    if (!partText) return;

    const overlay = document.createElement('div');
    overlay.className = 'sim-dialog-overlay';
    overlay.innerHTML = `
        <div class="sim-dialog-box">
            <div class="sim-dialog-title"><i class="fa-solid fa-wand-magic-sparkles"></i> 통제광 (파트 ${partIdx + 1})</div>
            <p style="font-size:12px; color:var(--SmartThemeBodyColor, #aaa); margin:0 0 10px;">이 파트를 어떻게 수정할지 피드백을 입력하세요.</p>
            <textarea id="sim-part-revision-feedback" class="sim-revision-textarea" placeholder="어떻게 수정할까요?"></textarea>
            <div class="sim-dialog-buttons">
                <button class="sim-btn" id="sim-part-revision-cancel">취소</button>
                <button class="sim-btn sim-btn-primary" id="sim-part-revision-send"><i class="fa-solid fa-paper-plane"></i> 요청</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#sim-part-revision-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#sim-part-revision-send').addEventListener('click', async () => {
        const feedback = document.getElementById('sim-part-revision-feedback')?.value?.trim();
        if (!feedback) { toastr.warning('피드백을 입력해주세요.'); return; }
        overlay.remove();

        // 이전 파트들을 컨텍스트로 구성
        const allParts = [sim.responses[responseIdx], ...conts];
        const precedingParts = allParts.slice(0, partIdx);
        const precedingContext = precedingParts.length > 0
            ? `\n<preceding_parts context_only="true">\n${precedingParts.join('\n---\n')}\n</preceding_parts>\n`
            : '';

        const revisionPrompt = `<revision_task priority="critical" mode="EDIT_ONLY">
<rule>You are performing an editorial revision. Your ONLY task is to rewrite the original_message below according to the feedback provided.</rule>
<rule>Output ONLY the revised message text. Nothing else.</rule>
<rule>Do NOT continue the story or add new events beyond the original ending point.</rule>
<rule>Do NOT add meta-commentary, explanations, or notes.</rule>
<rule>Do NOT generate a new roleplay response. This is NOT a continuation of the conversation.</rule>
<rule>Do NOT respond as if you are roleplaying. You are an EDITOR, not a character.</rule>
<rule>Maintain the same general length unless the feedback specifically requests otherwise.</rule>
<rule>Preserve the original message's structure, formatting, and style — only change what the feedback asks for.</rule>
<rule>The preceding_parts are provided for context ONLY. Do NOT include or modify them in your output.</rule>
</revision_task>

<original_request context_only="true">
${getEffectivePromptText(sim)}
</original_request>
${precedingContext}
<original_message target="revision">
${partText}
</original_message>

<feedback>
${feedback}
</feedback>

You are an editor. Rewrite ONLY the original_message above based on the feedback. Do NOT roleplay. Do NOT continue the story. Begin the revised text now:`;

        try {
            const rawResponse = await withSimulationPreset(sim.presetName, sim.togglePresetName, () =>
                generateQuietPrompt({ quietPrompt: revisionPrompt, quietToLoud: true })
            );
            // preset 전환 중 chat_metadata 가 바뀌었을 수 있어 live sim 재조회 (비글로벌)
            let target = sim;
            if (!isGlobal) {
                const liveSims = getSimulations();
                target = (tempSim && tempSim.id === sim.id) ? tempSim : liveSims.find(s => s.id === sim.id) || sim;
            }
            // 해당 파트를 교체
            if (partIdx === 0) {
                target.responses[responseIdx] = rawResponse;
            } else {
                if (target.continuations?.[key]) target.continuations[key][partIdx - 1] = rawResponse;
            }
            // 번역 캐시 무효화
            if (target.partTranslations?.[key]) delete target.partTranslations[key][String(partIdx)];

            if (isGlobal) {
                saveSettingsDebounced();
                renderGlobalDetailView();
            } else {
                if (!tempSim || tempSim.id !== target.id) saveSimulations();
                renderDetailView();
            }
            toastr.success('파트가 수정되었습니다.', '통제광');
        } catch (err) {
            console.error(DEBUG_PREFIX, 'Part revision failed:', err);
            toastr.error('수정 요청에 실패했습니다.', '통제광');
        }
    });
}

function showNewChatDialog(promptText, responseText) {
    const overlay = document.createElement('div');
    overlay.className = 'sim-dialog-overlay';
    overlay.innerHTML = `
        <div class="sim-dialog-box">
            <div class="sim-dialog-title">새 챗 시작</div>
            <div class="sim-dialog-desc">이 시뮬 응답을 그리팅으로 새 챗을 시작합니다.</div>
            <div class="sim-dialog-buttons">
                <button class="sim-btn" id="sim-newchat-response-only">응답만</button>
                <button class="sim-btn" id="sim-newchat-with-request">요청 포함</button>
                <button class="sim-btn sim-btn-muted" id="sim-newchat-cancel">취소</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#sim-newchat-response-only').addEventListener('click', async () => {
        overlay.remove();
        await startNewChatWithGreeting(null, responseText);
    });
    overlay.querySelector('#sim-newchat-with-request').addEventListener('click', async () => {
        overlay.remove();
        await startNewChatWithGreeting(promptText, responseText);
    });
    overlay.querySelector('#sim-newchat-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

async function startNewChatWithGreeting(promptText, responseText) {
    try {
        await doNewChat();
        const context = getContext();

        // 요청 포함 시: 유저 메시지 먼저 추가
        if (promptText) {
            // 기존 그리팅(chat[0]) 제거
            if (chat.length > 0) chat.splice(0, chat.length);
            chat.push({
                name: context.name1,
                is_user: true,
                is_system: false,
                send_date: new Date().toISOString(),
                mes: promptText,
                extra: {},
            });
            chat.push({
                name: context.name2,
                is_user: false,
                is_system: false,
                send_date: new Date().toISOString(),
                mes: responseText,
                extra: {},
            });
        } else {
            // 응답만: 그리팅을 시뮬 응답으로 교체
            if (chat.length > 0) {
                chat[0].mes = responseText;
                chat[0].swipes = [responseText];
                chat[0].swipe_id = 0;
            } else {
                chat.push({
                    name: context.name2,
                    is_user: false,
                    is_system: false,
                    send_date: new Date().toISOString(),
                    mes: responseText,
                    extra: {},
                });
            }
        }
        await saveChatConditional();
        await printMessages();
        toastr.success('시뮬 응답으로 새 챗이 생성되었습니다.', '시뮬 매니저');
    } catch (err) {
        console.error(DEBUG_PREFIX, 'Failed to create new chat:', err);
        toastr.error('새 챗 생성에 실패했습니다.', '시뮬 매니저');
    }
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

    document.getElementById('sim-settings-prompt-search')?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        if (!select) return;
        ensureSettings();
        const prompts = extension_settings[EXTENSION_NAME].savedPrompts;
        let options = `<option value="">-- 새 프롬프트 --</option>`;
        for (const p of prompts) {
            if (!query || p.name.toLowerCase().includes(query) || p.content.toLowerCase().includes(query)) {
                options += `<option value="${p.id}">${escapeHtml(p.name)}</option>`;
            }
        }
        select.innerHTML = options;
        selectedPromptId = null;
        renderSettingsSavedPrompts();
    });

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
    tempSim = null;
    isEditingPrompt = false;
    editingPartIdx = null;
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
 * 원본 응답 + continuation 파트들을 각각 별도 div로 렌더링.
 * 각 파트마다 수정/번역/삭제 액션을 독립 제공.
 * @param {object} sim
 * @param {number} responseIdx
 * @param {number|null} currentEditPart - 현재 수정 중인 파트 인덱스
 * @param {boolean} isGlobal
 */
function renderResponseParts(sim, responseIdx, currentEditPart = null, isGlobal = false) {
    const base = sim.responses[responseIdx] || '';
    const conts = sim.continuations?.[String(responseIdx)] || [];
    const parts = [base, ...conts];
    const prefix = isGlobal ? 'sim-gv' : 'sim';

    return parts.map((part, partIdx) => {
        const isCont = partIdx > 0;
        const partKey = `${prefix}-part-${partIdx}`;

        if (currentEditPart === partIdx) {
            // 수정 모드
            return `<div class="sim-response-part" data-part-idx="${partIdx}">
                <textarea class="sim-edit-response-textarea" id="${partKey}-edit-input">${escapeHtml(part)}</textarea>
                <div class="sim-edit-prompt-actions">
                    <button class="sim-btn" data-action="part-edit-cancel" data-part="${partIdx}">취소</button>
                    <button class="sim-btn sim-btn-primary" data-action="part-edit-save" data-part="${partIdx}">저장</button>
                </div>
            </div>`;
        }

        // 파트별 번역 텍스트 확인
        const partTranslations = sim.partTranslations?.[String(responseIdx)];
        const hasTranslation = partTranslations?.[String(partIdx)];
        const displayText = (showTranslated && hasTranslation) ? hasTranslation : part;

        // 액션 버튼
        ensureSettings();
        const translationOn = extension_settings[EXTENSION_NAME].translationEnabled;
        const isThisPartTranslating = isTranslating && translatingPartIdx === partIdx;
        let translateBtn = '';
        if (translationOn) {
            if (isThisPartTranslating) {
                translateBtn = `<button class="sim-btn-icon sim-btn-icon-sm" disabled><i class="fa-solid fa-spinner fa-spin"></i> 번역 중</button>`;
            } else if (hasTranslation) {
                translateBtn = `
                    <button class="sim-btn-icon sim-btn-icon-sm" data-action="part-translate" data-part="${partIdx}" title="${showTranslated ? '원문 보기' : '번역 보기'}"><i class="fa-solid fa-language"></i> ${showTranslated ? '원문' : '번역'}</button>
                    <button class="sim-btn-icon sim-btn-icon-sm" data-action="part-retranslate" data-part="${partIdx}" title="재번역"><i class="fa-solid fa-rotate-right"></i> 재번역</button>`;
            } else {
                translateBtn = `<button class="sim-btn-icon sim-btn-icon-sm" data-action="part-translate" data-part="${partIdx}" title="번역"><i class="fa-solid fa-language"></i></button>`;
            }
        }
        const actions = `<div class="sim-part-actions">
            <button class="sim-btn-icon sim-btn-icon-sm" data-action="part-edit" data-part="${partIdx}" title="수정"><i class="fa-solid fa-pen"></i></button>
            <button class="sim-btn-icon sim-btn-icon-sm" data-action="part-revision" data-part="${partIdx}" title="통제광"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
            ${translateBtn}
            ${isCont ? `<button class="sim-btn-icon sim-btn-icon-sm sim-btn-icon-danger" data-action="part-delete" data-part="${partIdx}" title="삭제"><i class="fa-solid fa-xmark"></i></button>` : ''}
        </div>`;

        return `<div class="sim-response-part" data-part-idx="${partIdx}">
            ${actions}
            <div class="sim-response-part-text">${renderResponseText(displayText)}</div>
        </div>`;
    }).join('');
}

/**
 * 원본 + continuation을 합친 전체 텍스트 반환.
 */
function getFullResponseText(sim, responseIdx) {
    const base = sim.responses[responseIdx] || '';
    const conts = sim.continuations?.[String(responseIdx)] || [];
    return base + conts.join('');
}

function renderResponseText(text) {
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
                if (!transToggle.checked) showTranslated = false;
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
