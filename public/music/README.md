# Buzzers — Audience Display Music

All files are **optional**. The display falls back gracefully when a file is missing.
Place `.mp3` files in `public/music/` (copied to `dist/music/` on build).

## Folder / file map

```
public/music/
  pre-game.mp3              # loops from display login
  pre-game-extra.mp3        # muted until 3+ players, then fades in
  game-loop.mp3             # generic gameplay-bed fallback
  post-game.mp3             # one-shot after minigame results
  post-loop.mp3             # loops until the minigame is closed
  bingo/
    intro.mp3
    instructions-loop.mp3
    loop.mp3
    extra.mp3
    end.mp3
  wendithapn/
    intro.mp3
    instructions-loop.mp3
    loop.mp3
    extra.mp3
    end.mp3
  disordat/
    intro.mp3
    instructions-loop.mp3
    loop.mp3
    extra.mp3
    end.mp3
  quixort/
    intro.mp3
    instructions-loop.mp3
    loop.mp3
    extra.mp3
    end.mp3
```

## Cue behavior

| Phase | Track(s) | Notes |
|-------|----------|-------|
| **Display login / sign-in** | `pre-game` (loop) + `pre-game-extra` (muted, then fades in at **≥3 real players**) | Host, producers, kicked players excluded from count. Extra fades back out if count drops below 3. |
| **Normal buzzer rounds** (buttons / text / roulette / screw) | **Silence** | Pre-game stops at first round or when a minigame is selected. |
| **Minigame selected, not started** | `{mode}/intro` (once) → `{mode}/instructions-loop` (loop) | `mode` = `bingo`, `wendithapn`, `disordat`, or `quixort`. **Fibbage gets no music.** |
| **Minigame playing** | `{mode}/loop` (loop) + `{mode}/extra` (muted-in-sync, fades in) | If `{mode}/loop` is missing, falls back to root `game-loop.mp3`. If both missing but `{mode}/extra` exists, extra becomes the bed at full volume. |
| **Results / winner** | `{mode}/end` (once) → `post-game` (once) → `post-loop` (loop) | Bingo/Wen: winner detected or display observed play then `active` false. Dis or Dat / Quixort: `phase === "results"`. |
| **Host exits minigame / selects another** | Fade out; new minigame starts with its intro | `post-loop` stops when the minigame is closed. |
| **Fibbage** | **Silence** | Explicitly excluded. |
| **Credits overlay** | Silence (unless already in `post-loop`) | |

## Extra tracks (`-extra`)

- Started **muted** and **in sync** with their paired loop (`pre-game-extra` with `pre-game`; `{mode}-extra` with `{mode}/loop` or `game-loop`).
- Fade in when their condition is met (pre-game-extra: ≥3 players; minigame extra: gameplay start).
- Fade out when the condition drops.
- If an extra file is missing, the bed plays alone — no error.
- **Duration:** for best sync, the extra file should be the same length as its loop. The engine attempts drift correction but does not time-stretch.

## Fallback rules

1. Missing one-shot (`intro`, `end`, `post-game`) → skipped; next stage begins immediately.
2. Missing `{mode}/loop` → uses `game-loop.mp3`.
3. Missing both loop and `game-loop` but `{mode}/extra` exists → extra plays as the bed at full volume.
4. Missing `pre-game` but `pre-game-extra` exists → extra becomes the bed.
5. Everything missing → silence (no crash).

## Adding music

1. Drop `.mp3` files into the folders above.
2. Run `npm run build` — Vite copies `public/` to `dist/` and Workbox precaches the files for offline use.
3. Open the audience display, check **“Play music on this display (M toggles later)”**, and join.
4. Press **M** on the display to toggle music live (persists in localStorage).

## Notes

- Music runs **only** on audience-display clients (`clientMode === "display"`). Players, host, producers, and tablet timer are unaffected.
- No PlayroomKit state is used — music is purely local to each display screen.
- Default volumes: beds ~0.55, extras ~0.35, stingers ~0.7. Tweak in `src/music.js` if needed.
- The `M` key toggles music on/off (ignores modifiers, key-repeat, and focused inputs).
- If autoplay is blocked by the browser, a toast appears: “Music blocked — press M to start”.