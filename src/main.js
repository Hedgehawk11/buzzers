import "./style.css";
import { RPC, getParticipants, getRoomCode, getState, insertCoin, isHost, me, setState } from "playroomkit";

const DEFAULT_SETTINGS = {
  timeOpen: 20,
  lockAfterBuzz: true,
  rebuzzAllowed: false,
  closeBuzzersOnPointsGiven: false,
  showScoresToPlayers: false,
  inputMode: "buttons",
  optionCount: 4,
  disabledOptions: [],
  disabledPlayerIds: [],
  scoringMode: "uniform",
  uniformPoints: 1000,
  jackMultiplier: 1,
  allowScrewing: false,
  valueSelectionMethod: "standard",
  rouletteMode: "additive",
  rouletteTopAmount: 1000,
  rouletteSinglePlayerTarget: "random",
};

const ROUND_STATUSES = {
  IDLE: "idle",
  OPEN: "open",
  ROULETTE: "roulette",
  LOCKED: "locked",
  CLOSED: "closed",
};

const ROULETTE_PATTERN = [
  { label: "Low", min: 0.16, max: 0.34 },
  { label: "Low", min: 0.14, max: 0.32 },
  { label: "Medium", min: 0.38, max: 0.62 },
  { label: "Low", min: 0.15, max: 0.33 },
  { label: "Really Low", min: 0.04, max: 0.14 },
  { label: "High", min: 0.68, max: 1 },
];

const app = document.querySelector("#app");
const NAME_KEY = "buzzer_player_name";
let gameLaunched = false;
let buzzNotice = "";
let buzzNoticeTs = 0;
let lastUiSignature = "";
let prejoinMode = "landing";
let rouletteAnimationInterval = null;
let rouletteKeydownBound = false;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const now = () => Date.now();
const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

function getSafeState(key, fallback) {
  const value = getState(key);
  return value === undefined || value === null ? fallback : value;
}

function setBuzzNotice(message) {
  buzzNotice = String(message || "");
  buzzNoticeTs = now();
}

function getRecentBuzzNotice(maxAgeMs = 4000) {
  if (!buzzNotice) {
    return "";
  }
  if (now() - buzzNoticeTs > maxAgeMs) {
    return "";
  }
  return buzzNotice;
}

function currentParticipants() {
  const participants = Object.values(getParticipants() || {});
  return participants.sort((a, b) => a.id.localeCompare(b.id));
}

function getPlayerName(player) {
  const custom = player?.getState?.("displayName");
  if (typeof custom === "string" && custom.trim()) {
    return custom.trim();
  }
  return player?.getProfile?.()?.name || "Player";
}

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...getSafeState("settings", {}) };
}

function normalizeDisabledOptions(options, optionCount) {
  const max = Number(optionCount) || 0;
  return [...new Set((options || []).map(Number).filter((opt) => Number.isInteger(opt) && opt >= 1 && opt <= max))];
}

function isOptionEnabled(settings, option) {
  const disabledOptions = normalizeDisabledOptions(settings.disabledOptions, settings.optionCount);
  return !disabledOptions.includes(Number(option));
}

function normalizeDisabledPlayerIds(disabledIds, players, controllerId) {
  const validIds = new Set(players.map((player) => player.id).filter((id) => id !== controllerId));
  return [...new Set((disabledIds || []).filter((id) => typeof id === "string" && validIds.has(id)))];
}

function isPlayerBuzzerEnabled(settings, playerId) {
  const controllerId = getControllerId();
  if (playerId === controllerId) {
    return false;
  }
  const disabledPlayerIds = normalizeDisabledPlayerIds(settings.disabledPlayerIds, currentParticipants(), controllerId);
  return !disabledPlayerIds.includes(playerId);
}

function getRound() {
  return getSafeState("round", {
    status: ROUND_STATUSES.IDLE,
    opensAt: null,
    closesAt: null,
    remainingCs: null,
    winnerId: null,
    winnerOption: null,
    winnerAnswer: null,
    winnerName: null,
    buzzedPlayerIds: [],
    roulette: {
      active: false,
      startedAt: null,
      mode: "additive",
      topAmount: 1000,
      ceiling: 0,
      targetPlayerId: null,
      targetPlayerName: null,
      selections: {},
      completedPlayerIds: [],
      finalValue: null,
      finishedAt: null,
    },
    screw: {
      active: false,
      screwerId: null,
      screwerName: null,
      screweeId: null,
      screeeName: null,
      screwTimerMs: null,
    },
    screwsUsed: 0,
  });
}

function getScores() {
  return getSafeState("scores", {});
}

function getLog() {
  return getSafeState("gameLog", []);
}

function getControllerId() {
  return getSafeState("controllerId", null);
}

function getController() {
  const id = getControllerId();
  return currentParticipants().find((p) => p.id === id) || null;
}

function isControllerPlayer() {
  return me().id === getControllerId();
}

function canBuzz(playerId, option) {
  const round = getRound();
  const controllerId = getControllerId();
  const settings = getSettings();
  if (playerId === controllerId) {
    return false;
  }
  if (round.status !== ROUND_STATUSES.OPEN) {
    return false;
  }
  
  // If screw is active with a timer running, only screwee can buzz
  if (round.screw.active && round.screw.screwTimerMs !== null && round.screw.screwTimerMs > 0) {
    return playerId === round.screw.screweeId;
  }
  
  // If screw is active but timer not started, no one can buzz
  if (round.screw.active) {
    return false;
  }
  
  if (!settings.rebuzzAllowed && round.buzzedPlayerIds.includes(playerId)) {
    return false;
  }
  if (!isPlayerBuzzerEnabled(settings, playerId)) {
    return false;
  }
  if (option !== undefined) {
    if (!isOptionEnabled(settings, option)) {
      return false;
    }
  }
  return true;
}

function getTimeLeftCs(round, settings) {
  if (!round || round.status === ROUND_STATUSES.IDLE) {
    return settings.timeOpen * 100;
  }
  if (round.status === ROUND_STATUSES.LOCKED && typeof round.remainingCs === "number") {
    return round.remainingCs;
  }
  if (round.status === ROUND_STATUSES.CLOSED && typeof round.remainingCs === "number") {
    return round.remainingCs;
  }
  if (round.status === ROUND_STATUSES.OPEN && round.closesAt) {
    const msLeft = Math.max(0, round.closesAt - now());
    return Math.ceil(msLeft / 10);
  }
  return settings.timeOpen * 100;
}

function formatSeconds(cs) {
  return (cs / 100).toFixed(2);
}

function updateTimerDisplays() {
  const round = getRound();
  const settings = getSettings();
  const timeLeftText = `${formatSeconds(getTimeLeftCs(round, settings))}s`;
  document.querySelectorAll("[data-live-time-left]").forEach((element) => {
    element.textContent = timeLeftText;
  });
}

function getUiSignature() {
  const round = getRound();
  const settings = getSettings();
  const pendingLogId = getSafeState("pendingLogId", null);
  return JSON.stringify({
    round: {
      status: round.status,
      opensAt: round.opensAt,
      closesAt: round.closesAt,
      remainingCs: round.remainingCs,
      winnerId: round.winnerId,
      winnerOption: round.winnerOption,
      winnerAnswer: round.winnerAnswer,
      winnerName: round.winnerName,
      buzzedPlayerIds: round.buzzedPlayerIds,
      roulette: round.roulette,
      screw: round.screw,
      screwsUsed: round.screwsUsed,
    },
    settings: {
      inputMode: settings.inputMode,
      optionCount: settings.optionCount,
      rebuzzAllowed: settings.rebuzzAllowed,
      lockAfterBuzz: settings.lockAfterBuzz,
      closeBuzzersOnPointsGiven: settings.closeBuzzersOnPointsGiven,
      showScoresToPlayers: settings.showScoresToPlayers,
      disabledOptions: settings.disabledOptions,
      disabledPlayerIds: settings.disabledPlayerIds,
      scoringMode: settings.scoringMode,
      uniformPoints: settings.uniformPoints,
      jackMultiplier: settings.jackMultiplier,
      allowScrewing: settings.allowScrewing,
      valueSelectionMethod: settings.valueSelectionMethod,
      rouletteMode: settings.rouletteMode,
      rouletteTopAmount: settings.rouletteTopAmount,
      rouletteSinglePlayerTarget: settings.rouletteSinglePlayerTarget,
    },
    pendingLogId,
    controllerId: getControllerId(),
    participantCount: currentParticipants().length,
  });
}

function computeBasePoints(settings, timeLeftCs, round = getRound()) {
  if (round?.roulette?.finalValue !== null && round?.roulette?.finalValue !== undefined) {
    return Math.max(0, Number(round.roulette.finalValue) || 0);
  }
  if (settings.scoringMode === "uniform") {
    return settings.uniformPoints;
  }
  return Math.max(0, Math.round(timeLeftCs * settings.jackMultiplier));
}

function normalizeRouletteTopAmount(value) {
  const allowed = [500, 1000, 1500, 2000];
  const numeric = Number(value);
  return allowed.includes(numeric) ? numeric : 1000;
}

function seededFraction(seed) {
  const raw = Math.sin(seed * 12.9898) * 43758.5453;
  return raw - Math.floor(raw);
}

function getRouletteFrame(roulette, tick = null) {
  const ceiling = Math.max(1, Number(roulette?.ceiling || 0) || 1);
  const currentTick = tick === null ? Math.floor(Math.max(0, now() - Number(roulette?.startedAt || now())) / 500) : Number(tick);
  const pattern = ROULETTE_PATTERN[currentTick % ROULETTE_PATTERN.length];
  const min = Math.max(1, Math.floor(ceiling * pattern.min));
  const max = Math.max(min, Math.floor(ceiling * pattern.max));
  const value = clamp(Math.round(min + seededFraction(currentTick + ceiling) * (max - min)), 1, ceiling);
  return { tick: currentTick, label: pattern.label, value, ceiling };
}

function getRoulettePlayers() {
  return currentParticipants().filter((player) => player.id !== getControllerId());
}

function isRoulettePlayerAllowed(roulette, playerId) {
  if (!roulette?.active) {
    return false;
  }
  if (roulette.mode === "single-player") {
    return playerId === roulette.targetPlayerId;
  }
  return playerId !== getControllerId();
}

