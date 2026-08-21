/**
 * 시뮬 응답 → 로어북 엔트리.
 *
 * 요약(LLM 호출) · 파싱 · 엔트리 저장 · 미리보기 팝업까지 로어북 관련은 전부 여기에 둔다.
 * LivingLorebook 은 import 하지 않는다. managed 로어북 경고를 위해 설정값만 훔쳐본다.
 */
import { generateQuietPrompt } from '../../../../script.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import {
    world_names,
    loadWorldInfo,
    createWorldInfoEntry,
    saveWorldInfo,
    reloadEditor,
} from '../../../world-info.js';
import {
    EXTENSION_NAME,
    DEBUG_PREFIX,
    LIVING_LOREBOOK_EXT,
    LORE_ACTIVATION,
    LORE_ACTIVATION_LABELS,
    LORE_POSITIONS,
    LORE_POSITION_LABELS,
    LORE_RESPONSE_PLACEHOLDER,
    LORE_SUMMARY_PROMPT,
} from './constants.js';
import { escapeHtml, getFullResponseText } from './utils.js';
import { ensureSettings, getLoreDefaults, normalizeLoreDepth } from './config.js';
import { S } from './state.js';

/** 등록된 로어북 이름 목록. */
export function getLorebookNames() {
    return Array.isArray(world_names) ? world_names.slice() : [];
}

/**
 * 이 로어북을 LivingLorebook 이 managed mode 로 쥐고 있는지.
 *
 * managed 로어북의 엔트리는 LL 이 key 를 비우고 vectorized 를 끈 채로 직접 주입한다.
 * 거기에 평범한 엔트리를 꽂으면 ST 키워드로도, LL 선택 엔진으로도 안 불려나오는
 * 유령 엔트리가 된다. 막지는 않고 팝업에서 경고만 띄운다.
 *
 * LL 의 코드가 아니라 설정 객체만 읽으므로 LL 이 없거나 폴더명이 바뀌어도 깨지지 않는다.
 */
export function isLoreManagedByLL(lorebookName) {
    const s = extension_settings[LIVING_LOREBOOK_EXT];
    if (!s || !lorebookName || !s.summarySelectionEnabled) return false;
    if (s.perLorebookMigrated && lorebookName in s.perLorebookMigrated) {
        return !!s.perLorebookMigrated[lorebookName];
    }
    if (lorebookName === s.targetLorebook) return !!s.managedModeMigrated;
    return false;
}

/** 설정의 커스텀 프롬프트(없으면 기본값)에 시뮬 응답을 꽂아 완성한다. */
export function buildLoreSummaryPrompt(responseText) {
    ensureSettings();
    const custom = String(extension_settings[EXTENSION_NAME].loreSummaryPrompt || '').trim();
    const template = custom || LORE_SUMMARY_PROMPT;

    // 자리표시자를 여기서 직접 치환한다. ST 매크로 엔진까지 흘려보내지 않기 위함.
    if (template.includes(LORE_RESPONSE_PLACEHOLDER)) {
        return template.split(LORE_RESPONSE_PLACEHOLDER).join(responseText);
    }
    // 커스텀 프롬프트에 자리표시자가 빠졌으면 끝에 붙여준다.
    return `${template}\n\n<simulation_text>\n${responseText}\n</simulation_text>`;
}

/**
 * LLM 출력 → { title, keywords, content }.
 * 라벨을 못 찾아도 던지지 않는다. 미리보기에서 사람이 고치는 게 전제라
 * 최악의 경우 본문에 전체를 넣고 넘긴다.
 */
