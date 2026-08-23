/**
 * 시뮬 생성 파이프라인: 전송/재생성/이어쓰기/통제광, 프롬프트 주입과 중단 제어.
 */
import {
    extension_settings,
    getContext,
} from '../../../extensions.js';
import {
    generateQuietPrompt,
    substituteParams,
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    doNewChat,
    chat,
    saveChatConditional,
    printMessages,
    addOneMessage,
    stopGeneration,
} from '../../../../script.js';
import { uuidv4 } from '../../../utils.js';
import {
    EXTENSION_NAME,
    DEBUG_PREFIX,
    SIM_CONTINUE_INSTRUCTION,
    SIM_SYSTEM_INSTRUCTION,
    SIM_POSITIONS,
    SIM_DIRECTIVE_KEY,
    SIM_OOC_KEY,
} from './constants.js';
import {
    normalizeSimPosition,
    applySwap,
    normalizePromptText,
    getFullResponseText,
} from './utils.js';
import { ensureSettings } from './config.js';
import { withSimulationPreset } from './preset.js';
import { withPromptIntercept } from './promptPreview.js';
import { S } from './state.js';
import {
    getEffectivePromptText,
    getSimulations,
    saveSimulations,
} from './store.js';
import {
    captureCurrentLocation,
    getSelectedMultiSendTargets,
    handleMultiSendSimulation,
    sameLocation,
} from './multiSend.js';
import { showSimNotification } from './popup.js';
import { renderSettingsSavedPrompts } from './settingsPanel.js';
import { renderDetailView } from './views/detail.js';
import { renderCreateView } from './views/list.js';

/**
 * 시뮬 생성을 중단. generateQuietPrompt 는 GENERATION_STOPPED 이벤트를 듣고 abort 한다.
 */
export function stopSimGeneration() {
    S.simAborted = true;
    try { stopGeneration(); } catch (e) { console.error(DEBUG_PREFIX, 'stopGeneration failed:', e); }
}

/**
 * 전송 전 프롬프트 확인(인터셉트)을 걸고 fn 실행.
 * 설정이 꺼져 있으면 그냥 fn 을 통과시킨다. 모달에서 취소하면 S.simAborted 를 세워
 * 기존 '취소했습니다' 안내 경로를 그대로 탄다.
 */
export function withSimIntercept(meta, fn) {
    return withPromptIntercept({ ...meta, onCancel: () => { S.simAborted = true; } }, fn);
}

/**
 * 생성 시작 시 호출. activeBtnId 버튼을 '중단' 버튼으로 바꾸고, 다른 생성 버튼은 비활성화.
 */
