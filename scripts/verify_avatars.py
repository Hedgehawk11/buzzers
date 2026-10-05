#!/usr/bin/env python3
"""Verify the coop avatar / rank-badge images in ../public.

Mirrors the probing rules in src/main.js (RANK_BADGE_EXTENSIONS order,
`/{slot}` base + `/{slot}-{state}` states) and the spec in avatars.md:

- rank badges:        /{1,2,3}.{png,jpg,jpeg,webp,gif,svg,avif} (first hit wins)
- base (required):    /{slot}.{ext}  -- idle face, also the audience face
- buzz/correct/wrong: horizontal filmstrip spritesheets preferred (PNG/WebP
  recommended). Plain GIFs work but loop instead of freezing on the final
  frame; frame count is auto-detected as round(width / height).
- dance:              looping image shown while the slot is the roulette rep.

Checks per file: opens with PIL when available and reports dimensions /
animation; validates square frames for strips (width == N x height); warns
over ~2MB and when frame height < 256px.

Exit status: 0 when every check passes, 1 on any FAIL. Warnings never fail.
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Images live in public/ next to the Vite root; this script lives in scripts/.
PUBLIC_DIR = os.path.normpath(os.path.join(HERE, "..", "public"))
EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif"]
SLOTS = (1, 2, 3)
OPTIONAL_STATES = ("buzz", "dance", "correct", "wrong")
STRIP_STATES = ("buzz", "correct", "wrong")
SIZE_WARN_BYTES = 2 * 1024 * 1024
FRAME_HEIGHT_WARN = 256

try:
    from PIL import Image
except ImportError:  # fall back to existence + size checks only
    Image = None

failures: list[str] = []
warnings: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)
    print(f"FAIL  {msg}")


def warn(msg: str) -> None:
    warnings.append(msg)
    print(f"WARN  {msg}")


def ok(msg: str) -> None:
    print(f"ok    {msg}")


def info(msg: str) -> None:
    print(f"info  {msg}")


def resolve(stem: str) -> str | None:
    """First existing file for `stem` in probe order (mirrors the client)."""
    for ext in EXTENSIONS:
        path = os.path.join(PUBLIC_DIR, f"{stem}.{ext}")
        if os.path.isfile(path):
            return path
    return None


def describe(path: str) -> str:
    """Open with PIL and return a short description; '' if unavailable."""
    if Image is None:
        return ""
    try:
        with Image.open(path) as im:
            frames = getattr(im, "n_frames", 1) or 1
            animated = bool(getattr(im, "is_animated", False))
            desc = f"{im.size[0]}x{im.size[1]}"
            if animated:
                desc += f", animated ({frames} frames)"
            return desc
    except Exception as exc:  # noqa: BLE001 -- report and continue
        warn(f"{os.path.basename(path)}: PIL cannot open it ({exc})")
        return ""


def check_strip(path: str, slot: int, state: str) -> None:
    """Validate filmstrip geometry for buzz/correct/wrong assets."""
    name = os.path.basename(path)
    size = os.path.getsize(path)
    if size > SIZE_WARN_BYTES:
        warn(f"{name}: {size / 1024 / 1024:.1f}MB exceeds ~2MB guideline")
    if Image is None:
        return
    try:
        with Image.open(path) as im:
            w, h = im.size
            animated = bool(getattr(im, "is_animated", False))
    except Exception:  # already warned in describe()
        return
    if animated and path.lower().endswith(".gif"):
        warn(f"{name}: GIFs loop and cannot freeze on the final frame "
             f"-- use a PNG/WebP filmstrip for '{state}'")
        return
    if w <= h:
        info(f"{name}: single frame ({w}x{h}), swaps in statically")
        return
    frames = max(1, round(w / h))
    if abs(w - frames * h) > max(1, h * 0.02):
        fail(f"{name}: width {w} is not N x height {h} "
             f"(nearest: {frames} frames of {w / frames:.1f}px)")
        return
    frame_desc = f"{frames} square frames ({h}px)"
    if h < FRAME_HEIGHT_WARN:
        warn(f"{name}: {frame_desc}, frame height under {FRAME_HEIGHT_WARN}px")
    else:
        ok(f"slot {slot} {state}: {name} -- {frame_desc}")


def main() -> int:
    if Image is None:
        warn("PIL (Pillow) not installed -- checking file presence and sizes only")

    print("== rank badges (1/2/3 set) ==")
    badge_paths: dict[int, str | None] = {}
    for rank in SLOTS:
        badge_paths[rank] = resolve(str(rank))
        if badge_paths[rank] is None:
            fail(f"rank {rank}: no /{rank}.{{{','.join(EXTENSIONS)}}} found")
        else:
            ok(f"rank {rank}: {os.path.basename(badge_paths[rank])} "
               f"({describe(badge_paths[rank])})")

    for slot in SLOTS:
        print(f"== slot {slot} ==")
        base = resolve(str(slot))
        if base is None:
            fail(f"slot {slot}: missing base face /{slot}.{{{','.join(EXTENSIONS)}}}")
        else:
            ok(f"slot {slot} base: {os.path.basename(base)} ({describe(base)})")
            badge = badge_paths[slot]
            if badge is not None and os.path.abspath(badge) == os.path.abspath(base):
                info(f"slot {slot}: rank-{slot} badge shares the base file "
                     f"(expected collision, badge wins visually)")

        for state in OPTIONAL_STATES:
            path = resolve(f"{slot}-{state}")
            if path is None:
                info(f"slot {slot} {state}: missing (optional)")
                continue
            if state in STRIP_STATES:
                check_strip(path, slot, state)
            else:
                desc = describe(path)
                ok(f"slot {slot} {state}: {os.path.basename(path)}"
                   + (f" ({desc})" if desc else ""))

    print()
    print(f"{len(failures)} failure(s), {len(warnings)} warning(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
