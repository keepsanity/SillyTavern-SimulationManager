/**
 * 저장된 프롬프트 관리 뷰 (목록/편집).
 */
import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { uuidv4 } from '../../../../utils.js';
import { EXTENSION_NAME } from '../constants.js';
import { escapeHtml } from '../utils.js';
import { ensureSettings } from '../config.js';
import {
    goToList,
    maybeResetContentScroll,
} from '../popup.js';

export function renderPromptManagerView() {
    const container = document.getElementById('sim-content');
    if (!container) return;
    maybeResetContentScroll('promptManager');

    ensureSettings();
    const prompts = extension_settings[EXTENSION_NAME].savedPrompts;

    let html = `<div class="sim-list-view">
        <input type="text" class="sim-prompt-search" id="sim-pm-search" placeholder="프롬프트 검색..." style="margin-bottom:8px;" />`;

    if (prompts.length === 0) {
        html += `<div class="sim-empty"><i class="fa-solid fa-bookmark" style="font-size:28px; margin-bottom:10px; opacity:0.3;"></i><br>저장된 프롬프트가 없습니다.</div>`;
    } else {
        for (const p of [...prompts].reverse()) {
            const preview = p.content.length > 60 ? p.content.substring(0, 60) + '…' : p.content;
            html += `
            <div class="sim-item sim-pm-item" data-prompt-id="${escapeHtml(p.id)}">
                <div class="sim-item-prompt">${escapeHtml(p.name)}</div>
                <div class="sim-item-meta"><span>${escapeHtml(preview)}</span></div>
            </div>`;
        }
    }
    html += `</div>`;
    container.innerHTML = html;

    const footer = document.getElementById('sim-footer');
    if (footer) {
        footer.classList.remove('hidden');
        footer.innerHTML = `
        <div class="sim-create-actions">
            <button class="sim-btn" id="sim-pm-back"><i class="fa-solid fa-arrow-left"></i> 뒤로</button>
            <button class="sim-btn sim-btn-primary" id="sim-pm-new"><i class="fa-solid fa-plus"></i> 새 프롬프트</button>
        </div>`;
    }

    document.getElementById('sim-pm-back')?.addEventListener('click', goToList);
    document.getElementById('sim-pm-new')?.addEventListener('click', () => renderPromptEditView(null));

    document.getElementById('sim-pm-search')?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        container.querySelectorAll('.sim-pm-item').forEach(el => {
            const id = el.dataset.promptId;
            const p = prompts.find(x => x.id === id);
            const match = !query || p?.name.toLowerCase().includes(query) || p?.content.toLowerCase().includes(query);
            el.style.display = match ? '' : 'none';
        });
    });

    container.querySelectorAll('.sim-pm-item').forEach(el => {
        el.addEventListener('click', () => renderPromptEditView(el.dataset.promptId));
    });
}

export function renderPromptEditView(promptId) {
    const container = document.getElementById('sim-content');
    if (!container) return;
    maybeResetContentScroll('promptEdit');

    ensureSettings();
    const prompts = extension_settings[EXTENSION_NAME].savedPrompts;
    const prompt = promptId ? prompts.find(p => p.id === promptId) : null;

    container.innerHTML = `
    <div class="sim-create-view sim-create-view-v2 sim-prompt-edit-view">
        <div class="sim-create-toolbar">
            <button class="sim-btn" id="sim-pe-back"><i class="fa-solid fa-arrow-left"></i> 목록으로</button>
        </div>
        <div class="sim-card sim-card-main">
            <h4 class="sim-card-title"><i class="fa-solid fa-bookmark"></i> ${prompt ? '프롬프트 수정' : '새 프롬프트'}</h4>
            <div class="sim-field">
                <label>이름</label>
                <input type="text" class="sim-prompt-search" id="sim-pe-name"
                    placeholder="프롬프트 이름" value="${prompt ? escapeHtml(prompt.name) : ''}" />
            </div>
            <div class="sim-field">
                <label>내용</label>
                <textarea class="sim-prompt-textarea sim-prompt-textarea-lg" id="sim-pe-content"
                    placeholder="프롬프트 내용">${prompt ? escapeHtml(prompt.content) : ''}</textarea>
            </div>
        </div>
    </div>`;

    const footer = document.getElementById('sim-footer');
    if (footer) {
        footer.classList.remove('hidden');
        footer.innerHTML = `
        <div class="sim-create-actions">
            ${prompt ? `<button class="sim-btn sim-btn-danger" id="sim-pe-delete"><i class="fa-solid fa-trash"></i> 삭제</button>` : ''}
            <button class="sim-btn sim-btn-primary" id="sim-pe-save"><i class="fa-solid fa-floppy-disk"></i> 저장</button>
        </div>`;
    }

    document.getElementById('sim-pe-back')?.addEventListener('click', renderPromptManagerView);

    document.getElementById('sim-pe-save')?.addEventListener('click', () => {
        const name = document.getElementById('sim-pe-name')?.value.trim();
        const content = document.getElementById('sim-pe-content')?.value.trim();
        if (!name || !content) { alert('이름과 내용을 모두 입력해주세요.'); return; }

        ensureSettings();
        const prompts = extension_settings[EXTENSION_NAME].savedPrompts;
        if (promptId) {
            const found = prompts.find(p => p.id === promptId);
            if (found) { found.name = name; found.content = content; }
        } else {
            prompts.push({ id: `prompt_${uuidv4()}`, name, content });
        }
        saveSettingsDebounced();
        toastr.success('저장되었습니다.', '시뮬 매니저');
        renderPromptManagerView();
    });

    document.getElementById('sim-pe-delete')?.addEventListener('click', () => {
        if (!promptId || !confirm('이 프롬프트를 삭제하시겠습니까?')) return;
        ensureSettings();
        const prompts = extension_settings[EXTENSION_NAME].savedPrompts;
        const idx = prompts.findIndex(p => p.id === promptId);
        if (idx !== -1) prompts.splice(idx, 1);
        saveSettingsDebounced();
        toastr.info('삭제되었습니다.', '시뮬 매니저');
        renderPromptManagerView();
    });
}