function getRouletteExpectedCount(roulette) {
  if (!roulette?.active) {
    return 0;
  }
  if (roulette.mode === "single-player") {
    return 1;
  }
  return getRoulettePlayers().length;
}

function getRouletteFinalValue(roulette) {
  const values = Object.values(roulette?.selections || {}).map((selection) => Number(selection.value) || 0);
  if (values.length === 0) {
    return 0;
  }
  if (roulette.mode === "highest") {
    return Math.max(...values);
  }
  if (roulette.mode === "single-player") {
    const targetSelection = roulette.selections?.[roulette.targetPlayerId] || null;
    return Number(targetSelection?.value || 0);
  }
  return values.reduce((total, value) => total + value, 0);
}

function startRouletteAnimationLoop() {
  if (rouletteAnimationInterval) {
    return;
  }
  rouletteAnimationInterval = setInterval(() => {
    if (getRound().status === ROUND_STATUSES.ROULETTE) {
      render();
    }
  }, 500);
}

function getSelectedRouletteTarget(settings, players) {
  if (settings.rouletteMode !== "single-player" || players.length === 0) {
    return null;
  }

  const preferredId = settings.rouletteSinglePlayerTarget;
  if (typeof preferredId === "string" && preferredId !== "random") {
    const preferredPlayer = players.find((player) => player.id === preferredId);
    if (preferredPlayer) {
      return preferredPlayer;
    }
  }

  const randomIndex = Math.floor(Math.random() * players.length);
  return players[randomIndex] || null;
}

function maybeFinalizeRoulettePhase() {
  if (!isHost()) {
    return false;
  }

  const round = getRound();
  const roulette = round.roulette;
  if (round.status !== ROUND_STATUSES.ROULETTE || !roulette?.active) {
    return false;
  }

  const expectedCount = getRouletteExpectedCount(roulette);
  const completedCount = Array.isArray(roulette.completedPlayerIds) ? roulette.completedPlayerIds.length : 0;
  if (completedCount < expectedCount) {
    return false;
  }

  const settings = getSettings();
  const finalValue = clamp(getRouletteFinalValue(roulette), 1, roulette.ceiling || normalizeRouletteTopAmount(settings.rouletteTopAmount));
  const openedAt = now();

  setState(
    "round",
    {
      ...round,
      status: ROUND_STATUSES.OPEN,
      opensAt: openedAt,
      closesAt: openedAt + settings.timeOpen * 1000,
      remainingCs: settings.timeOpen * 100,
      winnerId: null,
      winnerOption: null,
      winnerAnswer: null,
      winnerName: null,
      roulette: {
        ...roulette,
        active: false,
        finalValue,
        finishedAt: openedAt,
      },
    },
    true,
  );
  render();
  return true;
}

function startRoulettePhase() {
  if (!isHost()) {
    return { ok: false, reason: "Only host can start roulette." };
  }

  const settings = getSettings();
  const round = getRound();
  const players = getRoulettePlayers();
  const topAmount = normalizeRouletteTopAmount(settings.rouletteTopAmount);
  const ceiling = Math.max(1, Math.floor(topAmount / Math.max(1, players.length || 1)));
  const targetPlayer = getSelectedRouletteTarget(settings, players);

  if (players.length === 0) {
    setState(
      "round",
      {
        ...round,
        status: ROUND_STATUSES.OPEN,
        opensAt: now(),
        closesAt: now() + settings.timeOpen * 1000,
        remainingCs: settings.timeOpen * 100,
        winnerId: null,
        winnerOption: null,
        winnerAnswer: null,
        winnerName: null,
        roulette: {
          ...round.roulette,
          active: false,
          startedAt: null,
          mode: settings.rouletteMode,
          topAmount,
          ceiling,
          targetPlayerId: null,
          targetPlayerName: null,
          selections: {},
          completedPlayerIds: [],
          finalValue: null,
          finishedAt: now(),
        },
      },
      true,
    );
    setState("pendingLogId", null, true);
    render();
    return { ok: true, message: "No players available for roulette, opening buzzers." };
  }

  setState(
    "round",
    {
      ...round,
      status: ROUND_STATUSES.ROULETTE,
      opensAt: null,
      closesAt: null,
      remainingCs: settings.timeOpen * 100,
      winnerId: null,
      winnerOption: null,
      winnerAnswer: null,
      winnerName: null,
      buzzedPlayerIds: [],
      roulette: {
        active: true,
        startedAt: now(),
        mode: settings.rouletteMode,
        topAmount,
        ceiling,
        targetPlayerId: targetPlayer ? targetPlayer.id : null,
        targetPlayerName: targetPlayer ? getPlayerName(targetPlayer) : null,
        selections: {},
        completedPlayerIds: [],
        finalValue: null,
        finishedAt: null,
      },
      screw: {
        active: false,
        screwerId: null,
        screwerName: null,
        screweeId: null,
        screeeName: null,
        screwTimerMs: null,
      },
    },
    true,
  );
  setState("pendingLogId", null, true);
  render();
  return {
    ok: true,
    message: settings.rouletteMode === "single-player" && targetPlayer
      ? `${getPlayerName(targetPlayer)} will stop the roulette.`
      : "Roulette started.",
  };
}

function renderRoulettePanel(settings, round, mePlayer) {
  const roulette = round.roulette || {};
  const currentFrame = getRouletteFrame(roulette);
  const playerSelection = roulette.selections?.[mePlayer.id] || null;
  const completedCount = Array.isArray(roulette.completedPlayerIds) ? roulette.completedPlayerIds.length : 0;
  const expectedCount = getRouletteExpectedCount(roulette);
  const canStop = isRoulettePlayerAllowed(roulette, mePlayer.id) && !playerSelection;
  const modeLabel = {
    additive: "Additive",
    highest: "Highest value",
    "single-player": "Single-player",
  }[roulette.mode || settings.rouletteMode] || "Additive";
  const targetText = roulette.mode === "single-player"
    ? roulette.targetPlayerName
      ? `Only ${roulette.targetPlayerName} can stop this round.`
      : "Waiting to choose a player."
    : "Everyone can stop when they want to lock in their number.";
  const displayedValue = playerSelection ? Number(playerSelection.value || 0) : currentFrame.value;
  const displayedLabel = playerSelection ? "Locked" : currentFrame.label;
  const completedLabel = expectedCount > 0 ? `${completedCount}/${expectedCount} players locked in.` : "Waiting for players.";

  return `
    <section class="card player-card roulette-card">
      <h2>Value Roulette</h2>
      <p class="muted">${modeLabel} mode · Top amount ${roulette.topAmount || normalizeRouletteTopAmount(settings.rouletteTopAmount)} · Ceiling ${roulette.ceiling || 0}</p>
      <div class="roulette-display" aria-live="polite">
        <span class="roulette-value">${displayedValue}</span>
        <span class="roulette-label">${displayedLabel}</span>
      </div>
      <p class="muted">${targetText}</p>
      <p class="muted">${completedLabel}</p>
      ${playerSelection
        ? `<p class="roulette-locked-note">You locked in ${Number(playerSelection.value || 0)}.</p>`
        : `<button type="button" class="roulette-stop" data-roulette-stop ${canStop ? "" : "disabled"}>STOP</button>`}
    </section>
  `;
}

function updateScoresForLogEntry(logId, newAwardedDelta) {
  if (!isHost()) {
    return;
  }
  const log = getLog();
  const entryIndex = log.findIndex((entry) => entry.id === logId);
  if (entryIndex < 0) {
    return;
  }

  const entry = log[entryIndex];
  const round = getRound();
  const oldAwarded = Number(entry.awardedDelta || 0);
  let nextAwarded = Number(newAwardedDelta || 0);
  
  // Handle screw scoring: reverse the points if screw is active
  if (round.screw.active && round.screw.screweeId === entry.playerId) {
    nextAwarded = -nextAwarded;
  }
  
  const diff = nextAwarded - oldAwarded;

  const scores = getScores();
  scores[entry.playerId] = Number(scores[entry.playerId] || 0) + diff;
  
  // If screw is active, also update the screwer's score (opposite)
  if (round.screw.active && round.screw.screwerId) {
    const screwReverseDiff = -diff;
    scores[round.screw.screwerId] = Number(scores[round.screw.screwerId] || 0) + screwReverseDiff;
  }

  const updatedLog = [...log];
  updatedLog[entryIndex] = {
    ...entry,
    awardedDelta: nextAwarded,
    resolved: true,
    updatedAt: now(),
  };

  setState("scores", scores, true);
  setState("gameLog", updatedLog, true);

  const pendingId = getSafeState("pendingLogId", null);
  if (pendingId === logId) {
    setState("pendingLogId", null, true);
    if (round.status === ROUND_STATUSES.LOCKED) {
      const settings = getSettings();
      const shouldCloseOnPointsGiven =
        Boolean(settings.lockAfterBuzz) && Boolean(settings.closeBuzzersOnPointsGiven) && nextAwarded > 0;
      const remainingCs = Number.isFinite(round.remainingCs) ? Math.max(0, Number(round.remainingCs)) : 0;

      if (shouldCloseOnPointsGiven || remainingCs <= 0) {
        setState(
          "round",
          {
            ...round,
            status: ROUND_STATUSES.CLOSED,
            winnerId: null,
            winnerOption: null,
            winnerName: null,
          },
          true,
        );
        // Close screw mode after ruling
        closeScrewMode();
        render();
        return;
      }

      const reopenedAt = now();
      setState(
        "round",
        {
          ...round,
          status: ROUND_STATUSES.OPEN,
          opensAt: reopenedAt,
          closesAt: reopenedAt + remainingCs * 10,
          remainingCs,
          winnerId: null,
          winnerOption: null,
          winnerAnswer: null,
          winnerName: null,
        },
        true,
      );
    }
  }

  render();
}

function pushBuzzLogEntry(player, { option = null, answerText = null }, timeLeftCs) {
  const settings = getSettings();
  const points = computeBasePoints(settings, timeLeftCs);
  const entry = {
    id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "buzz",
    ts: now(),
    playerId: player.id,
    playerName: getPlayerName(player),
    option,
    answerText,
    timeLeftCs,
    scoringMode: settings.scoringMode,
    jackMultiplier: settings.jackMultiplier,
    uniformPoints: settings.uniformPoints,
    basePoints: points,
    awardedDelta: 0,
    resolved: false,
  };

  const log = getLog();
  setState("gameLog", [...log, entry], true);
  return entry;
}

