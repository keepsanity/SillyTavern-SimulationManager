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
import { eventSource, event_types, generateQuietPrompt, substituteParams, chat_metadata, saveChatDebounced, saveSettingsDebounced, getRequestHeaders, setExtensionPrompt, extension_prompt_types, extension_prompt_roles, doNewChat, chat, saveChatConditional, printMessages, addOneMessage, stopGeneration } from '../../../../script.js';
import { uuidv4 } from '../../../utils.js';
import { getPresetManager } from '../../../preset-manager.js';
import { oai_settings, promptManager } from '../../../openai.js';
import { playMessageSound } from '../../../power-user.js';
import {
    EXTENSION_NAME,
    CUSTOM_PRESET_EXT,
    DEBUG_PREFIX,
    SIM_ICON_PRESETS,
    PRONOUN_MAP,
    PRONOUN_REGEX,
    SIM_CONTINUE_INSTRUCTION,
    SIM_SYSTEM_INSTRUCTION,
    SIM_POSITIONS,
    SIM_POSITION_LABELS,
    SIM_DIRECTIVE_KEY,
    SIM_OOC_KEY,
    SIM_SAVE_BTN_CLASS,
} from './constants.js';

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
    // 표시(브랜딩) 설정: 지팡이 버튼 + 헤더에 공통 적용
    displayName: '시뮬레이션',
    displayIcon: 'fa-flask',
    // 저장된 프롬프트 불러오기 정렬 ('newest' | 'oldest' | 'name')
    promptSortOrder: 'newest',
};

const PROMPT_SORT_ORDERS = ['newest', 'oldest', 'name'];

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
    if (typeof s.displayName !== 'string' || s.displayName.trim() === '') s.displayName = '시뮬레이션';
    if (typeof s.displayIcon !== 'string' || s.displayIcon.trim() === '') s.displayIcon = 'fa-flask';
    if (!PROMPT_SORT_ORDERS.includes(s.promptSortOrder)) s.promptSortOrder = 'newest';
}

function getDisplayName() {
    ensureSettings();
    return extension_settings[EXTENSION_NAME].displayName;
}

function getDisplayIcon() {
    ensureSettings();
    const icon = extension_settings[EXTENSION_NAME].displayIcon;
    // 프리셋에 없는 값이면 기본값으로 폴백 (잘못된 클래스 주입 방지)
    return SIM_ICON_PRESETS.includes(icon) ? icon : 'fa-flask';
}

function getDefaultInjectPosition() {
    ensureSettings();
    return normalizeSimPosition(extension_settings[EXTENSION_NAME].defaultInjectPosition);
}

// ============================================
// Char/User Swap & Pronoun Swap
// ============================================
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

/**
 * 시뮬 목록/상세에 표시할 제목.
 * 사용자가 직접 지정한 customTitle 이 최우선 (프롬프트 자동 동기화로 덮이지 않음).
 */
function getSimDisplayTitle(sim) {
    if (sim?.customTitle && sim.customTitle.trim()) return sim.customTitle.trim();
    if (sim?.promptName) return sim.promptName;
    const pt = sim?.promptText || '';
    if (!pt) return '(제목 없음)';
    return pt.length > 80 ? pt.slice(0, 80) + '...' : pt;
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
// Backup (내보내기) & Cleanup (캐시 정리)
// ============================================

/**
 * 전체 시뮬을 JSON 파일로 내보내기 (다운로드).
 * 채팅 파일은 건드리지 않음 — 스캔(읽기) 후 globalSimulations 캐시를 직렬화.
 * @returns {Promise<number>} 내보낸 시뮬 개수 (실패 시 -1)
 */
async function exportSimBackup() {
    try {
        await scanAllChatsForSimulations(); // 최신 데이터 보장
        ensureSettings();
        const data = extension_settings[EXTENSION_NAME].globalSimulations || {};
        const simCount = Object.values(data).reduce((n, d) => n + (d?.simulations?.length || 0), 0);

        const payload = {
            type: 'sim-manager-backup',
            version: 1,
            exportedAt: new Date().toISOString(),
            chatCount: Object.keys(data).length,
            simCount,
            globalSimulations: structuredClone(data),
        };

        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.href = url;
        a.download = `sim-manager-backup_${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        return simCount;
    } catch (e) {
        console.error(DEBUG_PREFIX, 'Export failed:', e);
        return -1;
    }
}

/**
 * 현재 존재하는 채팅방 키 집합 수집 (채팅 내용은 안 읽고 목록만).
 * @returns {Promise<{keys: Set<string>, complete: boolean}>}
 *   complete=false 면 일부 캐릭터 목록을 못 읽은 것 → '유령 항목' 정리는 보류해야 안전.
 */
async function collectExistingChatKeys() {
    const keys = new Set();
    let complete = true;
    const context = getContext();
    const headers = getRequestHeaders();

    const cur = getCurrentChatKey();
    if (cur) keys.add(cur);

    for (const char of (context.characters || [])) {
        if (!char?.avatar) continue;
        try {
            const res = await fetch('/api/characters/chats', {
                method: 'POST',
                headers,
                body: JSON.stringify({ avatar_url: char.avatar }),
            });
            if (!res.ok) { complete = false; continue; }
            const files = Object.values(await res.json());
            for (const f of files) {
                const fn = f?.file_name;
                if (fn) keys.add(`${char.name}_${fn.replace('.jsonl', '')}`);
            }
        } catch (e) {
            complete = false;
        }
    }

    for (const group of (context.groups || [])) {
        if (group?.id) keys.add(`group_${group.id}`);
    }

    return { keys, complete };
}

/**
 * 모아보기 캐시(globalSimulations) 정리.
 * - 빈 항목(시뮬 0개) 제거: 항상 안전
 * - 삭제된 채팅의 유령 항목 제거: 채팅 목록을 모두 성공적으로 읽었을 때만
 * 채팅 파일은 건드리지 않음 (설정 캐시만 수정).
 * @returns {Promise<{removedEmpty: number, removedGone: number, prunedGone: boolean}>}
 */
async function cleanupGlobalCache() {
    ensureSettings();
    const global = extension_settings[EXTENSION_NAME].globalSimulations || {};
    const { keys, complete } = await collectExistingChatKeys();

    let removedEmpty = 0;
    let removedGone = 0;

    for (const key of Object.keys(global)) {
        const entry = global[key];
        const empty = !entry?.simulations || entry.simulations.length === 0;
        if (empty) {
            delete global[key];
            removedEmpty++;
            continue;
        }
        if (complete && !keys.has(key)) {
            delete global[key];
            removedGone++;
        }
    }

    saveSettingsDebounced();
    return { removedEmpty, removedGone, prunedGone: complete };
}

// ============================================
// State
// ============================================
let currentView = 'list'; // 'list' | 'create' | 'detail' | 'globalList' | 'globalSimList' | 'globalDetail'
let currentSimId = null;
let tempSim = null; // 저장 안 하기 모드의 임시 sim
let isEditingPrompt = false;
let isEditingTitle = false; // 상세 뷰에서 제목 수정 중인지
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

// Generation state (생성 중단)
let simGenerating = false;  // 시뮬 생성(최초/재생성/이어쓰기)이 진행 중인지
let simAborted = false;     // 사용자가 '중단'을 눌러 abort 했는지

// 다중 전송(여러 채팅방) 상태
let multiSendRunning = false;       // 다중 전송 루프 진행 중
let multiSendShouldStop = false;    // 중지 버튼 눌림
let multiSendTargetsCache = [];     // 생성 화면에 표시 중인 대상 목록 (캐시)
let multiSendSelKeys = new Set();   // 선택된 대상 키 (type:id)

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 시뮬 생성을 중단. generateQuietPrompt 는 GENERATION_STOPPED 이벤트를 듣고 abort 한다.
 */
function stopSimGeneration() {
    simAborted = true;
    try { stopGeneration(); } catch (e) { console.error(DEBUG_PREFIX, 'stopGeneration failed:', e); }
}

/**
 * 생성 시작 시 호출. activeBtnId 버튼을 '중단' 버튼으로 바꾸고, 다른 생성 버튼은 비활성화.
 */
function enterSimGeneratingMode(activeBtnId) {
    simGenerating = true;
    simAborted = false;
    for (const id of ['sim-continue', 'sim-continue-dir', 'sim-regenerate']) {
        const b = document.getElementById(id);
        if (!b) continue;
        if (id === activeBtnId) {
            b.dataset.simStop = '1';
            b.disabled = false;
            b.classList.add('sim-btn-danger');
            b.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 취소하기';
        } else {
            b.disabled = true;
        }
    }
}

/**
 * 생성 종료 시 호출. 보통 직후 재렌더로 푸터가 새로 그려지지만, 방어적으로 stop 플래그를 정리.
 */
function exitSimGeneratingMode() {
    simGenerating = false;
    for (const id of ['sim-continue', 'sim-continue-dir', 'sim-regenerate']) {
        const el = document.getElementById(id);
        if (!el) continue;
        delete el.dataset.simStop;
        el.classList.remove('sim-btn-danger');
    }
}

// ============================================
// HTML Builders
// ============================================
function buildPopupHTML() {
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
                    <h4 style="margin:8px 0 4px; font-size:14px;">표시 설정</h4>
                    <label style="font-size:12px; color:#aaa;">이름 (지팡이 버튼 · 헤더 공통)</label>
                    <input type="text" id="sim-display-name" placeholder="시뮬레이션" maxlength="20" style="width:100%; padding:8px 10px; border:1px solid var(--SmartThemeBorderColor,#444); border-radius:6px; background:var(--SmartThemeBlurTintColor,#0d1117); color:var(--SmartThemeBodyColor,#ddd); font-size:13px; margin-bottom:8px;" />
                    <label style="font-size:12px; color:#aaa;">아이콘</label>
                    <div id="sim-icon-grid" class="sim-icon-grid"></div>
                    <hr />
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
                    <button class="sim-btn sim-btn-primary" id="sim-open-prompt-manager-btn" style="width:100%; margin-top:4px;">
                        <i class="fa-solid fa-bookmark"></i> 저장된 프롬프트 관리
                    </button>
                </div>
            </div>
        </div>
    </div>`;
}

function buildWandButtonHTML() {
    return `
    <div id="sim-manager-wand-btn" class="list-group-item flex-container flexGap5" title="${escapeHtml(getDisplayName())} 열기">
        <div class="fa-solid ${getDisplayIcon()} extensionsMenuExtensionButton"></div>
        <span>${escapeHtml(getDisplayName())}</span>
    </div>`;
}

// 설정 변경 시 이미 그려진 헤더/지팡이 버튼에 이름·아이콘 즉시 반영
function applyBranding() {
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

// ============================================
// Render Views
// ============================================
function renderListView() {
    const sims = getSimulations();
    const container = document.getElementById('sim-content');
    if (!container) return;
    maybeResetContentScroll('list');

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
            const displayName = getSimDisplayTitle(sim);
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
            isEditingTitle = false;
            renderDetailView();
        });
    });
}

