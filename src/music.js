// =============================================================================
// music.js — audience-display music engine (HTMLAudio-based, no deps)
// =============================================================================

const MUSIC_ROOT = "/music/";

// --- Track path helpers ---
export function modeFolder(mode) {
  return `${MUSIC_ROOT}${mode}/`;
}
export function modeTrack(mode, name) {
  return `${modeFolder(mode)}${name}.mp3`;
}
export function rootTrack(name) {
  return `${MUSIC_ROOT}${name}.mp3`;
}

// --- Cue plan (pure, testable) ---
/**
 * Given the current display state, return the next desired cue plan.
 * Does NOT mutate anything; the engine applies this plan.
 * @returns {{
 *   bed: {src: string, loop: boolean, volume: number} | null,
 *   extra: {src: string, volume: number, shouldPlay: boolean} | null,
 *   stinger: {src: string, volume: number} | null,
 *   nextStage: string // for test assertions
 * }}
 */
export function getDisplayMusicPlan({
  hasShowStarted,
  minigameMode,
  minigameActive,
  minigamePhase,
  minigameWinner,
  minigameSeenPlay,
  playerCount,
  creditsActive,
  preGameEnded,
  postGameStarted,
  postLoopStarted,
}) {
  const preExtraShouldPlay = playerCount >= 3;

  // Pre-game (before any show activity)
  if (!hasShowStarted) {
    return {
      bed: { src: rootTrack("pre-game"), loop: true, volume: 0.55 },
      extra: preExtraShouldPlay
        ? { src: rootTrack("pre-game-extra"), volume: 0.35, shouldPlay: true }
        : { src: rootTrack("pre-game-extra"), volume: 0, shouldPlay: false },
      stinger: null,
      nextStage: "pre-game",
    };
  }

  // Fibbage or normal buzzer rounds -> silence
  if (minigameMode === "fibbage" || !minigameMode) {
    return {
      bed: null,
      extra: null,
      stinger: null,
      nextStage: "silence",
    };
  }

  // Results / winner (post-game sequence) — check BEFORE playing so winners override
  const isBingo = minigameMode === "bingo" || minigameMode === "wendithapn";
  const isResults = minigamePhase === "results" || (isBingo && minigameWinner && minigameSeenPlay);
  const isEnded = !minigameActive && (postGameStarted || postLoopStarted);

  if (isResults || isEnded) {
    if (!postGameStarted && !postLoopStarted) {
      // First frame of results -> end stinger, then post-game
      return {
        bed: { src: rootTrack("post-game"), loop: false, volume: 0.7 },
        extra: null,
        stinger: { src: modeTrack(minigameMode, "end"), volume: 0.7 },
        nextStage: "post-game",
      };
    }
    if (!postLoopStarted) {
      // post-game done -> post-loop
      return {
        bed: { src: rootTrack("post-loop"), loop: true, volume: 0.55 },
        extra: null,
        stinger: null,
        nextStage: "post-loop",
      };
    }
    // post-loop running
    return {
      bed: { src: rootTrack("post-loop"), loop: true, volume: 0.55 },
      extra: null,
      stinger: null,
      nextStage: "post-loop",
    };
  }

  // Minigame selected but not started -> intro then instructions-loop
  if (!minigameActive) {
    return {
      bed: { src: modeTrack(minigameMode, "instructions-loop"), loop: true, volume: 0.55 },
      extra: { src: modeTrack(minigameMode, "extra"), volume: 0, shouldPlay: false },
      stinger: null, // intro handled as one-shot outside plan
      nextStage: "instructions",
    };
  }

  // Minigame playing
  if (minigameActive && minigamePhase === "playing") {
    const loopSrc = modeTrack(minigameMode, "loop");
    const fallbackSrc = rootTrack("game-loop");
    return {
      bed: { src: loopSrc, fallbackSrc, loop: true, volume: 0.55 },
      extra: { src: modeTrack(minigameMode, "extra"), volume: 0.35, shouldPlay: true },
      stinger: null,
      nextStage: "playing",
    };
  }

  // Credits overlay on audience display -> silence (or keep post-loop if already in it)
  if (creditsActive && !postLoopStarted) {
    return {
      bed: null,
      extra: null,
      stinger: null,
      nextStage: "silence",
    };
  }

  return {
    bed: null,
    extra: null,
    stinger: null,
    nextStage: "silence",
  };
}

