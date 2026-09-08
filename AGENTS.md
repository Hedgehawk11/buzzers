# Buzzers — Agent guide

## Project
Vanilla JS SPA (Vite 8 + PlayroomKit 0.0.95). No framework, TS, linter, or test runner. Multiplayer buzzer system for live gameshows. PWA via `vite-plugin-pwa`. Node 20+ (`engines` enforced).

## Commands
```
npm run dev          # vite dev server
npm run dev-server   # vite --host (LAN multi-device)
npm run build        # vite build → dist/ (verify after every change)
npm run preview      # vite preview built output
npm run test:harness # node stub harness, 99 checks (see Verification)
```
No typecheck/lint/format hooks. `dist/` gitignored. PWA SW only in `build` — stale-SW/user-cache is the prime suspect for "works here, broken live" reports.

## Key structure
- `src/main.js` (~9170 lines) — entire game: state, RPC, render assembly. Game logic goes here.
- `src/render.js` (~445 lines) — resilient renderer: rAF scheduler, delegated bus, input preservation (`[data-log-input]` keyed by entry id), `transitionMount` (`:393`), `showToast`, score-delta, smooth timer. Only split from `main.js` — keep it that way.
- `src/snark.json` (~1250 lines) — `screen.group.key → {en,snark1,snark2}` with `{token}`. All player strings via `getSnark()`. **Vars are `escapeHtml`'d by `getSnark`** — pass raw values; pre-wrapped `<strong>` double-escapes in snark modes (off mode returns the fallback as-is, so keep its inline HTML).
- `src/style.css` (~2230 lines) — flat CSS, custom properties, no modules. `body:has(...)` backgrounds are order-dependent: screw block is deliberately last (wins ties).
- `index.html` — `<div id="app">` + `<div id="toast-layer">` + `src/main.js` + footer.
- `vite.config.js` — `VitePWA` only. Workbox precaches `gif` (coop faces).
- `test-harness/` — node ESM harness stubbing PlayroomKit + DOM, drives real RPC handlers (`run.mjs`, `*-stub.mjs`, `hooks.mjs`).

## Architecture
- **PlayroomKit** (`insertCoin({skipLobby:true, maxPlayersPerRoom:42})`) — host is SSOT via `setState(k,v,true)` (reliable). Players → host via `RPC.call(…,RPC.Mode.HOST)`. Hash cleared via `history.replaceState` before `insertCoin`.
- Round: `IDLE → OPEN → LOCKED/ROULETTE → CLOSED → IDLE` (`ROUND_STATUSES`). Host drives `setState("round",…)`. Round shape has a null-invariant: `coopControl`/`winnerCoopKey`/`correctOptions`/`correctAnswer` are `null` when absent — `resetRound`/`open`/`close`/finalize must all write `null`, never drop keys (`undefined` breaks signature + strict checks).
- Roles: `player` | `host` | `co-host` | `display` | `tablet_timer`. `clientMode` picks render path. `isAudienceDisplayClient()` true for display/tablet.
- **Auth model**: `cohost-action` requires sender ∈ `cohostIds` — any other sender gets `{ok:false}`. `screw` victim-pick requires sender = screwer or co-host. Co-host password is broadcast state; only host/co-host clients render it. No rate-limiting on `claim-cohost` (accepted risk).
- Shared keys (all `,true`): `settings`, `round`, `scores`, `gameLog`, `bingo`, `disordat`, `fibbage`, `teamAssignments`/`teamSelect`, `controllerId`, `cohostPassword`/`cohostIds`, plus coop `coopRosters`/`coopMoods`/`coopLastCorrect`. `ensureHostInit()` seeds defaults, prunes departed rosters/scores/`buzzedPlayerIds`/`coopControl`/`coopMoods`/`coopLastCorrect`, forces alliance when coop is on.
- `getUiSignature()` (`main.js:1104`) is the dirty-check for the 1s host tick and 250ms audience poll. It carries `scores` + a bounded `gameLogDigest` (`id/awardedDelta/resolved/basePoints/result/scoreKey`) + `coopLastCorrect`/`buzzCounts`/presets — **any score/log change must flip it** or remote screens go stale (their tick otherwise only patches timers). Never put full `gameLog` back in (unbounded stringify every 250ms/display).
- `updateTimerDisplays()` patches `data-*` timers without full `render()`.
- Timers: handlers enforce wall-clock (`timeEndsAt`/`voteEndsAt` with `>=`); the 1s `hostTick` only backstops. Screw without a started timer auto-releases after 60s (`activatedAt`); `startScrewTimer` won't extend a running timer.

