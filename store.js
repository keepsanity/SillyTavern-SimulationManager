/**
 * SillyTavern - Simulation Manager
 * 시뮬 저장소 · 모아보기 인덱스 · 백업/정리
 *
 * 저장 모델
 * - 원본:      채팅 .jsonl 의 chat_metadata[EXTENSION_NAME].simulations
 * - 인덱스:    extension_settings 의 globalIndex — 방마다 이름·개수·최신시각·출처만 (수 KB)
 * - 본문:      memCache — 휘발성. 모아보기에서 방을 펼칠 때만 채운다
 *
 * 1.5.0 전에는 시뮬 본문 전체를 globalSimulations 로 settings.json 에 복사해 뒀다.
 * 설정 파일이 수십 MB 로 불어나고, 시뮬 하나 저장할 때마다 그 전체를 다시 쓰는 게 문제라
 * 인덱스만 남기고 본문은 필요할 때 채팅 파일에서 읽도록 바꿨다.
 * 기존 사용자 처리는 migrateLegacyGlobalStore() 참고.
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
// 채팅 식별
// ============================================
/**
 * 그룹은 방 하나에 채팅이 여러 개다. `group.chats` 가 채팅 id 목록이고
 * `group.chat_id` 가 지금 열려 있는 것. /api/chats/group/get 도 그룹 id 가 아니라
 * **채팅 id** 를 받는다(<id>.jsonl 을 그대로 읽음). 그룹 id 로 키를 잡으면
 * 같은 그룹의 채팅들이 한 칸을 덮어쓰고, 불러올 때도 엉뚱한 파일을 읽게 된다.
 */
function getGroup(context, groupId) {
    return (context.groups || []).find(g => String(g.id) === String(groupId));
}

function groupChatIds(group) {
    if (Array.isArray(group?.chats) && group.chats.length) return group.chats.map(String);
    return group?.chat_id ? [String(group.chat_id)] : [];
}

function groupChatKey(groupId, chatId) {
    return `group_${groupId}_${chatId}`;
}

/** 채팅이 여럿인 그룹은 어느 채팅인지 구분되게 이름에 붙여 준다. */
function groupChatLabel(group, chatId, chatCount) {
    const name = group?.name || '그룹 채팅';
    return chatCount > 1 ? `${name} / ${chatId}` : name;
}

