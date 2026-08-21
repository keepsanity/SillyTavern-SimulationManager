/**
 * SillyTavern - Simulation Manager
 * 확장 설정(기본값/검증) 및 표시(브랜딩) 헬퍼
 */

import { extension_settings } from '../../../extensions.js';
import {
    EXTENSION_NAME,
    SIM_ICON_PRESETS,
    LORE_ACTIVATION,
    LORE_ACTIVATION_LABELS,
    LORE_POSITION_LABELS,
    LORE_DEFAULT_DEPTH,
} from './constants.js';
import { normalizeSimPosition } from './utils.js';

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
    // 전송 전 프롬프트 확인(인터셉트) — 켜면 생성 직전 최종 프롬프트를 보여주고 전송/취소를 묻는다
    promptIntercept: false,
    // 로어북 엔트리 생성 — 팝업이 미리 채워질 기본값들
    loreSummaryPrompt: '',              // 비우면 LORE_SUMMARY_PROMPT 사용
    loreProfileId: '',                  // 비우면 현재 API/프리셋으로 요약
    loreDefaultActivation: LORE_ACTIVATION.NORMAL,
    loreDefaultPosition: 0,             // LORE_POSITIONS.BEFORE_CHAR
    loreDefaultDepth: LORE_DEFAULT_DEPTH,
    loreLastLorebook: '',               // 마지막으로 저장한 로어북 이름
};

export const PROMPT_SORT_ORDERS = ['newest', 'oldest', 'name'];

export function ensureSettings() {
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
    if (typeof s.promptIntercept !== 'boolean') s.promptIntercept = false;
    if (typeof s.loreSummaryPrompt !== 'string') s.loreSummaryPrompt = '';
    if (typeof s.loreProfileId !== 'string') s.loreProfileId = '';
    if (!Object.hasOwn(LORE_ACTIVATION_LABELS, s.loreDefaultActivation)) s.loreDefaultActivation = LORE_ACTIVATION.NORMAL;
    if (!Object.hasOwn(LORE_POSITION_LABELS, s.loreDefaultPosition)) s.loreDefaultPosition = 0;
    s.loreDefaultDepth = normalizeLoreDepth(s.loreDefaultDepth);
    if (typeof s.loreLastLorebook !== 'string') s.loreLastLorebook = '';
}

/** 깊이는 0 이상의 정수만. 이상한 값은 코어 기본값으로. */
export function normalizeLoreDepth(v) {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : LORE_DEFAULT_DEPTH;
}

/** 로어북 팝업이 미리 채워둘 기본값 묶음. */
export function getLoreDefaults() {
    ensureSettings();
    const s = extension_settings[EXTENSION_NAME];
    return {
        activation: s.loreDefaultActivation,
        position: Number(s.loreDefaultPosition),
        depth: normalizeLoreDepth(s.loreDefaultDepth),
        lastLorebook: s.loreLastLorebook,
    };
}

export function getDisplayName() {
    ensureSettings();
    return extension_settings[EXTENSION_NAME].displayName;
}

export function getDisplayIcon() {
    ensureSettings();
    const icon = extension_settings[EXTENSION_NAME].displayIcon;
    // 프리셋에 없는 값이면 기본값으로 폴백 (잘못된 클래스 주입 방지)
    return SIM_ICON_PRESETS.includes(icon) ? icon : 'fa-flask';
}

export function getDefaultInjectPosition() {
    ensureSettings();
    return normalizeSimPosition(extension_settings[EXTENSION_NAME].defaultInjectPosition);
}
