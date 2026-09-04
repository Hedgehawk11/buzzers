# Buzzers — Agent guide

## Project
Vanilla JS SPA (Vite 8 + PlayroomKit 0.0.95). No framework, TS, test runner, or linter. Multiplayer buzzer system for live gameshows. PWA via `vite-plugin-pwa`. Node 20+ (CI matrix 20/22/24).

## Commands
```
npm run dev        # vite dev server
npm run dev-server # vite --host (LAN multi-device)
npm run build      # vite build → dist/ (CI: npm ci && npm run build)
npm run preview    # vite preview built output
```
No typecheck/lint/format/test hooks. `dist/` gitignored. PWA SW only in `build`.

## Key structure
- `src/main.js` (~7300 lines) — entire app: render, state, RPC, prejoin. Change here for game logic.
- `src/snark.json` (~1100 lines) — `screen.group.key → {en,snark1,snark2}` with `{token}`. All player strings via `getSnark()`.
- `src/style.css` (~1850 lines) — flat CSS, custom properties. No modules.
- `index.html` — `<div id="app">` + `src/main.js`
- `vite.config.js` — `VitePWA` only. `public/` icons + optional `1.png`/`2.png`/`3.png` rank badges.

## Architecture
- **PlayroomKit** (`insertCoin({skipLobby:true, maxPlayersPerRoom:42})`) — host is SSOT via `setState(k,v,true)` (reliable). Players → host via `RPC.call("buzz",…,RPC.Mode.HOST)`. `me().state.clientMode` mirrors `clientMode` var.
- Round: `IDLE → OPEN → LOCKED/ROULETTE → CLOSED → IDLE` (`ROUND_STATUSES`). Host drives `setState("round",…)`.
- Roles: `player` | `host` (controls) | `co-host` | `display` | `tablet_timer`. `clientMode` picks render path.
- Shared keys: `settings` (host-only, locked when `OPEN`/`ROULETTE`), `round`, `scores`, `gameLog`, `bingo`, `disordat`, `fibbage`, `teamAssignments`/`teamSelect`, `controllerId`, `cohostPassword`/`cohostIds`. All mutations `,true`.
- `ensureHostInit()` seeds defaults; cleans stale `cohostIds`/`teamAssignments`.

## Co-host
- Host seeds 5-digit `cohostPassword`; claim via `claim-cohost` RPC → `cohostIds`. `hasHostPrivileges()=isHost()||isCohost()`.
- `cohostDispatch(fn,args)` relays via `cohost-action` RPC to `HOST_ACTIONS` map on host.
- Host-only modes: Bingo/Wen/Dis or Dat/Fibbage — cohost sees "host must manage" and handlers early-return.

## Team modes
- `teamModeEnabled` + `teamScoringMode` `"alliance"` (individual buzzers, summed) vs `"shared"` (one buzzer/score per team). Set on host prejoin. `TEAM_COLORS` 10: red/blue/green/purple/gray/orange/pink/brown/cyan/lime — adding one needs `button.team-buzzer.team-*`, `.team-*` chip, `body[data-team="*"]` in `style.css`.
- Player-led select: `teamSelect {active,enabledTeams,locked,maxPerTeam}` (0=unlimited). Starts locked, host unlocks. RPC `select-team`, host can override via `setPlayerTeam`. Routed via `isTeamSelectActive()` before bingo/disordat/fibbage. Requires `round.status===IDLE`.

## Scoring modes
- **Uniform**: `uniformPoints` 500..10000/500 (default 1000, `VALUE_OPTIONS`).
- **JACK**: `timeLeftCs * jackMultiplier` (1..3x, time decays).
- **Pick-a-Value** (`roulette` internals): ceiling `topAmount/playerCount` (additive) or `topAmount`. `getRouletteFrame()` deterministic pseudo-random per `roulette.seed`+tick (triangular ~0.75*ceiling, half-to-full).

## Input modes (all switch via `settings.inputMode`, host-only, `hostTick` early-returns)
- `buttons`: 1/2/4/6/8 options (8=`.eight-grid`), `correctOptions[]`.
- `text`: free-text, `correctAnswer` string.
- `bingo`/`wendithapn`: 5 tiles or 3×Before/Never/After, cycling `750ms`, `50ms` bingo re-render loop.
- `disordat`: 7 Qs, 300pts each + time bonus 5+ correct. `disordat` state, host presets `answers[7]`.
- `fibbage`: lie game (see below). `fibbage` state, host presets truth, players lie then vote.

