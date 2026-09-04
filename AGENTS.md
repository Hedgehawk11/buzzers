# Buzzers — Agent guide

## Project
Vanilla JS SPA (Vite 8 + PlayroomKit 0.0.95). No framework, TS, test runner, or linter. Multiplayer buzzer system for live gameshows. PWA via `vite-plugin-pwa`. Node 20+ (CI matrix 20/22/24 on `npm ci && npm run build`).

## Commands
```
npm run dev        # vite dev server
npm run dev-server # vite --host (LAN multi-device)
npm run build      # vite build → dist/ (verify before PR)
npm run preview    # vite preview built output
```
No typecheck/lint/format/test hooks. `dist/` gitignored. PWA SW only in `build` (`dev` has no SW — test PWA with `build && preview`).

## Key structure
- `src/main.js` (~7145 lines) — entire game: state, RPC, render assembly. Change here for game logic.
- `src/render.js` (~395 lines) — resilient renderer: rAF scheduler, delegated bus, input preservation, `transitionMount`, `showToast`, score-delta, smooth timer. Imported by `main.js`.
- `src/snark.json` (~1100 lines) — `screen.group.key → {en,snark1,snark2}` with `{token}`. All player strings via `getSnark()`.
- `src/style.css` (~2076 lines) — flat CSS, custom properties. No modules. Includes toast, score-delta, `layoutFadeIn/Out` transitions, `buzzersOpenFlash`.
- `index.html` — `<div id="app">` + `<div id="toast-layer">` + `src/main.js` + footer.
- `vite.config.js` — `VitePWA` only. `public/` icons + optional `1.png/2.png/3.png` rank badges via `probeRankBadges()` in `boot()`.

## Architecture
- **PlayroomKit** (`insertCoin({skipLobby:true, maxPlayersPerRoom:42})`) — host is SSOT via `setState(k,v,true)` (reliable). Players → host via `RPC.call("buzz",…,RPC.Mode.HOST)`. `me().state.clientMode` mirrors `clientMode` var. Hash cleared via `history.replaceState` before `insertCoin` (PlayroomKit prefers hash over `roomCode`).
- Round: `IDLE → OPEN → LOCKED/ROULETTE → CLOSED → IDLE` (`ROUND_STATUSES`). Host drives `setState("round",…)`.
- Roles: `player` | `host` | `co-host` | `display` | `tablet_timer`. `clientMode` picks render path. `isAudienceDisplayClient()` true for display/tablet.
- Shared keys (all `,true`): `settings` (locked when `OPEN`/`ROULETTE`), `round`, `scores`, `gameLog`, `bingo`, `disordat`, `fibbage`, `teamAssignments`/`teamSelect`, `controllerId`, `cohostPassword`/`cohostIds`. `ensureHostInit()` seeds defaults, cleans stale `cohostIds`/`teamAssignments`.
- `getUiSignature()` is dirty-check for 1s host tick; `updateTimerDisplays()` patches `data-*` timers without full `render()`.

## Renderer (new — do not revert to per-render rebinding)
- `render()` in `main.js:5988` assembles HTML string and mounts via `getApp()` (`#app`) using `transitionMount(mount, html, modeKey)` `render.js:341` (140ms `layoutFadeOut` → 160ms `layoutFadeIn`, respects `uiAnimationsEnabled`/`prefers-reduced-motion`, interrupts pending). Mode keys: `prejoin-*`, `audience`/`tablet`, `teamselect`/`bingo`/`disordat`/`fibbage`/`default`.
- Delegated events: `bindEvents()` `main.js:6232` runs once (`delegatedBound` guard), calls `initRenderer` + `delegate(type, selector, fn)` `render.js:144` (`closest` on `appEl`). Do not add `querySelectorAll`+`addEventListener` per render.
- Scheduler: `scheduleRender(render)` `render.js:90` coalesces multiple callers (hostTick + roulette 500ms + bingo 50ms + audience 25ms + RPC) into one `requestAnimationFrame` with `capturePreservedInputs`/`restorePreservedInputs`. Use `renderImmediate` only for prejoin.
- Input preservation: `PRESERVED_INPUT_IDS` `render.js:14` (fibbage-truth, answer-entry, correct-answer-entry, bingo-word, disordat-*, fibbage-lie-entry, prejoin-*, selects) + generic fallback for any focused input. `setBuzzNotice` also calls `showToast` `render.js:177`.
- `prejoinHtml` via `renderPrejoinScreen` `main.js:6653` now uses `transitionMount` (`prejoin-${mode}`) with same scheduler.