// --- Music Engine ---
const BED_CROSSFADE_MS = 1000;
const EXTRA_FADE_IN_MS = 4000;
const EXTRA_FADE_OUT_MS = 2000;
const STINGER_VOLUME = 0.7;
const ONE_SHOT_TIMEOUT_MS = 15000;

function createAudio(src) {
  const audio = new Audio(src);
  audio.preload = "auto";
  return audio;
}

export function createMusicEngine() {
  // Active elements
  let bed = null; // { audio, src, targetVolume, fading }
  let extra = null; // { audio, src, targetVolume, fading }
  let stinger = null; // { audio, src, resolve }
  let stingerTimeout = null;
  let generation = 0; // invalidate stale one-shot callbacks
  let enabled = false;
  let unlocked = false;
  let lastPlan = null;

  // Helpers
  function stopAndClean(audio) {
    if (!audio) return;
    try {
      audio.pause();
      audio.src = "";
      audio.load();
    } catch {}
  }

  function fadeVolume(audio, from, to, ms, onDone) {
    if (!audio) { onDone?.(); return; }
    const steps = Math.max(1, Math.round(ms / 50));
    const step = (to - from) / steps;
    let current = from;
    audio.volume = from;
    let i = 0;
    function tick() {
      if (i >= steps) {
        audio.volume = to;
        onDone?.();
        return;
      }
      current += step;
      audio.volume = Math.max(0, Math.min(1, current));
      i++;
      setTimeout(tick, 50);
    }
    tick();
  }

  function playOneShot(src, volume, gen) {
    return new Promise((resolve) => {
      const audio = createAudio(src);
      audio.volume = volume;
      const cleanup = () => {
        clearTimeout(stingerTimeout);
        audio.removeEventListener("ended", onEnd);
        audio.removeEventListener("error", onError);
        stopAndClean(audio);
        if (stinger?.gen === gen) stinger = null;
        resolve();
      };
      const onEnd = () => cleanup();
      const onError = () => cleanup();
      audio.addEventListener("ended", onEnd);
      audio.addEventListener("error", onError);
      stinger = { audio, src, gen };
      stingerTimeout = setTimeout(cleanup, ONE_SHOT_TIMEOUT_MS);
      audio.play().catch(cleanup);
    });
  }

  async function ensureUnlocked() {
    if (unlocked) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume();
      unlocked = true;
    } catch {}
  }

  // Main apply function
  async function applyPlan(plan) {
    if (!enabled) return;
    await ensureUnlocked();

    const { bed: newBed, extra: newExtra, stinger: newStinger, nextStage } = plan;
    const gen = ++generation;

    // Stinger (one-shot) takes priority
    if (newStinger) {
      await playOneShot(newStinger.src, newStinger.volume, gen);
    }

    // Bed crossfade
    if (newBed) {
      const src = newBed.src;
      const fallbackSrc = newBed.fallbackSrc;
      const loop = newBed.loop;
      const targetVol = newBed.volume;

      if (bed && bed.src === src && bed.audio.loop === loop) {
        // Same bed, just adjust volume if needed
        if (Math.abs(bed.audio.volume - targetVol) > 0.01) {
          fadeVolume(bed.audio, bed.audio.volume, targetVol, BED_CROSSFADE_MS);
          bed.targetVolume = targetVol;
        }
      } else {
        // New bed
        const newAudio = createAudio(src);
        newAudio.loop = loop;
        newAudio.volume = 0;
        let loadFailed = false;
        newAudio.addEventListener("error", () => { loadFailed = true; }, { once: true });

        const tryPlay = () => {
          newAudio.play().catch(() => { loadFailed = true; });
        };

        // Wait briefly for load, then try play
        await new Promise(r => setTimeout(r, 50));
        if (loadFailed && fallbackSrc && src !== fallbackSrc) {
          newAudio.src = fallbackSrc;
          newAudio.load();
          await new Promise(r => setTimeout(r, 50));
        }
        tryPlay();

        // Crossfade out old bed
        if (bed) {
          fadeVolume(bed.audio, bed.audio.volume, 0, BED_CROSSFADE_MS, () => {
            stopAndClean(bed.audio);
          });
        }
        // Fade in new bed
        fadeVolume(newAudio, 0, targetVol, BED_CROSSFADE_MS);

        bed = { audio: newAudio, src: loadFailed && fallbackSrc ? fallbackSrc : src, targetVolume: targetVol };
      }
    } else {
      // No bed wanted
      if (bed) {
        fadeVolume(bed.audio, bed.audio.volume, 0, BED_CROSSFADE_MS, () => {
          stopAndClean(bed.audio);
        });
        bed = null;
      }
    }

    // Extra track (muted-in-sync with bed, faded in/out)
    if (newExtra) {
      const src = newExtra.src;
      const shouldPlay = newExtra.shouldPlay;
      const targetVol = shouldPlay ? newExtra.volume : 0;

      if (extra && extra.src === src) {
        // Same extra, adjust volume
        if (Math.abs(extra.audio.volume - targetVol) > 0.01) {
          const ms = targetVol > extra.audio.volume ? EXTRA_FADE_IN_MS : EXTRA_FADE_OUT_MS;
          fadeVolume(extra.audio, extra.audio.volume, targetVol, ms);
          extra.targetVolume = targetVol;
        }
      } else {
        // New extra
        const newAudio = createAudio(src);
        newAudio.loop = true; // extras are always looped in sync
        newAudio.volume = 0;
        let loadFailed = false;
        newAudio.addEventListener("error", () => { loadFailed = true; }, { once: true });
        await new Promise(r => setTimeout(r, 50));
        if (!loadFailed) {
          newAudio.play().catch(() => { loadFailed = true; });
        }
        if (loadFailed) {
          stopAndClean(newAudio);
          extra = null;
        } else {
          // Fade to target
          const ms = targetVol > 0 ? EXTRA_FADE_IN_MS : EXTRA_FADE_OUT_MS;
          fadeVolume(newAudio, 0, targetVol, ms);
          if (extra) {
            fadeVolume(extra.audio, extra.audio.volume, 0, EXTRA_FADE_OUT_MS, () => {
              stopAndClean(extra.audio);
            });
          }
          extra = { audio: newAudio, src, targetVolume: targetVol };
        }
      }
    } else {
      // No extra wanted
      if (extra) {
        fadeVolume(extra.audio, extra.audio.volume, 0, EXTRA_FADE_OUT_MS, () => {
          stopAndClean(extra.audio);
        });
        extra = null;
      }
    }

    lastPlan = nextStage;
  }

  function setEnabled(v) {
    enabled = v;
    if (!v) {
      // Fade everything out
      if (bed) {
        fadeVolume(bed.audio, bed.audio.volume, 0, BED_CROSSFADE_MS, () => stopAndClean(bed.audio));
        bed = null;
      }
      if (extra) {
        fadeVolume(extra.audio, extra.audio.volume, 0, EXTRA_FADE_OUT_MS, () => stopAndClean(extra.audio));
        extra = null;
      }
      if (stinger) {
        clearTimeout(stingerTimeout);
        stopAndClean(stinger.audio);
        stinger = null;
      }
    }
  }

  function getEnabled() { return enabled; }

  function getLastPlan() { return lastPlan; }

  function stopAll() {
    setEnabled(false);
    generation++;
  }

  return {
    applyPlan,
    setEnabled,
    getEnabled,
    getLastPlan,
    stopAll,
    _internals: { bed, extra, stinger }, // for tests
  };
}