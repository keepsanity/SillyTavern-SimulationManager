/**
 * 다중 전송: 여러 채팅방을 순회하며 같은 시뮬을 생성한다.
 */
import {
    extension_settings,
    getContext,
} from '../../../extensions.js';
import {
    eventSource,
    event_types,
    substituteParams,
    saveSettingsDebounced,
} from '../../../../script.js';
import { uuidv4 } from '../../../utils.js';
import {
    EXTENSION_NAME,
    DEBUG_PREFIX,
    SIM_SYSTEM_INSTRUCTION,
} from './constants.js';
import {
    sleep,
    applySwap,
    escapeHtml,
} from './utils.js';
import { ensureSettings } from './config.js';
import { S } from './state.js';
import {
    getSimulations,
    saveSimulationsVerified,
} from './store.js';
import {
    runSimGeneration,
    stopSimGeneration,
    withGenerationPreset,
    withSimIntercept,
} from './generation.js';
import {
    closePopup,
    openPopupToSim,
} from './popup.js';
import { renderSettingsSavedPrompts } from './settingsPanel.js';


/** 현재 위치(캐릭터/그룹) 키. 대상 목록에서 '현재' 표시용. */
export function currentLocationKey() {
    try {
        const ctx = getContext();
        if (ctx.groupId) return `group:${ctx.groupId}`;
        if (ctx.characterId !== undefined && ctx.characterId !== null) return `char:${ctx.characterId}`;
    } catch { /* ignore */ }
    return null;
}

/** 복귀용으로 현재 위치를 target 형태로 캡처. */
export function captureCurrentLocation() {
    try {
        const ctx = getContext();
        if (ctx.groupId) {
            const g = (ctx.groups || []).find(x => String(x.id) === String(ctx.groupId));
            return { type: 'group', id: ctx.groupId, name: g?.name || '그룹', avatar: '', chatId: ctx.chatId };
        }
        const idx = ctx.characterId;
        if (idx !== undefined && idx !== null) {
            const c = (ctx.characters || [])[idx];
            return { type: 'char', id: idx, name: c?.name || '캐릭터', avatar: c?.avatar || '', chatId: ctx.chatId };
        }
    } catch { /* ignore */ }
    return null;
}

