# Coopertition Player Avatars

Character art for coopertition mode. Files live in `/public` next to the
rank badges (`1.png`, `2.png`, `3.png`) and are probed automatically at boot —
no code changes needed to swap art.

## Slot mapping

| File base | Slot | Keyboard key |
|-----------|------|--------------|
| `1.*`     | Player 1 | `Q` |
| `2.*`     | Player 2 | `B` in 3-player groups, `P` in 2-player groups |
| `3.*`     | Player 3 | `P` |

In coopertition mode these images identify **slots**, not 1st/2nd/3rd place.
Rank badges keep working as today and are shown alongside avatars on grouped
scoreboard rows. Single-player (1-slot) devices use the slot-1 art.

## Naming convention

`{slot}-{state}.{ext}` — `state` omitted for the base/idle image:

- `1.png` — base / idle (also used on the audience display, always)
- `1-buzz.gif` — plays once when that player buzzes in
- `1-dance.gif` — loops while that player is the pick-a-value rep
- `1-correct.png` — one-shot spritesheet on a correct ruling
- `1-wrong.png` — one-shot spritesheet on a wrong ruling, holds last frame

Supported extensions (probed in order):
`png, jpg, jpeg, webp, gif, svg, avif`

All files are optional. Anything missing falls back to the highlight /
score-delta treatment (audience screens always show the base image only).

## Spritesheet specification (correct / wrong)

GIFs loop and **cannot** freeze on their final frame, so `correct` and `wrong`
should be horizontal filmstrip spritesheets (PNG or WebP recommended):

- One row, left-to-right playback order.
- Square frames (frame height == image height).
- Frame count is auto-detected as `round(imageWidth / imageHeight)` — no
  sidecar or metadata files needed.
- Playback is ~0.9s with a stepped timing function and `forwards` fill, so
  the strip freezes on its final frame.
- `correct` plays once then returns to idle; `wrong` holds its final frame
  until the round is reset, pick-a-value is left, or that player buzzes again.
- Transparent backgrounds preferred. Keep strips under ~2MB so the audience
  and player screens stay snappy. 256px+ frame height looks best.

Plain (non-strip) images are also accepted for these states — they simply
swap in statically. `prefers-reduced-motion` and the in-game UI-animation
toggle show the final frame without animating.

## Behavior summary

| State | Trigger | Lifetime | Where |
|-------|---------|----------|-------|
| idle (base) | default | — | everywhere, incl. audience 24/7 |
| buzz | slot buzzes in | ~1.5s, then idle | player + host screens |
| dance | slot is pick-a-value rep | whole roulette phase | player + host screens (highlight glow on audience) |
| correct | positive ruling, multiple-choice only | plays once, then idle | player + host screens |
| wrong | negative ruling, multiple-choice only | holds until reset / roulette exit / re-buzz | player + host screens |

Zero-point rulings stay neutral (no face). Text answers advance the
last-correct rep but never show faces. Bingo, Dis-or-Dat and Fibbage never
show faces.