## Renderer (do not revert to per-render rebinding)
- `render()` (`main.js:7806`) assembles HTML, mounts via `transitionMount` (250ms out/in, interrupts pending, respects `uiAnimationsEnabled`/`prefers-reduced-motion`). Mode keys only change between gamemodes.
- Delegated events: `bindEvents()` (`main.js:8051`) runs once (`delegatedBound`), `delegate(type, selector, fn)`. `render.js` attaches types registered before `#app` exists once it resolves (via `initRenderer` + `getApp`). Never add per-render listeners.
- `scheduleRender(render)` coalesces callers into one rAF with input capture/restore. `renderImmediate` for prejoin only.
- `PRESERVED_INPUT_IDS` (`render.js`) + generic focused-input fallback — no manual draft logic. `isEditingControl()` (`main.js:8566`) treats any focused input/select/textarea as editing (Q/B/P/space suppressed).
- `setBuzzNotice` auto-toasts to `#toast-layer` (top-right, limit 3). No bottom notice bar (removed).
- Score delta: `renderScores` emits `data-score-key`/`data-score-value`; `applyScoreDeltas` adds the `::after` pill, which floats **above** the row (never over the number). Audience never shows deltas (guard + CSS).
- Smooth timer is display-only; 1s `hostTick` stays authoritative.
- Buzzers-open background flash applies **only** with anims on (`body:not([data-ui-anims="off"]):has([data-buzzers-open])`) — the flash animation is the sole background color source, so gating it (not just `animation:none`) is what keeps the closed background.

