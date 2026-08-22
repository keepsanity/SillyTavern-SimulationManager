# SillyTavern-SimulationManager

A SillyTavern extension for running side generations ("simulations") that don't pollute the main
chat — quick "what if" branches you can steer, translate, and export without touching the actual
conversation.

## Features

- **Simulation branches** — generate off a chat-history snapshot via quiet prompt, without adding
  a message to the real chat. Pick the injection position (last message / depth 1 / depth 0 /
  bottom), swap `{{char}}`/`{{user}}` or pronouns, and reuse a preset per simulation
- **Regenerate / continue / steer** — re-roll a response, continue it, or nudge it with a director's
  note (통제광), each kept as its own revision so you can flip back
- `/sim` slash command with `name` / `preset` / `position` / `quiet` / `open` / `return` arguments
- **Saved prompts** — store prompt templates and reuse them, with sort by newest/oldest/name
- **Multiple send** — run the same simulation across several chats in one pass
- **Global viewer** — browse every chat's simulations app-wide, export a backup, clean up stale entries
- **Translation** — translate a response with its own connection profile, target language, and
  custom prompt (independent of the main API/preset)
- **Lorebook entry generation** — summarize a simulation response into a lorebook entry: pick the
  target lorebook, activation type (keyword / constant / vector), position and depth, preview and
  edit before saving. Can use its own connection profile and prompt, separate from the main one
- **Prompt intercept** — optionally preview the fully-assembled prompt and confirm before every send
- Custom display name/icon for the wand button and popup header

## Settings

**Extensions > 시뮬레이션 매니저** covers: display name/icon, notification on completion, prompt
intercept toggle, default injection position, translation (profile/language/custom prompt), lorebook
defaults (activation/position/depth, profile, summary prompt), and saved-prompt management.

---

# SillyTavern-SimulationManager

메인 채팅을 건드리지 않고 곁가지 생성("시뮬레이션")을 돌려보는 SillyTavern 확장 기능입니다.
"이렇게 흘러가면?"을 실제 대화에 영향 없이 만들고, 다듬고, 번역하고, 필요하면 로어북으로 뽑아낼 수 있습니다.

## 기능

- **시뮬레이션 생성** — 현재 채팅 기록을 스냅샷으로 삼아 조용히 생성만 하고, 실제 채팅에는 메시지를
  남기지 않음. 주입 위치(마지막 메시지 / 깊이 1 / 깊이 0 / 맨 아래) 선택, `{{char}}`/`{{user}}` 또는
  대명사 교체, 시뮬마다 다른 프리셋 지정 가능
- **재생성 / 이어쓰기 / 통제광** — 응답을 다시 굴리거나, 이어 쓰거나, 지시문으로 방향을 틀 수 있고
  각각 리비전으로 남아서 이전 버전으로 되돌릴 수 있음
- `name` / `preset` / `position` / `quiet` / `open` / `return` 인자를 받는 `/sim` 슬래시 커맨드
- **저장된 프롬프트** — 자주 쓰는 프롬프트를 저장해두고 재사용, 최신순/오래된순/이름순 정렬
- **다중 전송** — 같은 시뮬을 여러 채팅방에 한 번에 실행
- **모아보기** — 전체 채팅방의 시뮬을 한 곳에서 훑어보고, 백업 내보내기, 오래된 항목 정리
- **번역** — 메인 API/프리셋과 별개로 자체 커넥션 프로필·대상 언어·커스텀 프롬프트로 응답 번역
- **로어북 엔트리 생성** — 시뮬 응답을 요약해 로어북 엔트리로: 대상 로어북, 활성화 방식(키워드/상시/
  벡터), 위치·깊이 지정, 저장 전 미리보기·수정 가능. 요약용 커넥션 프로필·프롬프트도 메인과 별개로 설정 가능
- **전송 전 프롬프트 확인** — 켜두면 전송마다 조립이 끝난 최종 프롬프트를 보여주고 확인받음
- 지팡이 버튼/팝업 헤더에 쓰이는 이름·아이콘 커스터마이즈

## 설정

**확장 기능 > 시뮬레이션 매니저**에서 표시 이름/아이콘, 완료 알림, 프롬프트 확인 토글, 기본 주입
위치, 번역(프로필/언어/커스텀 프롬프트), 로어북 기본값(활성화/위치/깊이, 프로필, 요약 프롬프트),
저장된 프롬프트 관리를 설정할 수 있습니다.

---

## License
This project is licensed under the AGPL-3.0 License.