export function getCurrentChatKey() {
    try {
        const context = getContext();
        if (context.groupId) {
            const group = getGroup(context, context.groupId);
            const chatId = group?.chat_id || context.chatId || context.groupId;
            return groupChatKey(context.groupId, chatId);
        }
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
            const group = getGroup(context, context.groupId);
            if (group) return groupChatLabel(group, group.chat_id, groupChatIds(group).length);
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

/**
 * 지금 열려 있는 채팅을 나중에 다시 읽어올 수 있는 최소 정보.
 * 인덱스에 같이 넣어 둬야 모아보기에서 온디맨드 로드가 가능하다.
 */
function getCurrentChatSource() {
    try {
        const context = getContext();
        if (context.groupId) {
            const group = getGroup(context, context.groupId);
            const chatId = group?.chat_id || context.chatId || context.groupId;
            return { groupId: String(context.groupId), groupChatId: String(chatId) };
        }
        const char = (context.characters || [])[context.characterId];
        if (char?.avatar) {
            return {
                avatar: char.avatar,
                chName: char.name,
                fileName: String(char.chat || context.chatId || ''),
            };
        }
    } catch { /* 채팅 미로드 상태 */ }
    return {};
}

// ============================================
// 모아보기 인덱스 + 본문 캐시
// ============================================

/**
 * chatKey -> simulations[] · 세션 동안만 유지되고 설정 파일에는 안 들어간다.
 * 방을 옮겨 다녀도 본문이 계속 쌓이지 않도록 최근 몇 개만 붙들어 둔다.
 */
const memCache = new Map();
const MEM_CACHE_LIMIT = 4;

function cacheSims(chatKey, sims) {
    memCache.delete(chatKey);          // 최근 사용 순서로 다시 넣기
    memCache.set(chatKey, sims);
    const currentKey = getCurrentChatKey();
    for (const key of memCache.keys()) {
        if (memCache.size <= MEM_CACHE_LIMIT) break;
        if (key === chatKey || key === currentKey) continue;
        memCache.delete(key);
    }
}

/** 붙들고 있던 본문을 놓아준다 (백업처럼 전체를 훑고 난 뒤). */
export function clearSimCache() {
    memCache.clear();
}

export function getGlobalIndex() {
    ensureSettings();
    return extension_settings[EXTENSION_NAME].globalIndex;
}

/** 인덱스에 넣을 요약치. 본문은 빼고 목록 렌더에 필요한 것만. */
function summarize(sims) {
    let lastAt = 0;
    for (const s of sims) {
        if (typeof s?.createdAt === 'number' && s.createdAt > lastAt) lastAt = s.createdAt;
    }
    return { count: sims.length, lastAt };
}

/** 채팅 .jsonl 첫 줄(헤더)에서 시뮬 배열 꺼내기. */
function readSimsFromHeader(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const sims = messages[0]?.chat_metadata?.[EXTENSION_NAME]?.simulations;
    return Array.isArray(sims) ? sims : [];
}

export function syncToGlobal() {
    const chatKey = getCurrentChatKey();
    if (!chatKey) return;
    const index = getGlobalIndex();
    const sims = getSimulations();

    if (sims.length === 0) {
        delete index[chatKey];
        memCache.delete(chatKey);
    } else {
        index[chatKey] = {
            chatName: getCurrentChatDisplayName(),
            ...summarize(sims),
            ...getCurrentChatSource(),
        };
        // 현재 방은 chat_metadata 가 곧 최신본이라 복사하지 않고 참조만 둔다.
        cacheSims(chatKey, sims);
    }
    saveSettingsDebounced();
}

/**
 * 한 방의 시뮬 본문 가져오기. 캐시에 없으면 그 채팅 파일만 읽는다.
 * @param {string} chatKey
 * @returns {Promise<Array>}
 */
export async function loadSimsForChat(chatKey) {
    if (!chatKey) return [];
    // 열려 있는 방이면 메타데이터가 원본이다.
    if (chatKey === getCurrentChatKey()) return getSimulations();
    if (memCache.has(chatKey)) return memCache.get(chatKey);

    const entry = getGlobalIndex()[chatKey];
    if (!entry) return [];

    const sims = await fetchSimsFromChatFile(entry);
    cacheSims(chatKey, sims);
    return sims;
}

async function fetchSimsFromChatFile(entry) {
    const headers = getRequestHeaders();
    try {
        let res;
        if (entry.groupChatId) {
            // 그룹은 반드시 채팅 id 로 조회한다. 그룹 id 를 넣으면 <그룹id>.jsonl 을 읽는데,
            // 그건 그 그룹의 첫 채팅이거나 아예 없는 파일이다 (요즘 그룹은 채팅 파일명이
            // humanizedDateTime). 그래서 groupId 밖에 없는 구버전 항목은 폴백하지 않고
            // 아래 '출처 없음' 으로 떨군다 — 엉뚱한 방을 보여주느니 스캔을 기다리는 게 낫다.
            res = await fetch('/api/chats/group/get', {
                method: 'POST',
                headers,
                cache: 'no-cache',
                body: JSON.stringify({ id: entry.groupChatId }),
            });
        } else if (entry.avatar && entry.fileName) {
            res = await fetch('/api/chats/get', {
                method: 'POST',
                headers,
                cache: 'no-cache',
                body: JSON.stringify({
                    ch_name: entry.chName,
                    file_name: entry.fileName,
                    avatar_url: entry.avatar,
                }),
            });
        } else {
            // 출처 정보가 없거나 구버전 형식인 항목 — 스캔이 다시 채워야 한다.
            return [];
        }
        if (!res.ok) return [];
        return readSimsFromHeader(await res.json());
    } catch (e) {
        console.error(DEBUG_PREFIX, 'Failed to load sims for chat:', e);
        return [];
    }
}

/**
 * 전체 채팅방 스캔 → 인덱스 재구축.
 * 채팅당 파일 전체를 받던 걸 캐릭터당 1회 요청(metadata:true, 서버가 첫 줄만 읽음)으로 바꿨다.
 * @returns {Promise<number>} 찾은 시뮬 개수 (실패 시 -1)
 */
export async function scanAllChatsForSimulations() {
    const index = getGlobalIndex();
    let totalFound = 0;

    try {
        const context = getContext();
        const headers = getRequestHeaders();
        const seen = new Set();
        let complete = true;

        // 인덱스만 세운다. 본문을 여기서 붙들면 설정에서 뺀 의미가 없어진다.
        const record = (chatKey, chatName, sims, source) => {
            if (!chatKey || !Array.isArray(sims) || sims.length === 0) return;
            index[chatKey] = { chatName, ...summarize(sims), ...source };
            seen.add(chatKey);
            totalFound += sims.length;
        };

        // 1. 현재 채팅 — chat_metadata 가 최신본이라 요청 없이 바로
        const currentKey = getCurrentChatKey();
        if (currentKey) {
            record(currentKey, getCurrentChatDisplayName(), getSimulations(), getCurrentChatSource());
        }

        // 2. 캐릭터별 채팅
        for (const char of (context.characters || [])) {
            if (!char?.avatar) continue;

            let chats = [];
            try {
                const res = await fetch('/api/characters/chats', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ avatar_url: char.avatar, metadata: true }),
                });
                if (!res.ok) { complete = false; continue; }
                const body = await res.json();
                chats = Array.isArray(body) ? body : Object.values(body || {});
            } catch (e) {
                complete = false;
                continue;
            }

            for (const info of chats) {
                const fileName = String(info?.file_name || '').replace('.jsonl', '');
                if (!fileName) continue;
                const chatKey = `${char.name}_${fileName}`;
                if (chatKey === currentKey) continue;
                const sims = info?.chat_metadata?.[EXTENSION_NAME]?.simulations;
                record(chatKey, fileName, sims, { avatar: char.avatar, chName: char.name, fileName });
            }
        }

        // 3. 그룹 채팅 — 그룹당 채팅이 여러 개다. 그룹 수는 적으니 채팅마다 파일을 받아도 된다
        for (const group of (context.groups || [])) {
            if (!group?.id) continue;
            const chatIds = groupChatIds(group);

            for (const chatId of chatIds) {
                const chatKey = groupChatKey(group.id, chatId);
                if (chatKey === currentKey) continue;

                try {
                    const res = await fetch('/api/chats/group/get', {
                        method: 'POST',
                        headers,
                        cache: 'no-cache',
                        body: JSON.stringify({ id: chatId }),
                    });
                    if (!res.ok) { complete = false; continue; }
                    record(
                        chatKey,
                        groupChatLabel(group, chatId, chatIds.length),
                        readSimsFromHeader(await res.json()),
                        { groupId: String(group.id), groupChatId: String(chatId) },
                    );
                } catch (e) {
                    complete = false;
                    continue;
                }
            }
        }

        // 스캔에 안 잡힌 항목은 실체가 없는 것 → 제거.
        // 단 목록을 하나라도 못 읽었으면 판단 근거가 불완전하므로 보류한다.
        if (complete) {
            for (const key of Object.keys(index)) {
                if (!seen.has(key)) {
                    delete index[key];
                    memCache.delete(key);
                }
            }
        }

        // 목록을 다 못 읽었으면 인덱스를 믿을 수 없다. stale 을 유지해 다음에 다시 스캔시킨다.
        ensureSettings();
        if (complete) extension_settings[EXTENSION_NAME].globalIndexStale = false;
        saveSettingsDebounced();
        return totalFound;
    } catch (e) {
        console.error(DEBUG_PREFIX, 'Scan failed:', e);
        return -1;
    }
}

