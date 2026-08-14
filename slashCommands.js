/**
 * 슬래시 명령 `/sim` — Quick Reply 버튼 하나로 시뮬을 생성하기 위한 진입점.
 *
 * 기본 동작은 '조용히 생성': 팝업을 열지 않고 백그라운드로 돌린 뒤 완료 토스트만 띄운다.
 * 토스트를 클릭하면 해당 시뮬 상세로 진입한다. open=true 면 생성 직후 팝업을 연다.
 */
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import {
    ARGUMENT_TYPE,
    SlashCommandArgument,
    SlashCommandNamedArgument,
} from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue, enumTypes } from '../../../slash-commands/SlashCommandEnumValue.js';
import { commonEnumProviders, enumIcons } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { slashCommandReturnHelper } from '../../../slash-commands/SlashCommandReturnHelper.js';
import { extension_settings } from '../../../extensions.js';
import { isTrueBoolean } from '../../../utils.js';
import {
    EXTENSION_NAME,
    DEBUG_PREFIX,
    SIM_POSITION_LABELS,
} from './constants.js';
import { normalizePromptText } from './utils.js';
import { ensureSettings, getDefaultInjectPosition } from './config.js';
import { getAvailablePresetNames } from './preset.js';
import { S } from './state.js';
import { sendSimulation } from './generation.js';
import { openPopupToSim } from './popup.js';

/** 저장된 프롬프트 자동완성. 입력 중에 목록이 떠서 골라 넣을 수 있다. */
function savedPromptEnumProvider() {
    ensureSettings();
    const prompts = extension_settings[EXTENSION_NAME].savedPrompts || [];
    // 최신순이 위로 오게 (배열 순서 = 저장순)
    return prompts.slice().reverse().map(p => new SlashCommandEnumValue(
        p.name,
        p.content.length > 60 ? p.content.slice(0, 60) + '…' : p.content,
        enumTypes.enum,
        enumIcons.message,
    ));
}

/** 프리셋 이름 자동완성. */
function presetEnumProvider() {
    return getAvailablePresetNames().map(n => new SlashCommandEnumValue(n, null, enumTypes.enum, enumIcons.preset));
}

/** 주입 위치 자동완성. */
function positionEnumProvider() {
    return Object.entries(SIM_POSITION_LABELS).map(([v, label]) =>
        new SlashCommandEnumValue(v, label, enumTypes.enum));
}

/** 이름이 정확히(대소문자 무시) 일치하는 저장 프롬프트. */
function findSavedPromptExact(name) {
    ensureSettings();
    const prompts = extension_settings[EXTENSION_NAME].savedPrompts || [];
    const q = String(name).trim();
    const lower = q.toLowerCase();
    return prompts.find(p => p.name === q)
        ?? prompts.find(p => p.name.toLowerCase() === lower)
        ?? null;
}

/**
 * 이름으로 저장된 프롬프트 찾기. 정확히 일치 → id → 부분 일치 순.
 */
function findSavedPrompt(name) {
    const exact = findSavedPromptExact(name);
    if (exact) return exact;

    ensureSettings();
    const prompts = extension_settings[EXTENSION_NAME].savedPrompts || [];
    const q = String(name).trim();
    const lower = q.toLowerCase();
    return prompts.find(p => p.id === q)
        ?? prompts.find(p => p.name.toLowerCase().includes(lower))
        ?? null;
}

/**
 * 이름이 실제 존재하는 프리셋인지 (대소문자 무시).
 * 프리셋 목록을 못 가져오는 상황(비 chat-completion API, 매니저 미준비)에서는
 * 판단을 포기하고 null 을 돌려준다 — 멀쩡한 이름을 잘못 걸러내지 않기 위해서다.
 * @returns {boolean|null}
 */
function isKnownPreset(name) {
    const q = String(name).trim().toLowerCase();
    if (!q) return false;
    const names = getAvailablePresetNames();
    if (!names.length) return null;
    return names.some(n => String(n).toLowerCase() === q);
}

