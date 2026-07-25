# Buzzers — Agent guide

## Project
Vanilla JS single-page app (Vite + PlayroomKit). No framework, no TypeScript, no test runner, no linter. Multiplayer buzzer system for live gameshows.

## Commands
```
npm run dev      # vite dev server
npm run build    # vite build → dist/
npm run preview  # vite preview
```
CI: `npm ci && npm run build` (no tests/lint). No typecheck, formatter, or pre-commit hooks exist.

## Key structure
- `src/main.js` — entire app (render, state machine, event binding, prejoin UI). ~4500 lines.
- `src/style.css` — all styles.
- `index.html` — mounts `<div id="app">`, loads `src/main.js` as module.
- `public/favicon.svg`, `public/icons.svg`

## Architecture
- **PlayroomKit** (`insertCoin`) for multiplayer — host is the single source of truth via `setState`/`getState`. Players send buzzes via `RPC.call("buzz", ..., RPC.Mode.HOST)`.
- Round state machine: `IDLE → OPEN → LOCKED/ROULETTE → CLOSED → IDLE`. Host drives transitions with `setState("round", ...)`.
- Three client modes selectable at join: **player** (buzzer UI), **host** (same as player but also sees controls), **audience display** (projection screen).
- Settings persisted in shared state under key `"settings"`. Only host can change them (gated by `isHost()`).
- Settings locked while round is OPEN or ROULETTE.
- Scores, team assignments, game log, bingo state, controller ID all live in shared PlayroomKit state keys.

## Host flow
1. Host opens a room (creates via `insertCoin`, no roomCode param).
2. `ensureHostInit()` seeds shared state: settings, round, scores, gameLog, controllerId.
3. Players join with the 4-char room code.
4. Host configures settings, assigns teams (optional), sets pre-set correct answer (optional).
5. Host clicks "Open Buzzers" → `RPC.call("buzz")` → host calls `hostHandleBuzz()` → log entry created → auto-evaluates if correct answer pre-set.
6. If `lockAfterBuzz` is on, host sees a ruling prompt (Correct/Incorrect).
7. Host clicks "Reset Round" to return to IDLE.

## Notable quirks
- **PlayroomKit hash collision**: The `launchGame()` function clears `window.location.hash` before calling `insertCoin` because PlayroomKit prioritises the `#r` parameter over the `roomCode` option. If you add navigation that preserves hashes, be aware.
- **Roulette ceiling** = `topAmount / playerCount` (additive mode), or `topAmount` (highest/single-player).
- **Screw mechanic**: One screw per game. Points are reversed: screwee loses, screwer gains.
- **F-You easter egg**: Typing "fuck you" in text-entry mode applies -2× base points penalty.
- **Bingo/Wen Dit Happn**: Separate input modes that replace the normal buzzer UI. 5-letter word for bingo, 3-option "Before/Never/After" for Wen Dit Happn. Co-hosts cannot control these modes (UI hidden, functions return early). Only the host manages bingo.
- Host tick runs every ~1s via `setInterval` in the `insertCoin` callback — manages timers, screw countdowns, roulette finalization.

## Conventions
- All DOM event binding via `data-*` attributes, re-bound on every `render()` call.
- No CSS modules, no CSS-in-JS. Flat CSS with CSS custom properties for theming.
- `ESM` only (`"type": "module"`).
- All state mutations go through `setState(key, value, true)` (third param = reliable broadcast).