/** 전송 대상 후보 목록 (캐릭터 + 그룹). 현재 방은 isCurrent 표시. */
export function getMultiSendTargets() {
    const targets = [];
    try {
        const ctx = getContext();
        (ctx.characters || []).forEach((char, index) => {
            if (char && char.name) {
                targets.push({ type: 'char', id: index, name: char.name, avatar: char.avatar || '', chatId: char.chat, isCurrent: false });
            }
        });
        (ctx.groups || []).forEach((g) => {
            if (g && g.name) {
                targets.push({ type: 'group', id: g.id, name: g.name, avatar: '', chatId: g.chat_id, isCurrent: false });
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
export function isOnTarget(target) {
    try {
        const ctx = getContext();
        if (target.chatId && String(ctx.chatId) !== String(target.chatId)) return false;
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
export function waitForChatChanged(timeout = 20000) {
    return new Promise((resolve) => {
        let done = false;
        let timer;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            eventSource.removeListener(event_types.CHAT_CHANGED, handler);
            resolve(ok);
        };
        const handler = () => finish(true);
        eventSource.on(event_types.CHAT_CHANGED, handler);
        timer = setTimeout(() => finish(false), timeout);
    });
}

/** 지정 채팅방으로 전환하고 로드 완료까지 대기. */
export async function switchToTargetChat(target) {
    const ctx = getContext();
    const loaded = waitForChatChanged(20000);
    if (target.type === 'group') {
        const g = (ctx.groups || []).find(x => String(x.id) === String(target.id));
        if (!g) throw new Error(`그룹을 찾을 수 없습니다: ${target.name}`);
        await ctx.openGroupChat(g.id, target.chatId || g.chat_id);
    } else {
        // 캐릭터 인덱스는 avatar 로 재확인 (목록 순서 변동 대비)
        let idx = target.id;
        if (target.avatar) {
            const found = (ctx.characters || []).findIndex(c => c.avatar === target.avatar);
            if (found >= 0) idx = found;
        }
        if (idx === undefined || idx === null || idx < 0) throw new Error(`캐릭터를 찾을 수 없습니다: ${target.name}`);
        await ctx.selectCharacterById(idx);
        if (target.chatId && String(getContext().chatId) !== String(target.chatId)) {
            await getContext().openCharacterChat(target.chatId);
        }
    }
    const didLoad = await loaded;
    if (!didLoad || !isOnTarget(target)) throw new Error('채팅방을 정확히 불러오지 못했습니다.');
    await sleep(500); // 메타데이터/연결 settle
}

/** 생성 화면의 대상 체크박스 UI 구성. */
export function setupMultiSendDrawer() {
    const listEl = document.getElementById('sim-multisend-list');
    if (!listEl) return;

    S.multiSendTargetsCache = getMultiSendTargets();
    S.multiSendSelKeys = new Set();

    const keyOf = (t) => `${t.type}:${t.id}`;

    // 현재 방은 기본 선택 (다른 방을 추가로 고르면 현재 방도 함께 전송됨).
    // 현재 방만 선택된 상태면 분기에서 단일 흐름으로 처리되므로 기본 동작은 그대로.
    const curTarget = S.multiSendTargetsCache.find(t => t.isCurrent);
    if (curTarget) S.multiSendSelKeys.add(keyOf(curTarget));

    const renderList = (query = '') => {
        const q = query.trim().toLowerCase();
        const items = S.multiSendTargetsCache.filter(t => !q || t.name.toLowerCase().includes(q));
        if (items.length === 0) {
            listEl.innerHTML = '<div class="sim-empty" style="padding:10px;">검색 결과가 없습니다.</div>';
            return;
        }
        listEl.innerHTML = items.map(t => {
            const k = keyOf(t);
            const checked = S.multiSendSelKeys.has(k) ? ' checked' : '';
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
            if (on) S.multiSendSelKeys.add(cb.dataset.key);
            else S.multiSendSelKeys.delete(cb.dataset.key);
        });
    });

    listEl.addEventListener('change', (e) => {
        const cb = e.target.closest('.sim-multisend-cb');
        if (!cb) return;
        if (cb.checked) S.multiSendSelKeys.add(cb.dataset.key);
        else S.multiSendSelKeys.delete(cb.dataset.key);
    });
}

/** 두 위치(target 형태)가 같은 채팅방인지. */
export function sameLocation(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.chatId && b.chatId && String(a.chatId) !== String(b.chatId)) return false;
    if (a.type === 'group') return String(a.id) === String(b.id);
    if (a.avatar && b.avatar) return a.avatar === b.avatar;
    return String(a.id) === String(b.id);
}

/** 현재 선택된 대상 목록 반환 (검색 필터로 가려진 선택도 유지). */
export function getSelectedMultiSendTargets() {
    if (!S.multiSendSelKeys || S.multiSendSelKeys.size === 0) return [];
    return S.multiSendTargetsCache.filter(t => S.multiSendSelKeys.has(`${t.type}:${t.id}`));
}

/** 프롬프트 자동 저장(단일 흐름과 동일 규칙) — 다중 전송 시 1회만. */
export function maybeAutoSavePrompt(opts) {
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
export function showMultiSendPanel(total) {
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
        S.multiSendShouldStop = true;
        try { stopSimGeneration(); } catch (e) { /* ignore */ }
        const s = document.getElementById('sim-ms-status');
        if (s) s.textContent = '중지 중... (현재 방 마무리)';
    });
}

export function updateMultiSendPanel(idx, total, name, status) {
    const c = document.getElementById('sim-ms-count');
    if (c) c.textContent = `${Math.min(idx + 1, total)}/${total}`;
    const s = document.getElementById('sim-ms-status');
    if (s) s.textContent = `${name}: ${status}`;
    const f = document.getElementById('sim-ms-bar-fill');
    if (f) f.style.width = `${total ? (idx / total * 100) : 0}%`;
}

export function hideMultiSendPanel() {
    document.getElementById('sim-multisend-panel')?.remove();
}

/**
 * 선택한 여러 채팅방에 같은 시뮬을 순차 생성.
 * 각 방을 열어 → 시뮬 생성 → 그 방 메타데이터에 저장(즉시 flush) → 다음 방.
 */
export async function handleMultiSendSimulation(targets, opts) {
    if (S.multiSendRunning || S.simGenerating) {
        if (typeof toastr !== 'undefined') toastr.warning('이미 생성이 진행 중입니다.', '시뮬 매니저');
        return;
    }

    maybeAutoSavePrompt(opts);

    S.multiSendRunning = true;
    S.multiSendShouldStop = false;
    S.simGenerating = true; // 다른 시뮬 동작 차단
    S.simAborted = false;

    const origin = captureCurrentLocation();
    closePopup();
    showMultiSendPanel(targets.length);

    let success = 0;
    let fail = 0;
    let originSimId = null; // 현재 방이 대상에 포함됐으면, 그 방에서 만든 시뮬 id
    let unsavedSimId = null;
    let stopped = false;

    for (let i = 0; i < targets.length; i++) {
        if (S.multiSendShouldStop) break;
        const target = targets[i];

        try {
            updateMultiSendPanel(i, targets.length, target.name, '채팅방 여는 중...');
            if (!isOnTarget(target)) {
                await switchToTargetChat(target);
            }
            if (!isOnTarget(target)) {
                throw new Error('채팅방 전환 확인 실패');
            }

            if (S.multiSendShouldStop) break;
            updateMultiSendPanel(i, targets.length, target.name, '시뮬 생성 중...');

            // {{char}}/{{user}} 가 이 방 기준으로 치환되도록 전환 후 재계산
            // 입력한 단어는 그 방 사람 이름이라 현재 방에만 적용
            const isOrigin = !!origin && sameLocation(target, origin);
            const aliases = isOrigin ? { char: opts.chosenCharAlias || '', user: opts.chosenUserAlias || '' } : null;
            const resolved = substituteParams(applySwap(opts.rawPrompt, opts.chosenSwapCharUser, opts.chosenSwapPronouns, aliases));

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
                ...(aliases?.char ? { charAlias: aliases.char } : {}),
                ...(aliases?.user ? { userAlias: aliases.user } : {}),
            };

            S.simAborted = false;
            const rawResponse = await withGenerationPreset(opts.chosenPresetName, opts.chosenTogglePresetName, () =>
                withSimIntercept({ kind: `다중 전송: ${target.name}`, position: sim.injectPosition }, () =>
                    runSimGeneration(SIM_SYSTEM_INSTRUCTION, resolved, sim.injectPosition))
            );

            if (S.simAborted || (S.multiSendShouldStop && !rawResponse)) {
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
            try {
                await saveSimulationsVerified();
            } catch (e) {
                unsavedSimId = sim.id;
                throw e;
            }

            // 현재(원래) 방이 대상이면, 끝나고 디테일 뷰로 열어줄 시뮬 id 기억
            if (origin && sameLocation(target, origin)) {
                originSimId = sim.id;
            }

            success++;
            updateMultiSendPanel(i, targets.length, target.name, '완료 ✓');
        } catch (err) {
            if (S.simAborted) { stopped = true; break; }
            console.error(DEBUG_PREFIX, 'multi-send failed for', target.name, err);
            fail++;
            updateMultiSendPanel(i, targets.length, target.name, '실패: ' + (err?.message || ''));
            if (unsavedSimId) break; // Keep unsaved output in the current chat for retry.
            await sleep(600);
        }

        if (i < targets.length - 1 && !S.multiSendShouldStop) await sleep(800);
    }

    // 원래 방으로 복귀
    try {
        if (!unsavedSimId && origin && !isOnTarget(origin)) {
            updateMultiSendPanel(targets.length, targets.length, origin.name, '원래 방으로 복귀 중...');
            await switchToTargetChat(origin);
        }
    } catch (e) {
        console.error(DEBUG_PREFIX, 'restore origin failed:', e);
    }

    stopped ||= S.multiSendShouldStop;
    S.simGenerating = false;
    S.multiSendRunning = false;
    S.multiSendShouldStop = false;
    S.simAborted = false;
    hideMultiSendPanel();
    if (unsavedSimId) openPopupToSim(unsavedSimId);

    // 현재 방이 대상에 포함됐고 복귀에 성공했으면, 그 방 시뮬을 디테일 뷰로 자동 오픈
    if (!unsavedSimId && originSimId && origin && isOnTarget(origin)) {
        try {
            openPopupToSim(originSimId);
        } catch (e) {
            console.error(DEBUG_PREFIX, 'open detail after multi-send failed:', e);
        }
    }

    if (typeof toastr !== 'undefined') {
        if (unsavedSimId) {
            toastr.error('저장을 확인하지 못해 다중 전송을 중단했습니다. 현재 결과에서 저장을 재시도해주세요.', '시뮬 매니저');
        } else if (stopped) {
            toastr.info(`다중 전송 중단. 완료 ${success} / 실패 ${fail} / 전체 ${targets.length}`, '시뮬 매니저');
        } else if (success > 0 && fail === 0 && success === targets.length) {
            toastr.success(`다중 전송 완료! ${success}개 방 모두 성공`, '시뮬 매니저');
        } else if (success > 0) {
            toastr.warning(`다중 전송 완료. 성공 ${success} / 실패 ${fail}`, '시뮬 매니저');
        } else {
            toastr.error(`다중 전송 실패. 성공 0 / 실패 ${fail}`, '시뮬 매니저');
        }
    }
}