export function parseLoreSummary(raw) {
    const text = String(raw ?? '').trim()
        .replace(/^```[\w-]*\r?\n/, '')   // 코드펜스로 감싸 오는 모델 대응
        .replace(/\r?\n```$/, '')
        .trim();

    const title = text.match(/^[ \t]*TITLE[ \t]*:[ \t]*(.*)$/im)?.[1]?.trim() ?? '';
    const keywordLine = text.match(/^[ \t]*KEYWORDS[ \t]*:[ \t]*(.*)$/im)?.[1] ?? '';
    const keywords = keywordLine.split(',').map(k => k.trim()).filter(Boolean);

    let content = text.match(/^[ \t]*CONTENT[ \t]*:[ \t]*\r?\n?([\s\S]*)$/im)?.[1]?.trim() ?? '';
    if (!content) {
        // CONTENT 라벨이 없으면 라벨 줄만 걷어내고 나머지를 본문으로.
        content = text
            .replace(/^[ \t]*TITLE[ \t]*:.*$/im, '')
            .replace(/^[ \t]*KEYWORDS[ \t]*:.*$/im, '')
            .replace(/^[ \t]*CONTENT[ \t]*:[ \t]*$/im, '')
            .trim();
    }

    return { title, keywords, content, parsed: !!(title || keywords.length) };
}

/** 시뮬 응답 하나를 요약해 엔트리 초안을 만든다. */
export async function summarizeToLoreEntry(responseText) {
    const prompt = buildLoreSummaryPrompt(responseText);
    console.log(DEBUG_PREFIX, '로어 요약 요청, 길이:', prompt.length);
    const raw = await generateQuietPrompt({ quietPrompt: prompt, quietToLoud: true });
    console.log(DEBUG_PREFIX, '로어 요약 응답 길이:', String(raw ?? '').length);
    return parseLoreSummary(raw);
}

/**
 * 엔트리를 만들어 로어북에 저장한다.
 * @returns {Promise<object>} 생성된 엔트리
 */
export async function saveLoreEntry(lorebookName, { title, keywords, content, activation, position, depth }) {
    const data = await loadWorldInfo(lorebookName);
    if (!data?.entries) throw new Error(`로어북 "${lorebookName}" 을(를) 불러오지 못했습니다.`);

    const entry = createWorldInfoEntry(lorebookName, data);
    if (!entry) throw new Error('엔트리 UID 할당에 실패했습니다.');

    entry.comment = title;
    entry.content = content;
    entry.key = Array.isArray(keywords) ? keywords : [];
    // 활성화 방식은 코어에서도 이 두 불린의 조합으로 표현된다.
    entry.constant = activation === LORE_ACTIVATION.CONSTANT;
    entry.vectorized = activation === LORE_ACTIVATION.VECTORIZED;
    entry.position = Number(position);
    if (entry.position === LORE_POSITIONS.AT_DEPTH) {
        entry.depth = normalizeLoreDepth(depth);
    }
    entry.disable = false;

    // setWIOriginalDataValue 는 카드에서 import 한 엔트리의 원본 포맷 보존용이라
    // 새로 만든 엔트리에는 no-op 이다. 부르지 않는다.

    await saveWorldInfo(lorebookName, data, true);

    // 로어북 에디터가 이 책을 열어두고 있으면 갱신 (선택 안 돼 있으면 아무 일도 안 함)
    try { reloadEditor(lorebookName); } catch (e) { console.error(DEBUG_PREFIX, 'reloadEditor failed:', e); }

    return entry;
}

// ============================================
// 미리보기 팝업
// ============================================

/** 요약이 도는 동안 두 번 열리는 걸 막는다. */
let loreBusy = false;

function optionsHtml(labelMap, selected) {
    return Object.entries(labelMap).map(([v, label]) =>
        `<option value="${escapeHtml(v)}"${String(v) === String(selected) ? ' selected' : ''}>${escapeHtml(label)}</option>`
    ).join('');
}

/**
 * 시뮬 응답 하나를 로어북 엔트리로 만드는 팝업.
 * 요약 → 사람이 확인/수정 → 저장.
 */
