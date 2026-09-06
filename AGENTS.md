# Buzzers — Agent guide

## Project
Vanilla JS SPA (Vite 8 + PlayroomKit 0.0.95). No framework, TS, linter, or test runner. Multiplayer buzzer system for live gameshows. PWA via `vite-plugin-pwa`. Node 20+.

## Commands
```
npm run dev          # vite dev server
npm run dev-server   # vite --host (LAN multi-device)
npm run build        # vite build → dist/ (verify after every change)
npm run preview      # vite preview built output
npm run test:harness # node stub harness, 55 checks (see Verification)
```
No typecheck/lint/format hooks. `dist/` gitignored. PWA SW only in `build` — stale-SW/user-cache is the prime suspect for "works here, broken live" reports.

## Key structure
- `src/main.js` (~8970 lines) — entire game: state, RPC, render assembly. Game logic goes here.
- `src/render.js` (~400 lines) — resilient renderer: rAF scheduler, delegated bus, input preservation, `transitionMount` (`:348`), `showToast`, score-delta, smooth timer. Only split from `main.js` — keep it that way.
- `src/snark.json` (~1220 lines) — `screen.group.key → {en,snark1,snark2}` with `{token}`. All player strings via `getSnark()`.
- `src/style.css` (~2230 lines) — flat CSS, custom properties, no modules.
- `index.html` — `<div id="app">` + `<div id="toast-layer">` + `src/main.js` + footer.
- `vite.config.js` — `VitePWA` only. `public/` icons + rank badges + coop avatars (see `public/avatars.md`).
- `test-harness/` — node ESM harness stubbing PlayroomKit + DOM, drives real RPC handlers (`run.mjs`, `*-stub.mjs`, `hooks.mjs`).

## Architecture
- **PlayroomKit** (`insertCoin({skipLobby:true, maxPlayersPerRoom:42})`) — host is SSOT via `setState(k,v,true)` (reliable). Players → host via `RPC.call(…,RPC.Mode.HOST)`. Hash cleared via `history.replaceState` before `insertCoin` (PlayroomKit prefers hash over `roomCode`).
- Round: `IDLE → OPEN → LOCKED/ROULETTE → CLOSED → IDLE` (`ROUND_STATUSES`). Host drives `setState("round",…)`.
- Roles: `player` | `host` | `co-host` | `display` | `tablet_timer`. `clientMode` picks render path. `isAudienceDisplayClient()` true for display/tablet.
- Shared keys (all `,true`): `settings`, `round`, `scores`, `gameLog`, `bingo`, `disordat`, `fibbage`, `teamAssignments`/`teamSelect`, `controllerId`, `cohostPassword`/`cohostIds`, plus coop `coopRosters`/`coopMoods`/`coopLastCorrect`. `ensureHostInit()` seeds defaults, prunes departed rosters/scores, forces alliance when coop is on.
- `getUiSignature()` (`main.js:1092`) is the dirty-check for the 1s host tick and 250ms audience poll. It carries `scores` + a bounded `gameLogDigest` — **any score/log change must flip it** or remote screens go stale (their tick otherwise only patches timers). Never put full `gameLog` back in (unbounded stringify every 250ms/display).
- `updateTimerDisplays()` patches `data-*` timers without full `render()`.

## Renderer (do not revert to per-render rebinding)
- `render()` (`main.js:7632`) assembles HTML, mounts via `transitionMount` (250ms out/in, interrupts pending, respects `uiAnimationsEnabled`/`prefers-reduced-motion`). Mode keys only change between gamemodes.
- Delegated events: `bindEvents()` (`main.js:7877`) runs once (`delegatedBound`), `delegate(type, selector, fn)`. Never add per-render listeners.
- `scheduleRender(render)` coalesces callers into one rAF with input capture/restore. `renderImmediate` for prejoin only.
- `PRESERVED_INPUT_IDS` (`render.js`) + generic focused-input fallback — no manual draft logic.
- `setBuzzNotice` auto-toasts to `#toast-layer` (top-right, limit 3). No bottom notice bar (removed).
- Score delta: `renderScores` emits `data-score-key`/`data-score-value`; `applyScoreDeltas` adds the `::after` pill, which floats **above** the row (never over the number). Audience never shows deltas (guard + CSS).
- Smooth timer is display-only; 1s `hostTick` stays authoritative.
- Buzzers-open background flash applies **only** with anims on (`body:not([data-ui-anims="off"]):has([data-buzzers-open])`) — the flash animation is the sole background color source, so gating it (not just `animation:none`) is what keeps the closed background.