function hostHandleBuzz(player, payload) {
  const settings = getSettings();
  const round = getRound();
  const shouldLockAfterBuzz = settings.lockAfterBuzz && !settings.rebuzzAllowed;
  const usingTextEntry = settings.inputMode === "text";

  let validOption = null;
  let answerText = null;

  if (usingTextEntry) {
    answerText = String(payload?.answerText || "").trim();
    if (!answerText) {
      return { ok: false, reason: "Answer cannot be empty." };
    }
    if (answerText.length > 120) {
      return { ok: false, reason: "Answer is too long." };
    }
  } else {
    validOption = Number(payload?.option);
    if (!Number.isInteger(validOption) || validOption < 1 || validOption > settings.optionCount) {
      return { ok: false, reason: "Invalid option." };
    }
  }

  if (!canBuzz(player.id, validOption === null ? undefined : validOption)) {
    return { ok: false, reason: "Buzzers are not open, disabled, or you already buzzed." };
  }

  const timeLeftCs = getTimeLeftCs(round, settings);
  const logEntry = pushBuzzLogEntry(
    player,
    {
      option: validOption,
      answerText,
    },
    timeLeftCs,
  );
  const buzzedPlayerIds = round.buzzedPlayerIds.includes(player.id)
    ? round.buzzedPlayerIds
    : [...round.buzzedPlayerIds, player.id];

  if (shouldLockAfterBuzz) {
    setState(
      "round",
      {
        ...round,
        status: ROUND_STATUSES.LOCKED,
        winnerId: player.id,
        winnerOption: validOption,
        winnerAnswer: answerText,
        winnerName: getPlayerName(player),
        remainingCs: timeLeftCs,
        buzzedPlayerIds,
      },
      true,
    );
    setState("pendingLogId", logEntry.id, true);
      // If the Host pre-set a correct answer for this round, auto-evaluate immediately
      try {
        const currentRound = getRound();
        let isCorrect = false;
        if (settings.inputMode === "text" && currentRound.correctAnswer) {
          const correct = String(currentRound.correctAnswer || "").trim().toLowerCase();
          if (answerText && String(answerText).trim().toLowerCase() === correct) {
            isCorrect = true;
          }
        } else if (settings.inputMode !== "text" && Array.isArray(currentRound.correctOptions) && currentRound.correctOptions.length > 0) {
          if (validOption !== null && currentRound.correctOptions.map(Number).includes(Number(validOption))) {
            isCorrect = true;
          }
        }

          if (isCorrect) {
            // award base points automatically
            updateScoresForLogEntry(logEntry.id, logEntry.basePoints);
        }
      } catch (e) {
        // ignore auto-eval errors
      }
  } else {
    setState(
      "round",
      {
        ...round,
        buzzedPlayerIds,
      },
      true,
    );
  }

  render();

  return {
    ok: true,
    message: shouldLockAfterBuzz
      ? usingTextEntry
        ? `${getPlayerName(player)} locked in an answer.`
        : `${getPlayerName(player)} locked in option ${validOption}.`
      : usingTextEntry
        ? `${getPlayerName(player)} submitted an answer.`
        : `${getPlayerName(player)} buzzed option ${validOption}.`,
  };
}

async function submitResponse(payload) {
  if (isControllerPlayer()) {
    return;
  }
  try {
    const result = await RPC.call("buzz", payload, RPC.Mode.HOST);
    if (result?.ok === false) {
      setBuzzNotice(result.reason || "Buzz blocked.");
      render();
      return;
    }
    if (result?.message) {
      setBuzzNotice(result.message);
    } else {
      setBuzzNotice("Buzz sent.");
    }
    render();
  } catch {
    setBuzzNotice("Could not send buzz. Check connection/room.");
    render();
  }
}

function openBuzzers() {
  if (!isHost()) {
    return;
  }
  console.log("openBuzzers: host triggered");
  const settings = getSettings();
  if (settings.valueSelectionMethod === "roulette") {
    startRoulettePhase();
    return;
  }
  const openedAt = now();
  const closesAt = openedAt + settings.timeOpen * 1000;
  const round = getRound();
  setState(
    "round",
    {
      ...round,
      status: ROUND_STATUSES.OPEN,
      opensAt: openedAt,
      closesAt,
      remainingCs: settings.timeOpen * 100,
      winnerId: null,
      winnerOption: null,
      winnerAnswer: null,
      winnerName: null,
      buzzedPlayerIds: [],
      roulette: {
        ...round.roulette,
        active: false,
        startedAt: null,
        mode: settings.rouletteMode,
        topAmount: normalizeRouletteTopAmount(settings.rouletteTopAmount),
        ceiling: 0,
        targetPlayerId: null,
        targetPlayerName: null,
        selections: {},
        completedPlayerIds: [],
        finalValue: null,
        finishedAt: null,
      },
      screw: {
        active: false,
        screwerId: null,
        screwerName: null,
        screweeId: null,
        screeeName: null,
        screwTimerMs: null,
      },
    },
    true,
  );
  setState("pendingLogId", null, true);
  render();
}

function closeBuzzers() {
  if (!isHost()) return;
  console.log("closeBuzzers: host triggered");
  const settings = getSettings();
  const round = getRound();
  setState(
    "round",
    {
      ...round,
      status: ROUND_STATUSES.CLOSED,
      remainingCs: getTimeLeftCs(round, settings),
      winnerId: null,
      winnerOption: null,
      winnerAnswer: null,
      winnerName: null,
      roulette: {
        ...round.roulette,
        active: false,
      },
      screw: {
        active: false,
        screwerId: null,
        screwerName: null,
        screweeId: null,
        screeeName: null,
        screwTimerMs: null,
      },
    },
    true,
  );
  setState("pendingLogId", null, true);
  render();
}

function resetRound() {
  if (!isHost()) {
    return;
  }
  const settings = getSettings();
  setState(
    "round",
    {
      status: ROUND_STATUSES.IDLE,
      opensAt: null,
      closesAt: null,
      remainingCs: settings.timeOpen * 100,
      winnerId: null,
      winnerOption: null,
      winnerAnswer: null,
      winnerName: null,
      buzzedPlayerIds: [],
      roulette: {
        active: false,
        startedAt: null,
        mode: settings.rouletteMode,
        topAmount: normalizeRouletteTopAmount(settings.rouletteTopAmount),
        ceiling: 0,
        targetPlayerId: null,
        targetPlayerName: null,
        selections: {},
        completedPlayerIds: [],
        finalValue: null,
        finishedAt: null,
      },
      screw: {
        active: false,
        screwerId: null,
        screwerName: null,
        screweeId: null,
        screeeName: null,
        screwTimerMs: null,
      },
    },
    true,
  );
  setState("pendingLogId", null, true);
  render();
}

function initiateScrew(screwerId) {
  if (!isHost()) {
    return { ok: false, reason: "Only host can initiate screw." };
  }
  const round = getRound();
  const settings = getSettings();
  
  if (!settings.allowScrewing) {
    return { ok: false, reason: "Screwing is not enabled." };
  }
  if (round.status !== ROUND_STATUSES.OPEN) {
    return { ok: false, reason: "Buzzers are not open." };
  }
  if (round.screw.active) {
    return { ok: false, reason: "A screw is already in progress." };
  }
  if (round.screwsUsed >= 1) {
    return { ok: false, reason: "A screw has already been used this game." };
  }
  
  const screwer = currentParticipants().find((p) => p.id === screwerId);
  if (!screwer) {
    return { ok: false, reason: "Invalid screwer." };
  }
  
  setState(
    "round",
    {
      ...round,
      screw: {
        ...round.screw,
        active: true,
        screwerId,
        screwerName: getPlayerName(screwer),
        screweeId: null,
        screeeName: null,
        screwTimerMs: null,
      },
    },
    true,
  );
  
  setBuzzNotice("A screw is being used...");
  render();
  return { ok: true, message: `${getPlayerName(screwer)} initiated a screw.` };
}

function selectScrewee(screweeId) {
  if (!isHost()) {
    return { ok: false, reason: "Only host can select screwee." };
  }
  const round = getRound();
  
  if (!round.screw.active) {
    return { ok: false, reason: "No screw in progress." };
  }
  if (round.screw.screweeId !== null) {
    return { ok: false, reason: "Screwee already selected." };
  }
  
  const screwee = currentParticipants().find((p) => p.id === screweeId);
  if (!screwee) {
    return { ok: false, reason: "Invalid screwee." };
  }
  if (screwee.id === getControllerId()) {
    return { ok: false, reason: "Cannot screw the host." };
  }
  if (screwee.id === round.screw.screwerId) {
    return { ok: false, reason: "Cannot screw yourself." };
  }
  
  setState(
    "round",
    {
      ...round,
      screw: {
        ...round.screw,
        screweeId,
        screeeName: getPlayerName(screwee),
        screwTimerMs: null,
      },
    },
    true,
  );
  
  render();
  return { ok: true, message: `${round.screw.screwerName} is screwing over ${getPlayerName(screwee)}.` };
}

function startScrewTimer() {
  if (!isHost()) {
    return { ok: false, reason: "Only host can start screw timer." };
  }
  const round = getRound();
  
  if (!round.screw.active || !round.screw.screweeId) {
    return { ok: false, reason: "No screw in progress or screwee not selected." };
  }
  
  setState(
    "round",
    {
      ...round,
      screw: {
        ...round.screw,
        screwTimerMs: 5000,
      },
    },
    true,
  );
  
  render();
  return { ok: true, message: "Screw timer started." };
}

function closeScrewMode() {
  if (!isHost()) {
    return;
  }
  const round = getRound();
  setState(
    "round",
    {
      ...round,
      screw: {
        active: false,
        screwerId: null,
        screwerName: null,
        screweeId: null,
        screeeName: null,
        screwTimerMs: null,
      },
      screwsUsed: round.screwsUsed + 1,
    },
    true,
  );
  render();
}

function resetScrews() {
  if (!isHost()) {
    return;
  }
  const round = getRound();
  setState(
    "round",
    {
      ...round,
      screw: {
        active: false,
        screwerId: null,
        screwerName: null,
        screweeId: null,
        screeeName: null,
        screwTimerMs: null,
      },
      screwsUsed: 0,
    },
    true,
  );
  render();
}

