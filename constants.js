/**
 * SillyTavern - Simulation Manager
 * 상수 모음 (순수 데이터만, 부수효과 없음)
 */

export const EXTENSION_NAME = 'SillyTavern-SimulationManager';
export const CUSTOM_PRESET_EXT = 'SillyTavern-CustomPreset';
export const DEBUG_PREFIX = '[SimManager]';

// 아이콘 선택 그리드용 프리셋 (FontAwesome 6.5 solid · 귀여운 테마)
export const SIM_ICON_PRESETS = [
    'fa-heart', 'fa-star', 'fa-wand-magic-sparkles', 'fa-moon', 'fa-clover',
    'fa-cat', 'fa-paw', 'fa-frog', 'fa-fish', 'fa-dove',
    'fa-otter', 'fa-hippo', 'fa-ghost', 'fa-seedling', 'fa-gem',
    'fa-crown', 'fa-gift', 'fa-ice-cream', 'fa-cookie-bite', 'fa-cake-candles',
    'fa-candy-cane', 'fa-lemon', 'fa-mug-hot', 'fa-flask',
];

// 대명사 매핑: 'her → him' 단방향 선택 (모호성 감수)
export const PRONOUN_MAP = {
    he: 'she', she: 'he',
    him: 'her', her: 'him',
    his: 'her',             // "his" → "her" (소유격 his 도 목적격 her 로 간단히 뭉개기)
    himself: 'herself', herself: 'himself',
};
export const PRONOUN_REGEX = /\b(he|she|him|her|his|himself|herself)\b/gi;

// 시뮬 생성 시스템 지시문
export const SIM_CONTINUE_INSTRUCTION = `<simulation_continue_directive priority="critical">
<rule>This is a CONTINUATION of a previous simulation response — NOT a regular roleplay turn.</rule>
<rule>Write the NEXT content that comes AFTER the existing response. The user wants to see WHAT HAPPENS NEXT.</rule>
<rule>Do NOT refine, rewrite, polish, or expand the existing response. The existing response is already finalized — move FORWARD from it.</rule>
<rule>Continue from EXACTLY where the previous response ended. Do NOT repeat any part of the existing response.</rule>
<rule>Stay focused on the ORIGINAL simulation request. Do NOT drift into generic roleplay narration or wrap-up prose.</rule>
<rule>Maintain the same tone, style, and context as the existing response.</rule>
<rule>Output ONLY the continuation text. Do NOT include any meta-commentary or acknowledgment.</rule>
</simulation_continue_directive>`;

export const SIM_SYSTEM_INSTRUCTION = `<simulation_directive priority="critical">
<rule>This is a STANDALONE SIMULATION requested by the user.</rule>
<rule>FOLLOW OOC REQUEST ONLY. Generate a response based ONLY on the user's simulation request below.</rule>
<rule>Stay in character and maintain the established setting, personality, and tone.</rule>
</simulation_directive>`;

// 시뮬 주입 위치
export const SIM_POSITIONS = {
    LAST_MESSAGE: 'last_message', // chat 의 마지막 user 메시지 자리 (ghost push) — 기본
    DEPTH_1: 'depth_1',           // IN_CHAT depth 1 USER — 진짜 마지막 메시지 앞
    DEPTH_0: 'depth_0',           // IN_CHAT depth 0 USER — 진짜 마지막 메시지 뒤 (history 안)
    BOTTOM: 'bottom',             // quietPrompt — </history> 밖, 프롬프트 맨 끝
};
export const SIM_POSITION_LABELS = {
    [SIM_POSITIONS.LAST_MESSAGE]: '마지막 메시지 (기본)',
    [SIM_POSITIONS.DEPTH_1]: '깊이 1',
    [SIM_POSITIONS.DEPTH_0]: '깊이 0',
    [SIM_POSITIONS.BOTTOM]: '맨 밑',
};
export const SIM_DIRECTIVE_KEY = 'sim_manager_directive';
export const SIM_OOC_KEY = 'sim_manager_ooc';

// 채팅 메시지 → 시뮬 저장 버튼 클래스
export const SIM_SAVE_BTN_CLASS = 'sim-save-to-mgr';
