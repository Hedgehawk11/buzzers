# Coopertition Player Avatars

Character art for coopertition mode. Files live in `/public` alongside rank badges (`1.png`, `2.png`, `3.png`) and are probed automatically at login on every client — no code changes needed to swap art.

---

## Slot Mapping

| File base | Slot index | Keyboard key | Character number (internal) |
|-----------|------------|--------------|----------------------------|
| `1.*`     | 0 (Player 1) | `Q` | 1 |
| `2.*`     | 1 (Player 2) | `B` (3-player) / `P` (2-player) | 2 |
| `3.*`     | 2 (Player 3) | `P` | 3 |

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
| **dance** | `1-dance.gif` | Loops while that slot is the pick-a-value rep (roulette, coop mode only) |
| **correct** | `1-correct.png` | One-shot spritesheet on a positive ruling (multiple-choice only) |
| **wrong** | `1-wrong.png` | One-shot spritesheet on a negative ruling, holds last frame |
| **rewind** | (uses `wrong` art) | Plays wrong strip **in reverse** when a new round opens/reset (~1s), then idle |

**Supported extensions (probed in order):** `png`, `jpg`, `jpeg`, `webp`, `gif`, `svg`, `avif`.

All files are optional. Missing states fall back to the base image (audience screens always show the base image only).

### Namespace Support

Episodes can configure custom namespaces via settings:

- **`coopImageNamespace`** — prefix for all coop avatar files (e.g., `/my-set/1.png`)
- **`gibberishQuestionNamespace`** — higher-priority prefix when set (used for themed episodes)

The probe path becomes `/{namespace}/{slot}-{state}.{ext}` (or `/{namespace}/{slot}.{ext}` for base). If neither namespace is set, files are probed at the root of `/public`.

---

## Spritesheet Specification (`buzz` / `correct` / `wrong`)

GIFs loop and **cannot** freeze on their final frame, so `buzz`, `correct`, and `wrong` should be **horizontal filmstrip spritesheets** (PNG or WebP recommended):

- **Layout:** One row, left-to-right playback order
- **Frames:** Square (frame height == image height)
- **Frame count:** Auto-detected as `round(imageWidth / imageHeight)` — no sidecar/metadata files needed
- **Playback:** ~0.9s with a stepped timing function (`steps(frames-1)`) and `forwards` fill, so the strip freezes on its final frame
- **`buzz`:** Plays once on buzz-in (optimistically on local keypress, then from host round state) and holds its final frame while the ruling is pending (~1s in fast coop rounds)
- **`correct`:** Plays once when judged positive, then returns to idle
- **`wrong`:** Plays once, holds last frame until a new round opens or the round resets, then **plays in reverse (rewind)** back to idle using the same `wrong` artwork
- **Visibility:** One-shot states (`buzz`/`correct`/`wrong`) animate only on the acting slot's own device (plus host/producer screens) — other devices keep the idle avatar. **Exception:** alliance teammates see each other's faces on the teammate strip.
- **Dance:** Loops for the entire roulette phase while the slot is the pick-a-value rep. Visible to **everyone** (player, host, and audience screens show a highlight glow).
- **Transparency:** Transparent backgrounds preferred
- **Size:** Keep strips under ~2MB; 256px+ frame height looks best

Plain (non-strip) images are also accepted — they simply swap in statically. `prefers-reduced-motion` and the in-game UI-animation toggle show the final frame without animating.

---

## Behavior Summary

| State | Trigger | Lifetime | Where |
|-------|---------|----------|-------|
| **idle** (base) | Default | — | Everywhere, including audience 24/7 |
| **buzz** | Slot buzzes in | Plays once on keypress, holds last frame until judged | Buzzing device + host/producer screens (alliance teammates too) |
| **dance** | Slot is pick-a-value rep | Whole roulette phase (coop mode only) | Player + host screens (highlight glow on audience) |
| **correct** | Positive ruling (multiple-choice only) | Plays once, then idle | Buzzing device + host/producer screens (alliance teammates too) |
| **wrong** | Negative ruling (multiple-choice only) | Plays once, holds last frame until new round/reset, then rewinds to idle | Buzzing device + host/producer screens (alliance teammates too) |
| **rewind** | New round opens or reset | Plays wrong strip in reverse ~1s, then idle | Same devices as `wrong` |

**Notes:**
- Zero-point rulings stay neutral (no face animation)
- Text answers advance the last-correct rep but never show faces
- Bingo, Dis-or-Dat, and Fibbage never show faces
- Lockout-added sibling slots (from a correct ruling) **never** show buzz faces

---

## Audience Display

- Audience screens **always** show the base/idle avatar only — never buzz/dance/correct/wrong faces
- The base image (`1.png`, `2.png`, `3.png`) is the only avatar visible on remote displays
- Avatar state changes (buzz, correct, wrong) are **not** broadcast to audience screens; they remain on the idle base image
- During roulette, the pick-a-value rep shows a **highlight glow** on audience screens (no dance animation)

---

## Host / Producer Screens

- Host/producer screens display the full avatar lifecycle (buzz → judged face → idle/correct/wrong/rewind as appropriate)
- Host/producer screens also show the dance animation while a slot holds pick-a-value rep status
- The host sees all player faces including those on remote devices

---

## File Ownership & Fallback

- **Gitignored by design** — see `.gitignore`. Fresh deploys 404-probe and fall back silently; no code changes needed to swap art.
- **Probing:** Runs at login on every client via `Image()` loads. On success, `render()` is scheduled to pick up the discovered URL.
- Missing avatar files fall back gracefully:
  - The base image is always available (default placeholder if none provided)
  - State-specific files fall back to the base image when absent
- **Rank badge collision:** Rank badges (`1.png`, `2.png`, `3.png`) share the same filenames as slot-1/2/3 base images. The probe order (`png` first) means rank badges double as idle avatars when no dedicated `{slot}.png` exists — this is intentional and works correctly for grouped scoreboard rows where both are shown together.
- Rank badges continue to work alongside avatars on grouped scoreboard rows and are shown in addition to, not instead of, the player avatar images.

---

## Implementation Notes (for maintainers)

- **Probing:** `Image` probes at login on every client; audience and player screens both probe. `coopCharsProbed` guard prevents duplicate probes.
- **Lifecycle:**
  1. `buzz` — optimistic local preview on keypress (`noteCoopLocalBuzz`), then host log entry arrives; holds while pending
  2. `correct` / `wrong` — host sets `coopMoods[scoreKey]` via `setState("coopMoods", ..., true)`; plays once
  3. `correct` self-clears after ~1.5s (next render with no matching log entry returns idle)
  4. `wrong` holds until new round opens/reset → `rewindCoopWrongFaces()` sets mood to `rewind` for ~1s (plays wrong strip backwards via `animation-direction:reverse`), then clears `coopMoods`
- **Face deduplication:** `coopFaceSeen` map tracks first render of each face action; repeats within 150ms render frozen. `coopFaceHeld` ensures optimistic→host handoff doesn't replay the strip.
- **Device ownership:** Faces render only on the owning device + host/producer. `getCoopCharMoodForKey` enforces this via `hasHostPrivileges()` and device ID comparison. Dance is the exception — visible to all.
- **Animation loop:** Session-persistent `rouletteAnimationLoop` (started once at login) — cheap status check when idle, never self-clears. Do not reintroduce self-clearing or only the host will animate.
- **Frame detection:** `coopCharFrames[slot][state]` stores frame count for spritesheets; inlined into CSS `steps()` at render time.