function hostTick() {
  if (!isHost()) {
    return;
  }
  const round = getRound();
  if (round.status === ROUND_STATUSES.ROULETTE) {
    if (maybeFinalizeRoulettePhase()) {
      return;
    }
    render();
    return;
  }
  if (round.status !== ROUND_STATUSES.OPEN) {
    return;
  }
  
  // Handle screw timer
  if (round.screw.active && round.screw.screwTimerMs !== null && round.screw.screwTimerMs > 0) {
    const nextMs = Math.max(0, round.screw.screwTimerMs - 100);
    setState(
      "round",
      {
        ...round,
        screw: {
          ...round.screw,
          screwTimerMs: nextMs,
        },
      },
      true,
    );
    
    if (nextMs <= 0) {
      // Screw timer expired - check if screwee buzzed
      const pendingId = getSafeState("pendingLogId", null);
      if (!pendingId) {
        // Screwee didn't buzz - auto-fail them
        const screweePlayer = currentParticipants().find((p) => p.id === round.screw.screweeId);
        if (screweePlayer) {
          const settings = getSettings();
          const basePoints = computeBasePoints(settings, round.remainingCs || settings.timeOpen * 100, round);
          const entry = {
            id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: "buzz",
            ts: now(),
            playerId: round.screw.screweeId,
            playerName: round.screw.screeeName,
            option: null,
            answerText: "[No answer - Screw timeout]",
            timeLeftCs: round.remainingCs || settings.timeOpen * 100,
            scoringMode: settings.scoringMode,
            jackMultiplier: settings.jackMultiplier,
            uniformPoints: settings.uniformPoints,
            valueSelectionMethod: settings.valueSelectionMethod,
            rouletteMode: settings.rouletteMode,
            rouletteTopAmount: settings.rouletteTopAmount,
            rouletteFinalValue: round.roulette?.finalValue ?? null,
            basePoints: basePoints,
            awardedDelta: -basePoints,
            resolved: true,
          };
          const log = getLog();
          setState("gameLog", [...log, entry], true);
          
          // Auto-award points (screwee loses, screwer gains)
          const scores = getScores();
          scores[round.screw.screweeId] = Number(scores[round.screw.screweeId] || 0) - basePoints;
          scores[round.screw.screwerId] = Number(scores[round.screw.screwerId] || 0) + basePoints;
          setState("scores", scores, true);
        }
      }
      closeScrewMode();
    }
    render();
    return;
  }
  
  // When screw is active but timer not started, don't tick main timer
  if (round.screw.active) {
    render();
    return;
  }
  
  // Normal timer tick
  const settings = getSettings();
  const timeLeftCs = getTimeLeftCs(round, settings);
  if (timeLeftCs <= 0) {
    setState(
      "round",
      {
        ...round,
        status: ROUND_STATUSES.CLOSED,
        remainingCs: 0,
        winnerId: null,
        winnerOption: null,
        winnerAnswer: null,
        winnerName: null,
      },
      true,
    );
    setState("pendingLogId", null, true);
    render();
  }
}

function setHostSetting(key, value) {
  if (!isHost()) {
    return;
  }
  const settings = getSettings();
  const next = { ...settings, [key]: value };
  if (key === "scoringMode" && value === "uniform") {
    next.uniformPoints = settings.uniformPoints || 1000;
  }
  if (key === "scoringMode" && value === "jack") {
    next.jackMultiplier = settings.jackMultiplier || 1;
  }
  if (key === "optionCount") {
    next.disabledOptions = normalizeDisabledOptions(settings.disabledOptions, value);
  }
  if (key === "inputMode" && value === "text") {
    next.optionCount = settings.optionCount || 4;
    next.disabledOptions = normalizeDisabledOptions([], settings.optionCount || 4);
  }
  if (key === "rouletteTopAmount") {
    next.rouletteTopAmount = normalizeRouletteTopAmount(value);
  }
  setState("settings", next, true);
  render();
}

function toggleBuzzerOption(option) {
  if (!isHost()) {
    return;
  }
  const settings = getSettings();
  const opt = Number(option);
  if (!Number.isInteger(opt) || opt < 1 || opt > settings.optionCount) {
    return;
  }

  const disabledOptions = normalizeDisabledOptions(settings.disabledOptions, settings.optionCount);
  const currentlyDisabled = disabledOptions.includes(opt);
  const enabledCount = settings.optionCount - disabledOptions.length;

  if (!currentlyDisabled && enabledCount <= 1) {
    return;
  }

  const nextDisabled = currentlyDisabled
    ? disabledOptions.filter((value) => value !== opt)
    : [...disabledOptions, opt].sort((a, b) => a - b);

  setState(
    "settings",
    {
      ...settings,
      disabledOptions: nextDisabled,
    },
    true,
  );
  render();
}

function togglePlayerBuzzer(playerId) {
  if (!isHost()) {
    return;
  }

  const settings = getSettings();
  const players = currentParticipants();
  const controllerId = getControllerId();
  if (!players.some((player) => player.id === playerId) || playerId === controllerId) {
    return;
  }

  const disabledPlayerIds = normalizeDisabledPlayerIds(settings.disabledPlayerIds, players, controllerId);
  const currentlyDisabled = disabledPlayerIds.includes(playerId);
  const nextDisabled = currentlyDisabled
    ? disabledPlayerIds.filter((id) => id !== playerId)
    : [...disabledPlayerIds, playerId];

  setState(
    "settings",
    {
      ...settings,
      disabledPlayerIds: nextDisabled,
    },
    true,
  );
  render();
}

function assignControllerIfNeeded() {
  if (!isHost()) {
    return;
  }
  const current = getControllerId();
  if (current) {
    return;
  }
  setState("controllerId", me().id, true);
}

function ensureHostInit() {
  if (!isHost()) {
    return;
  }
  if (!getState("settings")) {
    setState("settings", DEFAULT_SETTINGS, true);
  }
  if (!getState("round")) {
    resetRound();
  }
  if (!getState("scores")) {
    setState("scores", {}, true);
  }
  if (!getState("gameLog")) {
    setState("gameLog", [], true);
  }
  if (getState("pendingLogId") === undefined) {
    setState("pendingLogId", null, true);
  }
  assignControllerIfNeeded();
}

function optionButtonLabel(option) {
  const labels = {
    1: "A",
    2: "B",
    3: "X",
    4: "Y",
  };
  return labels[option] || String(option);
}

