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
- `src/main.js` (~5800 lines) — entire app: render, state machine, event binding, prejoin UI
- `src/snark.json` (~930 lines) — player-facing string dictionary (see Snark mode)
- `src/style.css` (~1630 lines) — flat CSS, custom properties for theming
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
- Main timer pauses during screw; `closeScrewMode()` resumes it from the frozen value.
- Red background (`body:has([data-screw-active])`) on all screens during screw.
- **Round normally closes after screw ruling (never re-opens)** — unless `reopenBuzzersAfterScrew` (default off, shown only when `allowScrewing` on) is set, in which case the round reopens with the remaining time. Screw mode is closed via `closeScrewMode()` in both paths.
- Disabled during bingo / Wen Dit Happn / Dis or Dat modes (`allowScrewing` setting).

## Input modes
- **`buttons`**: 1–6 option buttons. `correctOptions` array for auto-eval.
- **`text`**: free-text entry. `correctAnswer` string for auto-eval.
- **`bingo`**: 5-letter word, grid of tiles, cycling animation, first to collect all wins.
- **`wendithapn`**: 3-option "Before/Never/After" per tile. Same cycling/collection as bingo.
- **`disordat`**: 7 "Dis or Dat" questions (300 pts each, 30s timed, +bonus for 5+ correct). Host taps correct answers to preset; players answer each. Uses its own host panel and tick handler.
- Bingo/Wen/Dis-or-Dat: host-only control; `hostTick()` returns early for bingo, routes to `handleDisOrDatTick()` for disordat.

## Buzz handling (`hostHandleBuzz`)
- With `lockAfterBuzz` **off** and `rebuzzAllowed` **off**, buzzers stay open and host rules each entry from the Game Log — **but the round auto-closes to `CLOSED` as soon as every eligible player has buzzed** (`isAllEligibleBuzzed`; eligible = non-host, non-cohost, buzzer enabled). Re-buzz on → no auto-close.
- **Rebuzz per-option cap**: with `rebuzzAllowed` on, each player can buzz each option at most `maxBuzzesPerOption` (default 1, host-adjustable 1–50). Counts live in `round.buzzCounts` (`{playerId: {option: n}}`), reset in `openBuzzers`/`resetRound`; enforced in `canBuzz()` and by disabling the matching buzzer buttons. Text entry is uncapped.
- `round.buzzedPlayerIds` = who has answered this round (resets each open). For shared-team scoring, all team members are appended together.

## Snark mode
- `src/snark.json` maps player-facing strings to snarky variants. Keys are dot-paths `screen.group.section` (e.g. `player.buzzer.buzzSent`); each entry is `{ en, snark1, snark2 }` with `{token}` placeholders.
- Host setting `snarkMode`: `"off"` | `"1"` | `"2"`. Level 2 prefers `snark2`, level 1 prefers `snark1`; a blank line falls back to `en`, then to the English fallback passed to `getSnark()`.
- `getSnark(section, fallbackEn, vars)` replaces all player-facing strings. Strings reused across screens live once under the `"shared"` screen and are found by fallback.
- **Convention**: any new/changed player-facing string should route through `getSnark()` with keys added to `snark.json` — otherwise snark mode silently leaves it in English.

## UI animations
- Buzzers-open flash: `data-buzzers-open` on `<main>` when `isBuzzersOpenFlash()` (round `OPEN`, `inputMode === "buttons"`, no active screw). CSS `buzzersOpenFlash` animates `background-color` — **not** `background-image` gradients, which Chrome/Safari snap rather than interpolate. The tablet timer is excluded.
- Host toggle `uiAnimationsEnabled` (default on) → `render()` sets `body[data-ui-anims="on"|"off"]`; CSS `body[data-ui-anims="off"] * { animation: none !important }` kills the flash and roulette pulse (`roulettePulse`). New decorative animations must animate descendants of `body` or add their own `!important` gate.

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