// ============================================
// Backup (내보내기) & Cleanup (인덱스 정리)
// ============================================

/**
 * 전체 시뮬을 JSON 파일로 내보내기 (다운로드).
 * 채팅 파일은 건드리지 않음 — 스캔(읽기) 후 직렬화만.
 * @returns {Promise<number>} 내보낸 시뮬 개수 (실패 시 -1)
 */
export async function exportSimBackup() {
    try {
        await scanAllChatsForSimulations(); // 최신 데이터 보장
        const payload = await buildBackupPayload();
        clearSimCache();                    // 전 채팅 본문을 들고 있을 이유가 없다

        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sim-manager-backup_${fileStamp()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        return payload.simCount;
    } catch (e) {
        console.error(DEBUG_PREFIX, 'Export failed:', e);
        return -1;
    }
}

/** 백업 파일 형식은 1.5.0 이전과 동일하게 유지한다 (globalSimulations 모양). */
async function buildBackupPayload() {
    const index = getGlobalIndex();
    const globalSimulations = {};
    let simCount = 0;

    for (const [key, entry] of Object.entries(index)) {
        const sims = await loadSimsForChat(key);
        if (!sims.length) continue;
        // 곧바로 직렬화하므로 복사하지 않는다 (전 채팅 분량이라 사본 하나가 그대로 최대치가 됨)
        globalSimulations[key] = { chatName: entry.chatName, simulations: sims };
        simCount += sims.length;
    }

    return {
        type: 'sim-manager-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        chatCount: Object.keys(globalSimulations).length,
        simCount,
        globalSimulations,
    };
}

/**
 * 모아보기 인덱스 정리.
 * - 빈 항목(시뮬 0개) 제거: 항상 안전
 * - 삭제된 채팅의 유령 항목 제거: 채팅 목록을 모두 성공적으로 읽었을 때만
 * 채팅 파일은 건드리지 않음 (인덱스만 수정).
 * @returns {Promise<{removedEmpty: number, removedGone: number, prunedGone: boolean}>}
 */
export async function cleanupGlobalCache() {
    const index = getGlobalIndex();
    const { keys, complete } = await collectExistingChatKeys();

    let removedEmpty = 0;
    let removedGone = 0;

    for (const key of Object.keys(index)) {
        const entry = index[key];
        if (!entry || !entry.count) {
            delete index[key];
            memCache.delete(key);
            removedEmpty++;
            continue;
        }
        if (complete && !keys.has(key)) {
            delete index[key];
            memCache.delete(key);
            removedGone++;
        }
    }

    saveSettingsDebounced();
    return { removedEmpty, removedGone, prunedGone: complete };
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
                body: JSON.stringify({ avatar_url: char.avatar, simple: true }),
            });
            if (!res.ok) { complete = false; continue; }
            const body = await res.json();
            const files = Array.isArray(body) ? body : Object.values(body || {});
            for (const f of files) {
                const fn = f?.file_name;
                if (fn) keys.add(`${char.name}_${String(fn).replace('.jsonl', '')}`);
            }
        } catch (e) {
            complete = false;
        }
    }

    for (const group of (context.groups || [])) {
        if (!group?.id) continue;
        for (const chatId of groupChatIds(group)) keys.add(groupChatKey(group.id, chatId));
    }

    return { keys, complete };
}