## Coopertition mode (`settings.coopertitionEnabled`)
- Up to 3 sub-players per device. Join name = group name; setup screen takes count 1–3 + names (1P uses group name). Roster RPC `coop-roster`, edits gated by `coopAllowEdit`. Local drafts in `localStorage` (`buzzer_coop_*`); all `localStorage` access is try/catch (private-mode throws).
- Score keys: 1-slot devices keep `pid`; multi-slot use `coop:{deviceId}:{slot}`. Group totals derived, never stored. Shrinking freezes removed slots (greyed, still counted); growing folds orphaned `pid` into slot 0 (even zero balances, via `in`-check); toggle-off folds everything back; `ensureHostInit` prunes departed-device keys.
- **Jeopardy control** (`round.coopControl`): Q/B/P key or BUZZ claims control (no log entry); the shared normal grid unlocks only for the controlling device; the pick is attributed to the controller and releases control. Cleared on open/close/reset/roulette/timeout and ruling-reopen; released when holder departs.
- **Locks**: screws fully banned at every layer (player RPC, `initiateScrew`/`selectScrewee`/`startScrewTimer` server-side, `hostInitiateScrew`, host button; enabling coop clears a live screw). JACK hidden/coerced (`JACK_MULTIPLIER_OPTIONS` = 1/1.5/2/2.5/3, clamped in UI + `setHostSetting`), re-buzz forced off, options locked 4+, shared-team scoring forced to alliance, fibbage blocked in UI **and** at `fibbage-lie`/`fibbage-vote` RPC level. Mode/mode-toggle only from buttons/text; coop can't enable mid-fibbage.
- **Preset gate**: coop without `lockAfterBuzz` requires a preset (`correctOptions`/`correctAnswer`) to open — enforced in `openBuzzers` + button disabled state. Presets validated: answer trimmed ≤120 chars, options integers within `optionCount`.
- **Auto-rule judges both sides** when a preset exists (wrong picks auto-deduct); no preset → unresolved for manual ruling. Bingo/disordat entries carry resolved `basePoints`/`awardedDelta`; ruling paths reject non-finite deltas (a `NaN` ruling used to poison scores). Re-ruling reverses the prior screw-mirror move (`screwerScoreKey`/`screwerDelta` on the entry) instead of compounding.
- **Correct-solution lockout is per-device**: ruling positive appends the solving device's remaining slots to `buzzedPlayerIds`; other groups keep playing. Must run **after** all round writes — ruling branches spread a stale `round` snapshot that wipes it.
- Bingo/Wen/DisOrDat are coop-adapted (per-slot tracks, sibling lockout till next target, last-place auto-pick + host override, host-paced claims via `disordat-claim`). Fibbage has no coop model — keep it that way. Bingo trusts client `litIndex` by decision (forgery possible; strict validation was considered and skipped).
- Roulette stays **device-level by decision** (ceiling ÷ devices, device-keyed stops) with a **frozen roster** (`expectedPlayerIds` snapshot at phase start): late joiners sit out, departs don't early-finalize, single-player target-leave finalizes at 0. Each group fields its last-correct rep (`coopLastCorrect`), telegraphed by dance/highlight. `startRoulettePhase` must (re)start the animation loop — it auto-clears on phase end, so later phases render static without the restart call. `openBuzzers` with roulette method and no `finalValue` stays blocked (empty-player roulette goes straight to OPEN — set a value first).
- Faces: `public/avatars.md` is the spec (`{slot}-{buzz,dance,correct,wrong}.*`, correct/wrong = filmstrips, frames auto-detected). Only `*-dance.gif` exist on disk and all avatar GIFs are gitignored by decision — fresh deploys 404 probes and fall back silently; rank-1 badge collides with `1.gif`. `correct` self-clears after ~1.5s; `wrong` holds until reset/roulette-exit/re-buzz. Audience forced `idle`.
- Mobile multi-slot blocked (`isMobileDevice`: coarse pointer + narrow); 1P exempt.

## Verification (no test runner — use these)
- `npm run build` after every change.
- `npm run test:harness` — stubbed PlayroomKit+DOM driving real handlers: buzz/ruling math, edits, bingo/disordat/fibbage gates, screw ban + victim-hijack rejection, non-cohost `cohost-action` rejection, roster accounting, roulette freeze, reset null-invariant, rendered HTML for host/player/audience views, no-render-warning check. A dedicated `coh1` co-host fixture drives all `cohost-action` calls (sender auth); player RPCs stay on `dev*` fixtures. Extend it before trusting multi-step logic by reasoning alone — stale-`round` overwrites and signature staleness both survived reasoning and died in the harness.
- Harness blind spots (don't trust it here): drops the `,true` reliable flag, hardcodes `isHost`, `getElementById→null` (toasts/input-preservation untestable), `querySelectorAll→[]` (timer patch/deltas/smooth-timer untested), keyboard events, mobile/`matchMedia`, avatar `Image` probing.
- Symptom cheatsheet: remote screens stale → signature missing the changed key; score `NaN`/frozen → ruling path wrote non-finite; host button works but players blocked → gate exists only in UI, add server-side check in the RPC handler; static roulette number → animation loop not restarted; `cohost-action` returns "Not co-host" → sender isn't in `cohostIds`.

## Conventions
- Use `workdir` param, not `cd &&`. Quote paths with spaces.
- Prefer editing over new files; read before `edit`. Keep `render.js`/`test-harness` splits as-is.
- Escape all interpolated names (`escapeHtml`); route strings through `getSnark()` + `snark.json` with raw var values.
- Deliberately unchanged: roulette device-level economics, muted slots counting in totals, device-counted teams, bingo client-trust model, gitignored avatars, dead `getPlayerRank`/`getOrdinal` (unused — delete if touched).