export function enterSimGeneratingMode(activeBtnId) {
    S.simGenerating = true;
    S.simAborted = false;
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
export function exitSimGeneratingMode() {
    S.simGenerating = false;
    for (const id of ['sim-continue', 'sim-continue-dir', 'sim-regenerate']) {
        const el = document.getElementById(id);
        if (!el) continue;
        delete el.dataset.simStop;
        el.classList.remove('sim-btn-danger');
    }
}

// ============================================
// 전송 (신규 시뮬 생성)
// ============================================
export async function handleSendSimulation() {
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

    // 다중 전송 분기: 현재 방 외에 다른 방이 하나라도 포함됐을 때만 다중 흐름.
    // (드로어 미사용 = 현재 방만 선택된 상태 → 기존 단일 인터랙티브 흐름 유지)
    const multiTargets = getSelectedMultiSendTargets();
    const curLoc = captureCurrentLocation();
    const onlyCurrent = multiTargets.length === 1 && sameLocation(multiTargets[0], curLoc);
    if (multiTargets.length > 0 && !onlyCurrent) {
        ensureSettings();
        const savedPrompts = extension_settings[EXTENSION_NAME].savedPrompts;
        const matchedPrompt = savedPrompts.find(p => p.content === rawPrompt);
        await handleMultiSendSimulation(multiTargets, {
            rawPrompt,
            promptName: customTitle || (matchedPrompt ? matchedPrompt.name : ''),
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

    await sendSimulation({
        rawPrompt,
        customTitle,
        noSave,
        noSavePrompt,
        loadedPromptId,
        chosenPosition,
        chosenSwapCharUser,
        chosenSwapPronouns,
        chosenPresetName,
        chosenTogglePresetName,
    });
}

/**
 * 시뮬 생성 코어. DOM 을 읽지 않고 인자만으로 동작한다.
 * 작성 화면 전송(handleSendSimulation)과 슬래시 명령(/sim)이 공유한다.
 *
 * @param {object} opts
 * @param {string} opts.rawPrompt               시뮬 프롬프트 원문 (스왑/치환 전)
 * @param {string} [opts.customTitle='']        사용자가 지정한 제목
 * @param {boolean} [opts.noSave=false]         true 면 목록에 저장하지 않고 임시 sim 으로만
 * @param {boolean} [opts.noSavePrompt=false]   true 면 보낸 프롬프트를 저장 목록에 추가하지 않음
 * @param {string} [opts.loadedPromptId='']     불러온 저장 프롬프트 id (제목 변경 감지용)
 * @param {string} [opts.chosenPosition]        SIM_POSITIONS.* 주입 위치
 * @param {boolean} [opts.chosenSwapCharUser=false]
 * @param {boolean} [opts.chosenSwapPronouns=false]
 * @param {string} [opts.chosenPresetName='']
 * @param {string} [opts.chosenTogglePresetName='']
 * @param {boolean} [opts.ui=true]              뷰 전환·작성화면 복원 등 팝업 UI 를 건드릴지.
 *                                              슬래시 백그라운드 실행은 false.
 * @param {boolean} [opts.notify=true]          완료 토스트를 띄울지
 * @returns {Promise<{sim: object, text: string}|null>} 실패·취소 시 null
 */
export async function sendSimulation({
    rawPrompt,
    customTitle = '',
    noSave = false,
    noSavePrompt = false,
    loadedPromptId = '',
    chosenPosition = undefined,
    chosenSwapCharUser = false,
    chosenSwapPronouns = false,
    chosenPresetName = '',
    chosenTogglePresetName = '',
    ui = true,
    notify = true,
}) {
    chosenPosition = normalizeSimPosition(chosenPosition);

    // 스왑 먼저 적용한 뒤 substituteParams
    const resolvedPrompt = substituteParams(applySwap(rawPrompt, chosenSwapCharUser, chosenSwapPronouns));

    // 프롬프트 이름 결정
    ensureSettings();
    const savedPrompts = extension_settings[EXTENSION_NAME].savedPrompts;
    const matchedPrompt = savedPrompts.find(p => p.content === rawPrompt);
    const promptName = customTitle || (matchedPrompt ? matchedPrompt.name : '');

    const sims = getSimulations();
    const isTemp = noSave;
    const sim = {
        id: isTemp ? `temp_${uuidv4()}` : `sim_${uuidv4()}`,
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

    if (!isTemp) {
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
    }

    // 팝업을 쓰는 흐름에서만 상세 뷰로 전환한다. 슬래시 백그라운드 실행은 화면을 건드리지 않음.
    if (ui) {
        if (isTemp) S.tempSim = sim;   // 저장 안 하기 모드: 메모리에만 있는 임시 sim
        S.currentSimId = sim.id;
        S.currentView = 'detail';
        S.isEditingPrompt = false;
        renderDetailView();
    }

    enterSimGeneratingMode('sim-regenerate');
    try {
        console.log(DEBUG_PREFIX, 'Generating simulation response...');

        // sim 의 injectPosition 사용 + 프리셋/토글 프리셋 임시 적용
        const rawResponse = await withSimulationPreset(chosenPresetName, chosenTogglePresetName, () =>
            withSimIntercept(
                { kind: ui ? '새 시뮬 전송' : '/sim 전송', position: sim.injectPosition },
                () => runSimGeneration(SIM_SYSTEM_INSTRUCTION, resolvedPrompt, sim.injectPosition))
        );
        console.log(DEBUG_PREFIX, 'Raw response length:', rawResponse?.length);

        // 생성 중에 시뮬 배열이 갈렸을 수 있으니 저장형은 id 로 다시 잡는다
        const targetSim = isTemp ? sim : (sims.find(s => s.id === sim.id) || sim);
        targetSim.responses.push(rawResponse);
        targetSim.currentIndex = 0;
        if (!isTemp) saveSimulations();

        if (notify) showSimNotification(targetSim);
        console.log(DEBUG_PREFIX, 'Simulation response received.');
        return { sim: targetSim, text: rawResponse };
    } catch (err) {
        if (S.simAborted) {
            toastr.info('시뮬레이션 생성을 취소했습니다.', '시뮬 매니저');
        } else {
            console.error(DEBUG_PREFIX, 'Generation failed:', err);
            toastr.error('시뮬레이션 생성에 실패했습니다.', '시뮬 매니저');
        }

        if (ui) {
            // 방금 만든 시뮬이 응답 하나 없이 끝났으면 되돌리고 작성 화면으로 복귀
            if (discardEmptyNewSim()) {
                S.pendingCreateDraft = {
                    rawPrompt,
                    customTitle,
                    chosenPresetName,
                    chosenTogglePresetName,
                    chosenPosition,
                    chosenSwapCharUser,
                    chosenSwapPronouns,
                    noSavePrompt,
                    loadedPromptId,
                };
                S.currentView = 'create';
                S.isEditingPrompt = false;
            }
        } else if (!isTemp && !sim.responses.length) {
            // 백그라운드 실행은 S.currentSimId 를 안 쓰므로 직접 롤백
            const live = getSimulations();
            const idx = live.findIndex(s => s.id === sim.id);
            if (idx !== -1) {
                live.splice(idx, 1);
                saveSimulations();
            }
        }
        return null;
    } finally {
        exitSimGeneratingMode();
        if (ui) {
            if (S.currentView === 'create') {
                renderCreateView();
            } else if (S.currentView === 'detail') {
                renderDetailView();
            }
        }
    }
}

/**
 * 현재 보고 있는 시뮬이 응답 0개면 목록에서 제거한다 (전송 취소/실패 롤백용).
 * 응답이 하나라도 있으면 손대지 않는다.
 * @returns {boolean} 실제로 제거했는지
 */
export function discardEmptyNewSim() {
    if (!S.currentSimId) return false;

    // 저장 안 하기 모드: 메모리상의 임시 sim
    if (S.tempSim && S.tempSim.id === S.currentSimId) {
        if (S.tempSim.responses?.length) return false;
        S.tempSim = null;
        S.currentSimId = null;
        return true;
    }

    const liveSims = getSimulations();
    const idx = liveSims.findIndex(s => s.id === S.currentSimId);
    if (idx === -1) return false;
    if (liveSims[idx].responses?.length) return false;

    liveSims.splice(idx, 1);
    saveSimulations();
    S.currentSimId = null;
    return true;
}

export async function handleRegenerateSimulation(sim) {
    if (S.simGenerating) return;
    const resolvedPrompt = substituteParams(getEffectivePromptText(sim));

    enterSimGeneratingMode('sim-regenerate');

    const simId = sim.id;
    try {
        const rawResponse = await withSimulationPreset(sim.presetName, sim.togglePresetName, () =>
            withSimIntercept(
                { kind: '답변 재생성', position: sim.injectPosition },
                () => runSimGeneration(SIM_SYSTEM_INSTRUCTION, resolvedPrompt, sim.injectPosition))
        );
        // 생성 후에 live sim 을 다시 찾아서 push (preset 전환 중 chat_metadata 가 바뀌었을 수 있음)
        const liveSims = getSimulations();
        const targetSim = (S.tempSim && S.tempSim.id === simId) ? S.tempSim : liveSims.find(s => s.id === simId) || sim;
        if (!Array.isArray(targetSim.responses)) targetSim.responses = [];
        targetSim.responses.push(rawResponse);
        targetSim.currentIndex = targetSim.responses.length - 1;
        if (!S.tempSim || S.tempSim.id !== simId) saveSimulations();

        showSimNotification(targetSim);
    } catch (err) {
        if (S.simAborted) {
            toastr.info('답변 재생성을 취소했습니다.', '시뮬 매니저');
        } else {
            console.error(DEBUG_PREFIX, 'Regeneration failed:', err);
            toastr.error('답변 재생성에 실패했습니다.', '시뮬 매니저');
        }
    } finally {
        exitSimGeneratingMode();
        if (S.currentView === 'detail' && S.currentSimId === simId) {
            renderDetailView();
        }
    }
}

export async function handleContinueSimulation(sim, responseIdx) {
    if (S.simGenerating) return;
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
            withSimIntercept(
                { kind: '이어쓰기', position: sim.injectPosition },
                () => runSimGeneration(continueDirective, continueBody, sim.injectPosition))
        );
        // preset 전환 중 chat_metadata 가 바뀌었을 수 있으므로 live sim 재조회
        const liveSims = getSimulations();
        const target = (S.tempSim && S.tempSim.id === sim.id) ? S.tempSim : liveSims.find(s => s.id === sim.id) || sim;
        // continuations 배열에 파트 분리 저장
        if (!target.continuations) target.continuations = {};
        const key = String(responseIdx);
        if (!Array.isArray(target.continuations[key])) target.continuations[key] = [];
        target.continuations[key].push(rawResponse);

        // 번역 캐시 무효화
        if (target.translations) delete target.translations[key];

        if (!S.tempSim || S.tempSim.id !== target.id) saveSimulations();

        toastr.success('응답이 이어쓰기되었습니다.', '시뮬 매니저');
    } catch (err) {
        if (S.simAborted) {
            toastr.info('이어쓰기를 취소했습니다.', '시뮬 매니저');
        } else {
            console.error(DEBUG_PREFIX, 'Continue failed:', err);
            toastr.error('이어쓰기에 실패했습니다.', '시뮬 매니저');
        }
    } finally {
        exitSimGeneratingMode();
        if (S.currentView === 'detail' && S.currentSimId === sim.id) renderDetailView();
    }
}

export function setSimDirectiveSystem(directive) {
    setExtensionPrompt(SIM_DIRECTIVE_KEY, directive, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
}
export function clearSimDirectiveSystem() {
    setExtensionPrompt(SIM_DIRECTIVE_KEY, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
}

export function setSimOocInChat(oocContent, depth) {
    setExtensionPrompt(SIM_OOC_KEY, oocContent, extension_prompt_types.IN_CHAT, depth, false, extension_prompt_roles.USER);
}
export function clearSimOocInChat() {
    setExtensionPrompt(SIM_OOC_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.USER);
}

export function pushSimGhostMessage(content) {
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
export function popSimGhostMessage(ghost) {
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
export async function runSimGeneration(directive, ooc, position = SIM_POSITIONS.LAST_MESSAGE) {
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



export function showPartRevisionDialog(sim, responseIdx, partIdx) {
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
            S.simAborted = false;
            const rawResponse = await withSimulationPreset(sim.presetName, sim.togglePresetName, () =>
                withSimIntercept(
                    { kind: '통제광 (파트 수정)', position: SIM_POSITIONS.BOTTOM },
                    () => generateQuietPrompt({ quietPrompt: revisionPrompt, quietToLoud: true }))
            );
            // preset 전환 중 chat_metadata 가 바뀌었을 수 있어 live sim 재조회
            const liveSims = getSimulations();
            const target = (S.tempSim && S.tempSim.id === sim.id) ? S.tempSim : liveSims.find(s => s.id === sim.id) || sim;
            // 해당 파트를 교체
            if (partIdx === 0) {
                target.responses[responseIdx] = rawResponse;
            } else {
                if (target.continuations?.[key]) target.continuations[key][partIdx - 1] = rawResponse;
            }
            // 번역 캐시 무효화
            if (target.partTranslations?.[key]) delete target.partTranslations[key][String(partIdx)];

            if (!S.tempSim || S.tempSim.id !== target.id) saveSimulations();
            renderDetailView();
            toastr.success('파트가 수정되었습니다.', '통제광');
        } catch (err) {
            if (S.simAborted) {
                toastr.info('수정 요청을 취소했습니다.', '통제광');
            } else {
                console.error(DEBUG_PREFIX, 'Part revision failed:', err);
                toastr.error('수정 요청에 실패했습니다.', '통제광');
            }
        }
    });
}

export function showNewChatDialog(promptText, responseText) {
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

export async function startNewChatWithGreeting(promptText, responseText) {
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

export function showInsertToChatDialog(promptText, responseText) {
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

export async function insertSimIntoCurrentChat(promptText, responseText) {
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