function renderBuzzerPanel(settings, round, mePlayer, timeLeftCs) {
  console.log("renderBuzzerPanel: status=", round?.status, "timeLeftCs=", timeLeftCs, "me=", mePlayer?.id);
  if (isControllerPlayer()) {
    return `
      <section class="card player-card controller-card">
        <h2>Host Control Screen</h2>
        <p>You are the Host and do not have a buzzer input.</p>
      </section>
    `;
  }

  if (round.status === ROUND_STATUSES.ROULETTE) {
    return renderRoulettePanel(settings, round, mePlayer);
  }

  // Show screw player selection UI if screw is active but screwee not yet selected
  if (round.screw.active && !round.screw.screweeId && mePlayer.id === round.screw.screwerId) {
    const nonHostPlayers = currentParticipants().filter(
      (p) => p.id !== getControllerId() && p.id !== mePlayer.id
    );
    const playerButtons = nonHostPlayers
      .map((p) => `<button type="button" data-screw-player="${p.id}">${getPlayerName(p)}</button>`)
      .join("");
    
    return `
      <section class="card player-card">
        <h2>Select Who to Screw</h2>
        <p class="muted">Choose another player to screw over:</p>
        <div class="screw-player-list">${playerButtons}</div>
      </section>
    `;
  }

  // Show "hold up, a screw is getting used" message for other players during screw
  if (round.screw.active && mePlayer.id !== round.screw.screwerId && mePlayer.id !== round.screw.screweeId) {
    const timeText = round.screw.screwTimerMs !== null
      ? formatSeconds(Math.ceil(round.screw.screwTimerMs / 10))
      : "pending";
    
    return `
      <section class="card player-card">
        <h2>Hold Up!</h2>
        <p class="muted">A screw is being used by <strong>${round.screw.screwerName}</strong> on <strong>${round.screw.screeeName}</strong>.</p>
        <p class="muted">Time: <strong>${timeText}s</strong></p>
      </section>
    `;
  }

  // Show screw timer UI for the screwee
  if (round.screw.active && mePlayer.id === round.screw.screweeId) {
    const timeText = round.screw.screwTimerMs !== null
      ? formatSeconds(Math.ceil(round.screw.screwTimerMs / 10))
      : "waiting";
    const buzzerDisabled = round.screw.screwTimerMs === null || round.screw.screwTimerMs <= 0;
    
    if (settings.optionCount === 1) {
      return `
        <section class="card player-card">
          <h2>You're Being Screwed!</h2>
          <p class="muted">Screw timer: <strong>${timeText}s</strong></p>
          <p class="muted">Answer quickly!</p>
          <button type="button" class="big-red" data-buzz="1" ${buzzerDisabled ? "disabled" : ""}>BUZZ</button>
        </section>
      `;
    }
    
    if (settings.optionCount === 4) {
      const button = (opt, cls) => {
        return `<button type="button" class="${cls}" data-buzz="${opt}" ${buzzerDisabled ? "disabled" : ""}>${optionButtonLabel(opt)}</button>`;
      };
      return `
        <section class="card player-card">
          <h2>You're Being Screwed!</h2>
          <p class="muted">Screw timer: <strong>${timeText}s</strong></p>
          <p class="muted">Answer quickly!</p>
          <div class="abxy-diamond">
            ${button(4, "pos-y")}
            ${button(2, "pos-b")}
            ${button(3, "pos-x")}
            ${button(1, "pos-a")}
          </div>
        </section>
      `;
    }
  }

  const disabled = round.status !== ROUND_STATUSES.OPEN;
  const alreadyBuzzed = round.buzzedPlayerIds.includes(mePlayer.id);
  const rebuzzAllowed = Boolean(settings.rebuzzAllowed);
  const playerDisabled = !isPlayerBuzzerEnabled(settings, mePlayer.id);
  const screwInProgress = round.screw.active;
  const globalDisabled = disabled || (!rebuzzAllowed && alreadyBuzzed) || playerDisabled || screwInProgress;
  const helperText = playerDisabled
    ? "Your buzzer is disabled by the Host."
    : disabled
    ? "Buzzers are currently closed."
    : !rebuzzAllowed && alreadyBuzzed
      ? "You already buzzed this round."
      : screwInProgress
      ? "A screw is in progress."
      : "Buzz now.";
  const notice = getRecentBuzzNotice();
  const timeText = formatSeconds(timeLeftCs);
  const usingTextEntry = settings.inputMode === "text";

  if (usingTextEntry) {
    const disabledAttr = globalDisabled ? "disabled" : "";
    const textHelper = playerDisabled
      ? "Your answer input is disabled by the Host."
      : disabled
      ? "Answers are currently closed."
      : !rebuzzAllowed && alreadyBuzzed
        ? "You already submitted an answer this round."
        : screwInProgress
        ? "A screw is in progress."
        : "Type your answer and submit.";

    return `
      <section class="card player-card">
        <h2>Your Answer</h2>
        <p class="muted">${textHelper}</p>
        <p class="muted">Time left: <strong data-live-time-left>${timeText}s</strong></p>
        ${notice ? `<p class="muted">${notice}</p>` : ""}
        <div class="text-entry">
          <input id="answer-entry" type="text" maxlength="120" placeholder="Type your answer" ${disabledAttr} />
          <button data-answer-submit ${disabledAttr}>Submit Answer</button>
        </div>
      </section>
    `;
  }

  if (settings.optionCount === 1) {
    const optionDisabled = !isOptionEnabled(settings, 1);
    const disabledAttr = globalDisabled || optionDisabled ? "disabled" : "";
    const screwBtn = settings.allowScrewing && !disabled && !playerDisabled && !screwInProgress
      ? `<button type="button" class="screw-btn" data-screw>SCREW</button>`
      : "";
    
    return `
      <section class="card player-card">
        <h2>Your Buzzer</h2>
        <p class="muted">${optionDisabled ? "This buzzer is disabled by the Host." : helperText}</p>
        <p class="muted">Time left: <strong data-live-time-left>${timeText}s</strong></p>
        ${notice ? `<p class="muted">${notice}</p>` : ""}
        <button type="button" class="big-red" data-buzz="1" ${disabledAttr}>BUZZ</button>
        ${screwBtn}
      </section>
    `;
  }

  if (settings.optionCount === 6) {
    const buttons = [1, 2, 3, 4, 5, 6]
      .map((opt) => {
        const disabledAttr = globalDisabled || !isOptionEnabled(settings, opt) ? "disabled" : "";
        return `<button type="button" data-buzz="${opt}" ${disabledAttr}>${opt}</button>`;
      })
      .join("");
    const screwBtn = settings.allowScrewing && !disabled && !playerDisabled && !screwInProgress
      ? `<button type="button" class="screw-btn" data-screw>SCREW</button>`
      : "";
    
    return `
      <section class="card player-card">
        <h2>Your Buzzer</h2>
        <p class="muted">${helperText}</p>
        <p class="muted">Time left: <strong data-live-time-left>${timeText}s</strong></p>
        ${notice ? `<p class="muted">${notice}</p>` : ""}
        <div class="six-grid">${buttons}</div>
        ${screwBtn}
      </section>
    `;
  }

  if (settings.optionCount === 4) {
    const button = (opt, cls) => {
      const disabledAttr = globalDisabled || !isOptionEnabled(settings, opt) ? "disabled" : "";
      return `<button type="button" class="${cls}" data-buzz="${opt}" ${disabledAttr}>${optionButtonLabel(opt)}</button>`;
    };
    const screwBtn = settings.allowScrewing && !disabled && !playerDisabled && !screwInProgress
      ? `<button type="button" class="screw-btn" data-screw>SCREW</button>`
      : "";

    return `
      <section class="card player-card">
        <h2>Your Buzzer</h2>
        <p class="muted">${helperText}</p>
        <p class="muted">Time left: <strong data-live-time-left>${timeText}s</strong></p>
        ${notice ? `<p class="muted">${notice}</p>` : ""}
        <div class="abxy-diamond">
          ${button(4, "pos-y")}
          ${button(2, "pos-b")}
          ${button(3, "pos-x")}
          ${button(1, "pos-a")}
        </div>
        ${screwBtn}
      </section>
    `;
  }

  const max = settings.optionCount;
  const buttons = [1, 2, 3, 4]
    .filter((opt) => opt <= max)
    .map((opt) => {
      const disabledAttr = globalDisabled || !isOptionEnabled(settings, opt) ? "disabled" : "";
      return `<button type="button" data-buzz="${opt}" ${disabledAttr}>${optionButtonLabel(opt)}</button>`;
    })
    .join("");
  const screwBtn = settings.allowScrewing && !disabled && !playerDisabled && !screwInProgress
    ? `<button type="button" class="screw-btn" data-screw>SCREW</button>`
    : "";

  return `
    <section class="card player-card">
      <h2>Your Buzzer</h2>
      <p class="muted">${helperText}</p>
      <p class="muted">${timeText}</p>
      ${notice ? `<p class="muted">${notice}</p>` : ""}
      <div class="abxy">${buttons}</div>
      ${screwBtn}
    </section>
  `;
}

function renderBuzzerToggles(settings, settingDisabledAttr) {
  const options = Array.from({ length: settings.optionCount }, (_, index) => index + 1);
  const toggles = options
    .map((option) => {
      const enabled = isOptionEnabled(settings, option);
      const label = settings.optionCount <= 4 ? optionButtonLabel(option) : String(option);
      return `<button type="button" class="toggle-chip ${enabled ? "is-on" : "is-off"}" data-toggle-option="${option}" ${settingDisabledAttr}>${label} ${enabled ? "On" : "Off"}</button>`;
    })
    .join("");

  return `
    <div class="toggle-group">
      <span class="muted">Enabled buzzers</span>
      <div class="toggle-list">${toggles}</div>
    </div>
  `;
}

function renderPlayerToggles(settings, players, controllerId, settingDisabledAttr) {
  const nonControllerPlayers = players.filter((player) => player.id !== controllerId);
  if (nonControllerPlayers.length === 0) {
    return `
      <div class="toggle-group">
        <span class="muted">Player buzzers</span>
        <p class="muted">No non-Host participants connected yet.</p>
      </div>
    `;
  }

  const toggles = nonControllerPlayers
    .map((player) => {
      const enabled = isPlayerBuzzerEnabled(settings, player.id);
      return `<button class="toggle-chip ${enabled ? "is-on" : "is-off"}" data-toggle-player="${player.id}" ${settingDisabledAttr}>${getPlayerName(player)} ${enabled ? "On" : "Off"}</button>`;
    })
    .join("");

  return `
    <div class="toggle-group">
      <span class="muted">Player buzzers</span>
      <div class="toggle-list">${toggles}</div>
    </div>
  `;
}

