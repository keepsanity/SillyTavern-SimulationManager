/**
 * 확장 설정 패널: 저장된 프롬프트 목록 렌더 + 설정 이벤트 바인딩.
 */
import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { uuidv4 } from '../../../utils.js';
import { EXTENSION_NAME } from './constants.js';
import { escapeHtml } from './utils.js';
import { ensureSettings } from './config.js';
import { S } from './state.js';
import { scanAllChatsForSimulations } from './store.js';
import { openPopup } from './popup.js';
import { renderGlobalListView } from './views/global.js';
import { renderPromptManagerView } from './views/prompts.js';

export function renderSettingsSavedPrompts() {
    ensureSettings();
    const select = document.getElementById('sim-prompt-select');
    const nameInput = document.getElementById('sim-new-prompt-name');
    const contentInput = document.getElementById('sim-new-prompt-content');
    const deleteBtn = document.getElementById('sim-delete-prompt-btn');
    if (!select) return;

    const prompts = extension_settings[EXTENSION_NAME].savedPrompts;

    let options = '<option value="">-- 새로 생성하기 --</option>';
    for (const p of prompts) {
        const selected = S.selectedPromptId === p.id ? 'selected' : '';
        options += `<option value="${p.id}" ${selected}>${escapeHtml(p.name)}</option>`;
    }
    select.innerHTML = options;

    if (S.selectedPromptId) {
        const found = prompts.find(p => p.id === S.selectedPromptId);
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

export function bindSettingsEvents() {
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
        S.selectedPromptId = null;
        renderSettingsSavedPrompts();
    });

    select?.addEventListener('change', () => {
        S.selectedPromptId = select.value || null;
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

        if (S.selectedPromptId) {
            const found = prompts.find(p => p.id === S.selectedPromptId);
            if (found) {
                found.name = name;
                found.content = content;
            }
        } else {
            const newId = `prompt_${uuidv4()}`;
            prompts.push({ id: newId, name, content });
            S.selectedPromptId = newId;
        }

        saveSettingsDebounced();
        renderSettingsSavedPrompts();
        if (typeof toastr !== 'undefined') toastr.success('저장되었습니다.', '시뮬 매니저');
    });

    deleteBtn?.addEventListener('click', () => {
        if (!S.selectedPromptId) return;
        if (!confirm('이 프롬프트를 삭제하시겠습니까?')) return;

        ensureSettings();
        const prompts = extension_settings[EXTENSION_NAME].savedPrompts;
        const idx = prompts.findIndex(p => p.id === S.selectedPromptId);
        if (idx !== -1) {
            prompts.splice(idx, 1);
            saveSettingsDebounced();
        }
        S.selectedPromptId = null;
        renderSettingsSavedPrompts();
        if (typeof toastr !== 'undefined') toastr.info('삭제되었습니다.', '시뮬 매니저');
    });

    // 프롬프트 관리 버튼
    document.getElementById('sim-open-prompt-manager-btn')?.addEventListener('click', () => {
        S.currentView = 'promptManager';
        openPopup();
        renderPromptManagerView();
    });

    // 모아보기 버튼
    document.getElementById('sim-global-viewer-btn')?.addEventListener('click', async () => {
        S.currentView = 'globalList';
        openPopup();

        ensureSettings();
        const s = extension_settings[EXTENSION_NAME];
        const hasIndex = Object.keys(s.globalIndex).length > 0;

        if (hasIndex && !s.globalIndexStale) {
            // 인덱스가 있으면 바로 표시 (본문은 방을 펼칠 때 읽는다)
            renderGlobalListView();
        } else {
            // 첫 실행이거나, 구버전에서 넘어와 인덱스에 출처 정보가 없을 때만 스캔
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
