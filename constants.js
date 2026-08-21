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

// ============================================
// 로어북 엔트리 생성
// ============================================
export const LIVING_LOREBOOK_EXT = 'SillyTavern-LivingLorebook';

// 활성화 방식. ST 는 이걸 constant/vectorized 불린 두 개의 조합으로 관리한다.
// (world-info.js 의 handleEntryStateSelectorHelper 참고)
export const LORE_ACTIVATION = {
    NORMAL: 'normal',           // 🟢 키워드 조건 만족 시
    CONSTANT: 'constant',       // 🔵 상시
    VECTORIZED: 'vectorized',   // 🔗 벡터화
};
export const LORE_ACTIVATION_LABELS = {
    [LORE_ACTIVATION.NORMAL]: '🟢 조건 만족시 (키워드)',
    [LORE_ACTIVATION.CONSTANT]: '🔵 상시',
    [LORE_ACTIVATION.VECTORIZED]: '🔗 벡터화',
};

// 값은 코어 world_info_position 과 반드시 같아야 한다 (world-info.js).
// import 하지 않고 복제하는 이유: 이 파일을 부수효과 없는 순수 상수로 유지하기 위함.
export const LORE_POSITIONS = {
    BEFORE_CHAR: 0,
    AFTER_CHAR: 1,
    AN_TOP: 2,
    AN_BOTTOM: 3,
    AT_DEPTH: 4,
    EM_TOP: 5,
    EM_BOTTOM: 6,
};
export const LORE_POSITION_LABELS = {
    [LORE_POSITIONS.BEFORE_CHAR]: '캐릭터 정의 전',
    [LORE_POSITIONS.AFTER_CHAR]: '캐릭터 정의 후',
    [LORE_POSITIONS.AN_TOP]: '작가 노트 상단',
    [LORE_POSITIONS.AN_BOTTOM]: '작가 노트 하단',
    [LORE_POSITIONS.AT_DEPTH]: '채팅 내 @ 깊이',
    [LORE_POSITIONS.EM_TOP]: '예제 메시지 상단',
    [LORE_POSITIONS.EM_BOTTOM]: '예제 메시지 하단',
};

// 코어 DEFAULT_DEPTH 와 동일
export const LORE_DEFAULT_DEPTH = 4;

// 요약 프롬프트에서 시뮬 응답이 들어갈 자리. 커스텀 프롬프트에 없으면 끝에 붙인다.
export const LORE_RESPONSE_PLACEHOLDER = '{{response}}';

// 로어 엔트리 추출 프롬프트. LLM 에 나가는 지시문이라 영어로 쓴다.
export const LORE_SUMMARY_PROMPT = `<lorebook_extraction_task priority="critical">
<rule>You are extracting a lorebook entry from a simulation text. This is a DATA EXTRACTION task, NOT roleplay.</rule>
<rule>Distill the durable, reusable facts: characters, places, objects, events, relationships, and rules of the world.</rule>
<rule>Omit moment-to-moment action, dialogue beats, and prose flourishes. Keep only what would still matter many scenes later.</rule>
<rule>Write the entry in the SAME LANGUAGE as the simulation text.</rule>
<rule>Output EXACTLY the three labeled fields shown below and nothing else. No preamble, no code fences, no commentary.</rule>
</lorebook_extraction_task>

<output_format>
TITLE: a short noun phrase naming this entry
KEYWORDS: 3-6 comma-separated terms that should trigger this entry
CONTENT:
the entry body, written as compact declarative statements
</output_format>

<simulation_text>
${LORE_RESPONSE_PLACEHOLDER}
</simulation_text>

Begin your output with "TITLE:" now:`;