/**
 * '저장된 프롬프트 불러오기' 드롭다운 옵션 HTML 생성.
 * 검색어로 필터 + 설정된 정렬(최신/오래된/이름) 적용.
 */
function buildLoadPromptOptions(query = '') {
    ensureSettings();
    const s = extension_settings[EXTENSION_NAME];
    const q = (query || '').toLowerCase().trim();
    let list = s.savedPrompts.filter(p => !q || p.name.toLowerCase().includes(q) || p.content.toLowerCase().includes(q));

    const order = s.promptSortOrder || 'newest';
    if (order === 'newest') {
        list = list.slice().reverse();          // 배열 순서 = 저장순 → 뒤집으면 최신순
    } else if (order === 'name') {
        list = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    }
    // 'oldest' = 원래 배열 순서 그대로

    let options = `<option value="">-- 직접 입력 --</option>`;
    for (const p of list) {
        options += `<option value="${p.id}">${escapeHtml(p.name)}</option>`;
    }
    return options;
}

function renderCreateView() {
    const container = document.getElementById('sim-content');
    if (!container) return;
    maybeResetContentScroll('create');

    ensureSettings();
    const savedPrompts = extension_settings[EXTENSION_NAME].savedPrompts;

    const selectOptions = buildLoadPromptOptions();

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
    const togglePresetField = togglesEnabled ? `
        <div class="sim-field">
            <label>토글 프리셋 (선택)</label>
            <select class="sim-saved-prompts-select" id="sim-toggle-preset-select"></select>
        </div>
    ` : '';

    const positionOptions = Object.entries(SIM_POSITION_LABELS).map(([v, l]) =>
        `<option value="${v}"${v === getDefaultInjectPosition() ? ' selected' : ''}>${escapeHtml(l)}</option>`
    ).join('');

    const html = `
    <div class="sim-create-view sim-create-view-v2">
        <div class="sim-create-toolbar">
            <button class="sim-btn" id="sim-back-to-list">
                <i class="fa-solid fa-arrow-left"></i> 목록으로
            </button>
        </div>

        <div class="sim-card sim-card-main">
            <h4 class="sim-card-title"><i class="fa-solid fa-flask"></i> 새 시뮬레이션</h4>
            <div class="sim-field">
                <label>제목</label>
                <input type="text" class="sim-prompt-search" id="sim-title-input" placeholder="제목 (비우면 프롬프트 앞글자 사용)" />
            </div>
            <div class="sim-field">
                <label>내용</label>
                <textarea class="sim-prompt-textarea sim-prompt-textarea-lg" id="sim-prompt-input" placeholder="프롬프트 내용"></textarea>
            </div>
        </div>

        <details class="sim-drawer">
            <summary>
                <span class="sim-drawer-title"><i class="fa-solid fa-bookmark"></i> 저장된 프롬프트 불러오기</span>
                <i class="fa-solid fa-chevron-down sim-drawer-arrow"></i>
            </summary>
            <div class="sim-drawer-body">
                <input type="text" class="sim-prompt-search" id="sim-prompt-search" placeholder="프롬프트 검색 (제목/내용)" />
                <select class="sim-saved-prompts-select sim-prompt-sort" id="sim-prompt-sort">
                    <option value="newest">최신순</option>
                    <option value="oldest">오래된순</option>
                    <option value="name">이름순</option>
                </select>
                <select class="sim-saved-prompts-select" id="sim-load-prompt">
                    ${selectOptions}
                </select>
                <span class="sim-create-hint" id="sim-overwrite-hint" style="display:none;">제목이나 내용을 수정하면 새 프롬프트로 저장됩니다.</span>
            </div>
        </details>

        <details class="sim-drawer">
            <summary>
                <span class="sim-drawer-title"><i class="fa-solid fa-sliders"></i> 실행 옵션</span>
                <i class="fa-solid fa-chevron-down sim-drawer-arrow"></i>
            </summary>
            <div class="sim-drawer-body">
                <div class="sim-field">
                    <label>프리셋</label>
                    <select class="sim-saved-prompts-select" id="sim-preset-select">
                        ${presetOptions}
                    </select>
                </div>
                ${togglePresetField}
                <div class="sim-field">
                    <label>주입 위치</label>
                    <select class="sim-saved-prompts-select" id="sim-position-select">
                        ${positionOptions}
                    </select>
                </div>
            </div>
        </details>

        <details class="sim-drawer">
            <summary>
                <span class="sim-drawer-title"><i class="fa-solid fa-arrows-rotate"></i> 변환 옵션</span>
                <i class="fa-solid fa-chevron-down sim-drawer-arrow"></i>
            </summary>
            <div class="sim-drawer-body">
                <label class="sim-checkbox-label">
                    <input type="checkbox" id="sim-swap-charuser" />
                    <span>{{char}} ↔ {{user}} 교체</span>
                </label>
                <label class="sim-checkbox-label">
                    <input type="checkbox" id="sim-swap-pronouns" />
                    <span>대명사 교체 (he/she, him/her, ...)</span>
                </label>
            </div>
        </details>

        <details class="sim-drawer">
            <summary>
                <span class="sim-drawer-title"><i class="fa-solid fa-floppy-disk"></i> 저장 옵션</span>
                <i class="fa-solid fa-chevron-down sim-drawer-arrow"></i>
            </summary>
            <div class="sim-drawer-body">
                <label class="sim-checkbox-label">
                    <input type="checkbox" id="sim-no-save-prompt" />
                    <span>이 프롬프트 저장 안 하기</span>
                </label>
            </div>
        </details>

        <details class="sim-drawer" id="sim-multisend-drawer">
            <summary>
                <span class="sim-drawer-title"><i class="fa-solid fa-tower-broadcast"></i> 여러 방에 보내기</span>
                <i class="fa-solid fa-chevron-down sim-drawer-arrow"></i>
            </summary>
            <div class="sim-drawer-body">
                <span class="sim-create-hint">현재 방은 기본 포함됩니다. 다른 방을 추가로 선택하면 함께 전송하고, 현재 방을 빼려면 (현재) 항목 체크를 해제하세요. 선택한 방마다 차례로 열어 같은 시뮬을 생성·저장하며, 끝나면 원래 방으로 돌아옵니다.</span>
                <input type="text" class="sim-prompt-search" id="sim-multisend-search" placeholder="채팅방 검색 (이름)" />
                <label class="sim-checkbox-label sim-multisend-allrow">
                    <input type="checkbox" id="sim-multisend-all" />
                    <span>보이는 항목 전체 선택</span>
                </label>
                <div id="sim-multisend-list" class="sim-multisend-list"></div>
            </div>
        </details>
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

    const rebuildLoadPrompt = () => {
        const select = document.getElementById('sim-load-prompt');
        if (!select) return;
        const query = document.getElementById('sim-prompt-search')?.value || '';
        select.innerHTML = buildLoadPromptOptions(query);
    };

    document.getElementById('sim-prompt-search')?.addEventListener('input', rebuildLoadPrompt);

    const sortSelect = document.getElementById('sim-prompt-sort');
    if (sortSelect) {
        sortSelect.value = extension_settings[EXTENSION_NAME].promptSortOrder || 'newest';
        sortSelect.addEventListener('change', () => {
            extension_settings[EXTENSION_NAME].promptSortOrder = PROMPT_SORT_ORDERS.includes(sortSelect.value) ? sortSelect.value : 'newest';
            saveSettingsDebounced();
            rebuildLoadPrompt();
        });
    }

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

    setupMultiSendDrawer();

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
    maybeResetContentScroll('detail', sim.id);

    const responseCount = sim.responses ? sim.responses.length : 0;
    const currentIdx = sim.currentIndex || 0;

    // 프롬프트 영역: 수정 모드 vs 보기 모드
    let promptBoxContent;
    if (isEditingPrompt) {
        promptBoxContent = `
            <div class="sim-detail-prompt-label">시뮬 요청 <span style="font-size:10px; color:#888;">(수정 중)</span></div>
            <textarea class="sim-edit-prompt-textarea" id="sim-edit-prompt-input">${escapeHtml(normalizePromptText(sim.promptText))}</textarea>
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
                <div class="sim-detail-prompt-text">${escapeHtml(normalizePromptText(sim.promptText))}</div>
            </details>`;
    }

    // ===== 제목 (사용자 지정 가능) =====
    let titleBlock;
    if (isEditingTitle) {
        titleBlock = `
            <div class="sim-detail-title-row">
                <input type="text" class="sim-title-edit-input" id="sim-title-edit-input"
                    value="${escapeHtml(sim.customTitle || getSimDisplayTitle(sim))}"
                    placeholder="비우면 기본 제목으로" />
                <button class="sim-btn-icon" id="sim-title-edit-save" title="저장"><i class="fa-solid fa-check"></i></button>
                <button class="sim-btn-icon" id="sim-title-edit-cancel" title="취소"><i class="fa-solid fa-xmark"></i></button>
            </div>`;
    } else {
        titleBlock = `
            <div class="sim-detail-title-row">
                <div class="sim-detail-title" title="${escapeHtml(getSimDisplayTitle(sim))}">${escapeHtml(getSimDisplayTitle(sim))}</div>
                <button class="sim-btn-icon" id="sim-edit-title-btn" title="제목 수정"><i class="fa-solid fa-pen"></i></button>
            </div>`;
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
            <div class="sim-detail-prompt-label" style="display:flex; align-items:center; gap:6px;">
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
        <div class="sim-detail-topbar">
            <button class="sim-btn sim-btn-sm" id="sim-back-to-list">
                <i class="fa-solid fa-arrow-left"></i> 목록으로
            </button>
            ${titleBlock}
        </div>

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
                <button class="sim-btn-icon" id="sim-insert-chat-btn" title="이 응답을 기존 챗에 삽입"><i class="fa-solid fa-file-import"></i> 기존 챗</button>
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
        const newText = normalizePromptText(textarea.value.trim());
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

    // ===== 제목 수정 =====
    document.getElementById('sim-edit-title-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isEditingTitle = true;
        renderDetailView();
        const titleInput = document.getElementById('sim-title-edit-input');
        if (titleInput) {
            titleInput.focus();
            titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length);
        }
    });

    const saveTitle = () => {
        const input = document.getElementById('sim-title-edit-input');
        if (!input) return;
        const val = input.value.trim();
        if (val) sim.customTitle = val;
        else delete sim.customTitle; // 비우면 기존 프롬프트 제목으로 복귀
        isEditingTitle = false;
        if (!tempSim || tempSim.id !== sim.id) saveSimulations();
        renderDetailView();
        if (typeof toastr !== 'undefined') toastr.success('제목이 변경되었습니다.', '시뮬 매니저');
    };
    document.getElementById('sim-title-edit-save')?.addEventListener('click', saveTitle);
    document.getElementById('sim-title-edit-cancel')?.addEventListener('click', () => {
        isEditingTitle = false;
        renderDetailView();
    });
    document.getElementById('sim-title-edit-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); saveTitle(); }
        else if (e.key === 'Escape') { e.preventDefault(); isEditingTitle = false; renderDetailView(); }
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

    // 기존 챗에 삽입
    document.getElementById('sim-insert-chat-btn')?.addEventListener('click', async () => {
        const responseText = getFullResponseText(sim, sim.currentIndex || 0);
        if (!responseText) return;
        showInsertToChatDialog(sim.promptText, responseText);
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
                case 'part-copy':
                    copyTextToClipboard(getPartText(sim, currentIdx, partIdx));
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

    document.getElementById('sim-continue')?.addEventListener('click', (e) => {
        if (e.currentTarget.dataset.simStop === '1') { stopSimGeneration(); return; }
        handleContinueSimulation(sim, sim.currentIndex || 0, false);
    });

    document.getElementById('sim-regenerate')?.addEventListener('click', (e) => {
        if (e.currentTarget.dataset.simStop === '1') { stopSimGeneration(); return; }
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
    maybeResetContentScroll('globalList');

    ensureSettings();
    const global = extension_settings[EXTENSION_NAME].globalSimulations;
    // 각 방의 가장 최근 시뮬 createdAt 기준 최신순 정렬
    const latestCreatedAt = (data) => {
        const sims = data?.simulations || [];
        let m = 0;
        for (const s of sims) {
            if (typeof s.createdAt === 'number' && s.createdAt > m) m = s.createdAt;
        }
        return m;
    };
    const chatKeys = Object.keys(global).sort((a, b) => latestCreatedAt(global[b]) - latestCreatedAt(global[a]));

    let html = `<div class="sim-global-list-view">`;
    html += `<div class="sim-global-title">
        <span><i class="fa-solid fa-layer-group"></i> 전체 시뮬레이션 모아보기</span>
        <span class="sim-global-actions">
            <button class="sim-btn sim-btn-sm" id="sim-global-export" title="전체 시뮬을 JSON 파일로 백업"><i class="fa-solid fa-download"></i> 백업</button>
            <button class="sim-btn sim-btn-sm" id="sim-global-cleanup" title="삭제된 채팅·빈 항목 정리"><i class="fa-solid fa-broom"></i> 정리</button>
            <button class="sim-btn sim-btn-sm" id="sim-global-rescan" title="다시 스캔"><i class="fa-solid fa-arrows-rotate"></i> 새로고침</button>
        </span>
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

    // 백업(내보내기) 버튼
    document.getElementById('sim-global-export')?.addEventListener('click', async () => {
        const btn = document.getElementById('sim-global-export');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 백업 중...';
        }
        const count = await exportSimBackup();
        if (typeof toastr !== 'undefined') {
            if (count >= 0) toastr.success(`${count}개 시뮬을 백업 파일로 내보냈습니다.`, '시뮬 매니저');
            else toastr.error('백업에 실패했습니다.', '시뮬 매니저');
        }
        renderGlobalListView();
    });

    // 정리(캐시 클린업) 버튼
    document.getElementById('sim-global-cleanup')?.addEventListener('click', async () => {
        const btn = document.getElementById('sim-global-cleanup');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 정리 중...';
        }
        const { removedEmpty, removedGone, prunedGone } = await cleanupGlobalCache();
        if (typeof toastr !== 'undefined') {
            const total = removedEmpty + removedGone;
            if (total === 0) {
                toastr.info('정리할 항목이 없습니다.', '시뮬 매니저');
            } else {
                let msg = `${total}개 항목 정리됨 (빈 항목 ${removedEmpty}, 삭제된 채팅 ${removedGone})`;
                if (!prunedGone) msg += ' · 일부 채팅 목록을 못 읽어 유령 항목 정리는 건너뜀';
                toastr.success(msg, '시뮬 매니저');
            }
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
    maybeResetContentScroll('globalSimList', globalViewChatKey);

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
            const displayName = getSimDisplayTitle(sim);
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
    maybeResetContentScroll('globalDetail', sim.id);

    const responseCount = sim.responses ? sim.responses.length : 0;
    const currentIdx = globalViewSimIndex || 0;

    // 프롬프트 영역
    let promptBoxContent;
    if (isEditingGlobalPrompt) {
        promptBoxContent = `
            <div class="sim-detail-prompt-label">시뮬 요청 <span style="font-size:10px; color:#888;">(수정 중)</span></div>
            <textarea class="sim-edit-prompt-textarea" id="sim-gv-edit-prompt-input">${escapeHtml(normalizePromptText(sim.promptText))}</textarea>
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
                <div class="sim-detail-prompt-text">${escapeHtml(normalizePromptText(sim.promptText))}</div>
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
        const newText = normalizePromptText(textarea.value.trim());
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
                case 'part-copy':
                    copyTextToClipboard(getPartText(sim, currentIdx, partIdx));
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

    const rawPrompt = normalizePromptText(promptInput.value.trim());
    if (!rawPrompt) {
        alert('시뮬레이션 내용을 입력해주세요.');
        return;
    }

    const titleInput = document.getElementById('sim-title-input');
    const customTitle = titleInput ? titleInput.value.trim() : '';
    const noSave = document.getElementById('sim-no-save')?.checked || false;
    const noSavePrompt = document.getElementById('sim-no-save-prompt')?.checked || false;
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

    // 다중 전송 분기: 현재 방 외에 다른 방이 하나라도 포함됐을 때만 다중 흐름.
    // (드로어 미사용 = 현재 방만 선택된 상태 → 기존 단일 인터랙티브 흐름 유지)
    const multiTargets = getSelectedMultiSendTargets();
    const curLoc = captureCurrentLocation();
    const onlyCurrent = multiTargets.length === 1 && sameLocation(multiTargets[0], curLoc);
    if (multiTargets.length > 0 && !onlyCurrent) {
        await handleMultiSendSimulation(multiTargets, {
            rawPrompt,
            promptName,
            customTitle,
            noSavePrompt,
            loadedPromptId,
            chosenPresetName,
            chosenTogglePresetName,
            chosenPosition,
            chosenSwapCharUser,
            chosenSwapPronouns,
        });
        return;
    }

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

        // 보낸 프롬프트 자동 저장 (체크박스로 옵트아웃 가능)
        if (!noSavePrompt) {
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

    enterSimGeneratingMode('sim-regenerate');
    try {
        console.log(DEBUG_PREFIX, 'Generating simulation response...');

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

        showSimNotification(targetSim);
        console.log(DEBUG_PREFIX, 'Simulation response received.');
    } catch (err) {
        if (simAborted) {
            toastr.info('시뮬레이션 생성을 취소했습니다.', '시뮬 매니저');
        } else {
            console.error(DEBUG_PREFIX, 'Generation failed:', err);
            toastr.error('시뮬레이션 생성에 실패했습니다.', '시뮬 매니저');
        }
    } finally {
        exitSimGeneratingMode();
        if (currentView === 'detail') {
            renderDetailView();
        }
    }
}

// ============================================
// 다중 전송 (여러 채팅방)
// ============================================

/** 현재 위치(캐릭터/그룹) 키. 대상 목록에서 '현재' 표시용. */
function currentLocationKey() {
    try {
        const ctx = getContext();
        if (ctx.groupId) return `group:${ctx.groupId}`;
        if (ctx.characterId !== undefined && ctx.characterId !== null) return `char:${ctx.characterId}`;
    } catch { /* ignore */ }
    return null;
}

/** 복귀용으로 현재 위치를 target 형태로 캡처. */
function captureCurrentLocation() {
    try {
        const ctx = getContext();
        if (ctx.groupId) {
            const g = (ctx.groups || []).find(x => String(x.id) === String(ctx.groupId));
            return { type: 'group', id: ctx.groupId, name: g?.name || '그룹', avatar: '' };
        }
        const idx = ctx.characterId;
        if (idx !== undefined && idx !== null) {
            const c = (ctx.characters || [])[idx];
            return { type: 'char', id: idx, name: c?.name || '캐릭터', avatar: c?.avatar || '' };
        }
    } catch { /* ignore */ }
    return null;
}

/** 전송 대상 후보 목록 (캐릭터 + 그룹). 현재 방은 isCurrent 표시. */
function getMultiSendTargets() {
    const targets = [];
    try {
        const ctx = getContext();
        (ctx.characters || []).forEach((char, index) => {
            if (char && char.name) {
                targets.push({ type: 'char', id: index, name: char.name, avatar: char.avatar || '', isCurrent: false });
            }
        });
        (ctx.groups || []).forEach((g) => {
            if (g && g.name) {
                targets.push({ type: 'group', id: g.id, name: g.name, avatar: '', isCurrent: false });
            }
        });
        const curKey = currentLocationKey();
        for (const t of targets) {
            if (`${t.type}:${t.id}` === curKey) t.isCurrent = true;
        }
    } catch (e) {
        console.error(DEBUG_PREFIX, 'getMultiSendTargets failed:', e);
    }
    return targets;
}

/** 현재 활성 채팅이 target 과 동일한지. */
function isOnTarget(target) {
    try {
        const ctx = getContext();
        if (target.type === 'group') return String(ctx.groupId || '') === String(target.id);
        if (ctx.groupId) return false;
        const idx = ctx.characterId;
        if (idx === undefined || idx === null) return false;
        const cur = (ctx.characters || [])[idx];
        if (!cur) return false;
        return target.avatar ? cur.avatar === target.avatar : cur.name === target.name;
    } catch {
        return false;
    }
}

/** 다음 CHAT_CHANGED 이벤트(또는 타임아웃)를 기다린다. */
function waitForChatChanged(timeout = 20000) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            eventSource.removeListener(event_types.CHAT_CHANGED, handler);
            resolve(ok);
        };
        const handler = () => finish(true);
        eventSource.on(event_types.CHAT_CHANGED, handler);
        setTimeout(() => finish(false), timeout);
    });
}

/** 지정 채팅방으로 전환하고 로드 완료까지 대기. */
async function switchToTargetChat(target) {
    const ctx = getContext();
    const loaded = waitForChatChanged(20000);
    if (target.type === 'group') {
        const g = (ctx.groups || []).find(x => String(x.id) === String(target.id));
        if (!g) throw new Error(`그룹을 찾을 수 없습니다: ${target.name}`);
        await ctx.openGroupChat(g.id, g.chat_id);
    } else {
        // 캐릭터 인덱스는 avatar 로 재확인 (목록 순서 변동 대비)
        let idx = target.id;
        if (target.avatar) {
            const found = (ctx.characters || []).findIndex(c => c.avatar === target.avatar);
            if (found >= 0) idx = found;
        }
        if (idx === undefined || idx === null || idx < 0) throw new Error(`캐릭터를 찾을 수 없습니다: ${target.name}`);
        await ctx.selectCharacterById(idx);
    }
    await loaded;
    await sleep(500); // 메타데이터/연결 settle
}

/** 생성 화면의 대상 체크박스 UI 구성. */
function setupMultiSendDrawer() {
    const listEl = document.getElementById('sim-multisend-list');
    if (!listEl) return;

    multiSendTargetsCache = getMultiSendTargets();
    multiSendSelKeys = new Set();

    const keyOf = (t) => `${t.type}:${t.id}`;

    // 현재 방은 기본 선택 (다른 방을 추가로 고르면 현재 방도 함께 전송됨).
    // 현재 방만 선택된 상태면 분기에서 단일 흐름으로 처리되므로 기본 동작은 그대로.
    const curTarget = multiSendTargetsCache.find(t => t.isCurrent);
    if (curTarget) multiSendSelKeys.add(keyOf(curTarget));

    const renderList = (query = '') => {
        const q = query.trim().toLowerCase();
        const items = multiSendTargetsCache.filter(t => !q || t.name.toLowerCase().includes(q));
        if (items.length === 0) {
            listEl.innerHTML = '<div class="sim-empty" style="padding:10px;">검색 결과가 없습니다.</div>';
            return;
        }
        listEl.innerHTML = items.map(t => {
            const k = keyOf(t);
            const checked = multiSendSelKeys.has(k) ? ' checked' : '';
            const cur = t.isCurrent ? ' <span class="sim-multisend-cur">(현재)</span>' : '';
            const icon = t.type === 'group' ? '👥 ' : '';
            return `<label class="sim-checkbox-label sim-multisend-item">
                <input type="checkbox" class="sim-multisend-cb" data-key="${escapeHtml(k)}"${checked} />
                <span>${icon}${escapeHtml(t.name)}${cur}</span>
            </label>`;
        }).join('');
    };

    renderList();

    document.getElementById('sim-multisend-search')?.addEventListener('input', (e) => {
        renderList(e.target.value);
    });

    document.getElementById('sim-multisend-all')?.addEventListener('change', (e) => {
        const on = e.target.checked;
        listEl.querySelectorAll('.sim-multisend-cb').forEach(cb => {
            cb.checked = on;
            if (on) multiSendSelKeys.add(cb.dataset.key);
            else multiSendSelKeys.delete(cb.dataset.key);
        });
    });

    listEl.addEventListener('change', (e) => {
        const cb = e.target.closest('.sim-multisend-cb');
        if (!cb) return;
        if (cb.checked) multiSendSelKeys.add(cb.dataset.key);
        else multiSendSelKeys.delete(cb.dataset.key);
    });
}

/** 두 위치(target 형태)가 같은 채팅방인지. */
function sameLocation(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === 'group') return String(a.id) === String(b.id);
    if (a.avatar && b.avatar) return a.avatar === b.avatar;
    return String(a.id) === String(b.id);
}

/** 현재 선택된 대상 목록 반환 (검색 필터로 가려진 선택도 유지). */
function getSelectedMultiSendTargets() {
    if (!multiSendSelKeys || multiSendSelKeys.size === 0) return [];
    return multiSendTargetsCache.filter(t => multiSendSelKeys.has(`${t.type}:${t.id}`));
}

/** 프롬프트 자동 저장(단일 흐름과 동일 규칙) — 다중 전송 시 1회만. */
function maybeAutoSavePrompt(opts) {
    if (opts.noSavePrompt) return;
    ensureSettings();
    const savedPrompts = extension_settings[EXTENSION_NAME].savedPrompts;
    const loadedPrompt = opts.loadedPromptId ? savedPrompts.find(p => p.id === opts.loadedPromptId) : null;
    const titleChanged = opts.customTitle && loadedPrompt && opts.customTitle !== loadedPrompt.name;
    const contentChanged = !savedPrompts.some(p => p.content === opts.rawPrompt);
    if (titleChanged || contentChanged) {
        savedPrompts.push({
            id: `prompt_${uuidv4()}`,
            name: opts.customTitle || (opts.rawPrompt.length > 20 ? opts.rawPrompt.substring(0, 20) + '...' : opts.rawPrompt),
            content: opts.rawPrompt,
        });
        saveSettingsDebounced();
        renderSettingsSavedPrompts();
    }
}

// ---- 진행 패널 ----
function showMultiSendPanel(total) {
    hideMultiSendPanel();
    const html = `
    <div id="sim-multisend-panel">
        <div class="sim-ms-head">
            <span><i class="fa-solid fa-tower-broadcast"></i> 다중 시뮬 전송</span>
            <span id="sim-ms-count">0/${total}</span>
        </div>
        <div id="sim-ms-status" class="sim-ms-status">준비 중...</div>
        <div class="sim-ms-bar"><div id="sim-ms-bar-fill"></div></div>
        <button id="sim-ms-stop" class="sim-btn sim-btn-danger sim-ms-stop"><i class="fa-solid fa-stop"></i> 중지</button>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    document.getElementById('sim-ms-stop')?.addEventListener('click', () => {
        multiSendShouldStop = true;
        try { stopSimGeneration(); } catch (e) { /* ignore */ }
        const s = document.getElementById('sim-ms-status');
        if (s) s.textContent = '중지 중... (현재 방 마무리)';
    });
}

function updateMultiSendPanel(idx, total, name, status) {
    const c = document.getElementById('sim-ms-count');
    if (c) c.textContent = `${Math.min(idx + 1, total)}/${total}`;
    const s = document.getElementById('sim-ms-status');
    if (s) s.textContent = `${name}: ${status}`;
    const f = document.getElementById('sim-ms-bar-fill');
    if (f) f.style.width = `${total ? (idx / total * 100) : 0}%`;
}

function hideMultiSendPanel() {
    document.getElementById('sim-multisend-panel')?.remove();
}

/**
 * 선택한 여러 채팅방에 같은 시뮬을 순차 생성.
 * 각 방을 열어 → 시뮬 생성 → 그 방 메타데이터에 저장(즉시 flush) → 다음 방.
 */
async function handleMultiSendSimulation(targets, opts) {
    if (multiSendRunning || simGenerating) {
        if (typeof toastr !== 'undefined') toastr.warning('이미 생성이 진행 중입니다.', '시뮬 매니저');
        return;
    }

    maybeAutoSavePrompt(opts);

    multiSendRunning = true;
    multiSendShouldStop = false;
    simGenerating = true; // 다른 시뮬 동작 차단
    simAborted = false;

    const origin = captureCurrentLocation();
    closePopup();
    showMultiSendPanel(targets.length);

    let success = 0;
    let fail = 0;
    let originSimId = null; // 현재 방이 대상에 포함됐으면, 그 방에서 만든 시뮬 id

    for (let i = 0; i < targets.length; i++) {
        if (multiSendShouldStop) break;
        const target = targets[i];

        try {
            updateMultiSendPanel(i, targets.length, target.name, '채팅방 여는 중...');
            if (!isOnTarget(target)) {
                await switchToTargetChat(target);
            }
            if (!isOnTarget(target)) {
                throw new Error('채팅방 전환 확인 실패');
            }

            if (multiSendShouldStop) break;
            updateMultiSendPanel(i, targets.length, target.name, '시뮬 생성 중...');

            // {{char}}/{{user}} 가 이 방 기준으로 치환되도록 전환 후 재계산
            const resolved = substituteParams(applySwap(opts.rawPrompt, opts.chosenSwapCharUser, opts.chosenSwapPronouns));

            const sim = {
                id: `sim_${uuidv4()}`,
                promptText: opts.rawPrompt,
                promptName: opts.promptName,
                responses: [],
                currentIndex: 0,
                createdAt: Date.now(),
                presetName: opts.chosenPresetName,
                togglePresetName: opts.chosenTogglePresetName,
                injectPosition: opts.chosenPosition,
                swapCharUser: opts.chosenSwapCharUser,
                swapPronouns: opts.chosenSwapPronouns,
            };

            const rawResponse = await withSimulationPreset(opts.chosenPresetName, opts.chosenTogglePresetName, () =>
                runSimGeneration(SIM_SYSTEM_INSTRUCTION, resolved, sim.injectPosition)
            );

            if (simAborted || (multiSendShouldStop && !rawResponse)) {
                // 생성 도중 중단 — 빈 시뮬 저장하지 않음
                break;
            }

            // 생성 중 예기치 않게 방이 바뀌었으면 다시 맞춤
            if (!isOnTarget(target)) {
                await switchToTargetChat(target);
                if (!isOnTarget(target)) throw new Error('생성 후 채팅방 복귀 실패');
            }

            sim.responses.push(rawResponse);
            sim.currentIndex = 0;

            const sims = getSimulations(); // 이 방의 메타데이터
            sims.push(sim);

            // 다음 방으로 넘어가기 전 즉시 저장 (debounce 미flush 방지)
            try { await getContext().saveChat(); } catch (e) { console.error(DEBUG_PREFIX, 'saveChat failed:', e); }
            syncToGlobal();

            // 현재(원래) 방이 대상이면, 끝나고 디테일 뷰로 열어줄 시뮬 id 기억
            if (origin && sameLocation(target, origin)) {
                originSimId = sim.id;
            }

            success++;
            updateMultiSendPanel(i, targets.length, target.name, '완료 ✓');
        } catch (err) {
            console.error(DEBUG_PREFIX, 'multi-send failed for', target.name, err);
            fail++;
            updateMultiSendPanel(i, targets.length, target.name, '실패: ' + (err?.message || ''));
            await sleep(600);
        }

        if (i < targets.length - 1 && !multiSendShouldStop) await sleep(800);
    }

    // 원래 방으로 복귀
    try {
        if (origin && !isOnTarget(origin)) {
            updateMultiSendPanel(targets.length, targets.length, origin.name, '원래 방으로 복귀 중...');
            await switchToTargetChat(origin);
        }
    } catch (e) {
        console.error(DEBUG_PREFIX, 'restore origin failed:', e);
    }

    simGenerating = false;
    multiSendRunning = false;
    multiSendShouldStop = false;
    simAborted = false;
    hideMultiSendPanel();

    // 현재 방이 대상에 포함됐고 복귀에 성공했으면, 그 방 시뮬을 디테일 뷰로 자동 오픈
    if (originSimId && origin && isOnTarget(origin)) {
        try {
            openPopupToSim(originSimId);
        } catch (e) {
            console.error(DEBUG_PREFIX, 'open detail after multi-send failed:', e);
        }
    }

    if (typeof toastr !== 'undefined') {
        if (success > 0 && fail === 0) {
            toastr.success(`다중 전송 완료! ${success}개 방 모두 성공`, '시뮬 매니저');
        } else if (success > 0) {
            toastr.warning(`다중 전송 완료. 성공 ${success} / 실패 ${fail}`, '시뮬 매니저');
        } else {
            toastr.error(`다중 전송 실패. 성공 0 / 실패 ${fail}`, '시뮬 매니저');
        }
    }
}

async function handleRegenerateSimulation(sim) {
    if (simGenerating) return;
    const resolvedPrompt = substituteParams(getEffectivePromptText(sim));

    enterSimGeneratingMode('sim-regenerate');

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

        showSimNotification(targetSim);
    } catch (err) {
        if (simAborted) {
            toastr.info('답변 재생성을 취소했습니다.', '시뮬 매니저');
        } else {
            console.error(DEBUG_PREFIX, 'Regeneration failed:', err);
            toastr.error('답변 재생성에 실패했습니다.', '시뮬 매니저');
        }
    } finally {
        exitSimGeneratingMode();
        if (currentView === 'detail' && currentSimId === simId) {
            renderDetailView();
        }
    }
}

async function handleContinueSimulation(sim, responseIdx, isGlobal = false) {
    if (simGenerating) return;
    const currentResponse = sim.responses[responseIdx];
    if (!currentResponse) {
        toastr.warning('이어쓸 응답이 없습니다.', '시뮬 매니저');
        return;
    }

    const continuePrompt = substituteParams(getEffectivePromptText(sim));

    enterSimGeneratingMode('sim-continue');

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
        } else {
            if (!tempSim || tempSim.id !== target.id) saveSimulations();
        }

        toastr.success('응답이 이어쓰기되었습니다.', '시뮬 매니저');
    } catch (err) {
        if (simAborted) {
            toastr.info('이어쓰기를 취소했습니다.', '시뮬 매니저');
        } else {
            console.error(DEBUG_PREFIX, 'Continue failed:', err);
            toastr.error('이어쓰기에 실패했습니다.', '시뮬 매니저');
        }
    } finally {
        exitSimGeneratingMode();
        if (isGlobal) {
            if (currentView === 'globalDetail') renderGlobalDetailView();
        } else {
            if (currentView === 'detail' && currentSimId === sim.id) renderDetailView();
        }
    }
}

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

