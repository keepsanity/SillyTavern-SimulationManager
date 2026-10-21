import { extension_settings } from '../../../extensions.js';
import { getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { EXTENSION_NAME } from './constants.js';
import { createJsonDataStore, jsonFileTransport } from './json-data-store.js';

let store;
export function reportPromptStorageError(error) {
    console.error('[SimulationManager] Saved prompt storage:', error);
    toastr.error('저장 프롬프트 파일을 읽거나 저장하지 못했습니다. 연결 및 파일 상태를 확인해 주세요.', '시뮬 매니저');
}
export async function initPromptStorage() {
    store = createJsonDataStore({
        settings: extension_settings[EXTENSION_NAME], key: 'savedPrompts', empty: [],
        validate: value => Array.isArray(value) && value.every(p => p && typeof p.id === 'string'
            && typeof p.name === 'string' && typeof p.content === 'string'),
        merge: (file, legacy) => {
            const ids = new Set(legacy.map(p => p.id));
            return [...legacy, ...file.filter(p => !ids.has(p.id))];
        },
        saveSettings: saveSettingsDebounced,
        ...jsonFileTransport('SillyTavern-SimulationManager-saved-prompts.json', getRequestHeaders),
    });
    await store.init();
}
export function getSavedPrompts() { return store.get(); }
export async function updateSavedPrompts(edit) {
    try {
        await store.update(edit);
        return true;
    } catch (error) {
        reportPromptStorageError(error);
        return false;
    }
}

let actionPending = false;
export function promptStorageAction(action) {
    return async event => {
        if (actionPending) return;
        actionPending = true;
        const button = event.currentTarget;
        button.disabled = true;
        try {
            await action(event);
        } catch (error) {
            reportPromptStorageError(error);
        } finally {
            actionPending = false;
            button.disabled = false;
        }
    };
}