## Co-host
- Host seeds 5-digit `cohostPassword`; claim via `claim-cohost` RPC → `cohostIds`. `hasHostPrivileges()=isHost()||isCohost()`. `cohostDispatch` relays via `cohost-action` to `HOST_ACTIONS` on host. Host-only modes: Bingo/Wen/Dis or Dat/Fibbage — cohost early-returns.

## Team modes
- `teamModeEnabled` + `teamScoringMode` `"alliance"` (individual buzzers, summed) vs `"shared"` (one buzzer/score per team). Set on host prejoin. `TEAM_COLORS` 10: red/blue/green/purple/gray/orange/pink/brown/cyan/lime — adding one needs `button.team-buzzer.team-*`, `.team-*` chip, `body[data-team="*"]` in `style.css`.
- Player-led select: `teamSelect {active,enabledTeams,locked,maxPerTeam}` (0=unlimited). Starts locked, host unlocks. RPC `select-team`, host override via `setPlayerTeam`. Routed via `isTeamSelectActive()` before bingo/disordat/fibbage. Requires `round.status===IDLE`.

## Scoring modes
- **Uniform**: `uniformPoints` 500..10000/500 (default 1000, `VALUE_OPTIONS`).
- **JACK**: `timeLeftCs * jackMultiplier` (1..3x).
- **Pick-a-Value** (`roulette`): ceiling `topAmount/playerCount` (additive) or `topAmount`. `getRouletteFrame()` deterministic per `roulette.seed`+tick (triangular ~0.75*ceiling). `startRouletteAnimationLoop` 500ms now `scheduleRender` + auto-clears when not `ROULETTE`.

## Input modes (all switch via `settings.inputMode`, host-only, `hostTick` early-returns)
- `buttons`: 1/2/4/6/8 options (8=`.eight-grid`), `correctOptions[]`.
- `text`: free-text, `correctAnswer` string.
- `bingo`/`wendithapn`: 5 tiles or 3×Before/Never/After, cycling `750ms`, `50ms` bingo re-render loop (state-keyed).
- `disordat`: 7 Qs, 300pts each + time bonus 5+ correct (`disordat` state, host presets `answers[7]`).
- `fibbage`: lie game (see below).

## Fibbage
- **Truth** locked after `Enter Lies` (`setFibbageTruth` early-returns if `active`). `Show Responses`/`Enter Lies` auto-apply draft `#fibbage-truth` via generic preservation `render.js:14`. Timers via `getFibbageLie/VoteTimeLeftCs`, `handleFibbageTick` in `hostTick` (skips full `render()` when truth input focused, only `updateTimerDisplays`).
- **Phases**: `setup → lying (30|45|60) → review → voting_ready → voting (30|45|60) → results`. `multiplier` 1..5 scales `500` per fool and `1000` for truth.
- **Lies**: `RPC fibbage-lie {lieText}` one per `trackKey` (`getTeamTrackKey` → shared-team one per team). Block via `blocked[track]`. Duplicates merged by normalized text → `authorKeys[]`, each co-author gets full `500*M` per voter. Shuffle deterministic per `seed` (`seededFraction`).
- **Voting**: `RPC fibbage-vote {choiceIdx}`, can't pick own lie. Ends when all eligible voted or timer expires. `finalizeFibbageScores()` on reveal, single `gameLog type:"fibbage"` per track.
- **Reveal**: `Show All` → green truth/red fooled/yellow unpicked; `Spotlight` → `.fibbage-spotlight` (62vh, `fibbageSpotlightIn`/`fibbageGlow`). `revealed{all,singleIdx,revealedIdxs}` in state.

## Screw mechanic
- One per player per game (`round.screwsUsedBy`). Screwer→screwee→5s `screwTimerMs`, only screwee can buzz. Freeze `screw.frozenCs/frozenPoints` for JACK, pause main timer (`closeScrewMode` resumes). Red `body:has([data-screw-active])`. `data-screw-timer` patched by smooth timer rAF.
- Scoring: screwee ±1000 extra, screwer ∓1000. Timeout: screwee `-base-1000`, screwer `+1000`. Normally closes round; `reopenBuzzersAfterScrew` re-opens with remaining time. Disabled in bingo/wen/disordat/fibbage.

