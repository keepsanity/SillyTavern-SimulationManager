/**
 * SillyTavern - Simulation Manager
 * 프리셋 / 토글 프리셋 헬퍼 (Custom Preset 확장 연동)
 */

import { eventSource, event_types } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { getPresetManager } from '../../../preset-manager.js';
import { oai_settings, promptManager } from '../../../openai.js';
import { DEBUG_PREFIX, CUSTOM_PRESET_EXT } from './constants.js';

function getOpenAiPresetManager() {
    return getPresetManager('openai');
}

/** 연속 공백을 한 칸으로 접고 양끝을 자른다. */
function collapseWs(s) {
    return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** 프리셋 셀렉트의 DOM 엘리먼트. PresetManager.select 는 jQuery 객체다. */
function getPresetSelectEl(pm) {
    const s = pm?.select;
    if (!s) return null;
    if (typeof s === 'string') return document.querySelector(s);
    if (typeof HTMLSelectElement !== 'undefined' && s instanceof HTMLSelectElement) return s;
    return s[0] ?? null;
}

/**
 * 프리셋 이름 두 개가 같은 프리셋을 가리키는지.
 * ST 코어가 이름을 얻는 경로마다 공백 처리가 달라서(findPresetValue 주석 참고)
 * 연속 공백은 무시하고 비교한다.
 */
export function isSamePresetName(a, b) {
    if (a === b) return true;
    const ca = collapseWs(a);
    return !!ca && ca === collapseWs(b);
}

/**
 * 실제 존재하는 프리셋 이름으로 정규화. 못 찾으면 null.
 * 목록을 못 가져오는 상황(비 chat-completion API 등)에서도 null.
 */
export function resolvePresetName(name) {
    const q = String(name ?? '').trim();
    if (!q) return null;
    const names = getAvailablePresetNames();
    if (!names.length) return null;
    if (names.includes(q)) return q;
    const target = collapseWs(q).toLowerCase();
    return names.find(n => collapseWs(n).toLowerCase() === target) ?? null;
}

/**
 * 프리셋 이름 -> <option> value.
 *
 * ST 코어가 같은 <option> 에서 이름을 서로 다른 방식으로 읽는다:
 *   getAllPresets()  ->  el.text       (HTMLOptionElement.text 게터: 연속 공백을 한 칸으로 접음)
 *   findPreset(name) ->  $(el).text()  (textContent: 원본 그대로)
 * 그래서 이름에 공백이 두 칸 이상 들어간 프리셋은
 * "목록에서 고른 이름"으로 findPreset 을 하면 영영 못 찾는다.
 * (예: "... Gemini Pro  1.9" 는 목록에 "... Gemini Pro 1.9" 로 나옴)
 * 코어를 건드리지 않고 여기서 공백을 접어 한 번 더 대조한다.
 */
function findPresetValue(pm, name) {
    const direct = pm.findPreset(name);
    if (direct !== undefined && direct !== null) return direct;

    const el = getPresetSelectEl(pm);
    if (!el?.options) return undefined;
    const target = collapseWs(name);
    if (!target) return undefined;
    for (const opt of el.options) {
        if (collapseWs(opt.textContent) === target) return opt.value;
    }
    return undefined;
}

export function getAvailablePresetNames() {
    const pm = getOpenAiPresetManager();
    if (!pm) return [];
    try { return pm.getAllPresets(); } catch { return []; }
}

export function getCurrentPresetName() {
    return oai_settings?.preset_settings_openai || '';
}

export function isCustomPresetTogglesEnabled() {
    const s = extension_settings[CUSTOM_PRESET_EXT];
    return !!(s && s.showTogglePresetFeature);
}

function getTogglePresetMap(presetName) {
    const s = extension_settings[CUSTOM_PRESET_EXT];
    if (!s || !s.togglePresets || !presetName) return null;
    const map = s.togglePresets[presetName];
    return (map && typeof map === 'object') ? map : null;
}

export function getTogglePresetNames(presetName) {
    const map = getTogglePresetMap(presetName);
    if (!map) return [];
    const names = Object.keys(map);
    // 'default' 가 있으면 첫 번째로
    return ['default', ...names.filter(n => n !== 'default').sort()].filter(n => map[n]);
}

export function getCurrentActiveTogglePresetName(presetName) {
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
    const value = findPresetValue(pm, presetName);
    if (value === undefined || value === null) return false;
    if (isSamePresetName(pm.getSelectedPresetName(), presetName)) return true;
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
export async function withSimulationPreset(presetName, togglePresetName, fn) {
    const pm = getOpenAiPresetManager();
    const prevPresetName = pm ? pm.getSelectedPresetName() : '';
    const prevToggleSnap = captureToggleSnapshot();
    const needPresetSwitch = !!presetName && pm && !isSamePresetName(presetName, prevPresetName);
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