export function showLoreEntryDialog(responseText) {
    if (!responseText) return;

    if (loreBusy || S.simGenerating || S.multiSendRunning) {
        toastr.warning('이미 생성이 진행 중입니다.', '시뮬 매니저');
        return;
    }

    const books = getLorebookNames();
    if (!books.length) {
        toastr.warning('로어북이 하나도 없습니다. 먼저 로어북을 만들어주세요.', '시뮬 매니저');
        return;
    }

    const defaults = getLoreDefaults();
    const initialBook = books.includes(defaults.lastLorebook) ? defaults.lastLorebook : books[0];

    const overlay = document.createElement('div');
    overlay.className = 'sim-dialog-overlay';
    overlay.innerHTML = `
        <div class="sim-dialog-box sim-dialog-box-form">
            <div class="sim-dialog-title"><i class="fa-solid fa-book"></i> 로어북 엔트리로 저장</div>

            <div class="sim-lore-status" id="sim-lore-status">
                <i class="fa-solid fa-spinner fa-spin"></i> 요약하는 중...
            </div>

            <div class="sim-field">
                <label>대상 로어북</label>
                <select class="sim-saved-prompts-select" id="sim-lore-book">
                    ${books.map(n => `<option value="${escapeHtml(n)}"${n === initialBook ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('')}
                </select>
            </div>
            <div class="sim-lore-warn" id="sim-lore-warn" style="display:none;"></div>

            <div class="sim-field">
                <label>제목</label>
                <input type="text" class="text_pole" id="sim-lore-title" placeholder="엔트리 제목" />
            </div>

            <div class="sim-field">
                <label>활성화 방식</label>
                <select class="sim-saved-prompts-select" id="sim-lore-act">
                    ${optionsHtml(LORE_ACTIVATION_LABELS, defaults.activation)}
                </select>
            </div>

            <div class="sim-field">
                <label>키워드 (쉼표로 구분)</label>
                <input type="text" class="text_pole" id="sim-lore-keys" placeholder="키워드1, 키워드2" />
                <div class="sim-lore-hint" id="sim-lore-keyhint"></div>
            </div>

            <div class="sim-field">
                <label>위치</label>
                <select class="sim-saved-prompts-select" id="sim-lore-pos">
                    ${optionsHtml(LORE_POSITION_LABELS, defaults.position)}
                </select>
            </div>

            <div class="sim-field" id="sim-lore-depth-row" style="display:none;">
                <label>깊이</label>
                <input type="number" class="text_pole" id="sim-lore-depth" min="0" max="999" value="${defaults.depth}" />
            </div>

            <div class="sim-field">
                <label>본문</label>
                <textarea class="text_pole sim-lore-textarea" id="sim-lore-content" placeholder="엔트리 내용"></textarea>
            </div>

            <div class="sim-dialog-buttons">
                <button class="sim-btn sim-btn-muted" id="sim-lore-cancel">취소</button>
                <button class="sim-btn" id="sim-lore-resummarize"><i class="fa-solid fa-rotate-right"></i> 다시 요약</button>
                <button class="sim-btn sim-btn-primary" id="sim-lore-save"><i class="fa-solid fa-floppy-disk"></i> 저장</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const $ = (id) => overlay.querySelector(`#${id}`);
    const statusEl = $('sim-lore-status');
    const bookSel = $('sim-lore-book');
    const titleEl = $('sim-lore-title');
    const actSel = $('sim-lore-act');
    const keysEl = $('sim-lore-keys');
    const posSel = $('sim-lore-pos');
    const depthRow = $('sim-lore-depth-row');
    const depthEl = $('sim-lore-depth');
    const contentEl = $('sim-lore-content');
    const warnEl = $('sim-lore-warn');
    const keyHintEl = $('sim-lore-keyhint');
    const saveBtn = $('sim-lore-save');
    const resumBtn = $('sim-lore-resummarize');

    function close() {
        loreBusy = false;
        overlay.remove();
    }

    function setBusy(busy, message = '') {
        // 요약 중에 취소하고 다시 연 경우, 죽은 팝업의 늦은 응답이
        // 새 팝업의 busy 플래그를 풀어버리면 안 된다.
        if (!overlay.isConnected) return;
        loreBusy = busy;
        statusEl.style.display = busy || message ? '' : 'none';
        statusEl.innerHTML = busy
            ? `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(message || '요약하는 중...')}`
            : escapeHtml(message);
        saveBtn.disabled = busy;
        resumBtn.disabled = busy;
    }

    // 키워드는 '조건 만족시'에서만 실제로 쓰인다. 칸은 열어두고 안내만 (툴팁 대신 인라인).
    function refreshKeyHint() {
        const act = actSel.value;
        if (act === LORE_ACTIVATION.CONSTANT) {
            keyHintEl.textContent = '상시 모드에서는 키워드가 쓰이지 않습니다. (방식을 바꾸면 다시 쓰임)';
        } else if (act === LORE_ACTIVATION.VECTORIZED) {
            keyHintEl.textContent = '벡터화 모드에서는 키워드 대신 의미 검색으로 활성화됩니다.';
        } else {
            keyHintEl.textContent = '';
        }
    }

    function refreshDepthRow() {
        depthRow.style.display = Number(posSel.value) === LORE_POSITIONS.AT_DEPTH ? '' : 'none';
    }

    function refreshWarn() {
        const managed = isLoreManagedByLL(bookSel.value);
        warnEl.style.display = managed ? '' : 'none';
        warnEl.textContent = managed
            ? '이 로어북은 Living Lorebook 이 관리 중입니다. 여기서 만든 엔트리는 LL 선택 엔진에 잡히지 않아 주입되지 않을 수 있습니다.'
            : '';
    }

    async function runSummary() {
        setBusy(true);
        try {
            const draft = await summarizeToLoreEntry(responseText);
            if (!overlay.isConnected) return;   // 기다리는 동안 닫혔으면 버린다
            titleEl.value = draft.title;
            keysEl.value = draft.keywords.join(', ');
            contentEl.value = draft.content;
            setBusy(false, draft.parsed ? '' : '형식을 알아보지 못해 전체를 본문에 넣었습니다. 확인해주세요.');
        } catch (err) {
            console.error(DEBUG_PREFIX, '로어 요약 실패:', err);
            setBusy(false, '요약에 실패했습니다. 다시 시도해주세요.');
        }
    }

    actSel.addEventListener('change', refreshKeyHint);
    posSel.addEventListener('change', refreshDepthRow);
    bookSel.addEventListener('change', refreshWarn);
    $('sim-lore-cancel').addEventListener('click', close);
    resumBtn.addEventListener('click', runSummary);

    saveBtn.addEventListener('click', async () => {
        const lorebookName = bookSel.value;
        const title = titleEl.value.trim();
        const content = contentEl.value.trim();
        if (!content) { toastr.warning('본문이 비어있습니다.', '시뮬 매니저'); return; }

        setBusy(true, '저장하는 중...');
        try {
            await saveLoreEntry(lorebookName, {
                title,
                content,
                keywords: keysEl.value.split(',').map(k => k.trim()).filter(Boolean),
                activation: actSel.value,
                position: Number(posSel.value),
                depth: depthEl.value,
            });

            ensureSettings();
            extension_settings[EXTENSION_NAME].loreLastLorebook = lorebookName;
            saveSettingsDebounced();

            close();
            toastr.success(`"${lorebookName}" 에 엔트리를 추가했습니다.`, '시뮬 매니저');
        } catch (err) {
            console.error(DEBUG_PREFIX, '로어 엔트리 저장 실패:', err);
            setBusy(false, err?.message || '저장에 실패했습니다.');
        }
    });

    // 바깥 클릭으로 닫기 — 요약/저장 중에는 막는다 (입력 날아가는 사고 방지)
    overlay.addEventListener('click', (e) => { if (e.target === overlay && !loreBusy) close(); });

    refreshKeyHint();
    refreshDepthRow();
    refreshWarn();
    runSummary();
}

/** 시뮬의 현재 응답을 로어북 엔트리로. 상세 뷰 버튼의 진입점. */
export function openLoreEntryDialogForSim(sim) {
    const text = getFullResponseText(sim, sim.currentIndex || 0);
    if (!text) {
        toastr.warning('저장할 응답이 없습니다.', '시뮬 매니저');
        return;
    }
    showLoreEntryDialog(text);
}