async function simCallback(args, unnamed) {
    let inlineText = normalizePromptText(String(unnamed ?? '').trim());
    let promptName = String(args?.name ?? '').trim();
    let presetName = String(args?.preset ?? '').trim();
    const quiet = isTrueBoolean(String(args?.quiet ?? 'false'));
    const open = isTrueBoolean(String(args?.open ?? 'false'));
    const returnType = String(args?.return ?? 'none');

    // 자동완성이 공백 있는 값을 따옴표 없이 넣어버리는 경우가 있다.
    //   /sim name=던전 시뮬  →  파서가 name="던전" + 이름없는 인자 "시뮬" 로 쪼갬
    // 잘린 값과 뒤따라온 텍스트를 다시 붙여서 실제 이름으로 해석되면 그쪽을 택한다.
    // (손으로 따옴표 없이 친 경우도 같이 구제된다)
    if (inlineText && promptName
        && !findSavedPromptExact(promptName)
        && findSavedPromptExact(`${promptName} ${inlineText}`)) {
        promptName = `${promptName} ${inlineText}`;
        inlineText = '';
    } else if (inlineText && presetName
        && !isKnownPreset(presetName)
        && isKnownPreset(`${presetName} ${inlineText}`)) {
        presetName = `${presetName} ${inlineText}`;
        inlineText = '';
    }

    if (!inlineText && !promptName) {
        !quiet && toastr.warning('프롬프트 이름(name=) 이나 시뮬 내용을 넣어주세요.', '시뮬 매니저');
        return '';
    }

    if (S.simGenerating || S.multiSendRunning) {
        !quiet && toastr.warning('이미 시뮬 생성이 진행 중입니다.', '시뮬 매니저');
        return '';
    }

    // 즉석 텍스트가 있으면 그게 우선. 없으면 저장된 프롬프트를 이름으로 찾는다.
    let rawPrompt = inlineText;
    let loadedPromptId = '';
    let customTitle = '';

    if (!rawPrompt) {
        const found = findSavedPrompt(promptName);
        if (!found) {
            !quiet && toastr.error(`저장된 프롬프트 "${promptName}" 를 찾을 수 없습니다.`, '시뮬 매니저');
            return '';
        }
        rawPrompt = normalizePromptText(found.content);
        loadedPromptId = found.id;
        customTitle = found.name;
    }

    const position = String(args?.position ?? '').trim() || getDefaultInjectPosition();

    // 없는 프리셋 이름은 withSimulationPreset 이 경고하고 현재 프리셋으로 진행한다. 여기서 또 막지 않는다.
    console.log(DEBUG_PREFIX, '/sim 실행:', { promptName, position, presetName, open, returnType });

    const result = await sendSimulation({
        rawPrompt,
        customTitle,
        loadedPromptId,
        chosenPresetName: presetName,
        chosenPosition: position,
        // 슬래시로 보낸 즉석 텍스트가 저장 프롬프트 목록에 쌓이지 않게 한다.
        noSavePrompt: true,
        ui: false,
        notify: !quiet,
    });

    if (!result) return '';   // 실패·취소는 sendSimulation 이 이미 안내함

    if (open) openPopupToSim(result.sim.id);

    return await slashCommandReturnHelper.doReturn(returnType, result.text ?? '');
}

export function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sim',
        helpString: `
            <div>
                시뮬레이션을 생성합니다. 저장된 프롬프트를 <code>name=</code> 으로 고르거나,
                이름 없는 인자로 즉석 프롬프트를 바로 적을 수 있습니다. (둘 다 주면 즉석 쪽이 우선)
            </div>
            <div>
                기본은 팝업을 열지 않는 백그라운드 생성이며, 끝나면 토스트로 알립니다.
                토스트를 누르면 해당 시뮬 상세로 이동합니다. Quick Reply 에 넣어 버튼 하나로 쓰는 용도입니다.
            </div>
            <div>
                즉석 프롬프트는 저장된 프롬프트 목록에 자동 추가되지 않습니다.
            </div>
            <div>
                이름에 공백이 있으면 <code>name="던전 시뮬"</code> 처럼 따옴표로 감싸는 게 정확합니다.
                따옴표가 빠져도 저장된 이름과 맞으면 알아서 붙여 해석합니다.
            </div>
            <div><strong>예시:</strong></div>
            <ul>
                <li><pre><code class="language-stscript">/sim name="던전 시뮬"</code></pre></li>
                <li><pre><code class="language-stscript">/sim name="던전 시뮬" preset="시뮬전용" quiet=true</code></pre></li>
                <li><pre><code class="language-stscript">/sim 만약 지금 비가 왔다면?</code></pre></li>
                <li><pre><code class="language-stscript">/sim name="날씨" return=pipe | /setvar key=weather</code></pre></li>
            </ul>
        `,
        callback: simCallback,
        returns: '생성된 시뮬 응답 텍스트 (return= 에 따라 다름)',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: '저장된 프롬프트 이름',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: savedPromptEnumProvider,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'preset',
                description: '생성에 쓸 프리셋 이름 (비우면 현재 프리셋)',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: presetEnumProvider,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'position',
                description: '시뮬 프롬프트 주입 위치 (비우면 확장 설정의 기본 위치)',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: positionEnumProvider,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: '완료·오류 토스트를 띄우지 않음',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'open',
                description: '생성이 끝나면 팝업을 열어 해당 시뮬 상세로 이동',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: '생성 결과를 어떻게 돌려줄지',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'none',
                enumList: slashCommandReturnHelper.enumList({ allowObject: false, allowChat: true, allowPopup: true }),
                forceEnum: true,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: '즉석 시뮬 프롬프트 (저장된 프롬프트 대신 바로 입력)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
    }));
}