function renderHostSettings(settings, round, timeLeftCs, players, controllerId) {
  if (!isControllerPlayer()) {
    return "";
  }

  const settingsLocked = round.status === ROUND_STATUSES.OPEN || round.status === ROUND_STATUSES.ROULETTE;
  const settingDisabledAttr = settingsLocked ? "disabled" : "";
  const nonControllerPlayers = players.filter((player) => player.id !== controllerId);
  const roulettePlayerCount = Math.max(1, nonControllerPlayers.length);
  const rouletteCeiling = Math.max(1, Math.floor(normalizeRouletteTopAmount(settings.rouletteTopAmount) / roulettePlayerCount));

  const statusText = {
    [ROUND_STATUSES.IDLE]: "Idle",
    [ROUND_STATUSES.OPEN]: "Open",
    [ROUND_STATUSES.ROULETTE]: "Roulette",
    [ROUND_STATUSES.LOCKED]: "Locked",
    [ROUND_STATUSES.CLOSED]: "Closed",
  }[round.status];

  return `
    <section class="card host-panel">
      <h2>Host Controls</h2>
      <div class="control-grid">
        <label>
          Time open
          <input type="number" min="1" max="120" step="1" value="${settings.timeOpen}" data-setting="timeOpen" ${settingDisabledAttr} />
        </label>

        <label>
          Lock buzzers after buzz
          <select data-setting="lockAfterBuzz" ${settingDisabledAttr}>
            <option value="true" ${settings.lockAfterBuzz ? "selected" : ""}>On</option>
            <option value="false" ${!settings.lockAfterBuzz ? "selected" : ""}>Off</option>
          </select>
        </label>

        <label>
          Re-Buzz allowed
          <select data-setting="rebuzzAllowed" ${settingDisabledAttr}>
            <option value="true" ${settings.rebuzzAllowed ? "selected" : ""}>On</option>
            <option value="false" ${!settings.rebuzzAllowed ? "selected" : ""}>Off</option>
          </select>
        </label>

        <label>
          Show scores to players
          <select data-setting="showScoresToPlayers" ${settingDisabledAttr}>
            <option value="true" ${settings.showScoresToPlayers ? "selected" : ""}>On</option>
            <option value="false" ${!settings.showScoresToPlayers ? "selected" : ""}>Off</option>
          </select>
        </label>

        <label>
          Answer mode
          <select data-setting="inputMode" ${settingDisabledAttr}>
            <option value="buttons" ${settings.inputMode !== "text" ? "selected" : ""}>Button buzzer</option>
            <option value="text" ${settings.inputMode === "text" ? "selected" : ""}>Text entry</option>
          </select>
        </label>

        ${
          settings.lockAfterBuzz
            ? `<label>
                Close buzzers on points given
                <select data-setting="closeBuzzersOnPointsGiven" ${settingDisabledAttr}>
                  <option value="true" ${settings.closeBuzzersOnPointsGiven ? "selected" : ""}>On</option>
                  <option value="false" ${!settings.closeBuzzersOnPointsGiven ? "selected" : ""}>Off</option>
                </select>
              </label>`
            : ""
        }

        ${
          settings.inputMode === "text"
            ? ""
            : `<label>
                Option count
                <select data-setting="optionCount" ${settingDisabledAttr}>
                  <option value="1" ${settings.optionCount === 1 ? "selected" : ""}>1</option>
                  <option value="2" ${settings.optionCount === 2 ? "selected" : ""}>2</option>
                  <option value="4" ${settings.optionCount === 4 ? "selected" : ""}>4</option>
                  <option value="6" ${settings.optionCount === 6 ? "selected" : ""}>6</option>
                </select>
              </label>`
        }

        <label>
          Scoring
          <select data-setting="scoringMode" ${settingDisabledAttr}>
            <option value="uniform" ${settings.scoringMode === "uniform" ? "selected" : ""}>Uniform</option>
            <option value="jack" ${settings.scoringMode === "jack" ? "selected" : ""}>JACK</option>
          </select>
        </label>

        ${
          settings.scoringMode === "uniform"
            ? `<label>
                Uniform points
                  <select data-setting="uniformPoints" ${settingDisabledAttr}>
                  <option value="1000" ${settings.uniformPoints === 1000 ? "selected" : ""}>1000</option>
                  <option value="2000" ${settings.uniformPoints === 2000 ? "selected" : ""}>2000</option>
                  <option value="3000" ${settings.uniformPoints === 3000 ? "selected" : ""}>3000</option>
                </select>
              </label>`
            : `<label>
                JACK multiplier
                  <select data-setting="jackMultiplier" ${settingDisabledAttr}>
                  <option value="1" ${settings.jackMultiplier === 1 ? "selected" : ""}>1x</option>
                  <option value="2" ${settings.jackMultiplier === 2 ? "selected" : ""}>2x</option>
                  <option value="3" ${settings.jackMultiplier === 3 ? "selected" : ""}>3x</option>
                </select>
              </label>`
        }

        <label>
          Value selection
          <select data-setting="valueSelectionMethod" ${settingDisabledAttr}>
            <option value="standard" ${settings.valueSelectionMethod !== "roulette" ? "selected" : ""}>Standard</option>
            <option value="roulette" ${settings.valueSelectionMethod === "roulette" ? "selected" : ""}>Roulette</option>
          </select>
        </label>

        ${
          settings.valueSelectionMethod === "roulette"
            ? `<label>
                Roulette mode
                <select data-setting="rouletteMode" ${settingDisabledAttr}>
                  <option value="additive" ${settings.rouletteMode === "additive" ? "selected" : ""}>Additive</option>
                  <option value="highest" ${settings.rouletteMode === "highest" ? "selected" : ""}>Highest value</option>
                  <option value="single-player" ${settings.rouletteMode === "single-player" ? "selected" : ""}>Single-player</option>
                </select>
              </label>
              <label>
                Top amount
                <select data-setting="rouletteTopAmount" ${settingDisabledAttr}>
                  <option value="500" ${normalizeRouletteTopAmount(settings.rouletteTopAmount) === 500 ? "selected" : ""}>500</option>
                  <option value="1000" ${normalizeRouletteTopAmount(settings.rouletteTopAmount) === 1000 ? "selected" : ""}>1000</option>
                  <option value="1500" ${normalizeRouletteTopAmount(settings.rouletteTopAmount) === 1500 ? "selected" : ""}>1500</option>
                  <option value="2000" ${normalizeRouletteTopAmount(settings.rouletteTopAmount) === 2000 ? "selected" : ""}>2000</option>
                </select>
              </label>
              ${settings.rouletteMode === "single-player"
                ? `<label>
                    Single-player target
                    <select data-setting="rouletteSinglePlayerTarget" ${settingDisabledAttr}>
                      <option value="random" ${settings.rouletteSinglePlayerTarget === "random" ? "selected" : ""}>Random player</option>
                      ${nonControllerPlayers
                        .map((player) => `<option value="${player.id}" ${settings.rouletteSinglePlayerTarget === player.id ? "selected" : ""}>${escapeHtml(getPlayerName(player))}</option>`)
                        .join("")}
                    </select>
                  </label>`
                : ""}
              <div class="roulette-help muted">Ceiling per player: ${rouletteCeiling}. The locked roulette total becomes the round value.</div>`
            : ""
        }

        <label>
          Allow Screwing
          <select data-setting="allowScrewing" ${settingDisabledAttr}>
            <option value="true" ${settings.allowScrewing ? "selected" : ""}>On</option>
            <option value="false" ${!settings.allowScrewing ? "selected" : ""}>Off</option>
          </select>
        </label>
      </div>

      <!-- Pre-set correct answer UI -->
      <div class="correct-answer">
        <h3>Pre-set correct answer</h3>
        <p class="muted">Optionally set the correct answer before opening buzzers. Text mode is case-insensitive.</p>
        <div class="correct-controls">
          ${settings.inputMode === "text"
            ? `<label>Correct answer text
                 <input id="correct-answer-entry" type="text" maxlength="120" value="${escapeHtml(round.correctAnswer || "")}" ${settingDisabledAttr} />
                 <div style="margin-top:0.5rem">
                   <button type="button" data-set-correct-text ${settingDisabledAttr}>Set</button>
                   <button type="button" data-clear-correct ${settingDisabledAttr}>Clear</button>
                 </div>
               </label>`
            : `<div>
                 <span class="muted">Correct options</span>
                 <div class="toggle-list" style="margin-top:0.5rem">
                   ${Array.from({ length: settings.optionCount }, (_, i) => i + 1)
                     .map((opt) => {
                       const enabled = Array.isArray(round.correctOptions) && round.correctOptions.map(Number).includes(opt);
                       const label = settings.optionCount <= 4 ? optionButtonLabel(opt) : String(opt);
                       return `<button type="button" class="toggle-chip ${enabled ? "is-on" : "is-off"}" data-correct-option="${opt}" ${settingDisabledAttr}>${label} ${enabled ? "On" : "Off"}</button>`;
                     })
                     .join("")}
                 </div>
                 <div style="margin-top:0.5rem"><button type="button" data-clear-correct ${settingDisabledAttr}>Clear</button></div>
               </div>`}
        </div>
      </div>

      ${settings.inputMode === "text" ? "" : renderBuzzerToggles(settings, settingDisabledAttr)}
      ${renderPlayerToggles(settings, players, controllerId, settingDisabledAttr)}

      <div class="host-actions">
        <button type="button" data-host-action="open" ${round.status === ROUND_STATUSES.OPEN ? "disabled" : ""}>Open Buzzers</button>
        <button type="button" data-host-action="close">Close Buzzers</button>
        <button type="button" data-host-action="reset">Reset Round</button>
        ${settings.allowScrewing && round.screwsUsed >= 1 ? `<button type="button" data-host-action="reset-screws">Reset Screws</button>` : ""}
      </div>

      <div class="status-strip">
        <span>Status: <strong>${statusText}</strong></span>
        <span>Time left: <strong data-live-time-left>${formatSeconds(timeLeftCs)}s</strong></span>
        ${settings.rebuzzAllowed && settings.lockAfterBuzz ? "<span>Re-Buzz is on, so lock-after-buzz is ignored.</span>" : ""}
        ${settings.lockAfterBuzz && settings.closeBuzzersOnPointsGiven ? "<span>Buzzers close after a positive ruling.</span>" : ""}
        ${round.status === ROUND_STATUSES.ROULETTE ? "<span>Roulette is running.</span>" : ""}
        ${settingsLocked ? "<span>Settings are locked while buzzers are open.</span>" : ""}
      </div>
    </section>
  `;
}

function renderScrewNotice(round) {
  if (!isControllerPlayer() || !round.screw.active) {
    return "";
  }

  // Screw is active but screwee not selected yet - show waiting
  if (!round.screw.screweeId) {
    return `
      <section class="card screw-card">
        <h3>Screw In Progress</h3>
        <p><strong>${round.screw.screwerName}</strong> is selecting a target...</p>
      </section>
    `;
  }

  // Screwee selected but timer not started yet
  if (round.screw.screwTimerMs === null) {
    return `
      <section class="card screw-card">
        <h3>Screw Status</h3>
        <p><strong>${round.screw.screwerName}</strong> is screwing over <strong>${round.screw.screeeName}</strong>!</p>
        <button type="button" class="green" data-screw-start-timer>Start Timer (5s)</button>
      </section>
    `;
  }

  // Timer is running
  const timeText = formatSeconds(Math.ceil(round.screw.screwTimerMs / 10));
  return `
    <section class="card screw-card">
      <h3>Screw Timer</h3>
      <p><strong>${round.screw.screwerName}</strong> is screwing over <strong>${round.screw.screeeName}</strong>.</p>
      <p>Time left: <strong>${timeText}s</strong></p>
    </section>
  `;
}

function renderLockedRuling(settings, pendingEntry) {
  if (!isControllerPlayer() || !settings.lockAfterBuzz || !pendingEntry) {
    return "";
  }

  const plusVal = pendingEntry.basePoints;
  const minusVal = -pendingEntry.basePoints;

  const renderedAnswer = pendingEntry.answerText ? `\"${escapeHtml(pendingEntry.answerText)}\"` : pendingEntry.option;

  return `
    <section class="card ruling-card">
      <h3>Locked Ruling</h3>
      <p>
        ${pendingEntry.playerName} buzzed
        <strong>${renderedAnswer}</strong> with
        <strong>${formatSeconds(pendingEntry.timeLeftCs)}s</strong> left.
      </p>
      <p>Base points: <strong>${pendingEntry.basePoints}</strong></p>
      <div class="ruling-actions">
        <button type="button" class="green" data-ruling="${plusVal}" data-log-id="${pendingEntry.id}">Correct (+${plusVal})</button>
        <button type="button" class="red" data-ruling="${minusVal}" data-log-id="${pendingEntry.id}">Incorrect (${minusVal})</button>
      </div>
    </section>
  `;
}

function renderScores(players, scores) {
  const controllerId = getControllerId();
  const visiblePlayers = players.filter((player) => player.id !== controllerId);
  const items = visiblePlayers
    .map((player) => {
      const value = Number(scores[player.id] || 0);
      return `<li><span>${getPlayerName(player)}</span><strong>${value}</strong></li>`;
    })
    .join("");
  return `
    <section class="card score-card">
      <h2>Scores</h2>
      <ul>${items || "<li>No players yet.</li>"}</ul>
    </section>
  `;
}

