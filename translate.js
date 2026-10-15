/**
 * 파트 단위 번역. 번역문은 sim.partTranslations 에 저장한다.
 */
import {
    extension_settings,
    getContext,
} from '../../../extensions.js';
import {
    EXTENSION_NAME,
    DEBUG_PREFIX,
} from './constants.js';
import { ensureSettings } from './config.js';
import { S } from './state.js';
import { getCurrentChatKey, getSimulations, saveSimulationsVerified } from './store.js';

export function buildTranslationPrompt(text) {
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
export async function translatePart(sim, responseIdx, partIdx, renderFn) {
    if (S.isTranslating || S.simGenerating) return;
    const sourceChatKey = getCurrentChatKey();

    if (!sim.partTranslations) sim.partTranslations = {};
    const rKey = String(responseIdx);
    if (!sim.partTranslations[rKey]) sim.partTranslations[rKey] = {};
    const pKey = String(partIdx);

    // 이미 번역 있으면 토글
    if (sim.partTranslations[rKey][pKey]) {
        S.showTranslated = !S.showTranslated;
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

    S.isTranslating = true;
    S.translatingPartIdx = partIdx;
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

        if (typeof translated !== 'string' || !translated.trim()) throw new Error('번역 결과가 비어있습니다.');
        if (sourceChatKey !== getCurrentChatKey()) throw new Error('채팅방이 변경되어 번역 저장을 취소했습니다.');
        const target = S.tempSim?.id === sim.id ? S.tempSim : getSimulations().find(item => item.id === sim.id);
        const liveText = partIdx === 0 ? target?.responses[responseIdx] : target?.continuations?.[rKey]?.[partIdx - 1];
        if (!target || liveText !== partText) throw new Error('원문이 변경되어 번역 저장을 취소했습니다.');

        target.partTranslations ||= {};
        target.partTranslations[rKey] ||= {};
        target.partTranslations[rKey][pKey] = translated;
        S.showTranslated = true;

        if (S.tempSim?.id !== target.id) await saveSimulationsVerified();

        toastr.success('파트 번역 완료!', '시뮬 매니저');
    } catch (err) {
        console.error(DEBUG_PREFIX, 'Part translation failed:', err);
        toastr.error(`번역 실패: ${err.message}`, '시뮬 매니저');
    } finally {
        S.isTranslating = false;
        S.translatingPartIdx = null;
        if (sourceChatKey === getCurrentChatKey() && S.currentView === 'detail' && S.currentSimId === sim.id) renderFn();
    }
}
