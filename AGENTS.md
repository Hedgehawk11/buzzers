# Buzzers — Agent guide

## Project
Vanilla JS SPA (Vite 8 + PlayroomKit 0.0.95). No framework, TS, test runner, or linter. Multiplayer buzzer system for live gameshows.

## Commands
```
npm run dev      # vite dev server
npm run build    # vite build → dist/
npm run preview  # vite preview
```
CI: `npm ci && npm run build`. No typecheck, formatter, or pre-commit hooks.

## Key structure
- `src/main.js` (~4520 lines) — entire app: render, state machine, event binding, prejoin UI
- `src/style.css` (~1320 lines) — flat CSS, custom properties for theming
- `index.html` — mounts `<div id="app">`, loads `src/main.js` as module

## Architecture
- **PlayroomKit** (`insertCoin`) — host is single source of truth via `setState`/`getState`. Players send buzzes via `RPC.call("buzz", ..., RPC.Mode.HOST)`.
- Round state machine: `IDLE → OPEN → LOCKED/ROULETTE → CLOSED → IDLE`. Host drives transitions via `setState("round", ...)`.
- Three client modes: **player**, **host** (sees controls), **audience display** (projection screen).
- All state mutations use `setState(key, value, true)` (reliable broadcast).
- Settings key `"settings"`, only host can change (`isHost()`), locked while round is OPEN or ROULETTE.
- Scores, teams, log, bingo, controller ID all in shared PlayroomKit state keys.

## Scoring modes
- **Uniform**: fixed `uniformPoints` (500–3000, default 1000).
- **JACK**: `timeLeftCs × jackMultiplier` (1×–3×). Value decreases as timer ticks.
- **Roulette**: players set a value, ceiling = `topAmount / playerCount` (additive) or `topAmount` (highest/single).

## Host flow
1. `insertCoin` with no roomCode → creates room.
2. `ensureHostInit()` seeds shared state: settings, round, scores, gameLog, controllerId.
3. Players join via 4-char room code.
4. Host configures settings, assigns teams, sets pre-set correct answer (optional).
5. "Open Buzzers" → buzzer phase until timer expires or a buzz locks.
6. Auto-evaluates if preset correct answer exists; otherwise host rules Correct/Incorrect.
7. "Reset Round" → IDLE.

## Screw mechanic
- One screw per player per game. Tracked via `round.screwsUsedBy` array. Screwer picks a target (screwee), then a 5s countdown starts — only screwee can buzz.
- **Scoring**: screwee gets normal ±1000 (correct → +1000 extra, wrong → −1000 extra), screwer gets ∓1000 (opposite transfer).
- **Timeout** (no buzz): screwee loses `basePoints + 1000`, screwer gains +1000.
- Buzz freezes question value (`screw.frozenCs`/`screw.frozenPoints`) for JACK scoring.
- Main timer pauses during screw.
- Red background (`body:has([data-screw-active])`) on all screens during screw.
- Round always closes after screw ruling (never re-opens).
- Disabled during bingo/Wen Dit Happn modes.

## Input modes
- **`buttons`**: 1–6 option buttons. `correctOptions` array for auto-eval.
- **`text`**: free-text entry. `correctAnswer` string for auto-eval.
- **`bingo`**: 5-letter word, grid of tiles, cycling animation, first to collect all wins.
- **`wendithapn`**: 3-option "Before/Never/After" per tile. Same cycling/collection as bingo.
- Bingo/Wen Dit Happn: host-only control (co-host UI hidden, functions return early). Tick function returns early (`if (isBingoMode()) return`).

## Notable quirks
- **PlayroomKit hash collision**: `launchGame()` clears `window.location.hash` before `insertCoin` because PlayroomKit prioritises `#r` over `roomCode` option.
- **F-You easter egg**: Typing "fuck you" in text mode applies `-2 × basePoints` penalty via `resolveLogEntryWithForcedDelta` (bypasses normal screw scoring).
- **Host tick**: `setInterval` ~1s in `insertCoin` callback — manages timers, screw countdown, roulette finalization.
- **Roulette** uses `getRouletteFrame()` deterministic pseudo-random based on `round.roulette.seed`.

## Conventions
- DOM event binding via `data-*` attributes, re-bound on every `render()` call.
- No CSS modules or CSS-in-JS. Flat CSS with custom properties for theming.
- `ESM` only (`"type": "module"` in package.json).
- No vite config file — all defaults.