function renderLog(log, settings) {
  const rows = [...log]
    .reverse()
    .map((entry) => {
      const controls = isControllerPlayer()
        ? `
          <div class="log-controls">
            <input type="number" value="${Number(entry.awardedDelta || 0)}" data-log-input="${entry.id}" />
            <button type="button" data-log-apply="${entry.id}">Apply</button>
            <button type="button" class="green" data-log-quick="plus" data-log-id="${entry.id}">+${entry.basePoints}</button>
            <button type="button" class="red" data-log-quick="minus" data-log-id="${entry.id}">-${entry.basePoints}</button>
          </div>
        `
        : "";

      return `
        <li>
          <div class="log-main">
            <span class="log-player">${entry.playerName}</span>
            <span>
              ${
                entry.answerText
                  ? `Answer \"${escapeHtml(entry.answerText)}\"`
                  : `Option ${settings.optionCount === 4 ? optionButtonLabel(entry.option) : entry.option}`
              }
            </span>
            <span>${formatSeconds(entry.timeLeftCs)}s</span>
            <span>${entry.scoringMode === "uniform" ? `U:${entry.uniformPoints}` : `Jx${entry.jackMultiplier}`}</span>
            <span>Base ${entry.basePoints}</span>
            <span>Score ${Number(entry.awardedDelta || 0)}</span>
          </div>
          ${controls}
        </li>
      `;
    })
    .join("");

  const helper = settings.lockAfterBuzz
    ? "All rulings are editable here after they are made."
    : "Buzzers stay open. Use this log to apply and edit rulings.";

  return `
    <section class="card log-card">
      <h2>Game Log</h2>
      <p class="muted">${helper}</p>
      <ul class="log-list">${rows || "<li>No rulings yet.</li>"}</ul>
    </section>
  `;
}

function renderHiddenPanel(title, helper) {
  return `
    <section class="card muted-card">
      <h2>${title}</h2>
      <p class="muted">${helper}</p>
    </section>
  `;
}

function render() {
  const mePlayer = me();
  const players = currentParticipants();
  const settings = getSettings();
  const round = getRound();
  const scores = getScores();
  const gameLog = getLog();
  const timeLeftCs = getTimeLeftCs(round, settings);
  const pendingLogId = getSafeState("pendingLogId", null);
  const pendingEntry = gameLog.find((entry) => entry.id === pendingLogId) || null;
  const controller = getController();
  const showAdminData = isControllerPlayer();
  const showScoresToPlayers = Boolean(settings.showScoresToPlayers);

  app.innerHTML = `
    <main class="layout">
      <header class="hero">
        <div>
          <h1>Playroom Buzzers</h1>
          <p>Room: <strong>${getRoomCode() || "..."}</strong></p>
        </div>
        <div class="hero-meta">
          <span>You: ${getPlayerName(mePlayer)}</span>
          <span>Host: ${controller ? getPlayerName(controller) : "-"}</span>
          <span>Round: <strong data-round-status>${escapeHtml(round.status || "unknown")}</strong></span>
          <span style="font-size:0.8rem;margin-left:1rem;color:#999" data-debug-ids>me:${escapeHtml(mePlayer?.id||"?")} controller:${escapeHtml(getControllerId()||"?")} participants:${currentParticipants().length}</span>
        </div>
      </header>

      ${renderHostSettings(settings, round, timeLeftCs, players, controller?.id || null)}

      ${renderScrewNotice(round)}

      <section class="grid ${showAdminData ? "" : "grid-single"}">
        ${renderBuzzerPanel(settings, round, mePlayer, timeLeftCs)}
        ${(showAdminData || showScoresToPlayers)
          ? renderScores(players, scores)
          : renderHiddenPanel("Scores", "Only the Host can view scores.")}
      </section>

      ${renderLockedRuling(settings, pendingEntry)}
      ${showAdminData ? renderLog(gameLog, settings) : renderHiddenPanel("Game Log", "Only the Host can view the game log.")}
    </main>
  `;

  lastUiSignature = getUiSignature();
  bindEvents();
}

function bindEvents() {
  app.querySelectorAll("[data-buzz]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      submitResponse({ option: Number(button.dataset.buzz) });
    });
  });

  app.querySelectorAll("[data-answer-submit]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = app.querySelector("#answer-entry");
      const answerText = String(input?.value || "").trim();
      submitResponse({ answerText });
      if (input) {
        input.value = "";
      }
    });
  });

  app.querySelectorAll("[data-roulette-stop]").forEach((button) => {
    button.addEventListener("click", () => {
      submitRouletteStop();
    });
  });

  const answerInput = app.querySelector("#answer-entry");
  if (answerInput) {
    answerInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      const answerText = String(answerInput.value || "").trim();
      submitResponse({ answerText });
      answerInput.value = "";
    });
  }

  if (isControllerPlayer()) {
    app.querySelectorAll("[data-setting]").forEach((input) => {
      input.addEventListener("change", () => {
        const setting = input.dataset.setting;
        if (setting === "timeOpen") {
          const value = clamp(parseInt(input.value, 10) || 20, 1, 120);
          setHostSetting("timeOpen", value);
          return;
        }
        if (setting === "lockAfterBuzz") {
          setHostSetting("lockAfterBuzz", input.value === "true");
          return;
        }
        if (setting === "rebuzzAllowed") {
          setHostSetting("rebuzzAllowed", input.value === "true");
          return;
        }
        if (setting === "showScoresToPlayers") {
          setHostSetting("showScoresToPlayers", input.value === "true");
          return;
        }
        if (setting === "closeBuzzersOnPointsGiven") {
          setHostSetting("closeBuzzersOnPointsGiven", input.value === "true");
          return;
        }
        if (setting === "inputMode") {
          setHostSetting("inputMode", input.value === "text" ? "text" : "buttons");
          return;
        }
        if (setting === "optionCount") {
          setHostSetting("optionCount", Number(input.value));
          return;
        }
        if (setting === "scoringMode") {
          setHostSetting("scoringMode", input.value);
          return;
        }
        if (setting === "valueSelectionMethod") {
          setHostSetting("valueSelectionMethod", input.value === "roulette" ? "roulette" : "standard");
          return;
        }
        if (setting === "rouletteMode") {
          setHostSetting("rouletteMode", input.value === "highest" ? "highest" : input.value === "single-player" ? "single-player" : "additive");
          return;
        }
        if (setting === "rouletteTopAmount") {
          setHostSetting("rouletteTopAmount", normalizeRouletteTopAmount(input.value));
          return;
        }
        if (setting === "rouletteSinglePlayerTarget") {
          setHostSetting("rouletteSinglePlayerTarget", input.value || "random");
          return;
        }
        if (setting === "uniformPoints") {
          setHostSetting("uniformPoints", Number(input.value));
          return;
        }
        if (setting === "jackMultiplier") {
          setHostSetting("jackMultiplier", Number(input.value));
          return;
        }
        if (setting === "allowScrewing") {
          setHostSetting("allowScrewing", input.value === "true");
          return;
        }
      });
    });

    app.querySelectorAll("[data-host-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.hostAction;
        if (action === "open") {
          openBuzzers();
        } else if (action === "close") {
          closeBuzzers();
        } else if (action === "reset") {
          resetRound();
        } else if (action === "reset-screws") {
          resetScrews();
        }
      });
    });

    app.querySelectorAll("[data-toggle-option]").forEach((button) => {
      button.addEventListener("click", () => {
        toggleBuzzerOption(Number(button.dataset.toggleOption));
      });
    });

    app.querySelectorAll("[data-toggle-player]").forEach((button) => {
      button.addEventListener("click", () => {
        togglePlayerBuzzer(button.dataset.togglePlayer);
      });
    });

    // Correct answer handlers (host)
    app.querySelectorAll("[data-set-correct-text]").forEach((button) => {
      button.addEventListener("click", () => {
        const input = app.querySelector("#correct-answer-entry");
        const val = String(input?.value || "").trim();
        if (!val) return;
        const round = getRound();
        setState("round", { ...round, correctAnswer: val, correctOptions: null }, true);
        render();
      });
    });

    app.querySelectorAll("[data-clear-correct]").forEach((button) => {
      button.addEventListener("click", () => {
        const round = getRound();
        setState("round", { ...round, correctAnswer: null, correctOptions: null }, true);
        render();
      });
    });

    app.querySelectorAll("[data-correct-option]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!isControllerPlayer()) return;
        const opt = Number(button.dataset.correctOption);
        if (!Number.isInteger(opt)) return;
        const round = getRound();
        const current = Array.isArray(round.correctOptions) ? round.correctOptions.map(Number) : [];
        const included = current.includes(opt);
        const next = included ? current.filter((v) => Number(v) !== opt) : [...current, opt].sort((a,b)=>a-b);
        setState("round", { ...round, correctOptions: next.length ? next : null, correctAnswer: null }, true);
        render();
      });
    });

    

    app.querySelectorAll("[data-ruling]").forEach((button) => {
      button.addEventListener("click", () => {
        const logId = button.dataset.logId;
        const delta = Number(button.dataset.ruling);
        updateScoresForLogEntry(logId, delta);
      });
    });

    app.querySelectorAll("[data-log-apply]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.logApply;
        const input = app.querySelector(`[data-log-input="${id}"]`);
        const value = Number(input?.value || 0);
        updateScoresForLogEntry(id, value);
      });
    });

    app.querySelectorAll("[data-log-quick]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.logId;
        const log = getLog();
        const entry = log.find((item) => item.id === id);
        if (!entry) {
          return;
        }
        const delta = button.dataset.logQuick === "plus" ? entry.basePoints : -entry.basePoints;
        updateScoresForLogEntry(id, delta);
      });
    });

    // Screw handlers (host and players)
    app.querySelectorAll("[data-screw-start-timer]").forEach((button) => {
      button.addEventListener("click", () => {
        startScrewTimer();
      });
    });
  }

  // Screw button for players
  app.querySelectorAll("[data-screw]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mePlayer = me();
      if (isHost()) {
        initiateScrew(mePlayer.id);
      } else {
        try {
          const result = await RPC.call("screw", { screweeId: null }, RPC.Mode.HOST);
          if (!result?.ok) {
            setBuzzNotice(result?.reason || "Screw failed.");
          }
          render();
        } catch {
          setBuzzNotice("Could not send screw. Check connection/room.");
          render();
        }
      }
    });
  });

  // Player selection for screw
  app.querySelectorAll("[data-screw-player]").forEach((button) => {
    button.addEventListener("click", async () => {
      const screweeId = button.dataset.screwPlayer;
      if (isHost()) {
        selectScrewee(screweeId);
      } else {
        try {
          const result = await RPC.call("screw", { screweeId }, RPC.Mode.HOST);
          if (!result?.ok) {
            setBuzzNotice(result?.reason || "Screw selection failed.");
          }
          render();
        } catch {
          setBuzzNotice("Could not send screw selection. Check connection/room.");
          render();
        }
      }
    });
  });
  if (!rouletteKeydownBound) {
    document.addEventListener("keydown", handleRouletteKeydown);
    rouletteKeydownBound = true;
  }
}


function handleRouletteKeydown(event) {
  if (event.code !== "Space" && event.key !== " ") {
    return;
  }
  if (isEditingControl()) {
    return;
  }

  const round = getRound();
  if (round.status !== ROUND_STATUSES.ROULETTE || !round.roulette?.active) {
    return;
  }
  if (!isRoulettePlayerAllowed(round.roulette, me().id)) {
    return;
  }

  event.preventDefault();
  submitRouletteStop();
}

function submitRouletteStop() {
  if (isControllerPlayer()) {
    return;
  }

  const round = getRound();
  const roulette = round.roulette;
  if (round.status !== ROUND_STATUSES.ROULETTE || !roulette?.active) {
    return;
  }
  if (!isRoulettePlayerAllowed(roulette, me().id)) {
    setBuzzNotice("You cannot stop this roulette.");
    render();
    return;
  }
  if (Array.isArray(roulette.completedPlayerIds) && roulette.completedPlayerIds.includes(me().id)) {
    setBuzzNotice("You already locked in your roulette value.");
    render();
    return;
  }

  RPC.call("roulette-stop", {}, RPC.Mode.HOST)
    .then((result) => {
      if (result?.ok === false) {
        setBuzzNotice(result.reason || "Roulette stop blocked.");
      } else if (result?.message) {
        setBuzzNotice(result.message);
      } else {
        setBuzzNotice("Roulette locked in.");
      }
      render();
    })
    .catch(() => {
      setBuzzNotice("Could not send roulette stop. Check connection/room.");
      render();
    });
}
function isEditingControl() {
  const active = document.activeElement;
  if (!active) {
    return false;
  }
  if (!(active instanceof HTMLElement)) {
    return false;
  }

  return Boolean(
    active.closest("[data-setting]") ||
      active.closest("[data-log-input]") ||
      active.id === "answer-entry" ||
      active.matches("[data-prejoin-input]"),
  );
}

function getSavedPlayerName() {
  return localStorage.getItem(NAME_KEY) || "";
}

function getPrejoinNameDraft() {
  const draft = app.querySelector("#prejoin-name")?.value?.trim() || "";
  return draft || getSavedPlayerName();
}

function renderPrejoinScreen(mode = "landing", error = "") {
  prejoinMode = mode;
  const savedName = getPrejoinNameDraft();

  if (mode === "host") {
    app.innerHTML = `
      <main class="prejoin-layout">
        <section class="card prejoin-panel prejoin-panel-host">
          <div class="prejoin-header">
            <button class="prejoin-back" data-prejoin-back type="button">Back</button>
            <div>
              <p class="prejoin-kicker">Host game</p>
              <h1>Set up a room</h1>
              <p class="muted">Create the game, then let players join with the room code.</p>
            </div>
          </div>

          <form class="prejoin-form" data-prejoin-form="host">
            <label>
              Host name
              <input data-prejoin-input id="prejoin-name" type="text" maxlength="32" value="${escapeHtml(savedName)}" placeholder="Your name" />
            </label>

            <p class="prejoin-note">You do not need a room code to host. A new room will be created automatically.</p>

            ${error ? `<p class="error-text">${escapeHtml(error)}</p>` : ""}

            <div class="prejoin-actions">
              <button class="primary-action" type="submit">Host Game</button>
              <button class="secondary-action" data-prejoin-switch="join" type="button">Join Instead</button>
            </div>
          </form>
        </section>
      </main>
    `;
  } else if (mode === "join") {
    app.innerHTML = `
      <main class="prejoin-layout">
        <section class="card prejoin-panel prejoin-panel-join">
          <div class="prejoin-header">
            <button class="prejoin-back" data-prejoin-back type="button">Back</button>
            <div>
              <p class="prejoin-kicker">Join game</p>
              <h1>Enter the room code</h1>
              <p class="muted">Use the code from the host to connect as a player.</p>
            </div>
          </div>

          <form class="prejoin-form" data-prejoin-form="join">
            <label>
              Player name
              <input data-prejoin-input id="prejoin-name" type="text" maxlength="32" value="${escapeHtml(savedName)}" placeholder="Your name" />
            </label>

            <label>
              Room code
              <input data-prejoin-input id="prejoin-room-code" type="text" maxlength="12" placeholder="XXXX" />
            </label>

            ${error ? `<p class="error-text">${escapeHtml(error)}</p>` : ""}

            <div class="prejoin-actions">
              <button class="primary-action" type="submit">Join Game</button>
              <button class="secondary-action" data-prejoin-switch="host" type="button">Host Instead</button>
            </div>
          </form>
        </section>
      </main>
    `;
  } else {
    app.innerHTML = `
      <main class="prejoin-layout">
        <section class="card prejoin-landing">
          <div class="prejoin-hero">
            <p class="prejoin-kicker">Playroom Buzzers</p>
            <h1>Pick how you want to start</h1>
            <p class="muted">Host a new room or jump into an existing one with a code.</p>
          </div>

          ${error ? `<p class="error-text">${escapeHtml(error)}</p>` : ""}

          <div class="prejoin-choice-grid">
            <button class="prejoin-choice" data-prejoin-open="host" type="button">
              <span class="prejoin-choice-label">Host game</span>
              <span class="muted">Create a new room and control the round.</span>
            </button>
            <button class="prejoin-choice" data-prejoin-open="join" type="button">
              <span class="prejoin-choice-label">Join game</span>
              <span class="muted">Enter a room code and play as a contestant.</span>
            </button>
          </div>
        </section>
      </main>
    `;
  }

  app.querySelectorAll("[data-prejoin-open]").forEach((button) => {
    button.addEventListener("click", () => {
      renderPrejoinScreen(button.dataset.prejoinOpen || "landing");
    });
  });

  app.querySelectorAll("[data-prejoin-switch]").forEach((button) => {
    button.addEventListener("click", () => {
      renderPrejoinScreen(button.dataset.prejoinSwitch || "landing");
    });
  });

  app.querySelectorAll("[data-prejoin-back]").forEach((button) => {
    button.addEventListener("click", () => {
      renderPrejoinScreen();
    });
  });

  app.querySelectorAll("[data-prejoin-form]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const mode = form.dataset.prejoinForm;
      const nameInput = app.querySelector("#prejoin-name");
      const roomInput = app.querySelector("#prejoin-room-code");

      const chosenName = nameInput?.value?.trim() || "";
      const roomCode = roomInput?.value?.trim()?.toUpperCase() || "";

      if (!chosenName) {
        renderPrejoinScreen(mode || "landing", "Please choose a player name.");
        return;
      }

      if (mode === "join" && !roomCode) {
        renderPrejoinScreen("join", "Enter a room code to join.");
        return;
      }

      localStorage.setItem(NAME_KEY, chosenName);

      const submitButton = form.querySelector("button[type='submit']");
      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = true;
      }

      await launchGame({
        playerName: chosenName,
        roomCode: mode === "join" ? roomCode : undefined,
      });
    });
  });
}

async function launchGame({ playerName, roomCode }) {
  if (gameLaunched) {
    return;
  }

  try {
    await insertCoin({
      skipLobby: true,
      maxPlayersPerRoom: 11,
      roomCode,
    });
  } catch {
    renderPrejoinScreen(prejoinMode, "Could not connect to Playroom. Try again.");
    return;
  }

  gameLaunched = true;

  me().setState("displayName", playerName, true);

  RPC.register("buzz", async (payload, senderPlayer) => {
    if (!isHost()) {
      return { ok: false, reason: "Not host" };
    }
    return hostHandleBuzz(senderPlayer, payload);
  });

  RPC.register("roulette-stop", async (_payload, senderPlayer) => {
    if (!isHost()) {
      return { ok: false, reason: "Not host" };
    }

    const round = getRound();
    const roulette = round.roulette;
    if (round.status !== ROUND_STATUSES.ROULETTE || !roulette?.active) {
      return { ok: false, reason: "Roulette is not active." };
    }
    if (!isRoulettePlayerAllowed(roulette, senderPlayer.id)) {
      return { ok: false, reason: "You cannot stop this roulette." };
    }
    if (Array.isArray(roulette.completedPlayerIds) && roulette.completedPlayerIds.includes(senderPlayer.id)) {
      return { ok: false, reason: "You already locked in." };
    }

    const frame = getRouletteFrame(roulette);
    const nextSelections = {
      ...(roulette.selections || {}),
      [senderPlayer.id]: {
        playerId: senderPlayer.id,
        playerName: getPlayerName(senderPlayer),
        value: frame.value,
        label: frame.label,
        tick: frame.tick,
        stoppedAt: now(),
      },
    };
    const nextCompleted = Array.isArray(roulette.completedPlayerIds)
      ? [...roulette.completedPlayerIds, senderPlayer.id]
      : [senderPlayer.id];

    setState(
      "round",
      {
        ...round,
        roulette: {
          ...roulette,
          selections: nextSelections,
          completedPlayerIds: nextCompleted,
        },
      },
      true,
    );

    if (maybeFinalizeRoulettePhase()) {
      return { ok: true, message: `${getPlayerName(senderPlayer)} locked in ${frame.value}.` };
    }

    render();
    return { ok: true, message: `${getPlayerName(senderPlayer)} locked in ${frame.value}.` };
  });

  RPC.register("screw", async (payload, senderPlayer) => {
    if (!isHost()) {
      return { ok: false, reason: "Not host" };
    }
    const round = getRound();
    const screweeId = payload?.screweeId;

    // If screweeId is null, player is initiating a screw (first step)
    if (screweeId === null || screweeId === undefined) {
      return initiateScrew(senderPlayer.id);
    }

    // Otherwise, they're selecting a screwee
    if (!round.screw.active) {
      return { ok: false, reason: "No screw in progress" };
    }
    return selectScrewee(screweeId);
  });

  ensureHostInit();
  render();
  startRouletteAnimationLoop();

  setInterval(() => {
    ensureHostInit();
    hostTick();
    const signature = getUiSignature();
    if (signature !== lastUiSignature) {
      render();
      return;
    }
    updateTimerDisplays();
  }, 1000);
}

function boot() {
  renderPrejoinScreen();
}

boot();