## Buzz handling
- `canBuzz()` checks controller/cohost/team-assigned/enabled/option-enabled/`maxBuzzesPerOption` (1..50 when `rebuzzAllowed`), screw gate.
- `hostHandleBuzz`: `lockAfterBuzz` off + `rebuzzAllowed` off → stays OPEN but auto-`CLOSED` when all eligible buzzed (`isAllEligibleBuzzed`). `round.buzzCounts` per-option cap for rebuzz, `buzzedPlayerIds` (shared-team appends all members). F-You `"fuck you"` text → `-2*basePoints` via `resolveLogEntryWithForcedDelta`.

## New renderer features (do not bypass)
- **Toast**: `showToast(text,{ttlMs:3500})` `render.js:177` appends to `#toast-layer` (outside `#app`), limit 3 (drop oldest), `is-in`/`is-out` 180ms, `role="status"`. `setBuzzNotice` auto-toasts. Do not add buzz notices via `render()` inline only.
- **Score delta**: `trackScoreSnapshot`/`applyScoreDeltas` `render.js:234/249` — `renderScores` emits `data-score-key`/`data-score-value`; after `mount.innerHTML`, `requestAnimationFrame` adds `is-delta is-plus/is-minus` + `data-delta` (900ms) with `scorePop`/`scoreDeltaFly`. Guarded `!isAudienceDisplayClient()` and `.audience-layout` CSS `display:none` — never show on audience per spec.
- **Smooth timer**: `startSmoothTimer([...])` `render.js:276` rAF loop patching `[data-live-time-left]`/`[data-disordat-time-left]`/`[data-fibbage-time-left]`/`[data-screw-timer]` via `patchText`. Started in `boot()` `main.js:7124` for display/tablet **and** player when `OPEN`. Keep 1s `hostTick` authoritative; rAF is display-only.
- **Transitions**: `layoutFadeIn` 160ms / `layoutFadeOut` 140ms `style.css` on `#app[data-transition]` for `.layout` and `.prejoin-layout`. Respects `body[data-ui-anims="off"]` and `prefers-reduced-motion`. `transitionMount` interrupts pending (clears timeouts).

## Snark / Scoreboard / Animations
- `getSnark(section,fallbackEn,vars)` — `snarkMode off|1|2` (2→1→en fallback, blank skips). Now `escapeHtml(vars[k])` in `main.js:218`. New strings must route through it and add to `snark.json`.
- `renderScores()` sorted desc, emits `data-score-key` for delta. Alliance totals and shared-team scores included. `1/2/3.*` in `public/` → `rankBadgeUrls` via `probeRankBadges()` in `boot()`.
- Flash `data-buzzers-open` when `OPEN && buttons && !screw` → `buzzersOpenFlash`. `uiAnimationsEnabled` → `body[data-ui-anims="off"] * {animation:none!important}`.

## Quirks
- **Prejoin fade**: `renderPrejoinScreen` now uses `transitionMount` (`prejoin-${mode}`), so joining game animates `prejoin-*` → `default` (out 140ms + in 160ms). Initial `prejoin-landing` has no intro animation.
- **Host tick**: 1s `setInterval` manages timers/screw/roulette/fibbage; only `scheduleRender(render)` if signature changed else `updateTimerDisplays()`. rAF timer supplements patching. Extra loops: 25ms audience (still gated, now `scheduleRender`), 50ms bingo (state-keyed).
- **PWA**: SW only after `build`; `dev` has no SW — test PWA with `build && preview`.
- **Escape**: `getSnark` vars and `getPlayerName` interpolated HTML now escaped (`escapeHtml`). Do not add raw `playerName` to HTML.
- **Null `me()`**: `isControllerPlayer`/`isCohost` use `me()?.id`; `render()` early-returns to `renderPrejoinScreen` if `!me()`. `assignControllerIfNeeded` guards `me()?.id`.
- **Input preservation**: generic `PRESERVED_INPUT_IDS` + fallback for any focused input — do not add manual `_fibTruthDraft` logic.

## Conventions
- Verify via `npm run build`. No tests to run.
- Use `workdir` param, not `cd &&`. Quote paths with spaces.
- Prefer editing over new files; read before `edit`. `src/render.js` is the only split from `main.js` — keep it.