// ============================================
// 1.5.0 마이그레이션
// ============================================

/**
 * 구버전 globalSimulations(시뮬 본문 통째 사본)를 settings 에서 걷어낸다.
 *
 * 원본은 채팅 파일에 그대로 있지만, 예전 모아보기에서 한 편집은 캐시에만 남아 있을 수
 * 있다(그쪽 저장이 채팅 파일까지 안 갔음). 그래서 지우기 전에 서버에 파일로 한 벌
 * 떨궈 둔다 — 폰에서 다운로드 창이 뜨지 않도록 /api/files/upload 를 쓴다.
 * 백업이 실패하면 아무것도 지우지 않는다.
 *
 * @returns {Promise<{simCount: number, chatCount: number, path: string}|null>}
 *   마이그레이션할 게 없으면 null.
 */
export async function migrateLegacyGlobalStore() {
    ensureSettings();
    const s = extension_settings[EXTENSION_NAME];
    const legacy = s.globalSimulations;
    if (!legacy || typeof legacy !== 'object') return null;

    const chatCount = Object.keys(legacy).length;
    if (chatCount === 0) {
        delete s.globalSimulations;
        saveSettingsDebounced();
        return null;
    }

    // 백업이 실패하더라도 모아보기가 텅 비어 보이지 않도록 인덱스를 먼저 세운다.
    // 출처 정보가 없어서 본문 로드는 안 되므로, 다음에 모아보기를 열 때 스캔하도록 표시.
    const index = getGlobalIndex();
    let simCount = 0;
    for (const [key, data] of Object.entries(legacy)) {
        const sims = Array.isArray(data?.simulations) ? data.simulations : [];
        if (sims.length === 0) continue;
        simCount += sims.length;
        // 이미 제대로 잡힌 항목(출처 정보 있음)은 덮어쓰지 않는다.
        if (index[key]) continue;
        index[key] = { chatName: data.chatName || key, ...summarize(sims) };
    }
    s.globalIndexStale = true;

    const path = await uploadJsonToUserFiles(`sim-manager-legacy-backup_${fileStamp()}.json`, {
        type: 'sim-manager-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        note: 'Auto-saved before the 1.5.0 storage migration.',
        chatCount,
        simCount,
        globalSimulations: legacy,
    });

    if (!path) {
        // 백업 실패 — 원본 사본을 그대로 둔다. 다음 실행에서 다시 시도.
        saveSettingsDebounced();
        return null;
    }

    delete s.globalSimulations;
    saveSettingsDebounced();
    return { simCount, chatCount, path };
}

/** 사용자 파일 폴더에 JSON 저장. 실패하면 null. */
async function uploadJsonToUserFiles(name, payload) {
    try {
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name, data: toBase64(JSON.stringify(payload, null, 2)) }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        return body?.path || null;
    } catch (e) {
        console.error(DEBUG_PREFIX, 'Backup upload failed:', e);
        return null;
    }
}

/** UTF-8 문자열 → base64. 큰 파일에서 인자 개수로 스택이 터지지 않게 잘라서 처리. */
function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/** 파일명용 타임스탬프. /api/files/upload 는 영숫자 · _ · - · . 만 받는다. */
function fileStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
