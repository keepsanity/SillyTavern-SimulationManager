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
export async function withSimulationPreset(presetName, togglePresetName, fn) {
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