function showInsertToChatDialog(promptText, responseText) {
    const overlay = document.createElement('div');
    overlay.className = 'sim-dialog-overlay';
    overlay.innerHTML = `
        <div class="sim-dialog-box">
            <div class="sim-dialog-title">기존 챗에 삽입</div>
            <div class="sim-dialog-desc">이 시뮬 응답을 현재 채팅방 끝에 추가합니다.</div>
            <div class="sim-dialog-buttons">
                <button class="sim-btn" id="sim-insert-response-only">응답만</button>
                <button class="sim-btn" id="sim-insert-with-request">요청 포함</button>
                <button class="sim-btn sim-btn-muted" id="sim-insert-cancel">취소</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#sim-insert-response-only').addEventListener('click', async () => {
        overlay.remove();
        await insertSimIntoCurrentChat(null, responseText);
    });
    overlay.querySelector('#sim-insert-with-request').addEventListener('click', async () => {
        overlay.remove();
        await insertSimIntoCurrentChat(promptText, responseText);
    });
    overlay.querySelector('#sim-insert-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

async function insertSimIntoCurrentChat(promptText, responseText) {
    try {
        const context = getContext();

        if (promptText) {
            const userMsg = {
                name: context.name1,
                is_user: true,
                is_system: false,
                send_date: new Date().toISOString(),
                mes: promptText,
                extra: {},
            };
            chat.push(userMsg);
            addOneMessage(userMsg);
        }

        const charMsg = {
            name: context.name2,
            is_user: false,
            is_system: false,
            send_date: new Date().toISOString(),
            mes: responseText,
            extra: {},
        };
        chat.push(charMsg);
        addOneMessage(charMsg);

        await saveChatConditional();
        toastr.success('시뮬 응답이 현재 챗에 삽입되었습니다.', '시뮬 매니저');
    } catch (err) {
        console.error(DEBUG_PREFIX, 'Failed to insert into chat:', err);
        toastr.error('기존 챗 삽입에 실패했습니다.', '시뮬 매니저');
    }
}

// ============================================
// Capture: 채팅 메시지 → 시뮬 항목으로 저장
// ============================================

/**
 * 채팅 메시지 하나를 현재 챗의 시뮬 목록에 새 항목으로 저장.
 *  - responses[0] = 그 메시지 본문
 *  - promptText  = 바로 앞(가장 가까운) 유저 메시지 (없으면 빈 값)
 */
function captureMessageToSim(mesId) {
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
function injectSaveButton(mesEl) {
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
function refreshSaveButtons() {
    document.querySelectorAll('#chat .mes').forEach(injectSaveButton);
}

/** 버튼 주입 + 클릭 위임 + 렌더 이벤트 바인딩 (init 1회) */
function setupMessageCapture() {
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

    try { playMessageSound(); } catch (e) { console.error(DEBUG_PREFIX, 'playMessageSound failed:', e); }
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

    // 프롬프트 관리 버튼
    document.getElementById('sim-open-prompt-manager-btn')?.addEventListener('click', () => {
        currentView = 'promptManager';
        openPopup();
        renderPromptManagerView();
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
let lastRenderedView = null;
let lastRenderedSimId = null;

// 뷰 전환 시에만 sim-content 스크롤을 맨 위로. 같은 뷰의 인-플레이스 재렌더는 스크롤 보존.
function maybeResetContentScroll(viewKey, simId = null) {
    if (lastRenderedView !== viewKey || lastRenderedSimId !== simId) {
        const container = document.getElementById('sim-content');
        if (container) container.scrollTop = 0;
        lastRenderedView = viewKey;
        lastRenderedSimId = simId;
    }
}

// ============================================
// Prompt Manager Views
// ============================================
function renderPromptManagerView() {
    const container = document.getElementById('sim-content');
    if (!container) return;
    maybeResetContentScroll('promptManager');

    ensureSettings();
    const prompts = extension_settings[EXTENSION_NAME].savedPrompts;

    let html = `<div class="sim-list-view">
        <input type="text" class="sim-prompt-search" id="sim-pm-search" placeholder="프롬프트 검색..." style="margin-bottom:8px;" />`;

    if (prompts.length === 0) {
        html += `<div class="sim-empty"><i class="fa-solid fa-bookmark" style="font-size:28px; margin-bottom:10px; opacity:0.3;"></i><br>저장된 프롬프트가 없습니다.</div>`;
    } else {
        for (const p of [...prompts].reverse()) {
            const preview = p.content.length > 60 ? p.content.substring(0, 60) + '…' : p.content;
            html += `
            <div class="sim-item sim-pm-item" data-prompt-id="${escapeHtml(p.id)}">
                <div class="sim-item-prompt">${escapeHtml(p.name)}</div>
                <div class="sim-item-meta"><span>${escapeHtml(preview)}</span></div>
            </div>`;
        }
    }
    html += `</div>`;
    container.innerHTML = html;

    const footer = document.getElementById('sim-footer');
    if (footer) {
        footer.classList.remove('hidden');
        footer.innerHTML = `
        <div class="sim-create-actions">
            <button class="sim-btn" id="sim-pm-back"><i class="fa-solid fa-arrow-left"></i> 뒤로</button>
            <button class="sim-btn sim-btn-primary" id="sim-pm-new"><i class="fa-solid fa-plus"></i> 새 프롬프트</button>
        </div>`;
    }

    document.getElementById('sim-pm-back')?.addEventListener('click', goToList);
    document.getElementById('sim-pm-new')?.addEventListener('click', () => renderPromptEditView(null));

    document.getElementById('sim-pm-search')?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        container.querySelectorAll('.sim-pm-item').forEach(el => {
            const id = el.dataset.promptId;
            const p = prompts.find(x => x.id === id);
            const match = !query || p?.name.toLowerCase().includes(query) || p?.content.toLowerCase().includes(query);
            el.style.display = match ? '' : 'none';
        });
    });

    container.querySelectorAll('.sim-pm-item').forEach(el => {
        el.addEventListener('click', () => renderPromptEditView(el.dataset.promptId));
    });
}

function renderPromptEditView(promptId) {
    const container = document.getElementById('sim-content');
    if (!container) return;
    maybeResetContentScroll('promptEdit');

    ensureSettings();
    const prompts = extension_settings[EXTENSION_NAME].savedPrompts;
    const prompt = promptId ? prompts.find(p => p.id === promptId) : null;

    container.innerHTML = `
    <div class="sim-create-view sim-create-view-v2 sim-prompt-edit-view">
        <div class="sim-create-toolbar">
            <button class="sim-btn" id="sim-pe-back"><i class="fa-solid fa-arrow-left"></i> 목록으로</button>
        </div>
        <div class="sim-card sim-card-main">
            <h4 class="sim-card-title"><i class="fa-solid fa-bookmark"></i> ${prompt ? '프롬프트 수정' : '새 프롬프트'}</h4>
            <div class="sim-field">
                <label>이름</label>
                <input type="text" class="sim-prompt-search" id="sim-pe-name"
                    placeholder="프롬프트 이름" value="${prompt ? escapeHtml(prompt.name) : ''}" />
            </div>
            <div class="sim-field">
                <label>내용</label>
                <textarea class="sim-prompt-textarea sim-prompt-textarea-lg" id="sim-pe-content"
                    placeholder="프롬프트 내용">${prompt ? escapeHtml(prompt.content) : ''}</textarea>
            </div>
        </div>
    </div>`;

    const footer = document.getElementById('sim-footer');
    if (footer) {
        footer.classList.remove('hidden');
        footer.innerHTML = `
        <div class="sim-create-actions">
            ${prompt ? `<button class="sim-btn sim-btn-danger" id="sim-pe-delete"><i class="fa-solid fa-trash"></i> 삭제</button>` : ''}
            <button class="sim-btn sim-btn-primary" id="sim-pe-save"><i class="fa-solid fa-floppy-disk"></i> 저장</button>
        </div>`;
    }

    document.getElementById('sim-pe-back')?.addEventListener('click', renderPromptManagerView);

    document.getElementById('sim-pe-save')?.addEventListener('click', () => {
        const name = document.getElementById('sim-pe-name')?.value.trim();
        const content = document.getElementById('sim-pe-content')?.value.trim();
        if (!name || !content) { alert('이름과 내용을 모두 입력해주세요.'); return; }

        ensureSettings();
        const prompts = extension_settings[EXTENSION_NAME].savedPrompts;
        if (promptId) {
            const found = prompts.find(p => p.id === promptId);
            if (found) { found.name = name; found.content = content; }
        } else {
            prompts.push({ id: `prompt_${uuidv4()}`, name, content });
        }
        saveSettingsDebounced();
        toastr.success('저장되었습니다.', '시뮬 매니저');
        renderPromptManagerView();
    });

    document.getElementById('sim-pe-delete')?.addEventListener('click', () => {
        if (!promptId || !confirm('이 프롬프트를 삭제하시겠습니까?')) return;
        ensureSettings();
        const prompts = extension_settings[EXTENSION_NAME].savedPrompts;
        const idx = prompts.findIndex(p => p.id === promptId);
        if (idx !== -1) prompts.splice(idx, 1);
        saveSettingsDebounced();
        toastr.info('삭제되었습니다.', '시뮬 매니저');
        renderPromptManagerView();
    });
}

function goToList() {
    currentView = 'list';
    currentSimId = null;
    tempSim = null;
    isEditingPrompt = false;
    isEditingTitle = false;
    editingPartIdx = null;
    renderListView();
}

function fixMobileHeight() {
    const popup = document.getElementById('sim-manager-popup');
    if (popup) {
        // window.innerHeight 는 주소창은 반영하되, 소프트 키패드가 떠도 줄지 않는
        // 레이아웃 뷰포트 높이. visualViewport.height 를 쓰면 키패드만큼 모달이 줄어
        // 푸터가 중간으로 튀어 오르므로 innerHeight 를 사용한다. (키패드는 모달 위에 겹쳐 뜸)
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

// 소프트 키패드 열림/닫힘 감지 (resize 이벤트가 안 뜨는 브라우저 대응)
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        const popup = document.getElementById('sim-manager-popup');
        if (popup && popup.classList.contains('active')) {
            fixMobileHeight();
        }
    });
}

function openPopupToSim(simId) {
    currentSimId = simId;
    currentView = 'detail';
    isEditingPrompt = false;
    isEditingTitle = false;
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

// 외부에서 복붙된 nbsp 류를 일반 공백으로 정리 (시뮬 요청 텍스트에만 적용)
function normalizePromptText(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/[  ]/g, ' ');
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
            <button class="sim-btn-icon sim-btn-icon-sm" data-action="part-copy" data-part="${partIdx}" title="복사"><i class="fa-solid fa-copy"></i></button>
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

/**
 * 특정 파트의 텍스트 반환. 번역 보기 상태면 번역문, 아니면 원문.
 */
function getPartText(sim, responseIdx, partIdx) {
    const base = sim.responses[responseIdx] || '';
    const conts = sim.continuations?.[String(responseIdx)] || [];
    const parts = [base, ...conts];
    const original = parts[partIdx] || '';
    const translated = sim.partTranslations?.[String(responseIdx)]?.[String(partIdx)];
    return (showTranslated && translated) ? translated : original;
}

/**
 * 텍스트를 클립보드에 복사. HTTPS/localhost 가 아닌 환경 대비 fallback 포함.
 */
async function copyTextToClipboard(text) {
    if (!text) return;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        if (typeof toastr !== 'undefined') toastr.success('복사되었습니다.', '시뮬 매니저');
    } catch (e) {
        console.error(DEBUG_PREFIX, 'Copy failed:', e);
        if (typeof toastr !== 'undefined') toastr.error('복사에 실패했습니다.', '시뮬 매니저');
    }
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

    // 5. 채팅 메시지 → 시뮬로 저장 버튼
    setupMessageCapture();

    console.log(DEBUG_PREFIX, 'Simulation Manager loaded successfully.');
})();
