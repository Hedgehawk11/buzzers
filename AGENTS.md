# Buzzers — Agent guide

## Project
Vanilla JS SPA (Vite 8 + PlayroomKit 0.0.95). No framework, TS, test runner, or linter. Multiplayer buzzer system for live gameshows.

## Commands
```
npm run dev        # vite dev server
npm run dev-server # vite --host (LAN access for multi-device testing)
npm run build      # vite build → dist/
npm run preview    # vite preview
```
CI: `npm ci && npm run build` on Node 20/22/24 (`.github/workflows/node.js.yml`). No typecheck, formatter, or pre-commit hooks.

## Key structure
- `src/main.js` (~5500 lines) — entire app: render, state machine, event binding, prejoin UI
- `src/style.css` (~1600 lines) — flat CSS, custom properties for theming
- `index.html` — mounts `<div id="app">`, loads `src/main.js` as module

## Architecture
- **PlayroomKit** (`insertCoin`) — host is single source of truth via `setState`/`getState`. Players send buzzes via `RPC.call("buzz", ..., RPC.Mode.HOST)`.
- Round state machine: `IDLE → OPEN → LOCKED/ROULETTE → CLOSED → IDLE` (const `ROUND_STATUSES`). Host drives transitions via `setState("round", ...)`.
- Client roles: **player**, **host** (sees controls), **co-host**, **audience display** (projection), **tablet timer** (timer-only display). `clientMode` (and mirrored `me().state.clientMode`) picks the render path.
- All state mutations use `setState(key, value, true)` (reliable broadcast).
- Settings key `"settings"`, only host can change (`isHost()`), locked while round is OPEN or ROULETTE.
- Scores, teams, log, bingo, controller ID, cohosts all live in shared PlayroomKit state keys.

## Co-host
- Host seeds a random 5-digit `cohostPassword`; cohosts join with room code + password and claim via `claim-cohost` RPC (`cohostIds` state). Cleanup prunes stale cohost IDs.
- UI actions go through `cohostDispatch()`: runs locally if host, else relays via `cohost-action` RPC to the `HOST_ACTIONS` map on the host. `hasHostPrivileges()` = host OR cohost.
- Bingo / Wen Dit Happn / Dis or Dat are **host-only** — cohosts get a "host must manage it" notice (host-only UI panels, functions return early).

## Team modes
- `teamModeEnabled` + `teamScoringMode`: `"alliance"` (individual buzzers, summed team score) or `"shared"` (shared team buzzer, team score). Chosen on host prejoin screen; `teamAssignments` maps players → `TEAM_COLORS`.

## Scoring modes
- **Uniform**: fixed `uniformPoints` (500–3000, default 1000).
- **JACK**: `timeLeftCs × jackMultiplier` (1×–3×). Value decreases as timer ticks.
- **Pick-a-Value** (display name for the mode internally keyed as `roulette`): players set a value, ceiling = `topAmount / playerCount` (additive) or `topAmount` (highest/single).
  - All internal identifiers stay `roulette`: settings keys `rouletteMode`/`rouletteTopAmount`/`rouletteSinglePlayerTarget`, `round.roulette`, status `ROUND_STATUSES.ROULETTE`, RPC `"roulette-stop"`, CSS classes, and function names. Only user-facing strings say "Pick-a-Value".

## Host flow
1. `insertCoin` with no roomCode → creates room (host = first `insertCoin`).
2. `ensureHostInit()` seeds shared state: settings, round, scores, gameLog, pendingLogId, bingo, controllerId, cohostPassword/Ids.
3. Players join via 4-char room code; cohosts via code + password; displays via code.
4. Host configures settings, assigns teams, sets pre-set correct answer (optional).
5. "Open Buzzers" → buzzer phase until timer expires or a buzz locks.
6. Auto-evaluates if preset correct answer exists; otherwise host rules Correct/Incorrect.
7. "Reset Round" → IDLE.

## Screw mechanic
- One screw per player per game. Tracked via `round.screwsUsedBy` array. Screwer picks a target (screwee), then a 5s countdown starts (`screwTimerMs: 5000`) — only screwee can buzz.
- **Scoring**: screwee gets normal ±1000 (correct → +1000 extra, wrong → −1000 extra), screwer gets ∓1000 (opposite transfer).
- **Timeout** (no buzz): screwee loses `basePoints + 1000`, screwer gains +1000.
- Buzz freezes question value (`screw.frozenCs`/`screw.frozenPoints`) for JACK scoring.
- Main timer pauses during screw.
- Red background (`body:has([data-screw-active])`) on all screens during screw.
- Round always closes after screw ruling (never re-opens).
- Disabled during bingo / Wen Dit Happn / Dis or Dat modes (`allowScrewing` setting).

## Input modes
- **`buttons`**: 1–6 option buttons. `correctOptions` array for auto-eval.
- **`text`**: free-text entry. `correctAnswer` string for auto-eval.
- **`bingo`**: 5-letter word, grid of tiles, cycling animation, first to collect all wins.
- **`wendithapn`**: 3-option "Before/Never/After" per tile. Same cycling/collection as bingo.
- **`disordat`**: 7 "Dis or Dat" questions (300 pts each, 30s timed, +bonus for 5+ correct). Host taps correct answers to preset; players answer each. Uses its own host panel and tick handler.
- Bingo/Wen/Dis-or-Dat: host-only control; `hostTick()` returns early for bingo, routes to `handleDisOrDatTick()` for disordat.

## Notable quirks
- **PlayroomKit hash collision**: `launchGame()` clears `window.location.hash` (via `history.replaceState`) before `insertCoin` because PlayroomKit prioritises `#r` over `roomCode` option.
- **F-You easter egg**: Typing "fuck you" in text mode applies `-2 × basePoints` penalty via `resolveLogEntryWithForcedDelta` (bypasses normal screw scoring).
- **Host tick**: `setInterval` ~1s in `insertCoin` callback — manages timers, screw countdown, roulette finalization. Extra fast loops: 25ms re-render for audience display, 50ms for bingo cycling.
- **Roulette (Pick-a-Value) rendering** uses `getRouletteFrame()` deterministic pseudo-random based on `round.roulette.seed`.
- `maxPlayersPerRoom: 42`; `skipLobby: true`.

## Conventions
- DOM event binding via `data-*` attributes, re-bound on every `render()` call.
- No CSS modules or CSS-in-JS. Flat CSS with custom properties for theming.
- `ESM` only (`"type": "module"` in package.json).
- No vite config file — all defaults.