## Fibbage
- **Truth** can be set before/during/after lie phase; `Show Responses` gated until truth non-empty. Retro-cull: setting truth clears matching `lies` (norm `normalizeAnswerForCompare`) and sets `lieErrors[track]="The truth is not a lie — try again"` for retry.
- **Phases**: `setup → lying (lieTimeSec 30|45|60) → review → voting_ready → voting (voteTimeSec 30|45|60) → results`. `multiplier` 1..5 scales both `500` per fool and `1000` for truth. Timers via `getFibbageLie/VoteTimeLeftCs`, `handleFibbageTick` in `hostTick`.
- **Lies**: `RPC fibbage-lie {lieText}` one per `trackKey` (`getTeamTrackKey` → shared-team = one per team). Block via `blocked[track]` (host toggle, final). Duplicates merged by normalized text → one choice `authorKeys[]` (shown as `Player One + Player Two`), each co-author gets full `500*M` per voter. Shuffle deterministic per `seed` (`seededFraction`).
- **Voting**: `RPC fibbage-vote {choiceIdx}`, can't pick own lie (own `authorKeys` includes voter). Ends when all eligible voted or vote timer expires. `finalizeFibbageScores()` only on reveal, single `gameLog type:"fibbage"` entry per track.
- **Reveal**: host sees `who picked what` before reveal. `Show All` → green truth / red fooled lie / yellow unpicked; `Spotlight` single index → big-screen `renderFibbageAudienceDisplay` shows choice + pickers then author. `revealed{all,singleIdx,revealedIdxs}` in state. `updateTimerDisplays` updates `[data-fibbage-time-left]`.

## Screw mechanic
- One per player per game (`round.screwsUsedBy`). Screwer→screwee→5s `screwTimerMs`, only screwee can buzz. Freeze `screw.frozenCs/frozenPoints` for JACK, pause main timer (`closeScrewMode` resumes). Red `body:has([data-screw-active])`.
- Scoring: screwee ±1000 extra, screwer ∓1000. Timeout: screwee `-base-1000`, screwer `+1000`. Normally closes round; `reopenBuzzersAfterScrew` re-opens with remaining time. Disabled in bingo/wen/disordat/fibbage.

## Buzz handling
- `canBuzz()` checks controller/cohost/team-assigned/enabled/option-enabled/`maxBuzzesPerOption` (1..50 when `rebuzzAllowed`), screw gate.
- `hostHandleBuzz`: `lockAfterBuzz` off + `rebuzzAllowed` off → stays OPEN but auto-`CLOSED` when all eligible buzzed (`isAllEligibleBuzzed`). `round.buzzCounts` per-option cap for rebuzz, `buzzedPlayerIds` (shared-team appends all members). F-You `"fuck you"` text → `-2*basePoints` via `resolveLogEntryWithForcedDelta`.

## Snark / Scoreboard / Animations
- `getSnark(section,fallbackEn,vars)` — `snarkMode off|1|2` (2→1→en fallback, blank skips). New strings must route through it and add to `snark.json`.
- `renderScores()` sorted desc, includes alliance totals and shared-team scores. `1/2/3.*` in `public/` → `rankBadgeUrls` via `probeRankBadges()` in `boot()`.
- Flash `data-buzzers-open` when `OPEN && buttons && !screw` → `buzzersOpenFlash` (bg-color only). `uiAnimationsEnabled` → `body[data-ui-anims="off"] * {animation:none!important}`.

## Quirks
- **Hash collision**: `launchGame()` `history.replaceState` clears `#r` before `insertCoin` (PlayroomKit prefers hash over `roomCode`).
- **Host tick**: 1s `setInterval` manages timers/screw/roulette/fibbage; only `render()` if `getUiSignature()` changed else `updateTimerDisplays()`. Extra loops: 25ms audience, 50ms bingo (state-keyed).
- **PWA**: `manifest.webmanifest` + SW only after `build`; `dev` has no SW — test PWA with `build && preview`.
- **Events**: re-bind `data-*` on every `render()`. No CSS-in-JS. `type:module` ESM only.

## Conventions
- Verify via `npm run build` (CI does `npm ci && npm run build` on 20/22/24). No tests to run.
- Use `workdir` param, not `cd &&`. Quote paths with spaces.
- Prefer editing over new files; read before `edit`.