## Coopertition mode (`settings.coopertitionEnabled`)
- Up to 3 sub-players per device. Join name = group name; setup screen takes count 1–3 + names (1P uses group name). Roster RPC `coop-roster`, edits gated by `coopAllowEdit`. Local drafts in `localStorage` (`buzzer_coop_*`).
- Score keys: 1-slot devices keep `pid`; multi-slot use `coop:{deviceId}:{slot}`. Group totals derived, never stored. Shrinking freezes removed slots (greyed, still counted); growing folds orphaned `pid` into slot 0; toggle-off folds everything back; `ensureHostInit` prunes departed-device keys.
- **Jeopardy control** (`round.coopControl`): Q/B/P key orBUZZ claims control (no log entry); the shared normal grid unlocks only for the controlling device; the pick is attributed to the controller and releases control. Cleared on open/close/reset/roulette/timeout and ruling-reopen. 1P devices answer direct.
- **Locks**: screws fully banned (player RPC, `hostInitiateScrew`, host button; enabling coop clears a live screw). JACK hidden/coerced, re-buzz forced off, options locked 4+, shared-team scoring forced to alliance, fibbage blocked in UI **and** at `fibbage-lie`/`fibbage-vote` RPC level. Mode/mode-toggle only from buttons/text; coop can't enable mid-fibbage.
- **Preset gate**: coop without `lockAfterBuzz` requires a preset (`correctOptions`/`correctAnswer`) to open — enforced in `openBuzzers` + button disabled state.
- **Auto-rule judges both sides** when a preset exists (wrong picks auto-deduct); no preset → unresolved for manual ruling. Bingo log entries carry resolved `basePoints`/`awardedDelta`; `updateScoresForLogEntry` rejects non-finite deltas (a `NaN` ruling used to poison scores).
- **Correct-solution lockout is per-device**: ruling positive appends the solving device's remaining slots to `buzzedPlayerIds`; other groups keep playing. Must run **after** all round writes — ruling branches spread a stale `round` snapshot that wipes it.
- Bingo/Wen/DisOrDat are coop-adapted (per-slot tracks, sibling lockout till next target, last-place auto-pick + host override, host-paced claims via `disordat-claim`). Fibbage has no coop model — keep it that way.
- Roulette stays **device-level by decision** (ceiling ÷ devices, device-keyed stops); each group fields its last-correct rep (`coopLastCorrect`), telegraphed by dance/highlight. `startRoulettePhase` must (re)start the animation loop — it auto-clears on phase end, so later phases render static without the restart call.
- Faces: `public/avatars.md` is the spec (`{slot}-{buzz,dance,correct,wrong}.*`, correct/wrong = filmstrips, frames auto-detected). `correct` self-clears after ~1.5s; `wrong` holds until reset/roulette-exit/re-buzz. Audience forced `idle`.
- Mobile multi-slot blocked (`isMobileDevice`: coarse pointer + narrow); 1P exempt. Q/B/P ignored while editing (`isEditingControl` covers `data-coop-input`).

## Verification (no test runner — use these)
- `npm run build` after every change.
- `npm run test:harness` — stubbed PlayroomKit+DOM driving real handlers: buzz/ruling math, edits, bingo/disordat/fibbage gates, screw ban, roster accounting, rendered HTML for host/player/audience views, no-render-warning check. Extend it before trusting multi-step logic by reasoning alone — stale-`round` overwrites and signature staleness both survived reasoning and died in the harness.
- Symptom cheatsheet: remote screens stale → signature missing the changed key; score `NaN`/frozen → ruling path wrote non-finite; host button works but players blocked → gate exists only in UI, add server-side check in the RPC handler; static roulette number → animation loop not restarted.

## Conventions
- Use `workdir` param, not `cd &&`. Quote paths with spaces.
- Prefer editing over new files; read before `edit`. Keep `render.js`/`test-harness` splits as-is.
- Escape all interpolated names (`escapeHtml`); route strings through `getSnark()` + `snark.json`.
- Deliberately unchanged: roulette device-level economics, muted slots counting in totals, device-counted teams, dead `getPlayerRank`/`getOrdinal` (unused — delete if touched).
