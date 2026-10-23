# Coopertition Player Avatars

Character art for coopertition mode. Files live in `/public` alongside rank badges (`1.png`, `2.png`, `3.png`) and are probed automatically at boot — no code changes needed to swap art.

---

## Slot Mapping

| File base | Slot | Keyboard key |
|-----------|------|--------------|
| `1.*`     | Player 1 | `Q` |
| `2.*`     | Player 2 | `B` (3-player) / `P` (2-player) |
| `3.*`     | Player 3 | `P` |

In coopertition mode these images identify **slots**, not 1st/2nd/3rd place. Rank badges continue working as before and appear alongside avatars on grouped scoreboard rows. Single-player (1-slot) devices use the slot-1 art.

---

## Naming Convention

```
{slot}-{state}.{ext}
```

`state` is omitted for the base/idle image.

| State | File example | Purpose |
|-------|--------------|---------|
| **idle** (base) | `1.png` | Default avatar — used everywhere, including audience display 24/7 |
| **buzz** | `1-buzz.gif` | Plays once when that slot buzzes in |
| **dance** | `1-dance.gif` | Loops while that slot is the pick-a-value rep (roulette) |
| **correct** | `1-correct.png` | One-shot spritesheet on a positive ruling |
| **wrong** | `1-wrong.png` | One-shot spritesheet on a negative ruling, holds last frame |

**Supported extensions (probed in order):** `png`, `jpg`, `jpeg`, `webp`, `gif`, `svg`, `avif`.

All files are optional. Missing states fall back to the base image (audience screens always show the base image only).

---

## Spritesheet Specification (`correct` / `wrong`)

GIFs loop and **cannot** freeze on their final frame, so `correct` and `wrong` should be **horizontal filmstrip spritesheets** (PNG or WebP recommended):

- **Layout:** One row, left-to-right playback order
- **Frames:** Square (frame height == image height)
- **Frame count:** Auto-detected as `round(imageWidth / imageHeight)` — no sidecar/metadata files needed
- **Playback:** ~0.9s with a stepped timing function and `forwards` fill, so the strip freezes on its final frame
- **`buzz`:** Plays once on buzz-in (optimistically on local keypress, then from host round state) and holds its final frame while the ruling is pending (~1s in fast coop rounds)
- **`correct`:** Plays once when judged positive, then returns to idle
- **`wrong`:** Plays once, holds last frame until a new round opens or the round resets, then **plays in reverse (rewind)** back to idle
- **Visibility:** One-shot states animate only on the acting slot's own device (plus host screens) — other devices keep the idle avatar
- **Transparency:** Transparent backgrounds preferred
- **Size:** Keep strips under ~2MB; 256px+ frame height looks best

Plain (non-strip) images are also accepted — they simply swap in statically. `prefers-reduced-motion` and the in-game UI-animation toggle show the final frame without animating.

---

## Behavior Summary

| State | Trigger | Lifetime | Where |
|-------|---------|----------|-------|
| **idle** (base) | Default | — | Everywhere, including audience 24/7 |
| **buzz** | Slot buzzes in | Plays once on keypress, holds last frame until judged | Buzzing device + host screens |
| **dance** | Slot is pick-a-value rep | Whole roulette phase | Player + host screens (highlight glow on audience) |
| **correct** | Positive ruling (multiple-choice only) | Plays once, then idle | Buzzing device + host screens |
| **wrong** | Negative ruling (multiple-choice only) | Plays once, holds last frame until new round/reset, then rewinds to idle | Buzzing device + host screens |

**Notes:**
- Zero-point rulings stay neutral (no face animation)
- Text answers advance the last-correct rep but never show faces
- Bingo, Dis-or-Dat, and Fibbage never show faces

---

## Audience Display

- Audience screens **always** show the base/idle avatar only — never buzz/dance/correct/wrong faces
- The base image (`1.png`, `2.png`, `3.png`) is the only avatar visible on remote displays
- Avatar state changes (buzz, correct, wrong) are **not** broadcast to audience screens; they remain on the idle base image

---

## Host Screens

- Host screens display the full avatar lifecycle (buzz → judged face → idle/correct/wrong as appropriate)
- Host screens also show the dance animation while a slot holds pick-a-value rep status
- The host sees all player faces including those on remote devices

---

## File Ownership & Fallback

- **Gitignored by design** — see `.gitignore`. Fresh deploys 404-probe and fall back silently; no code changes needed to swap art.
- Missing avatar files fall back gracefully:
  - The base image is always available (default placeholder if none provided)
  - State-specific files fall back to the base image when absent
- **Rank badge collision:** Rank badges (`1.png`, `2.png`, `3.png`) share the same filenames as slot-1/2/3 base images. The probe order (`png` first) means rank badges double as idle avatars when no dedicated `{slot}.png` exists — this is intentional and works correctly for grouped scoreboard rows where both are shown together.
- Rank badges continue to work alongside avatars on grouped scoreboard rows and are shown in addition to, not instead of, the player avatar images.

---

## Implementation Notes (for maintainers)

- **Probing:** `Image` probes at login on every client; audience and player screens both probe.
- **Lifecycle:** `buzz` (optimistic local preview → host log entry) → judged face (`correct`/`wrong`) → idle. `correct` self-clears after ~1.5s; `wrong` holds until new round opens/reset, then `rewindCoopWrongFaces()` plays the strip backwards and clears.
- **Device ownership:** Faces render only on the owning device + host. Lockout-added sibling slots never show buzz faces.
- **Animation loop:** Session-persistent `roadkillHostTick`/`rouletteAnimationLoop` (started once at login) — cheap status check when idle, never self-clears.