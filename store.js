/**
 * SillyTavern - Simulation Manager
 * 시뮬 저장소 (채팅별 chat_metadata + globalSimulations 캐시) · 백업/정리
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { chat_metadata, saveChatDebounced, saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { EXTENSION_NAME, DEBUG_PREFIX } from './constants.js';
import { ensureSettings } from './config.js';
import { applySwap } from './utils.js';

// ============================================
// Sim 헬퍼
// ============================================
export function getEffectivePromptText(sim) {
    return applySwap(sim?.promptText || '', !!sim?.swapCharUser, !!sim?.swapPronouns);
}

/**
 * 시뮬 목록/상세에 표시할 제목.
 * 사용자가 직접 지정한 customTitle 이 최우선 (프롬프트 자동 동기화로 덮이지 않음).
 */
export function getSimDisplayTitle(sim) {
    if (sim?.customTitle && sim.customTitle.trim()) return sim.customTitle.trim();
    if (sim?.promptName) return sim.promptName;
    const pt = sim?.promptText || '';
    if (!pt) return '(제목 없음)';
    return pt.length > 80 ? pt.slice(0, 80) + '...' : pt;
}

export function getSimulations() {
    if (!chat_metadata[EXTENSION_NAME]) {
        chat_metadata[EXTENSION_NAME] = { simulations: [] };
    }
    if (!Array.isArray(chat_metadata[EXTENSION_NAME].simulations)) {
        chat_metadata[EXTENSION_NAME].simulations = [];
    }
    return chat_metadata[EXTENSION_NAME].simulations;
}

export function saveSimulations() {
    saveChatDebounced();
    syncToGlobal();
}

// ============================================
// Global Simulation Store
// ============================================
export function getCurrentChatKey() {
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

export function getCurrentChatDisplayName() {
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

export function syncToGlobal() {
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
export async function scanAllChatsForSimulations() {
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
export async function exportSimBackup() {
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
export async function cleanupGlobalCache() {
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
