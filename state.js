/**
 * 확장 전역에서 공유하는 런타임 상태.
 *
 * ES import 바인딩은 읽기 전용이라 모듈 간에 `let` 을 그대로 나눠 쓸 수 없다.
 * 그래서 상태를 단일 객체 `S` 에 담아 export 하고, 각 모듈은 `S.currentView = ...`
 * 처럼 프로퍼티로 읽고 쓴다. (객체 참조는 공유되므로 쓰기가 모든 모듈에 보인다.)
 *
 * 여기 담기는 건 '휘발성 UI/진행 상태'뿐이다. 영속 데이터는 config.js(설정) 와
 * store.js(시뮬 본체) 담당.
 */
export const S = {
    // ── 뷰 상태 ──────────────────────────────
    /** 'list' | 'create' | 'detail' | 'globalList' | 'globalSimList' | 'globalDetail' */
    currentView: 'list',
    currentSimId: null,
    /** 저장 안 하기 모드의 임시 sim */
    tempSim: null,
    isEditingPrompt: false,
    /** 상세 뷰에서 제목 수정 중인지 */
    isEditingTitle: false,
    /** 전송 취소로 되돌아올 때 작성 화면에 복원할 입력값 */
    pendingCreateDraft: null,
    /** null = 안 함, 0 = base, 1+ = continuation index+1 */
    editingPartIdx: null,

    // ── 모아보기(Global) 뷰 상태 ──────────────
    globalViewChatKey: null,
    globalViewSimId: null,
    globalViewSimIndex: 0,
    isEditingGlobalPrompt: false,
    editingGlobalPartIdx: null,

    // ── 번역 상태 ────────────────────────────
    /** true면 번역 보기, false면 원문 보기 */
    showTranslated: false,
    isTranslating: false,
    /** 현재 번역 중인 파트 인덱스 */
    translatingPartIdx: null,

    // ── 생성 상태 (생성 중단) ─────────────────
    /** 시뮬 생성(최초/재생성/이어쓰기)이 진행 중인지 */
    simGenerating: false,
    /** 사용자가 '중단'을 눌러 abort 했는지 */
    simAborted: false,

    // ── 다중 전송(여러 채팅방) 상태 ────────────
    /** 다중 전송 루프 진행 중 */
    multiSendRunning: false,
    /** 중지 버튼 눌림 */
    multiSendShouldStop: false,
    /** 생성 화면에 표시 중인 대상 목록 (캐시) */
    multiSendTargetsCache: [],
    /** 선택된 대상 키 (type:id) */
    multiSendSelKeys: new Set(),

    // ── 설정 패널 상태 ────────────────────────
    /** 설정의 저장된 프롬프트 목록에서 선택된 항목 */
    selectedPromptId: null,

    // ── 스크롤 리셋 판정용 (직전 렌더 기록) ─────
    lastRenderedView: null,
    lastRenderedSimId: null,
};
