// =============================================================================
// Instant Buzzers — a multiplayer buzzer system built on PlayroomKit
// =============================================================================

import "./style.css";
import { RPC, getParticipants, getRoomCode, getState, insertCoin, isHost, me, setState } from "playroomkit";
import SNARK from "./snark.json";

// =============================================================================
// Default game configuration — merged with live PlayroomKit state
// =============================================================================
const DEFAULT_SETTINGS = {
  timeOpen: 20,
  lockAfterBuzz: false,
  rebuzzAllowed: false,
  maxBuzzesPerOption: 1,
  closeBuzzersOnPointsGiven: false,
  showScoresToPlayers: false,
  showScoresToAudience: true,
  uiAnimationsEnabled: true,
  inputMode: "buttons",
  optionCount: 4,
  disabledOptions: [],
  disabledPlayerIds: [],
  scoringMode: "uniform",
  uniformPoints: 1000,
  jackMultiplier: 1,
  allowScrewing: false,
  reopenBuzzersAfterScrew: false,
  valueSelectionMethod: "standard",
  rouletteMode: "additive",
  rouletteTopAmount: 1000,
  rouletteSinglePlayerTarget: "random",
  teamModeEnabled: false,
  teamScoringMode: "alliance",
  bingoAlternateViewers: false,
  bingoLessRandom: true,
  snarkMode: "off",
};

const TEAM_COLORS = ["red", "blue", "green", "purple", "gray", "orange", "pink", "brown", "cyan", "lime"];

// =============================================================================
// Round state machine: IDLE -> OPEN -> LOCKED/ROULETTE -> CLOSED -> IDLE
// =============================================================================
const ROUND_STATUSES = {
  IDLE: "idle",
  OPEN: "open",
  ROULETTE: "roulette",
  LOCKED: "locked",
  CLOSED: "closed",
};

const BINGO_ITEM_CHANGE_INTERVAL_MS = 750;
const BINGO_RENDER_INTERVAL_MS = 50;
const BINGO_CORRECT_POINTS = 500;
const BINGO_INCORRECT_POINTS = -500;
const WEN_DIT_HAPN_ITEMS = ["Before", "Never", "After"];

const DIS_OR_DAT_QUESTION_COUNT = 7;
const DIS_OR_DAT_CORRECT_POINTS = 300;
const DIS_OR_DAT_TIMED_SECONDS = 30;
const DIS_OR_DAT_REVEAL_MS = 150;
const DIS_OR_DAT_BONUS_MIN_CORRECT = 5;

const VALUE_OPTIONS = Array.from({ length: 20 }, (_, index) => (index + 1) * 500);

const app = document.querySelector("#app");
const NAME_KEY = "buzzer_player_name";
let gameLaunched = false;
let clientMode = "player";
let buzzNotice = "";
let buzzNoticeTs = 0;
let lastUiSignature = "";
let prejoinMode = "landing";
let rouletteAnimationInterval = null;
let rouletteKeydownBound = false;
let fYouEasterEggUnlocked = false;
let hostPrejoinTeamSetting = "off";
let bingoCycleInterval = null;
let bingoCycleQueue = [];
let lastBingoRenderKey = "";
let audienceTimerFrozenCs = null;
let disOrDatRevealUntil = 0;

const F_YOU_EASTER_EGG_H2 = "Congratulations! You typed F*** You!";

// =============================================================================
// Utility helpers
// =============================================================================
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const now = () => Date.now();
const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

// =============================================================================
// Safe state accessors — return a fallback when PlayroomKit state is null
// =============================================================================
function getSafeState(key, fallback) {
  const value = getState(key);
  return value === undefined || value === null ? fallback : value;
}

// =============================================================================
// Answer normalization for case-insensitive comparison
// =============================================================================
function normalizeAnswerForCompare(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isFYouEasterEggAnswer(answerText) {
  return normalizeAnswerForCompare(answerText) === "fuck you";
}

function isFYouCorrectAnswer(round) {
  return normalizeAnswerForCompare(round?.correctAnswer) === "fuck you";
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

// =============================================================================
// Returns all non-display participants, sorted by ID
// =============================================================================
function currentParticipants() {
  const participants = Object.values(getParticipants() || {}).filter((player) => {
    const mode = player?.getState?.("clientMode");
    return mode !== "display" && mode !== "tablet_timer" && player?.getState?.("isAudienceDisplay") !== true;
  });
  return participants.sort((a, b) => a.id.localeCompare(b.id));
}

// =============================================================================
// True when the local client is an audience/projection display
// =============================================================================
function isAudienceDisplayClient() {
  return clientMode === "display" || clientMode === "tablet_timer" || me()?.getState?.("clientMode") === "display" || me()?.getState?.("clientMode") === "tablet_timer";
}

// =============================================================================
// Read a player's display name (custom override or profile name)
// =============================================================================
function getPlayerName(player) {
  const custom = player?.getState?.("displayName");
  if (typeof custom === "string" && custom.trim()) {
    return custom.trim();
  }
  return player?.getProfile?.()?.name || "Player";
}

// =============================================================================
// Game state accessors — merge defaults with live PlayroomKit state
// =============================================================================
function getSettings() {
  return { ...DEFAULT_SETTINGS, ...getSafeState("settings", {}) };
}

// =============================================================================
// Snark mode — swaps player-facing strings for snarky variants from snark.json.
// Section keys are dot-paths like "player.buzzer.buzzSent" (screen.group.section).
// Strings rendered on a single screen live under that screen; strings reused
// across screens live once under the "shared" screen and are found by fallback.
// When snark is off, or a level line is blank, falls back to the English line,
// then to the fallback. {token} placeholders are replaced with the vars object.
// =============================================================================
function getSnark(section, fallbackEn = "", vars = {}) {
  const mode = getSettings().snarkMode;
  if (mode === "off") {
    return fallbackEn;
  }
  const [screen, group, ...rest] = section.split(".");
  const key = rest.join(".");
  let entry = SNARK[screen]?.[group]?.[key];
  if (!entry && screen !== "shared") {
    entry = SNARK.shared?.[group]?.[key];
  }
  const candidates = [entry?.snark2, entry?.snark1, entry?.en];
  const startIndex = mode === "2" ? 0 : 1;
  let out = "";
  for (let i = startIndex; i < candidates.length; i++) {
    if (typeof candidates[i] === "string" && candidates[i].trim()) {
      out = candidates[i];
      break;
    }
  }
  if (!out) {
    out = fallbackEn;
  }
  return out.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? vars[key] : match));
}

function getTeamAssignments() {
  return getSafeState("teamAssignments", {});
}

function freshTeamSelect() {
  return {
    active: false,
    enabledTeams: [...TEAM_COLORS],
    locked: false,
    maxPerTeam: 0,
  };
}

function getTeamSelect() {
  return getSafeState("teamSelect", freshTeamSelect());
}

function isTeamSelectActive() {
  return getTeamSelect()?.active;
}

// Prune stale/deleted players from team assignment map
function normalizeTeamAssignments(assignments, players, controllerId) {
  const cohostIds = getSafeState("cohostIds", []);
  const validIds = new Set(players.map((player) => player.id).filter((id) => id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(id))));
  const normalized = {};
  Object.entries(assignments || {}).forEach(([playerId, teamColor]) => {
    if (validIds.has(playerId) && TEAM_COLORS.includes(String(teamColor))) {
      normalized[playerId] = String(teamColor);
    }
  });
  return normalized;
}

function getPlayerTeamColor(playerId, assignments = getTeamAssignments()) {
  const teamColor = assignments?.[playerId];
  return TEAM_COLORS.includes(teamColor) ? teamColor : null;
}

function getTeamScoreKey(teamColor) {
  return `team:${teamColor}`;
}

function getScoreKeyForPlayer(playerId, settings = getSettings(), assignments = getTeamAssignments()) {
  if (!settings.teamModeEnabled || settings.teamScoringMode !== "shared") {
    return playerId;
  }
  const teamColor = getPlayerTeamColor(playerId, assignments);
  return teamColor ? getTeamScoreKey(teamColor) : playerId;
}

// Shared key for special-question state (bingo tiles, disordat responses).
// In shared team mode every team member shares one track; otherwise per-player.
function getTeamTrackKey(playerId, settings = getSettings(), assignments = getTeamAssignments()) {
  if (!settings.teamModeEnabled || settings.teamScoringMode !== "shared") {
    return playerId;
  }
  return getPlayerTeamColor(playerId, assignments) || playerId;
}

// When bingoAlternateViewers is on in shared team mode, the lit letter is only
// visible to one teammate per cycle. Which teammate is determined deterministically
// from the shared state (same result on every client) via the cycling slot counter.
function isBingoActiveViewer(bingo, litSlot, playerId, settings, assignments) {
  if (!settings.bingoAlternateViewers) return true;
  if (!settings.teamModeEnabled || settings.teamScoringMode !== "shared") return true;
  const teamColor = getPlayerTeamColor(playerId, assignments);
  if (!teamColor) return true;
  const memberIds = getTeamMembers(teamColor, currentParticipants(), assignments).map((m) => m.id).sort();
  const myIndex = memberIds.indexOf(playerId);
  const teamSize = memberIds.length;
  if (myIndex < 0 || teamSize <= 1) return true;
  return (Math.floor(litSlot || 0) % teamSize) === myIndex;
}

function getTeamMembers(teamColor, players = currentParticipants(), assignments = getTeamAssignments()) {
  if (!teamColor) {
    return [];
  }
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  return players.filter((player) => player.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)) && assignments[player.id] === teamColor);
}

function hasUnassignedTeamPlayers(settings = getSettings(), players = currentParticipants(), assignments = getTeamAssignments()) {
  if (!settings.teamModeEnabled) {
    return false;
  }
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  const activePlayers = players.filter((player) => player.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)));
  return activePlayers.some((player) => !getPlayerTeamColor(player.id, assignments));
}

function getAllBuzzedTeamMemberIds(playerId, players, assignments) {
  const teamColor = getPlayerTeamColor(playerId, assignments);
  if (!teamColor) {
    return [playerId];
  }
  return getTeamMembers(teamColor, players, assignments).map((player) => player.id);
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
  const cohostIds = getSafeState("cohostIds", []);
  const validIds = new Set(players.map((player) => player.id).filter((id) => id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(id))));
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

function getEligibleBuzzerPlayerIds(settings) {
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  return currentParticipants()
    .filter(
      (p) =>
        p.id !== controllerId &&
        !(Array.isArray(cohostIds) && cohostIds.includes(p.id)) &&
        isPlayerBuzzerEnabled(settings, p.id)
    )
    .map((p) => p.id);
}

function isAllEligibleBuzzed(buzzedPlayerIds, settings) {
  const eligible = getEligibleBuzzerPlayerIds(settings);
  return eligible.length > 0 && eligible.every((id) => (buzzedPlayerIds || []).includes(id));
}

function getPlayerOptionBuzzCount(round, playerId, option) {
  return Number((round.buzzCounts || {})?.[playerId]?.[option] || 0);
}

function isPlayerAtOptionLimit(round, settings, playerId, option) {
  const limit = Number(settings.maxBuzzesPerOption);
  if (!settings.rebuzzAllowed || !Number.isInteger(limit) || limit < 1 || option === null || option === undefined) {
    return false;
  }
  return getPlayerOptionBuzzCount(round, playerId, option) >= limit;
}

// =============================================================================
// Returns the full round state with defaults for every sub-field
// =============================================================================
function getRound() {
  return getSafeState("round", {
    status: ROUND_STATUSES.IDLE,
    opensAt: null,
    closesAt: null,
    remainingCs: null,
    winnerId: null,
    winnerTeam: null,
    winnerOption: null,
    winnerAnswer: null,
    winnerName: null,
    buzzedPlayerIds: [],
    buzzCounts: {},
    roulette: {
      active: false,
      startedAt: null,
      mode: "additive",
      topAmount: 1000,
      ceiling: 0,
      seed: null,
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
      frozenCs: null,
      frozenPoints: null,
    },
    screwsUsedBy: [],
  });
}

// =============================================================================
// Score / Bingo / Log / Controller accessors
// =============================================================================
function getScores() {
  return getSafeState("scores", {});
}

function getPlayerRank(playerId, settings, scores, players) {
  const controllerId = getControllerId();
  const scored = players
    .filter((p) => p.id !== controllerId)
    .map((p) => ({
      id: p.id,
      score: Number(scores[getScoreKeyForPlayer(p.id, settings)] || 0),
    }))
    .sort((a, b) => b.score - a.score);
  const idx = scored.findIndex((p) => p.id === playerId);
  return idx === -1 ? scored.length + 1 : idx + 1;
}

function getOrdinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function isBingoMode() {
  const mode = getSettings().inputMode;
  return mode === "bingo" || mode === "wendithapn";
}

function isWenDitHapnMode() {
  return getSettings().inputMode === "wendithapn";
}

function isDisOrDatMode() {
  return getSettings().inputMode === "disordat";
}

function isBuzzersOpenFlash(settings, round) {
  return round?.status === ROUND_STATUSES.OPEN
    && settings.inputMode === "buttons"
    && !round.screw?.active;
}

function freshDisOrDatState() {
  return {
    active: false,
    phase: "playing",
    disLabel: "",
    datLabel: "",
    answers: Array(DIS_OR_DAT_QUESTION_COUNT).fill(null),
    mode: null,
    activePlayerId: null,
    pendingPick: false,
    timeEndsAt: null,
    currentQuestion: 0,
    responses: {},
    pointsEarned: {},
    jackBonus: {},
    finishedPlayerIds: [],
  };
}

function getDisOrDat() {
  return getSafeState("disordat", freshDisOrDatState());
}

function getDisOrDatTimeLeftCs(dd) {
  if (!dd?.timeEndsAt) return DIS_OR_DAT_TIMED_SECONDS * 100;
  return Math.max(0, Math.ceil((dd.timeEndsAt - now()) / 10));
}

function getBingo() {
  return getSafeState("bingo", {
    active: false,
    word: "",
    items: [],
    itemStates: [],
    targetIndex: -1,
    cycling: false,
    currentLitIndex: -1,
    currentLitSlot: 0,
    currentLitTs: 0,
    collectedCounts: {},
    winner: null,
    playerItems: {},
  });
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

function isPlayerExcluded(playerId) {
  if (playerId === getControllerId()) return true;
  const cohostIds = getSafeState("cohostIds", []);
  return Array.isArray(cohostIds) && cohostIds.includes(playerId);
}

function isCohost() {
  const cohostIds = getSafeState("cohostIds", []);
  return Array.isArray(cohostIds) && cohostIds.includes(me().id);
}

function hasHostPrivileges() {
  return isHost() || isCohost();
}

async function cohostDispatch(fnName, ...args) {
  if (isHost()) {
    const dispatch = {
      openBuzzers, closeBuzzers, resetRound, resetScrews,
      startRoulettePhase, startScrewTimer, closeScrewMode,
      startBingo, endBingo, setBingoTarget, startBingoCycling, stopBingoCycling,
      setHostSetting, toggleBuzzerOption, togglePlayerBuzzer,
      setPlayerTeam, randomizeTeams,
      openTeamSelect, closeTeamSelect, setTeamSelectLocked, setTeamSelectTeams, setTeamSelectLimit,
      updateScoresForLogEntry,
    };
    dispatch[fnName]?.(...args);
    return;
  }
  if (isCohost()) {
    try {
      await RPC.call("cohost-action", { fn: fnName, args }, RPC.Mode.HOST);
    } catch {
      // ignore RPC errors — the host tick will re-render if needed
    }
  }
}

// =============================================================================
// Authorization — check if a given player can buzz for a given option
// =============================================================================
function canBuzz(playerId, option) {
  const round = getRound();
  const controllerId = getControllerId();
  const settings = getSettings();
  const participants = currentParticipants();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), participants, controllerId);
  if (playerId === controllerId) {
    return false;
  }
  const cohostIds = getSafeState("cohostIds", []);
  if (Array.isArray(cohostIds) && cohostIds.includes(playerId)) {
    return false;
  }
  if (settings.teamModeEnabled && !getPlayerTeamColor(playerId, assignments)) {
    return false;
  }
  if (round.status !== ROUND_STATUSES.OPEN) {
    return false;
  }
  
  // If screw is active with a timer running, only screwee can buzz
  if (round.screw.active && getScrewTimerMs(round) !== null && getScrewTimerMs(round) > 0) {
    return playerId === round.screw.screweeId;
  }
  
  // If screw is active but timer not started, no one can buzz
  if (round.screw.active) {
    return false;
  }
  
  if (!settings.rebuzzAllowed && round.buzzedPlayerIds.includes(playerId)) {
    return false;
  }
  if (!settings.rebuzzAllowed && settings.teamModeEnabled && settings.teamScoringMode === "shared") {
    const teamMemberIds = getAllBuzzedTeamMemberIds(playerId, participants, assignments);
    if (teamMemberIds.some((memberId) => round.buzzedPlayerIds.includes(memberId))) {
      return false;
    }
  }
  if (!isPlayerBuzzerEnabled(settings, playerId)) {
    return false;
  }
  if (option !== undefined) {
    if (!isOptionEnabled(settings, option)) {
      return false;
    }
    if (isPlayerAtOptionLimit(round, settings, playerId, option)) {
      return false;
    }
  }
  return true;
}

function getTimeLeftCs(round, settings) {
  if (round?.screw?.active && round.screw.frozenCs != null) {
    return round.screw.frozenCs;
  }
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

// Screw timer remaining in ms. When the timer has a wall-clock end timestamp
// (set at start), compute locally so smooth 25ms audience/tablet renders tick
// it down instead of waiting for the host's once-per-second broadcast.
function getScrewTimerMs(round) {
  const screw = round?.screw || {};
  if (screw.screwTimerMs === null) return null;
  if (screw.active && typeof screw.screwTimerEndsAt === "number") {
    return Math.max(0, screw.screwTimerEndsAt - now());
  }
  return screw.screwTimerMs;
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
  if (isDisOrDatMode()) {
    const ddText = `${formatSeconds(getDisOrDatTimeLeftCs(getDisOrDat()))}s`;
    document.querySelectorAll("[data-disordat-time-left]").forEach((element) => {
      element.textContent = ddText;
    });
  }
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
      winnerTeam: round.winnerTeam,
      winnerOption: round.winnerOption,
      winnerAnswer: round.winnerAnswer,
      winnerName: round.winnerName,
      buzzedPlayerIds: round.buzzedPlayerIds,
      roulette: round.roulette,
      screw: round.screw,
      screwsUsedBy: round.screwsUsedBy,
    },
    settings: {
      inputMode: settings.inputMode,
      optionCount: settings.optionCount,
      rebuzzAllowed: settings.rebuzzAllowed,
      lockAfterBuzz: settings.lockAfterBuzz,
      closeBuzzersOnPointsGiven: settings.closeBuzzersOnPointsGiven,
showScoresToPlayers: settings.showScoresToPlayers,
      showScoresToAudience: settings.showScoresToAudience,
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
      teamModeEnabled: settings.teamModeEnabled,
      teamScoringMode: settings.teamScoringMode,
      bingoAlternateViewers: settings.bingoAlternateViewers,
      bingoLessRandom: settings.bingoLessRandom,
      snarkMode: settings.snarkMode,
    },
    teamAssignments: normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId()),
    teamSelect: getTeamSelect(),
    pendingLogId,
    controllerId: getControllerId(),
    cohostIds: getSafeState("cohostIds", []),
    disordat: getDisOrDat(),
    bingo: (() => {
      const b = getBingo();
      return {
        active: b.active,
        cycling: b.cycling,
        currentLitIndex: b.currentLitIndex,
        currentLitSlot: b.currentLitSlot,
        targetIndex: b.targetIndex,
        word: b.word,
        items: b.items,
        itemStates: b.itemStates,
        playerItems: b.playerItems,
        collectedCounts: b.collectedCounts,
        winner: b.winner,
      };
    })(),
    participantCount: currentParticipants().length,
  });
}

// =============================================================================
// Scoring: roulette final value, uniform points, or JACK multiplier
// =============================================================================
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
  const numeric = Number(value);
  return VALUE_OPTIONS.includes(numeric) ? numeric : 1000;
}

function normalizeUniformPoints(value) {
  const numeric = Number(value);
  return VALUE_OPTIONS.includes(numeric) ? numeric : 1000;
}

// =============================================================================
// Roulette helpers — deterministic pseudo-random fraction, frame calculation
// =============================================================================
function seededFraction(seed) {
  const raw = Math.sin(seed * 12.9898) * 43758.5453;
  return raw - Math.floor(raw);
}

function getRouletteFrame(roulette, tick = null) {
  const ceiling = Math.max(1, Number(roulette?.ceiling || 0) || 1);
  const seed = Number(roulette?.seed) || 0;
  const currentTick = tick === null ? Math.floor(Math.max(0, now() - Number(roulette?.startedAt || now())) / 500) : Number(tick);
  const r1 = seededFraction(seed + currentTick * 2);
  const r2 = seededFraction(seed + 1 + currentTick * 2);
  const fraction = 0.75 + ((r1 + r2) / 2 - 0.5) * 0.5;
  const value = clamp(Math.round(1 + fraction * (ceiling - 1)), 1, ceiling);
  return { tick: currentTick, label: "", value, ceiling };
}

function getRoulettePlayers() {
  const cohostIds = getSafeState("cohostIds", []);
  return currentParticipants().filter((player) => player.id !== getControllerId() && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)));
}

function isRoulettePlayerAllowed(roulette, playerId) {
  if (!roulette?.active) {
    return false;
  }
  const settings = getSettings();
  const cohostIds = getSafeState("cohostIds", []);
  if (Array.isArray(cohostIds) && cohostIds.includes(playerId)) {
    return false;
  }
  if (settings.teamModeEnabled) {
    const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
    if (!getPlayerTeamColor(playerId, assignments)) {
      return false;
    }
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

// =============================================================================
// Roulette animation — re-renders every 500 ms while roulette is active
// =============================================================================
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

// When all expected players have locked in, compute final value and close
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
  const finishedAt = now();

  setState(
    "round",
    {
      ...round,
      status: ROUND_STATUSES.CLOSED,
      opensAt: null,
      closesAt: null,
      remainingCs: settings.timeOpen * 100,
      winnerId: null,
      winnerTeam: null,
      winnerOption: null,
      winnerAnswer: null,
      winnerName: null,
      roulette: {
        ...roulette,
        active: false,
        finalValue,
        finishedAt,
      },
    },
    true,
  );
  render();
  return true;
}

// Host-only: transition from IDLE to ROULETTE (or directly to OPEN if no players)
function startRoulettePhase() {
  if (!isHost()) {
    if (isCohost()) { RPC.call("cohost-action", { fn: "startRoulettePhase", args: [] }, RPC.Mode.HOST); return { ok: true }; }
    return { ok: false, reason: "Only host can start pick-a-value." };
  }

  const settings = getSettings();
  const round = getRound();
  const participants = currentParticipants();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), participants, getControllerId());
  if (hasUnassignedTeamPlayers(settings, participants, assignments)) {
    return { ok: false, reason: "Assign every player to a team before starting pick-a-value." };
  }
  const players = getRoulettePlayers();
  const topAmount = normalizeRouletteTopAmount(settings.rouletteTopAmount);
  const seed = Math.floor(Math.random() * 2147483647) + 1;
  const ceiling = settings.rouletteMode === "additive"
    ? Math.max(1, Math.floor(topAmount / Math.max(1, players.length || 1)))
    : topAmount;
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
        winnerTeam: null,
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
          seed,
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
    return { ok: true, message: "No players available for pick-a-value, opening buzzers." };
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
      winnerTeam: null,
      winnerOption: null,
      winnerAnswer: null,
      winnerName: null,
      buzzedPlayerIds: [],
      buzzCounts: {},
      roulette: {
        active: true,
        startedAt: now(),
        mode: settings.rouletteMode,
        topAmount,
        ceiling,
        seed,
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
      ? `${getPlayerName(targetPlayer)} will stop the pick-a-value.`
      : "Pick-a-value started.",
  };
}

// =============================================================================
// Render functions — each returns an HTML string for a UI region
// =============================================================================
function renderRoulettePanel(settings, round, mePlayer) {
  const roulette = round.roulette || {};
  const currentFrame = getRouletteFrame(roulette);
  const playerSelection = roulette.selections?.[mePlayer.id] || null;
  const completedCount = Array.isArray(roulette.completedPlayerIds) ? roulette.completedPlayerIds.length : 0;
  const expectedCount = getRouletteExpectedCount(roulette);
  const canStop = isRoulettePlayerAllowed(roulette, mePlayer.id) && !playerSelection;
  const modeLabel = {
    additive: getSnark("player.roulette.modeAdditive", "Additive"),
    highest: getSnark("player.roulette.modeHighest", "Highest value"),
    "single-player": getSnark("player.roulette.modeSingle", "Single-player"),
  }[roulette.mode || settings.rouletteMode] || getSnark("player.roulette.modeAdditive", "Additive");
  const targetText = roulette.mode === "single-player"
    ? roulette.targetPlayerName
      ? getSnark("player.roulette.onlyTarget", `Only ${roulette.targetPlayerName} can stop this round.`, { player: roulette.targetPlayerName })
      : getSnark("player.roulette.waitingTarget", "Waiting to choose a player.")
    : getSnark("player.roulette.everyoneStops", "Everyone can stop when they want to lock in their number.");
  const displayedValue = playerSelection ? Number(playerSelection.value || 0) : currentFrame.value;
  const displayedLabel = playerSelection ? getSnark("player.roulette.lockedLabel", "Locked") : currentFrame.label;
  const completedLabel = expectedCount > 0
    ? getSnark("player.roulette.playersLocked", `${completedCount}/${expectedCount} players locked in.`, { completed: completedCount, expected: expectedCount })
    : getSnark("player.roulette.waitingPlayers", "Waiting for players.");

  return `
    <section class="card player-card roulette-card">
      <h2>${getSnark("player.roulette.title", "Pick a Value")}</h2>
      <p class="muted">${modeLabel} mode · Top amount ${roulette.topAmount || normalizeRouletteTopAmount(settings.rouletteTopAmount)} · Ceiling ${roulette.ceiling || 0}</p>
      <div class="roulette-display" aria-live="polite">
        <span class="roulette-value">${displayedValue}</span>
        <span class="roulette-label">${displayedLabel}</span>
      </div>
      <p class="muted">${targetText}</p>
      <p class="muted">${completedLabel}</p>
      ${playerSelection
        ? `<p class="roulette-locked-note">${getSnark("player.roulette.youLocked", `You locked in ${Number(playerSelection.value || 0)}.`, { value: Number(playerSelection.value || 0) })}</p>`
        : `<button type="button" class="roulette-stop" data-roulette-stop ${canStop ? "" : "disabled"}>${getSnark("player.roulette.stopButton", "STOP")}</button>`}
    </section>
  `;
}

// =============================================================================
// Host applies/edits a scoring ruling for a log entry, handles screw reversal
// =============================================================================
function updateScoresForLogEntry(logId, newAwardedDelta) {
  if (!isHost()) {
    if (isCohost()) RPC.call("cohost-action", { fn: "updateScoresForLogEntry", args: [logId, newAwardedDelta] }, RPC.Mode.HOST);
    return;
  }
  const log = getLog();
  const entryIndex = log.findIndex((entry) => entry.id === logId);
  if (entryIndex < 0) {
    return;
  }

  const entry = log[entryIndex];
  const round = getRound();
  const settings = getSettings();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
  const entryScoreKey = entry.scoreKey || getScoreKeyForPlayer(entry.playerId, settings, assignments);
  const oldAwarded = Number(entry.awardedDelta || 0);
  let nextAwarded = Number(newAwardedDelta || 0);
  
  if (round.screw.active && round.screw.screweeId === entry.playerId) {
    const screwBonus = nextAwarded >= 0 ? 1000 : -1000;
    nextAwarded = nextAwarded + screwBonus;
  }
  
  const diff = nextAwarded - oldAwarded;

  const scores = { ...getScores() };
  scores[entryScoreKey] = Number(scores[entryScoreKey] || 0) + diff;
  
  if (round.screw.active && round.screw.screwerId) {
    const screwerScoreKey = getScoreKeyForPlayer(round.screw.screwerId, settings, assignments);
    const screwSign = nextAwarded >= 0 ? -1000 : 1000;
    scores[screwerScoreKey] = Number(scores[screwerScoreKey] || 0) + screwSign;
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
      const shouldCloseOnPointsGiven =
        Boolean(settings.lockAfterBuzz) && Boolean(settings.closeBuzzersOnPointsGiven) && nextAwarded > 0;
      const remainingCs = Number.isFinite(round.remainingCs) ? Math.max(0, Number(round.remainingCs)) : 0;
      const reopenAfterScrew = round.screw.active && Boolean(settings.reopenBuzzersAfterScrew);

      if (((round.screw.active || shouldCloseOnPointsGiven) && !reopenAfterScrew) || remainingCs <= 0) {
        setState(
          "round",
          {
            ...round,
            status: ROUND_STATUSES.CLOSED,
            winnerId: null,
            winnerTeam: null,
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
          winnerTeam: null,
          winnerOption: null,
          winnerAnswer: null,
          winnerName: null,
        },
        true,
      );
      // Close screw mode (resumes the main timer from the frozen value)
      closeScrewMode();
    }
  }

  render();
}

// Force-set a delta (used by the F-You easter egg penalty)
function resolveLogEntryWithForcedDelta(logId, forcedDelta) {
  if (!isHost()) {
    if (isCohost()) RPC.call("cohost-action", { fn: "resolveLogEntryWithForcedDelta", args: [logId, forcedDelta] }, RPC.Mode.HOST);
    return;
  }

  const log = getLog();
  const entryIndex = log.findIndex((entry) => entry.id === logId);
  if (entryIndex < 0) {
    return;
  }

  const entry = log[entryIndex];
  const round = getRound();
  const settings = getSettings();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
  const entryScoreKey = entry.scoreKey || getScoreKeyForPlayer(entry.playerId, settings, assignments);
  const oldAwarded = Number(entry.awardedDelta || 0);
  const nextAwarded = Number(forcedDelta || 0);
  const diff = nextAwarded - oldAwarded;

  const scores = { ...getScores() };
  scores[entryScoreKey] = Number(scores[entryScoreKey] || 0) + diff;

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
      const shouldCloseOnPointsGiven =
        Boolean(settings.lockAfterBuzz) && Boolean(settings.closeBuzzersOnPointsGiven) && nextAwarded > 0;
      const remainingCs = Number.isFinite(round.remainingCs) ? Math.max(0, Number(round.remainingCs)) : 0;
      const reopenAfterScrew = round.screw.active && Boolean(settings.reopenBuzzersAfterScrew);

      if (((round.screw.active || shouldCloseOnPointsGiven) && !reopenAfterScrew) || remainingCs <= 0) {
        setState(
          "round",
          {
            ...round,
            status: ROUND_STATUSES.CLOSED,
            winnerId: null,
            winnerTeam: null,
            winnerOption: null,
            winnerName: null,
          },
          true,
        );
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
          winnerTeam: null,
          winnerOption: null,
          winnerAnswer: null,
          winnerName: null,
        },
        true,
      );
      // Close screw mode (resumes the main timer from the frozen value)
      closeScrewMode();
    }
  }

  render();
}

// =============================================================================
// Record a buzz event into the game log
// =============================================================================
function pushBuzzLogEntry(player, { option = null, answerText = null }, timeLeftCs) {
  const settings = getSettings();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
  const teamColor = getPlayerTeamColor(player.id, assignments);
  const scoreKey = getScoreKeyForPlayer(player.id, settings, assignments);
  const points = computeBasePoints(settings, timeLeftCs);
  const entry = {
    id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "buzz",
    ts: now(),
    playerId: player.id,
    playerName: getPlayerName(player),
    teamColor,
    scoreKey,
    scoreTarget: scoreKey.startsWith("team:") ? `Team ${teamColor}` : getPlayerName(player),
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

// Auto-award points when the host pre-set a correct answer for this round.
// Wrong answers are left unresolved so the host can rule them manually.
function autoEvaluatePresetAnswer(logEntry, answerText, validOption) {
  const currentRound = getRound();
  const settings = getSettings();
  let isCorrect = false;
  if (settings.inputMode === "text" && currentRound.correctAnswer) {
    const correct = normalizeAnswerForCompare(currentRound.correctAnswer);
    if (answerText && normalizeAnswerForCompare(answerText) === correct) {
      isCorrect = true;
    }
  } else if (settings.inputMode !== "text" && Array.isArray(currentRound.correctOptions) && currentRound.correctOptions.length > 0) {
    if (validOption !== null && currentRound.correctOptions.map(Number).includes(Number(validOption))) {
      isCorrect = true;
    }
  }
  if (isCorrect) {
    updateScoresForLogEntry(logEntry.id, logEntry.basePoints);
  }
}

// =============================================================================
// Host RPC handler — validate and record a player's buzz, auto-evaluate if
// the host pre-set a correct answer
// =============================================================================
function hostHandleBuzz(player, payload) {
  const settings = getSettings();
  const round = getRound();
  const players = currentParticipants();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), players, getControllerId());
  const playerTeamColor = getPlayerTeamColor(player.id, assignments);
  const shouldLockAfterBuzz = round.screw.active || (settings.lockAfterBuzz && !settings.rebuzzAllowed);
  const usingTextEntry = settings.inputMode === "text";

  let validOption = null;
  let answerText = null;

  if (usingTextEntry) {
    answerText = String(payload?.answerText || "").trim();
    if (!answerText) {
      return { ok: false, reason: getSnark("player.buzzer.answerEmpty", "Answer cannot be empty.") };
    }
    if (answerText.length > 120) {
      return { ok: false, reason: getSnark("player.buzzer.answerTooLong", "Answer is too long.") };
    }
  } else {
    validOption = Number(payload?.option);
    if (!Number.isInteger(validOption) || validOption < 1 || validOption > settings.optionCount) {
      return { ok: false, reason: getSnark("player.buzzer.invalidOption", "Invalid option.") };
    }
  }

  if (settings.teamModeEnabled && !playerTeamColor) {
    return { ok: false, reason: getSnark("player.buzzer.notAssignedToTeam", "Host has not assigned you to a team yet.") };
  }

  if (!canBuzz(player.id, validOption === null ? undefined : validOption)) {
    return { ok: false, reason: getSnark("player.buzzer.buzzNotAllowed", "Buzzers are not open, disabled, or you already buzzed.") };
  }

  const timeLeftCs = round.screw.active && round.screw.frozenCs != null ? round.screw.frozenCs : getTimeLeftCs(round, settings);
  const logEntry = pushBuzzLogEntry(
    player,
    {
      option: validOption,
      answerText,
    },
    timeLeftCs,
  );
  const newlyBuzzedIds = settings.teamModeEnabled && settings.teamScoringMode === "shared"
    ? getAllBuzzedTeamMemberIds(player.id, players, assignments)
    : [player.id];
  const buzzedPlayerIds = [...new Set([...(round.buzzedPlayerIds || []), ...newlyBuzzedIds])];

  const nextRound = {
    ...round,
    buzzedPlayerIds,
    ...(validOption !== null && settings.rebuzzAllowed
      ? {
          buzzCounts: {
            ...(round.buzzCounts || {}),
            [player.id]: {
              ...((round.buzzCounts || {})[player.id] || {}),
              [validOption]: getPlayerOptionBuzzCount(round, player.id, validOption) + 1,
            },
          },
        }
      : {}),
  };

  const allEligibleBuzzed = !settings.rebuzzAllowed && isAllEligibleBuzzed(buzzedPlayerIds, settings);

  if (usingTextEntry && isFYouEasterEggAnswer(answerText) && !isFYouCorrectAnswer(round)) {
    if (shouldLockAfterBuzz) {
      setState(
        "round",
        {
          ...nextRound,
          status: ROUND_STATUSES.LOCKED,
          winnerId: player.id,
          winnerTeam: playerTeamColor,
          winnerOption: validOption,
          winnerAnswer: answerText,
          winnerName: getPlayerName(player),
          remainingCs: timeLeftCs,
          screw: { ...round.screw, screwTimerMs: 0 },
        },
        true,
      );
      setState("pendingLogId", logEntry.id, true);
    } else {
      setState(
        "round",
        {
          ...nextRound,
          status: allEligibleBuzzed ? ROUND_STATUSES.CLOSED : round.status,
          remainingCs: allEligibleBuzzed ? timeLeftCs : round.remainingCs,
          closesAt: allEligibleBuzzed ? null : round.closesAt,
          winnerTeam: null,
        },
        true,
      );
    }

    resolveLogEntryWithForcedDelta(logEntry.id, -(logEntry.basePoints * 2));
    return {
      ok: true,
      message: getSnark("player.easteregg.heading", F_YOU_EASTER_EGG_H2),
      easterEgg: {
        id: "f-you",
      },
    };
  }

  if (shouldLockAfterBuzz) {
    setState(
      "round",
      {
        ...nextRound,
        status: ROUND_STATUSES.LOCKED,
        winnerId: player.id,
        winnerTeam: playerTeamColor,
        winnerOption: validOption,
        winnerAnswer: answerText,
        winnerName: getPlayerName(player),
        remainingCs: timeLeftCs,
        screw: { ...round.screw, screwTimerMs: 0 },
      },
      true,
    );
    setState("pendingLogId", logEntry.id, true);
    // If the Host pre-set a correct answer for this round, auto-evaluate immediately
    try {
      autoEvaluatePresetAnswer(logEntry, answerText, validOption);
    } catch (e) {
      // ignore auto-eval errors
    }
  } else {
    setState(
      "round",
      {
        ...nextRound,
        status: allEligibleBuzzed ? ROUND_STATUSES.CLOSED : round.status,
        remainingCs: allEligibleBuzzed ? timeLeftCs : round.remainingCs,
        closesAt: allEligibleBuzzed ? null : round.closesAt,
        winnerTeam: null,
      },
      true,
    );
    // If the Host pre-set a correct answer for this round, auto-evaluate immediately
    try {
      autoEvaluatePresetAnswer(logEntry, answerText, validOption);
    } catch (e) {
      // ignore auto-eval errors
    }
  }

  render();

  return {
    ok: true,
    message: shouldLockAfterBuzz
      ? usingTextEntry
        ? getSnark("player.buzzer.lockedInAnswer", `${getPlayerName(player)} locked in an answer.`, { player: getPlayerName(player) })
        : getSnark("player.buzzer.lockedInOption", `${getPlayerName(player)} locked in option ${validOption}.`, { player: getPlayerName(player), option: validOption })
      : usingTextEntry
        ? getSnark("player.buzzer.submittedAnswer", `${getPlayerName(player)} submitted an answer.`, { player: getPlayerName(player) })
        : getSnark("player.buzzer.buzzedOption", `${getPlayerName(player)} buzzed option ${validOption}.`, { player: getPlayerName(player), option: validOption }),
  };
}

// =============================================================================
// Player calls this to send their buzz to the host via RPC
// =============================================================================
async function submitResponse(payload) {
  if (isControllerPlayer() || isCohost()) {
    return;
  }
  try {
    const result = await RPC.call("buzz", payload, RPC.Mode.HOST);
    if (result?.ok === false) {
      setBuzzNotice(result.reason || getSnark("player.buzzer.buzzBlocked", "Buzz blocked."));
      render();
      return;
    }
    if (result?.easterEgg?.id === "f-you") {
      fYouEasterEggUnlocked = true;
    }
    if (result?.message) {
      setBuzzNotice(result.message);
    } else {
      setBuzzNotice(getSnark("player.buzzer.buzzSent", "Buzz sent."));
    }
    render();
  } catch {
    setBuzzNotice(getSnark("player.buzzer.buzzSendFailed", "Could not send buzz. Check connection/room."));
    render();
  }
}

// =============================================================================
// Host actions — open, close, reset round, start bingo, etc.
// =============================================================================
function openBuzzers() {
  if (!isHost()) {
    if (isCohost()) RPC.call("cohost-action", { fn: "openBuzzers", args: [] }, RPC.Mode.HOST);
    return;
  }
  console.log("openBuzzers: host triggered");
  const settings = getSettings();
  const round = getRound();
  const players = currentParticipants();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), players, getControllerId());
  if (isTeamSelectActive()) {
    setBuzzNotice("Close team selection before opening buzzers.");
    render();
    return;
  }
  if (hasUnassignedTeamPlayers(settings, players, assignments)) {
    setBuzzNotice("Assign every player to a team before opening buzzers.");
    render();
    return;
  }
  if (settings.valueSelectionMethod === "roulette" && (round.roulette?.finalValue === null || round.roulette?.finalValue === undefined)) {
    setBuzzNotice("Start pick-a-value first to set the round value.");
    render();
    return;
  }
  const openedAt = now();
  const closesAt = openedAt + settings.timeOpen * 1000;
  setState(
    "round",
    {
      ...round,
      status: ROUND_STATUSES.OPEN,
      opensAt: openedAt,
      closesAt,
      remainingCs: settings.timeOpen * 100,
      winnerId: null,
      winnerTeam: null,
      winnerOption: null,
      winnerAnswer: null,
      winnerName: null,
      buzzedPlayerIds: [],
      buzzCounts: {},
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
        finalValue: round.roulette?.finalValue ?? null,
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

// Immediately close buzzers mid-round
function closeBuzzers() {
  if (!isHost()) { if (isCohost()) RPC.call("cohost-action", { fn: "closeBuzzers", args: [] }, RPC.Mode.HOST); return; }
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
      winnerTeam: null,
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

// =============================================================================
// Bingo / "Wen Dit Happn" mode — host starts, sets target, cycles items
// =============================================================================
function startBingo() {
  if (!isHost()) return;
  const isWen = isWenDitHapnMode();
  let items, word;
  if (isWen) {
    items = [...WEN_DIT_HAPN_ITEMS];
    word = "";
  } else {
    const draftWord = String(document.querySelector("#bingo-word")?.value || "").trim().toUpperCase();
    if (draftWord.length !== 5 || !/^[A-Z]{5}$/.test(draftWord)) {
      setBuzzNotice("Enter a 5-letter word.");
      render();
      return;
    }
    word = draftWord;
    items = word.split("");
  }
  const itemStates = items.map(() => ({ collectedBy: null }));
  setState("bingo", {
    active: true,
    word,
    items,
    itemStates,
    targetIndex: -1,
    cycling: false,
    currentLitIndex: -1,
    currentLitSlot: 0,
    currentLitTs: 0,
    collectedCounts: {},
    winner: null,
    playerItems: {},
  }, true);
  setBuzzNotice(`${isWen ? "Wen Dit Happn" : "Bingo"} started!`);
  render();
}

// Stop bingo mode and clear cycling interval
function endBingo() {
  if (!isHost()) return;
  if (bingoCycleInterval) {
    clearInterval(bingoCycleInterval);
    bingoCycleInterval = null;
  }
  bingoCycleQueue = [];
  setState("bingo", { ...getBingo(), active: false, cycling: false, currentLitIndex: -1, currentLitSlot: 0 }, true);
  setBuzzNotice(`${isWenDitHapnMode() ? "Wen Dit Happn" : "Bingo"} stopped.`);
  render();
}

// Host picks which item is the correct target
function setBingoTarget(index) {
  if (!isHost()) return;
  const bingo = getBingo();
  if (index < 0 || index >= bingo.items.length) return;
  setState("bingo", { ...bingo, targetIndex: index, currentLitIndex: -1, currentLitSlot: 0 }, true);
  render();
}

// Fisher-Yates shuffle of indices 0..n-1, used by "Less random bingo" cycling
function shuffledIndices(n) {
  const arr = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Begin rapidly cycling through items so players must buzz at the right moment
function startBingoCycling() {
  if (!isHost()) return;
  const bingo = getBingo();
  if (bingo.targetIndex < 0) {
    setBuzzNotice("Select a target first.");
    render();
    return;
  }
  let firstIndex;
  if (getSettings().bingoLessRandom) {
    bingoCycleQueue = shuffledIndices(bingo.items.length);
    firstIndex = bingoCycleQueue.shift();
  } else {
    firstIndex = Math.floor(Math.random() * bingo.items.length);
  }
  setState("bingo", {
    ...bingo,
    cycling: true,
    currentLitIndex: firstIndex,
    currentLitSlot: 0,
    currentLitTs: now(),
  }, true);
  if (bingoCycleInterval) clearInterval(bingoCycleInterval);
  bingoCycleInterval = setInterval(() => {
    if (!isHost()) return;
    const cur = getBingo();
    if (!cur.active || !cur.cycling) return;
    let nextIdx;
    if (getSettings().bingoLessRandom) {
      if (bingoCycleQueue.length === 0) {
        bingoCycleQueue = shuffledIndices(cur.items.length);
        if (bingoCycleQueue.length > 1 && bingoCycleQueue[0] === cur.currentLitIndex) {
          [bingoCycleQueue[0], bingoCycleQueue[1]] = [bingoCycleQueue[1], bingoCycleQueue[0]];
        }
      }
      nextIdx = bingoCycleQueue.shift();
    } else {
      do {
        nextIdx = Math.floor(Math.random() * cur.items.length);
      } while (nextIdx === cur.currentLitIndex && cur.items.length > 1);
    }
    setState("bingo", { ...cur, currentLitIndex: nextIdx, currentLitSlot: (cur.currentLitSlot || 0) + 1, currentLitTs: now() }, true);
  }, BINGO_ITEM_CHANGE_INTERVAL_MS);
  render();
}

// Stop cycling animation without resolving the target
function stopBingoCycling() {
  if (!isHost()) return;
  if (bingoCycleInterval) {
    clearInterval(bingoCycleInterval);
    bingoCycleInterval = null;
  }
  bingoCycleQueue = [];
  const bingo = getBingo();
  setState("bingo", { ...bingo, cycling: false, currentLitIndex: -1, currentLitSlot: 0, currentLitTs: 0 }, true);
  render();
}

// Host RPC handler for bingo buzzes — compares observed litIndex to target
function handleBingoBuzz(player, payload) {
  const bingo = getBingo();
  if (!bingo.active || !bingo.cycling) {
    return { ok: false, reason: getSnark("player.bingo.notActive", "Not active.") };
  }
  const settings = getSettings();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
  const teamColor = getPlayerTeamColor(player.id, assignments);
  if (settings.teamModeEnabled && !teamColor) {
    return { ok: false, reason: getSnark("player.buzzer.notAssignedToTeam", "Host has not assigned you to a team yet.") };
  }
  const trackKey = getTeamTrackKey(player.id, settings, assignments);
  const scoreKey = getScoreKeyForPlayer(player.id, settings, assignments);
  if (!isBingoActiveViewer(bingo, payload?.litSlot, player.id, settings, assignments)) {
    return { ok: false, reason: getSnark("player.bingo.notYourTurn", "Not your turn — wait for your teammate to call the letter!") };
  }
  const observedIndex = payload?.litIndex;
  if (observedIndex === undefined || observedIndex < 0) {
    return { ok: false, reason: getSnark("player.bingo.invalid", "Invalid.") };
  }
  const targetIndex = bingo.targetIndex;
  const playerItems = bingo.playerItems || {};
  const collected = playerItems[trackKey] || [];
  if (observedIndex === targetIndex) {
    const alreadyCollected = collected.includes(targetIndex);
    const newPlayerItems = { ...playerItems };
    if (!alreadyCollected) {
      newPlayerItems[trackKey] = [...collected, targetIndex];
    }
    const collectedCounts = { ...bingo.collectedCounts };
    if (!alreadyCollected) {
      collectedCounts[trackKey] = (collectedCounts[trackKey] || 0) + 1;
    }
    let winner = null;
    if (!isWenDitHapnMode() && (collectedCounts[trackKey] || 0) >= bingo.items.length) {
      winner = trackKey;
    }
    const scores = { ...getScores() };
    scores[scoreKey] = (scores[scoreKey] || 0) + BINGO_CORRECT_POINTS;
    setState("scores", scores, true);
    const log = getLog();
    setState("gameLog", [...log, {
      id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "bingo", ts: now(), playerId: player.id,
      playerName: getPlayerName(player), teamColor,
      scoreKey,
      scoreTarget: scoreKey.startsWith("team:") ? `Team ${teamColor}` : getPlayerName(player),
      item: bingo.items[targetIndex],
      result: "correct", points: BINGO_CORRECT_POINTS,
    }], true);
    if (bingoCycleInterval) { clearInterval(bingoCycleInterval); bingoCycleInterval = null; }
    bingoCycleQueue = [];
    setState("bingo", {
      ...bingo, playerItems: newPlayerItems,
      collectedCounts, winner, cycling: false, currentLitIndex: -1, currentLitSlot: 0,
    }, true);
    render();
    return { ok: true, message: getSnark("player.outcome.bingoCorrect", "Correct! +500") };
  } else {
    const scores = { ...getScores() };
    scores[scoreKey] = (scores[scoreKey] || 0) + BINGO_INCORRECT_POINTS;
    setState("scores", scores, true);
    const log = getLog();
    setState("gameLog", [...log, {
      id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "bingo", ts: now(), playerId: player.id,
      playerName: getPlayerName(player), teamColor,
      scoreKey,
      scoreTarget: scoreKey.startsWith("team:") ? `Team ${teamColor}` : getPlayerName(player),
      item: bingo.items[observedIndex],
      result: "incorrect", points: BINGO_INCORRECT_POINTS,
    }], true);
    render();
    return { ok: true, message: getSnark("player.outcome.bingoIncorrect", "Incorrect! -500") };
  }
}

// =============================================================================
// Dis or Dat — host-only game logic (no cycling, static questions)
// =============================================================================
function startDisOrDat(mode, playerId) {
  if (!isHost()) return;
  const dd = getDisOrDat();
  if (dd.answers.some(a => a !== "dis" && a !== "dat" && a !== "both")) return;
  const isTimed = mode === "onePlayTimed" || mode === "allPlayTimed";
  setState("disordat", {
    ...dd,
    active: true,
    phase: "playing",
    mode,
    activePlayerId: mode === "onePlayTimed" ? playerId : null,
    pendingPick: false,
    timeEndsAt: isTimed ? now() + DIS_OR_DAT_TIMED_SECONDS * 1000 : null,
    currentQuestion: 0,
    responses: {},
    pointsEarned: {},
    jackBonus: {},
    finishedPlayerIds: [],
  }, true);
  render();
}

function handleDisOrDatAnswer(player, payload) {
  const dd = getDisOrDat();
  if (!dd.active || dd.phase !== "playing") {
    return { ok: false, reason: getSnark("player.disdat.notActive", "Dis or Dat isn't active.") };
  }
  const q = Number(payload?.q);
  const answer = payload?.answer;
  if (!Number.isInteger(q) || q < 0 || q >= DIS_OR_DAT_QUESTION_COUNT) {
    return { ok: false, reason: getSnark("player.disdat.badQuestion", "Bad question.") };
  }
  if (answer !== "dis" && answer !== "dat" && answer !== "both") {
    return { ok: false, reason: getSnark("player.disdat.badAnswer", "Bad answer.") };
  }
  const settings = getSettings();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
  const trackKey = getTeamTrackKey(player.id, settings, assignments);
  const isSharedTeam = trackKey !== player.id;
  if (settings.teamModeEnabled && !getPlayerTeamColor(player.id, assignments)) {
    return { ok: false, reason: getSnark("player.buzzer.notAssignedToTeam", "Host has not assigned you to a team yet.") };
  }
  if (dd.mode === "onePlayTimed") {
    const activeTrackKey = isSharedTeam ? getTeamTrackKey(dd.activePlayerId, settings, assignments) : dd.activePlayerId;
    if (player.id !== dd.activePlayerId && trackKey !== activeTrackKey) {
      return { ok: false, reason: getSnark("player.disdat.notActivePlayer", "You're not the active player.") };
    }
  }
  if (dd.mode === "allPlayHostPaced" && q !== dd.currentQuestion) {
    return { ok: false, reason: getSnark("player.disdat.notLiveYet", "That question isn't live yet.") };
  }
  if (dd.timeEndsAt && now() > dd.timeEndsAt) {
    return { ok: false, reason: getSnark("player.outcome.timeUp", "Time's up.") };
  }
  const resps = dd.responses[trackKey] || [];
  if (resps[q] === "dis" || resps[q] === "dat" || resps[q] === "both" || resps[q] === "none") {
    return { ok: false, reason: getSnark("player.disdat.alreadyAnswered", "Already answered.") };
  }
  if ((dd.mode === "onePlayTimed" || dd.mode === "allPlayTimed") &&
    q !== resps.filter(a => a === "dis" || a === "dat" || a === "both").length) {
    return { ok: false, reason: getSnark("player.disdat.answerCurrentFirst", "Answer the current question first.") };
  }

  const isTimed = dd.mode === "onePlayTimed" || dd.mode === "allPlayTimed";
  const isCorrect = answer === dd.answers[q];

  const nextResponses = { ...(dd.responses || {}) };
  const nextResps = [...resps];
  nextResps[q] = answer;
  nextResponses[trackKey] = nextResps;

  const nextPoints = { ...(dd.pointsEarned || {}) };
  if (isCorrect) nextPoints[trackKey] = (nextPoints[trackKey] || 0) + DIS_OR_DAT_CORRECT_POINTS;

  const nextBonus = { ...(dd.jackBonus || {}) };
  let nextFinished = dd.finishedPlayerIds || [];
  const answeredAll = nextResps.filter(a => a === "dis" || a === "dat" || a === "both").length >= DIS_OR_DAT_QUESTION_COUNT;
  if (answeredAll && isTimed && !nextFinished.includes(trackKey)) {
    const correctCount = nextResps.filter((a, i) => a === dd.answers[i]).length;
    if (correctCount >= DIS_OR_DAT_BONUS_MIN_CORRECT) {
      nextBonus[trackKey] = getDisOrDatTimeLeftCs(dd);
    }
    nextFinished = [...nextFinished, trackKey];
  }

  setState("disordat", {
    ...dd,
    responses: nextResponses,
    pointsEarned: nextPoints,
    jackBonus: nextBonus,
    finishedPlayerIds: nextFinished,
  }, true);

  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  const participants = currentParticipants().filter(p => p.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(p.id)));
  let activeTracks;
  if (dd.mode === "onePlayTimed") {
    activeTracks = [getTeamTrackKey(dd.activePlayerId, settings, assignments)].filter(Boolean);
  } else if (isSharedTeam) {
    activeTracks = [...new Set(participants.map(p => getTeamTrackKey(p.id, settings, assignments)).filter(Boolean))];
  } else {
    activeTracks = participants.map(p => p.id);
  }
  if (isTimed && activeTracks.length > 0 && activeTracks.every(track =>
    (nextResponses[track] || []).filter(a => a === "dis" || a === "dat" || a === "both").length >= DIS_OR_DAT_QUESTION_COUNT)) {
    finalizeDisOrDat();
    return { ok: true, message: isCorrect ? getSnark("player.outcome.disdatCorrect", "Correct! +300") : getSnark("player.outcome.disdatIncorrect", "Incorrect.") };
  }

  render();
  return { ok: true, message: isCorrect ? getSnark("player.outcome.disdatCorrect", "Correct! +300") : getSnark("player.outcome.disdatIncorrect", "Incorrect.") };
}

function nextDisOrDatQuestion() {
  if (!isHost()) return;
  const dd = getDisOrDat();
  if (!dd.active || dd.phase !== "playing" || dd.mode !== "allPlayHostPaced") return;
  const q = dd.currentQuestion;
  const nextResponses = { ...(dd.responses || {}) };
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  const participants = currentParticipants().filter(p => p.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(p.id)));
  const settings = getSettings();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), controllerId);
  const tracks = [...new Set(participants.map(p => getTeamTrackKey(p.id, settings, assignments)).filter(Boolean))];
  for (const track of tracks) {
    const resps = nextResponses[track] || [];
    if (resps[q] !== "dis" && resps[q] !== "dat" && resps[q] !== "both") {
      const next = [...resps];
      next[q] = "none";
      nextResponses[track] = next;
    }
  }
  const nextQ = q + 1;
  if (nextQ >= DIS_OR_DAT_QUESTION_COUNT) {
    setState("disordat", { ...dd, responses: nextResponses, currentQuestion: nextQ }, true);
    finalizeDisOrDat();
    return;
  }
  setState("disordat", { ...dd, responses: nextResponses, currentQuestion: nextQ }, true);
  render();
}

function finalizeDisOrDat() {
  if (!isHost()) return;
  const dd = getDisOrDat();
  if (!dd.active || dd.phase === "results") return;

  const isTimed = dd.mode === "onePlayTimed" || dd.mode === "allPlayTimed";
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  const participants = currentParticipants().filter(p => p.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(p.id)));

  const settings = getSettings();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), controllerId);
  const tracks = [...new Set(participants.map(p => getTeamTrackKey(p.id, settings, assignments)).filter(Boolean))];

  let responses = dd.responses || {};
  if (isTimed) {
    const next = {};
    for (const track of tracks) {
      const resps = responses[track] || [];
      const filled = resps.map(a => (a === "dis" || a === "dat" || a === "both") ? a : "none");
      next[track] = filled;
    }
    responses = next;
  }

  const scores = { ...getScores() };
  const log = getLog();

  for (const track of tracks) {
    const resps = responses[track] || [];
    if (resps.length === 0) continue;
    const correctCount = resps.filter((a, i) => a === dd.answers[i]).length;
    const base = correctCount * DIS_OR_DAT_CORRECT_POINTS;
    const bonus = dd.jackBonus[track] || 0;
    const total = base + bonus;
    const isTeamTrack = TEAM_COLORS.includes(track);
    const rep = participants.find(p => getTeamTrackKey(p.id, settings, assignments) === track) || null;
    const teamColor = isTeamTrack ? track : null;
    const scoreKey = rep ? getScoreKeyForPlayer(rep.id, settings, assignments) : track;
    scores[scoreKey] = Number(scores[scoreKey] || 0) + total;
    log.push({
      id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "disordat",
      ts: now(),
      playerId: rep?.id || track,
      playerName: rep ? getPlayerName(rep) : track,
      teamColor,
      scoreKey,
      scoreTarget: scoreKey.startsWith("team:") ? `Team ${teamColor}` : (rep ? getPlayerName(rep) : track),
      option: null,
      answerText: `Dis or Dat: ${correctCount}/${DIS_OR_DAT_QUESTION_COUNT} correct${isTimed && bonus ? ` + ${bonus} bonus` : ""}`,
      timeLeftCs: 0,
      scoringMode: "uniform",
      jackMultiplier: settings.jackMultiplier,
      uniformPoints: DIS_OR_DAT_CORRECT_POINTS,
      basePoints: 0,
      awardedDelta: total,
      resolved: true,
    });
  }

  setState("scores", scores, true);
  setState("gameLog", log, true);
  setState("disordat", { ...dd, responses, phase: "results" }, true);
  render();
}

function endDisOrDat() {
  if (!isHost()) return;
  finalizeDisOrDat();
}

function resetDisOrDat() {
  if (!isHost()) return;
  const dd = getDisOrDat();
  setState("disordat", {
    ...dd,
    active: false,
    phase: "playing",
    mode: null,
    activePlayerId: null,
    pendingPick: false,
    timeEndsAt: null,
    currentQuestion: 0,
    responses: {},
    pointsEarned: {},
    jackBonus: {},
    finishedPlayerIds: [],
  }, true);
  render();
}

function exitDisOrDat() {
  if (!isHost()) return;
  const dd = getDisOrDat();
  if (dd.active && dd.phase === "playing") finalizeDisOrDat();
  setHostSetting("inputMode", "buttons");
}

function handleDisOrDatTick() {
  if (!isHost()) return;
  const dd = getDisOrDat();
  if (!dd.active || dd.phase !== "playing") return;
  if (dd.mode === "onePlayTimed" || dd.mode === "allPlayTimed") {
    if (dd.timeEndsAt && now() >= dd.timeEndsAt) {
      finalizeDisOrDat();
      return;
    }
    render();
  }
}

// =============================================================================
// Return round to IDLE, preserving roulette final value and settings
// =============================================================================
function resetRound() {
  if (!isHost()) {
    if (isCohost()) RPC.call("cohost-action", { fn: "resetRound", args: [] }, RPC.Mode.HOST);
    return;
  }
  const settings = getSettings();
  const currentRound = getRound();
  setState(
    "round",
    {
      status: ROUND_STATUSES.IDLE,
      opensAt: null,
      closesAt: null,
      remainingCs: settings.timeOpen * 100,
      winnerId: null,
      winnerTeam: null,
      winnerOption: null,
      winnerAnswer: null,
      winnerName: null,
      buzzedPlayerIds: [],
      buzzCounts: {},
      roulette: {
        active: false,
        startedAt: null,
        mode: settings.rouletteMode,
        topAmount: normalizeRouletteTopAmount(settings.rouletteTopAmount),
        ceiling: 0,
        seed: null,
        targetPlayerId: null,
        targetPlayerName: null,
        selections: {},
        completedPlayerIds: [],
        finalValue: currentRound.roulette?.finalValue ?? null,
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

// =============================================================================
// Screw mechanic — a player can force another to answer under time pressure
// Points are reversed (screwer gains what screwee loses)
// =============================================================================
function initiateScrew(screwerId) {
  if (!isHost()) {
    if (isCohost()) { RPC.call("cohost-action", { fn: "initiateScrew", args: [screwerId] }, RPC.Mode.HOST); return { ok: true }; }
    return { ok: false, reason: "Only host can initiate screw." };
  }
  const round = getRound();
  const settings = getSettings();
  
  if (isBingoMode()) {
    return { ok: false, reason: getSnark("player.screw.noSpecial", "Cannot screw during special questions.") };
  }
  if (!settings.allowScrewing) {
    return { ok: false, reason: getSnark("player.screw.notEnabled", "Screwing is not enabled.") };
  }
  if (round.status !== ROUND_STATUSES.OPEN) {
    return { ok: false, reason: getSnark("player.buzzer.buzzersNotOpen", "Buzzers are not open.") };
  }
  if (round.screw.active) {
    return { ok: false, reason: getSnark("player.screw.alreadyActive", "A screw is already in progress.") };
  }
  if (round.screwsUsedBy?.includes(screwerId)) {
    return { ok: false, reason: getSnark("player.screw.alreadyUsed", "You have already used your screw.") };
  }
  
  const screwer = currentParticipants().find((p) => p.id === screwerId);
  if (!screwer) {
    return { ok: false, reason: getSnark("player.screw.invalidScrewer", "Invalid screwer.") };
  }
  const frozenCs = getTimeLeftCs(round, settings);
  const frozenPoints = computeBasePoints(settings, frozenCs, round);
  
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
        frozenCs,
        frozenPoints,
      },
    },
    true,
  );
  
  setBuzzNotice("A screw is being used...");
  render();
  return { ok: true, message: getSnark("player.screw.initiated", `${getPlayerName(screwer)} initiated a screw.`, { player: getPlayerName(screwer) }) };
}

// Host/co-host initiates a screw without needing allowScrewing or screw cap
function hostInitiateScrew() {
  if (!hasHostPrivileges()) return;
  const round = getRound();
  if (isBingoMode()) {
    setBuzzNotice("Cannot screw during special questions.");
    render();
    return;
  }
  if (round.status !== ROUND_STATUSES.OPEN) {
    setBuzzNotice("Buzzers are not open.");
    render();
    return;
  }
  if (round.screw.active) {
    setBuzzNotice("A screw is already in progress.");
    render();
    return;
  }
  const mePlayer = me();
  const frozenCs = getTimeLeftCs(round, getSettings());
  const frozenPoints = computeBasePoints(getSettings(), frozenCs, round);
  setState("round", {
    ...round,
    screw: {
      ...round.screw,
      active: true,
      screwerId: mePlayer.id,
      screwerName: getPlayerName(mePlayer),
      screweeId: null,
      screeeName: null,
      screwTimerMs: null,
      frozenCs,
      frozenPoints,
    },
  }, true);
  setBuzzNotice("Select a player to screw.");
  render();
}

// Host selects the target player being screwed
function selectScrewee(screweeId) {
  if (!isHost()) {
    if (isCohost()) { RPC.call("cohost-action", { fn: "selectScrewee", args: [screweeId] }, RPC.Mode.HOST); return { ok: true }; }
    return { ok: false, reason: "Only host can select screwee." };
  }
  const round = getRound();
  
  if (!round.screw.active) {
    return { ok: false, reason: getSnark("player.screw.noScrewInProgress", "No screw in progress.") };
  }
  if (round.screw.screweeId !== null) {
    return { ok: false, reason: getSnark("player.screw.screweeAlreadySelected", "Screwee already selected.") };
  }
  
  const screwee = currentParticipants().find((p) => p.id === screweeId);
  if (!screwee) {
    return { ok: false, reason: getSnark("player.screw.invalidScrewee", "Invalid screwee.") };
  }
  if (screwee.id === getControllerId()) {
    return { ok: false, reason: getSnark("player.screw.cannotHost", "Cannot screw the host.") };
  }
  if (screwee.id === round.screw.screwerId) {
    return { ok: false, reason: getSnark("player.screw.cannotSelf", "Cannot screw yourself.") };
  }

  const settings = getSettings();
  if (settings.teamModeEnabled && settings.teamScoringMode === "shared") {
    const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
    const screwerTeam = getPlayerTeamColor(round.screw.screwerId, assignments);
    const screweeTeam = getPlayerTeamColor(screweeId, assignments);
    if (screwerTeam && screwerTeam === screweeTeam) {
      return { ok: false, reason: getSnark("player.screw.cannotOwnTeam", "Cannot screw your own team in shared team mode.") };
    }
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
  return { ok: true, message: getSnark("player.screw.over", `${round.screw.screwerName} is screwing over ${getPlayerName(screwee)}.`, { screwer: round.screw.screwerName, screwee: getPlayerName(screwee) }) };
}

// Start the 5-second screw countdown — only screwee can buzz during this window
function startScrewTimer() {
  if (!isHost()) {
    if (isCohost()) { RPC.call("cohost-action", { fn: "startScrewTimer", args: [] }, RPC.Mode.HOST); return { ok: true }; }
    return { ok: false, reason: "Only host can start screw timer." };
  }
  const round = getRound();
  
  if (!round.screw.active || !round.screw.screweeId) {
    return { ok: false, reason: getSnark("player.screw.noScrewee", "No screw in progress or screwee not selected.") };
  }
  
  const settings = getSettings();
  const timeLeftCs = getTimeLeftCs(round, settings);
  const frozenPoints = computeBasePoints(settings, timeLeftCs, round);
  
  setState(
    "round",
    {
      ...round,
      screw: {
        ...round.screw,
        screwTimerMs: 5000,
        screwTimerEndsAt: now() + 5000,
        frozenCs: timeLeftCs,
        frozenPoints: frozenPoints,
      },
    },
    true,
  );
  
  render();
  return { ok: true, message: "Screw timer started." };
}

// End the screw and increment the screw-use counter
function closeScrewMode() {
  if (!isHost()) {
    if (isCohost()) RPC.call("cohost-action", { fn: "closeScrewMode", args: [] }, RPC.Mode.HOST);
    return;
  }
  const round = getRound();
  const frozenCs = round.screw?.frozenCs;
  const resumeOpen = round.status === ROUND_STATUSES.OPEN && Number.isFinite(frozenCs);
  const nextRound = {
    ...round,
    screw: {
      active: false,
      screwerId: null,
      screwerName: null,
      screweeId: null,
      screeeName: null,
      screwTimerMs: null,
      frozenCs: null,
      frozenPoints: null,
    },
    screwsUsedBy: [...(round.screwsUsedBy || []), round.screw.screwerId],
  };
  if (resumeOpen) {
    // Main timer was paused during the screw; resume it from the frozen value.
    nextRound.closesAt = now() + frozenCs * 10;
    nextRound.remainingCs = frozenCs;
  }
  setState("round", nextRound, true);
  render();
}

// Reset the screw counter (e.g. between games)
function resetScrews() {
  if (!isHost()) {
    if (isCohost()) RPC.call("cohost-action", { fn: "resetScrews", args: [] }, RPC.Mode.HOST);
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
      screwsUsedBy: [],
    },
    true,
  );
  render();
}

// =============================================================================
// Called every ~1 s by the host — manages timers, screw countdowns, roulette
// =============================================================================
function hostTick() {
  if (!isHost()) {
    return;
  }
  if (isBingoMode()) return;
  if (isDisOrDatMode()) {
    handleDisOrDatTick();
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
    const remainingMs = typeof round.screw.screwTimerEndsAt === "number"
      ? Math.max(0, round.screw.screwTimerEndsAt - now())
      : Math.max(0, round.screw.screwTimerMs - 1000);
    const nextMs = Math.max(0, remainingMs);
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
          const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
          const screweeTeamColor = getPlayerTeamColor(round.screw.screweeId, assignments);
          const screweeScoreKey = getScoreKeyForPlayer(round.screw.screweeId, settings, assignments);
          const screwerScoreKey = getScoreKeyForPlayer(round.screw.screwerId, settings, assignments);
          const frozenCs = round.screw.frozenCs ?? (round.remainingCs || settings.timeOpen * 100);
          const basePoints = round.screw.frozenPoints ?? computeBasePoints(settings, round.remainingCs || settings.timeOpen * 100, round);
          const entry = {
            id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: "buzz",
            ts: now(),
            playerId: round.screw.screweeId,
            playerName: round.screw.screeeName,
            teamColor: screweeTeamColor,
            scoreKey: screweeScoreKey,
            scoreTarget: screweeScoreKey.startsWith("team:") ? `Team ${screweeTeamColor}` : round.screw.screeeName,
            option: null,
            answerText: "[No answer - Screw timeout]",
            timeLeftCs: frozenCs,
            scoringMode: settings.scoringMode,
            jackMultiplier: settings.jackMultiplier,
            uniformPoints: settings.uniformPoints,
            valueSelectionMethod: settings.valueSelectionMethod,
            rouletteMode: settings.rouletteMode,
            rouletteTopAmount: settings.rouletteTopAmount,
            rouletteFinalValue: round.roulette?.finalValue ?? null,
            basePoints: basePoints,
            awardedDelta: -(basePoints + 1000),
            resolved: true,
          };
          const log = getLog();
          setState("gameLog", [...log, entry], true);
          
          const scores = { ...getScores() };
          scores[screweeScoreKey] = Number(scores[screweeScoreKey] || 0) - basePoints - 1000;
          scores[screwerScoreKey] = Number(scores[screwerScoreKey] || 0) + 1000;
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
        winnerTeam: null,
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

// =============================================================================
// Host applies a settings change — validates and syncs dependent fields
// =============================================================================
function setHostSetting(key, value) {
  if (!isHost()) {
    if (isCohost()) RPC.call("cohost-action", { fn: "setHostSetting", args: [key, value] }, RPC.Mode.HOST);
    return;
  }
  const settings = getSettings();
  const next = { ...settings, [key]: value };
  if (key === "scoringMode" && value === "uniform") {
    next.uniformPoints = settings.uniformPoints || 1000;
    next.valueSelectionMethod = "standard";
  }
  if (key === "scoringMode" && value === "jack") {
    next.jackMultiplier = settings.jackMultiplier || 1;
    next.valueSelectionMethod = "standard";
  }
  if (key === "scoringMode" && value === "roulette") {
    next.valueSelectionMethod = "roulette";
  }
  if (key === "optionCount") {
    next.disabledOptions = normalizeDisabledOptions(settings.disabledOptions, value);
  }
  if (key === "inputMode") {
    if (value !== "bingo" && value !== "wendithapn") {
      if (bingoCycleInterval) { clearInterval(bingoCycleInterval); bingoCycleInterval = null; }
      setState("bingo", getBingo(), true);
    }
    if (value === "text") {
      next.optionCount = settings.optionCount || 4;
      next.disabledOptions = normalizeDisabledOptions([], settings.optionCount || 4);
    }
    if (value === "bingo" || value === "wendithapn") {
      const idleRound = {
        status: ROUND_STATUSES.IDLE, opensAt: null, closesAt: null,
        remainingCs: settings.timeOpen * 100, winnerId: null, winnerTeam: null,
        winnerOption: null, winnerAnswer: null, winnerName: null,
        buzzedPlayerIds: [],
        buzzCounts: {},
        roulette: { active: false, startedAt: null, mode: settings.rouletteMode, topAmount: normalizeRouletteTopAmount(settings.rouletteTopAmount), ceiling: 0, seed: null, targetPlayerId: null, targetPlayerName: null, selections: {}, completedPlayerIds: [], finalValue: null, finishedAt: null },
        screw: { active: false, screwerId: null, screwerName: null, screweeId: null, screeeName: null, screwTimerMs: null, frozenCs: null, frozenPoints: null },
      };
      setState("round", idleRound, true);
      setState("pendingLogId", null, true);
    }
    if (value === "disordat") {
      const idleRound = {
        status: ROUND_STATUSES.IDLE, opensAt: null, closesAt: null,
        remainingCs: settings.timeOpen * 100, winnerId: null, winnerTeam: null,
        winnerOption: null, winnerAnswer: null, winnerName: null,
        buzzedPlayerIds: [],
        buzzCounts: {},
        roulette: { active: false, startedAt: null, mode: settings.rouletteMode, topAmount: normalizeRouletteTopAmount(settings.rouletteTopAmount), ceiling: 0, seed: null, targetPlayerId: null, targetPlayerName: null, selections: {}, completedPlayerIds: [], finalValue: null, finishedAt: null },
        screw: { active: false, screwerId: null, screwerName: null, screweeId: null, screeeName: null, screwTimerMs: null, frozenCs: null, frozenPoints: null },
      };
      setState("round", idleRound, true);
      setState("pendingLogId", null, true);
      setState("disordat", {
        ...getDisOrDat(),
        active: false,
        phase: "playing",
        mode: null,
        activePlayerId: null,
        pendingPick: false,
        timeEndsAt: null,
        currentQuestion: 0,
        responses: {},
        pointsEarned: {},
        jackBonus: {},
        finishedPlayerIds: [],
      }, true);
    }
  }
  if (key === "rouletteTopAmount") {
    next.rouletteTopAmount = normalizeRouletteTopAmount(value);
  }
  if (key === "teamModeEnabled" && !value) {
    next.teamScoringMode = "alliance";
    if (getTeamSelect()?.active) {
      setState("teamSelect", { ...getTeamSelect(), active: false, locked: false }, true);
    }
  }
  if (key === "teamScoringMode") {
    next.teamScoringMode = value === "shared" ? "shared" : "alliance";
  }
  setState("settings", next, true);
  render();
}

// =============================================================================
// Host toggles individual answer options on/off, ensures at least one stays on
// =============================================================================
function toggleBuzzerOption(option) {
  if (!isHost()) {
    if (isCohost()) RPC.call("cohost-action", { fn: "toggleBuzzerOption", args: [option] }, RPC.Mode.HOST);
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

// Host sets the correct text answer
function setCorrectAnswerValue(val) {
  if (!isHost()) {
    if (isCohost()) RPC.call("cohost-action", { fn: "setCorrectAnswerValue", args: [val] }, RPC.Mode.HOST);
    return;
  }
  const round = getRound();
  setState("round", { ...round, correctAnswer: val, correctOptions: null }, true);
  render();
}

function clearCorrectAnswerValue() {
  if (!isHost()) {
    if (isCohost()) RPC.call("cohost-action", { fn: "clearCorrectAnswerValue", args: [] }, RPC.Mode.HOST);
    return;
  }
  const round = getRound();
  setState("round", { ...round, correctAnswer: null, correctOptions: null }, true);
  render();
}

function toggleCorrectOption(opt) {
  if (!isHost()) {
    if (isCohost()) RPC.call("cohost-action", { fn: "toggleCorrectOption", args: [opt] }, RPC.Mode.HOST);
    return;
  }
  const round = getRound();
  const current = Array.isArray(round.correctOptions) ? round.correctOptions.map(Number) : [];
  const included = current.includes(opt);
  const next = included ? current.filter((v) => Number(v) !== opt) : [...current, opt].sort((a,b)=>a-b);
  setState("round", { ...round, correctOptions: next.length ? next : null, correctAnswer: null }, true);
  render();
}

// Host enables/disables a specific player's ability to buzz
function togglePlayerBuzzer(playerId) {
  if (!isHost()) {
    if (isCohost()) RPC.call("cohost-action", { fn: "togglePlayerBuzzer", args: [playerId] }, RPC.Mode.HOST);
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

// =============================================================================
// Team management — assign a player to a color team
// =============================================================================
// Host-side write: validates the player, prunes stale assignments, applies the change.
function applyTeamAssignment(playerId, teamColor) {
  const players = currentParticipants();
  const controllerId = getControllerId();
  if (!players.some((player) => player.id === playerId) || playerId === controllerId) {
    return;
  }

  const nextAssignments = {
    ...normalizeTeamAssignments(getTeamAssignments(), players, controllerId),
  };

  if (!teamColor || !TEAM_COLORS.includes(teamColor)) {
    delete nextAssignments[playerId];
  } else {
    nextAssignments[playerId] = teamColor;
  }

  setState("teamAssignments", nextAssignments, true);
}

function setPlayerTeam(playerId, teamColor) {
  if (!isHost()) {
    if (isCohost()) RPC.call("cohost-action", { fn: "setPlayerTeam", args: [playerId, teamColor] }, RPC.Mode.HOST);
    return;
  }

  applyTeamAssignment(playerId, teamColor);
  render();
}

function randomizeTeams() {
  if (!isHost()) {
    if (isCohost()) RPC.call("cohost-action", { fn: "randomizeTeams", args: [] }, RPC.Mode.HOST);
    return;
  }

  const players = currentParticipants();
  const controllerId = getControllerId();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), players, controllerId);
  const cohostIds = getSafeState("cohostIds", []);
  const nonControllerPlayers = players.filter((player) => player.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)));

  if (nonControllerPlayers.length === 0) {
    return;
  }

  const usedColors = [...new Set(Object.values(assignments))].filter((c) => TEAM_COLORS.includes(c));
  const teamColors = usedColors.length >= 2 ? usedColors : TEAM_COLORS.slice(0, Math.min(2, TEAM_COLORS.length));

  const shuffled = [...nonControllerPlayers];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const nextAssignments = {};
  shuffled.forEach((player, index) => {
    nextAssignments[player.id] = teamColors[index % teamColors.length];
  });

  setState("teamAssignments", nextAssignments, true);
  render();
}

// =============================================================================
// Player-led team selection — host controls the phase; players pick via RPC.
// =============================================================================
function openTeamSelect() {
  if (!hasHostPrivileges()) {
    return;
  }
  if (!isHost()) {
    cohostDispatch("openTeamSelect");
    return;
  }
  if (getRound().status !== ROUND_STATUSES.IDLE) {
    setBuzzNotice("Reset the round before opening team selection.");
    render();
    return;
  }
  const current = getTeamSelect();
  setState("teamSelect", { active: true, enabledTeams: [...TEAM_COLORS], locked: true, maxPerTeam: current.maxPerTeam || 0 }, true);
  render();
}

function closeTeamSelect() {
  if (!hasHostPrivileges()) {
    return;
  }
  if (!isHost()) {
    cohostDispatch("closeTeamSelect");
    return;
  }
  setState("teamSelect", { ...getTeamSelect(), active: false, locked: false }, true);
  render();
}

function setTeamSelectLocked(locked) {
  if (!hasHostPrivileges()) {
    return;
  }
  if (!isHost()) {
    cohostDispatch("setTeamSelectLocked", locked);
    return;
  }
  setState("teamSelect", { ...getTeamSelect(), locked: Boolean(locked) }, true);
  render();
}

function setTeamSelectTeams(teamColors) {
  if (!hasHostPrivileges()) {
    return;
  }
  if (!isHost()) {
    cohostDispatch("setTeamSelectTeams", teamColors);
    return;
  }
  const enabledTeams = (Array.isArray(teamColors) ? teamColors : []).filter((c) => TEAM_COLORS.includes(String(c)));
  const disabledTeams = TEAM_COLORS.filter((c) => !enabledTeams.includes(c));
  setState("teamSelect", { ...getTeamSelect(), enabledTeams }, true);
  if (disabledTeams.length > 0) {
    const players = currentParticipants();
    const controllerId = getControllerId();
    const nextAssignments = normalizeTeamAssignments(getTeamAssignments(), players, controllerId);
    players
      .filter((player) => player.id !== controllerId && disabledTeams.includes(nextAssignments[player.id]))
      .forEach((player) => delete nextAssignments[player.id]);
    setState("teamAssignments", nextAssignments, true);
  }
  render();
}

function setTeamSelectLimit(value) {
  if (!hasHostPrivileges()) {
    return;
  }
  if (!isHost()) {
    cohostDispatch("setTeamSelectLimit", value);
    return;
  }
  const maxPerTeam = Math.max(0, Math.min(42, parseInt(value, 10) || 0));
  setState("teamSelect", { ...getTeamSelect(), maxPerTeam }, true);
  render();
}

// Player-facing: select/change/leave a team while selection is open.
function handleSelectTeam(senderPlayer, teamColor) {
  const settings = getSettings();
  const teamSelect = getTeamSelect();
  const cohostIds = getSafeState("cohostIds", []);
  if (senderPlayer.id === getControllerId() || (Array.isArray(cohostIds) && cohostIds.includes(senderPlayer.id))) {
    return { ok: false, reason: getSnark("player.teamSelect.notOpen", "Team selection is not open.") };
  }
  if (!settings.teamModeEnabled || !teamSelect.active) {
    return { ok: false, reason: getSnark("player.teamSelect.notOpen", "Team selection is not open.") };
  }
  if (teamSelect.locked) {
    return { ok: false, reason: getSnark("player.teamSelect.locked", "Teams are locked. Ask the Host to unlock them.") };
  }
  if (teamColor && !TEAM_COLORS.includes(teamColor)) {
    return { ok: false, reason: getSnark("player.teamSelect.invalidTeam", "That team does not exist.") };
  }
  if (teamColor && !teamSelect.enabledTeams.includes(teamColor)) {
    return { ok: false, reason: getSnark("player.teamSelect.teamDisabled", "That team is not available to join.") };
  }
  if (teamColor && teamSelect.maxPerTeam > 0) {
    const alreadyOnTarget = getPlayerTeamColor(senderPlayer.id) === teamColor;
    if (!alreadyOnTarget && getTeamMembers(teamColor).length >= teamSelect.maxPerTeam) {
      return { ok: false, reason: getSnark("player.teamSelect.teamFull", "That team is full.") };
    }
  }
  applyTeamAssignment(senderPlayer.id, teamColor || null);
  render();
  if (teamColor) {
    return { ok: true, message: getSnark("player.teamSelect.joined", `Joined Team ${teamColor}.`, { team: teamColor }) };
  }
  return { ok: true, message: getSnark("player.teamSelect.left", "Left your team.") };
}

// =============================================================================
// Initialisation helpers — run on host only to set up initial state
// =============================================================================
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

// Ensure all shared state keys exist and are consistent
function ensureHostInit() {
  if (!isHost()) {
    return;
  }
  if (!getState("settings")) {
    const teamModeEnabled = hostPrejoinTeamSetting !== "off";
    const teamScoringMode = hostPrejoinTeamSetting === "shared" ? "shared" : "alliance";
    setState(
      "settings",
      {
        ...DEFAULT_SETTINGS,
        teamModeEnabled,
        teamScoringMode,
      },
      true,
    );
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
  if (!getState("bingo")) {
    setState("bingo", getBingo(), true);
  }
  if (!getState("teamSelect")) {
    setState("teamSelect", freshTeamSelect(), true);
  }
  if (!getState("cohostPassword")) {
    const password = String(Math.floor(10000 + Math.random() * 90000));
    setState("cohostPassword", password, true);
  }
  if (!getState("cohostIds")) {
    setState("cohostIds", [], true);
  } else {
    const currentIds = getSafeState("cohostIds", []);
    const activeIds = currentParticipants().map((p) => p.id);
    const cleaned = Array.isArray(currentIds) ? currentIds.filter((id) => activeIds.includes(id)) : [];
    if (cleaned.length !== (Array.isArray(currentIds) ? currentIds.length : 0)) {
      setState("cohostIds", cleaned, true);
    }
  }
  assignControllerIfNeeded();
  const players = currentParticipants();
  const controllerId = getControllerId();
  const normalizedAssignments = normalizeTeamAssignments(getTeamAssignments(), players, controllerId);
  const currentAssignments = getTeamAssignments();
  if (JSON.stringify(normalizedAssignments) !== JSON.stringify(currentAssignments)) {
    setState("teamAssignments", normalizedAssignments, true);
  }
}

// =============================================================================
// Maps numeric option to controller-style label (A/B/X/Y)
// =============================================================================
function optionButtonLabel(option) {
  const labels = {
    1: "A",
    2: "B",
    3: "X",
    4: "Y",
  };
  return labels[option] || String(option);
}

// =============================================================================
// Bingo host panel — word entry, target selection, cycling controls
// =============================================================================
function renderBingoAlternateViewersToggle(settings) {
  if (!settings.teamModeEnabled || settings.teamScoringMode !== "shared") {
    return "";
  }
  const isOn = settings.bingoAlternateViewers === true;
  const onCls = isOn ? "is-active" : "";
  const offCls = !isOn ? "is-active is-off-val" : "";
  return `
    <div class="toggle-group">
      <span class="muted">Alternate who sees the lit option</span>
      <div class="toggle-switch">
        <button type="button" class="toggle-switch-btn ${onCls}" data-toggle-setting="bingoAlternateViewers" data-value="true">On</button>
        <button type="button" class="toggle-switch-btn ${offCls}" data-toggle-setting="bingoAlternateViewers" data-value="false">Off</button>
      </div>
      <p class="muted">When on, each lit option is shown to only one teammate at a time, rotating each cycle. Only that teammate can buzz.</p>
    </div>`;
}

function renderBingoLessRandomToggle(settings) {
  const isOn = settings.bingoLessRandom === true;
  const onCls = isOn ? "is-active" : "";
  const offCls = !isOn ? "is-active is-off-val" : "";
  return `
    <div class="toggle-group">
      <span class="muted">Less random bingo</span>
      <div class="toggle-switch">
        <button type="button" class="toggle-switch-btn ${onCls}" data-toggle-setting="bingoLessRandom" data-value="true">On</button>
        <button type="button" class="toggle-switch-btn ${offCls}" data-toggle-setting="bingoLessRandom" data-value="false">Off</button>
      </div>
      <p class="muted">When on, every option appears once per full cycle instead of being picked randomly, so no option waits long gaps.</p>
    </div>`;
}

function renderBingoHostPanel(settings, players) {
  if (!hasHostPrivileges()) return "";
  const bingo = getBingo();
  const isWen = isWenDitHapnMode();
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  const nonController = players.filter(p => p.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(p.id)));
  if (!bingo.active) {
    const wordInput = isWen ? "" : `
      <label>
        5-letter word
        <input type="text" id="bingo-word" maxlength="5" value="${bingo.word || "BINGO"}" style="text-transform:uppercase;font-weight:800;letter-spacing:0.3em;font-size:1.2rem" />
      </label>`;
    return `
      <section class="card host-panel bingo-host-panel">
        <h2>${isWen ? "Wen Dit Happn" : "Bingo Mode"}</h2>
        <p class="muted">${isWen ? "Players see Before, Never, After. Select the correct answer and cycle." : "Enter a 5-letter word. Select a target letter and cycle through letters."}</p>
        ${wordInput}
        ${renderBingoAlternateViewersToggle(settings)}
        ${renderBingoLessRandomToggle(settings)}
        <div class="host-actions"><button type="button" class="primary-action" data-bingo-init>Start ${isWen ? "Wen Dit Happn" : "Bingo"}</button><button type="button" data-bingo-exit>Return to buzzer mode</button></div>
      </section>`;
  }
  const items = bingo.items;
  const targetOptions = items.map((item, i) =>
    `<option value="${i}" ${i === bingo.targetIndex ? "selected" : ""}>${item}</option>`
  ).join("");
  const assignments = normalizeTeamAssignments(getTeamAssignments(), players, controllerId);
  const isSharedTeam = settings.teamModeEnabled && settings.teamScoringMode === "shared";
  const progressHtml = isSharedTeam
    ? TEAM_COLORS.map(teamColor => {
        const members = getTeamMembers(teamColor, players, assignments);
        if (members.length === 0) return "";
        const collected = (bingo.playerItems?.[teamColor] || []).map(i => items[i]).join(", ");
        const count = (bingo.collectedCounts?.[teamColor] || 0);
        const names = members.map(m => getPlayerName(m)).join(", ");
        return `<div><strong>Team ${teamColor}</strong> <small>(${names})</small>: ${collected || "none"} (${count}/${items.length})</div>`;
      }).filter(Boolean).join("")
    : nonController.map(p => {
        const collected = (bingo.playerItems?.[p.id] || []).map(i => items[i]).join(", ");
        const count = (bingo.collectedCounts?.[p.id] || 0);
        return `<div><strong>${getPlayerName(p)}</strong>: ${collected || "none"} (${count}/${items.length})</div>`;
      }).join("");
  const winnerLabel = bingo.winner
    ? TEAM_COLORS.includes(bingo.winner)
      ? `Team ${bingo.winner}`
      : (players.find(p => p.id === bingo.winner) ? getPlayerName(players.find(p => p.id === bingo.winner)) : null)
    : null;
  return `
    <section class="card host-panel bingo-host-panel">
      <h2>${isWen ? "Wen Dit Happn" : "Bingo"} — Active</h2>
      <div class="${isWen ? "bingo-tile-grid bingo-three" : "bingo-word-display"}">${items.map((item, i) => {
        const taken = bingo.itemStates[i]?.collectedBy;
        const isTarget = i === bingo.targetIndex;
        return `<span class="bingo-tile ${isTarget ? "is-target" : ""} ${taken ? "is-collected" : ""}">${item}</span>`;
      }).join("")}</div>
      <label>${isWen ? "Correct answer" : "Target letter"}
        <select data-bingo-target>${targetOptions}</select>
      </label>
      <div class="host-actions">
        <button type="button" data-bingo-cycle ${bingo.cycling ? "disabled" : ""}>${bingo.cycling ? "Cycling..." : "Start Cycling"}</button>
        <button type="button" data-bingo-stop-cycle ${bingo.cycling ? "" : "disabled"}>Stop Cycling</button>
      </div>
      ${renderBingoAlternateViewersToggle(settings)}
      ${renderBingoLessRandomToggle(settings)}
      ${winnerLabel ? `<div class="bingo-winner"><h3>Winner: ${winnerLabel}!</h3></div>` : ""}
      <div class="bingo-progress"><h3>Progress</h3>${progressHtml || '<p class="muted">No players yet.</p>'}</div>
      <button type="button" data-bingo-end>Stop ${isWen ? "Wen Dit Happn" : "Bingo"}</button>
      <button type="button" data-bingo-exit>Return to buzzer mode</button>
    </section>`;
}

function renderBingoPlayerPanel(settings, mePlayer) {
  const bingo = getBingo();
  const isWen = isWenDitHapnMode();
  if (!bingo.active) {
    return `<section class="card player-card"><h2>${isWen ? "Wen Dit Happn" : "Bingo"}</h2><p class="muted">${getSnark("player.bingo.waitingHost", "Waiting for the host to start...")}</p></section>`;
  }
  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
  const isSharedTeam = settings.teamModeEnabled && settings.teamScoringMode === "shared";
  const trackKey = getTeamTrackKey(mePlayer.id, settings, assignments);
  const myTeamColor = getPlayerTeamColor(mePlayer.id, assignments);
  const teamPill = isSharedTeam && myTeamColor ? `<span class="team-pill team-${myTeamColor}">${myTeamColor}</span>` : "";
  const items = bingo.items;
  const collected = (bingo.playerItems?.[trackKey] || []);
  const activeViewer = isBingoActiveViewer(bingo, bingo.currentLitSlot, mePlayer.id, settings, assignments);
  const tilesHtml = items.map((item, i) => {
    const isLit = bingo.cycling && i === bingo.currentLitIndex && activeViewer;
    const isMine = collected.includes(i);
    let cls = "bingo-tile";
    if (isLit) cls += " is-lit";
    if (isMine) cls += " is-mine";
    return `<span class="${cls}">${item}</span>`;
  }).join("");
  const canBuzz = bingo.active && bingo.cycling && !isControllerPlayer() && !isCohost() && activeViewer;
  const waitHint = bingo.active && bingo.cycling && settings.bingoAlternateViewers && isSharedTeam && !activeViewer
    ? `<p class="muted bingo-wait-hint">${getSnark("player.bingo.waitForTeammate", "Wait for your teammate to call the letter!")}</p>`
    : "";
  const notice = getRecentBuzzNotice();
  const scores = getScores();
  const myScore = scores[getScoreKeyForPlayer(mePlayer.id, settings, assignments)] || 0;
  const winnerLabel = bingo.winner
    ? TEAM_COLORS.includes(bingo.winner)
      ? `Team ${bingo.winner}`
      : (currentParticipants().find(p => p.id === bingo.winner) ? getPlayerName(currentParticipants().find(p => p.id === bingo.winner)) : null)
    : null;
  return `
    <section class="card player-card bingo-player-card">
      <h2>${isWen ? "Wen Dit Happn" : "Bingo"} ${teamPill}</h2>
      ${isWen ? "" : `<p class="muted">${getSnark("player.bingo.collectedLabel", "Collected")}: ${collected.length}/${items.length}</p>`}
      <div class="bingo-tile-grid ${isWen ? "bingo-three" : "bingo-five"}">${tilesHtml}</div>
      <div class="bingo-buzz-area">
        <button type="button" class="bingo-buzz-btn" data-bingo-buzz ${canBuzz ? "" : "disabled"}>BUZZ${canBuzz ? "!" : ""}</button>
        ${waitHint}
        ${notice ? `<p class="muted bingo-notice">${notice}</p>` : ""}
      </div>
      <p class="muted">${getSnark("player.bingo.score", `Score: <strong>${myScore}</strong>`, { points: `<strong>${myScore}</strong>` })}</p>
      ${winnerLabel ? `<p class="bingo-winner-msg">${getSnark("player.bingo.winnerMsg", `${winnerLabel} wins!`, { winner: winnerLabel })}</p>` : ""}
    </section>`;
}

function renderBingoAudienceDisplay(settings, players) {
  const bingo = getBingo();
  const isWen = isWenDitHapnMode();
  const scores = getScores();
  if (!bingo.active) {
    return `
    <main class="layout audience-layout"${round.screw.active ? ' data-screw-active="true"' : ""} data-bingo-active="true">
      <header class="hero audience-hero">
          <div><p class="prejoin-kicker">Audience display</p><h1>${isWen ? "Wen Dit Happn" : "Bingo"}</h1><p class="muted">${getSnark("audience.bingo.waitingGame", "Waiting for the game to start...")}</p></div>
        </header>
      </main>`;
  }
  const items = bingo.items;
  const tilesHtml = items.map((item, i) => {
    const isLit = bingo.cycling && i === bingo.currentLitIndex;
    let cls = "bingo-tile bingo-tile-lg";
    if (isLit) cls += " is-lit";
    return `<span class="${cls}">${item}</span>`;
  }).join("");
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  const assignments = normalizeTeamAssignments(getTeamAssignments(), players, controllerId);
  const isSharedTeam = settings.teamModeEnabled && settings.teamScoringMode === "shared";
  const visible = players.filter(p => !isAudienceDisplayClient() && p.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(p.id)));
  let standings = "";
  if (isSharedTeam) {
    standings = TEAM_COLORS
      .map(teamColor => {
        const members = getTeamMembers(teamColor, players, assignments);
        if (members.length === 0) return "";
        const c = (bingo.collectedCounts?.[teamColor] || 0);
        const s = scores[getTeamScoreKey(teamColor)] || 0;
        const names = members.map(m => getPlayerName(m)).join(", ");
        return `<li><span class="team-pill team-${teamColor}">${teamColor}</span> <small>(${names})</small> ${isWen ? getSnark("audience.bingo.score", `Score: ${s}`, { points: s }) : getSnark("audience.bingo.lettersScore", `${c}/${items.length} letters — ${s}pts`, { collected: c, items: items.length, points: s })}</li>`;
      }).filter(Boolean).join("");
  } else {
    const sorted = visible
      .sort((a, b) => (bingo.collectedCounts?.[b.id] || 0) - (bingo.collectedCounts?.[a.id] || 0));
    standings = sorted.map(p => {
      const c = (bingo.collectedCounts?.[p.id] || 0);
      const s = scores[p.id] || 0;
      return `<li><strong>${getPlayerName(p)}</strong> ${isWen ? getSnark("audience.bingo.score", `Score: ${s}`, { points: s }) : getSnark("audience.bingo.lettersScore", `${c}/${items.length} letters — ${s}pts`, { collected: c, items: items.length, points: s })}</li>`;
    }).join("");
  }
  const winnerLabel = bingo.winner
    ? TEAM_COLORS.includes(bingo.winner)
      ? `Team ${bingo.winner}`
      : (players.find(p => p.id === bingo.winner) ? getPlayerName(players.find(p => p.id === bingo.winner)) : null)
    : null;
  return `
    <main class="layout audience-layout" data-bingo-active="true">
      <header class="hero audience-hero">
        <div><p class="prejoin-kicker">Audience display</p><h1>${isWen ? "Wen Dit Happn" : "Bingo"}</h1><p class="muted">${getSnark("audience.misc.roomPrefix", `Room ${getRoomCode() || "..."}`, { code: getRoomCode() || "..." })}</p></div>
      </header>
      <div class="bingo-tile-grid ${isWen ? "bingo-three" : "bingo-five"}">${tilesHtml}</div>
      ${winnerLabel ? `<div class="bingo-winner-banner">${getSnark("audience.bingo.winnerBanner", `${winnerLabel} WINS!`, { winner: winnerLabel })}</div>` : ""}
      <section class="card"><h2>${getSnark("audience.bingo.standings", "Standings")}</h2><ul class="bingo-standings">${standings || `<li class='muted'>${getSnark("shared.bingo.noPlayersYet", "No players yet.")}</li>`}</ul></section>
    </main>`;
}

// =============================================================================
// Dis or Dat host panel — setup, playing controls, and results
// =============================================================================
function renderDisOrDatHostPanel(settings, players) {
  if (!hasHostPrivileges()) return "";
  const dd = getDisOrDat();
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  const nonController = players.filter(p => p.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(p.id)));
  const assignments = normalizeTeamAssignments(getTeamAssignments(), players, controllerId);
  const isSharedTeam = settings.teamModeEnabled && settings.teamScoringMode === "shared";
  const isTimed = dd.mode === "onePlayTimed" || dd.mode === "allPlayTimed";

  const modeLabel = {
    onePlayTimed: "One Play — Timed",
    allPlayTimed: "All Play — Timed",
    allPlayHostPaced: "All Play — Host Paced",
  }[dd.mode] || "Dis or Dat";

  if (!dd.active) {
    const allAnswered = dd.answers.every(a => a !== null);
    const answerRows = dd.answers.map((answer, i) => {
      const chip = (value, label) => {
        const on = answer === value ? "is-on" : "";
        return `<button type="button" class="toggle-chip ${on}" data-disordat-answer-chip data-q="${i}" data-answer="${value}">${label}</button>`;
      };
      return `
        <div class="disordat-setup-row">
          <span class="disordat-q-num">${i + 1}</span>
          ${chip("dis", dd.disLabel || "Dis")}
          ${chip("dat", dd.datLabel || "Dat")}
          ${chip("both", "Both")}
        </div>
      `;
    }).join("");
    const pickButtons = isSharedTeam
      ? TEAM_COLORS.map(teamColor => {
          const members = getTeamMembers(teamColor, players, assignments);
          if (members.length === 0) return "";
          const names = members.map(m => getPlayerName(m)).join(", ");
          return `<button type="button" class="primary-action team-${teamColor}" data-disordat-pick-player="${teamColor}">Team ${teamColor} <small>(${names})</small></button>`;
        }).join("") || '<p class="muted">No teams assigned yet.</p>'
      : nonController.map(p => `<button type="button" class="primary-action" data-disordat-pick-player="${p.id}">${getPlayerName(p)}</button>`).join("") || '<p class="muted">No players in the room yet.</p>';
    const pickMenu = dd.pendingPick ? `
      <div class="disordat-pick">
        <h3>${isSharedTeam ? "Which team plays this Dis or Dat?" : "Who plays this Dis or Dat?"}</h3>
        <div class="host-actions">
          ${pickButtons}
        </div>
      </div>
    ` : "";
    return `
      <section class="card host-panel bingo-host-panel">
        <h2>Dis or Dat Setup</h2>
        <p class="muted">Optional labels shown on every question (you read each question aloud). Tap the correct answer for each of the ${DIS_OR_DAT_QUESTION_COUNT} questions.</p>
        <div class="control-grid">
          <label>Dis label
            <input type="text" id="disordat-dis-label" maxlength="40" value="${escapeHtml(dd.disLabel)}" placeholder="Dis" />
          </label>
          <label>Dat label
            <input type="text" id="disordat-dat-label" maxlength="40" value="${escapeHtml(dd.datLabel)}" placeholder="Dat" />
          </label>
        </div>
        <h3 style="font-size:0.9rem;margin:0.8rem 0 0.4rem;color:var(--muted)">Correct answers (${DIS_OR_DAT_QUESTION_COUNT})</h3>
        <div class="disordat-setup-list">${answerRows}</div>
        ${pickMenu}
        <div class="host-actions" style="margin-top:0.9rem">
          <button type="button" class="primary-action" data-disordat-start="onePlayTimed" ${allAnswered ? "" : "disabled"}>One Play Timed</button>
          <button type="button" class="primary-action" data-disordat-start="allPlayTimed" ${allAnswered ? "" : "disabled"}>All Play Timed</button>
          <button type="button" class="primary-action" data-disordat-start="allPlayHostPaced" ${allAnswered ? "" : "disabled"}>All Play, Host Paced</button>
        </div>
        ${allAnswered ? "" : '<p class="setting-helper" style="margin-top:0.4rem">Pick the correct answer for all ' + DIS_OR_DAT_QUESTION_COUNT + ' questions to start.</p>'}
        <div class="host-actions" style="margin-top:0.6rem">
          <button type="button" data-disordat-exit>Return to buzzer mode</button>
        </div>
      </section>
    `;
  }

  const activeTrack = dd.mode === "onePlayTimed"
    ? getTeamTrackKey(dd.activePlayerId, settings, assignments)
    : null;
  const trackRows = (activeTrack ? [activeTrack] : [...new Set(nonController.map(p => getTeamTrackKey(p.id, settings, assignments)).filter(Boolean))])
    .map(track => {
      const resps = dd.responses[track] || [];
      const correctCount = resps.filter((a, i) => a === dd.answers[i]).length;
      const base = dd.pointsEarned[track] || 0;
      const bonus = dd.jackBonus[track] || 0;
      const total = base + bonus;
      const rep = nonController.find(p => getTeamTrackKey(p.id, settings, assignments) === track) || null;
      const label = TEAM_COLORS.includes(track)
        ? `Team ${track}` + (rep ? ` <small>(${getPlayerName(rep)})</small>` : "")
        : getPlayerName(rep);
      return { track, correctCount, base, bonus, total, label };
    })
    .sort((a, b) => b.total - a.total);

  if (dd.phase === "results") {
    const rows = trackRows.map(({ track, correctCount, base, bonus, label }) => {
      return `<li><strong>${label}</strong> — ${correctCount}/${DIS_OR_DAT_QUESTION_COUNT} correct, ${base} pts${isTimed ? ` + ${bonus} bonus` : ""} = <strong>${base + bonus} pts</strong></li>`;
    }).join("");
    return `
      <section class="card host-panel bingo-host-panel">
        <h2>Dis or Dat — Results</h2>
        <ul class="disordat-standings">${rows || '<li class="muted">No players.</li>'}</ul>
        <div class="host-actions">
          <button type="button" class="primary-action" data-disordat-reset>Play Again</button>
          <button type="button" data-disordat-exit>Return to buzzer mode</button>
        </div>
      </section>
    `;
  }

  const progressRows = trackRows.map(({ track, label, correctCount, bonus, total }) => {
    const resps = dd.responses[track] || [];
    const answeredCount = resps.filter(a => a === "dis" || a === "dat" || a === "both").length;
    return `<div><strong>${label}</strong>: ${answeredCount}/${DIS_OR_DAT_QUESTION_COUNT} answered, ${correctCount} correct${isTimed ? `, ${bonus} bonus` : ""} — ${total} pts</div>`;
  }).join("");
  const activePlayer = trackRows.length > 0 && dd.mode === "onePlayTimed"
    ? nonController.find(p => getTeamTrackKey(p.id, settings, assignments) === trackRows[0].track)
    : null;
  const activeLabel = dd.mode === "onePlayTimed" && trackRows.length > 0 && TEAM_COLORS.includes(trackRows[0].track)
    ? `Team <strong>${trackRows[0].track}</strong>`
    : activePlayer ? `Player: <strong>${getPlayerName(activePlayer)}</strong>` : "";

  return `
    <section class="card host-panel bingo-host-panel">
      <h2>Dis or Dat — Active</h2>
      <p class="muted">Mode: <strong>${modeLabel}</strong>${activeLabel ? ` — ${activeLabel}` : ""}</p>
      ${isTimed ? `<p style="font-size:1.05rem">Time left: <strong data-disordat-time-left>${formatSeconds(getDisOrDatTimeLeftCs(dd))}s</strong></p>` : ""}
      ${!isTimed ? `<p>Question: <strong>${dd.currentQuestion + 1} / ${DIS_OR_DAT_QUESTION_COUNT}</strong></p>` : ""}
      <div class="disordat-progress"><h3>Progress</h3>${progressRows || '<p class="muted">No players yet.</p>'}</div>
      ${!isTimed ? `<div class="host-actions" style="margin-top:0.6rem"><button type="button" class="primary-action" data-disordat-next>Next Question</button></div>` : ""}
      <div class="host-actions" style="margin-top:0.6rem">
        <button type="button" data-disordat-end>End & Award Points</button>
        <button type="button" data-disordat-exit>Return to buzzer mode</button>
      </div>
    </section>
  `;
}

function renderDisOrDatPlayerPanel(settings, mePlayer) {
  const dd = getDisOrDat();
  const isTimed = dd.mode === "onePlayTimed" || dd.mode === "allPlayTimed";
  const isOnePlay = dd.mode === "onePlayTimed";

  if (!dd.active) {
    return `<section class="card player-card"><h2>Dis or Dat</h2><p class="muted">${getSnark("player.disdat.waitingHost", "Waiting for the host to start...")}</p></section>`;
  }

  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
  const isSharedTeam = settings.teamModeEnabled && settings.teamScoringMode === "shared";
  const trackKey = getTeamTrackKey(mePlayer.id, settings, assignments);
  const myTeamColor = getPlayerTeamColor(mePlayer.id, assignments);
  const teamPill = isSharedTeam && myTeamColor ? `<span class="team-pill team-${myTeamColor}">${myTeamColor}</span>` : "";

  if (isOnePlay) {
    const activeTrackKey = getTeamTrackKey(dd.activePlayerId, settings, assignments);
    if (trackKey !== activeTrackKey) {
      if (isSharedTeam && TEAM_COLORS.includes(activeTrackKey)) {
        return `<section class="card player-card"><h2>Dis or Dat</h2><p class="muted">${getSnark("player.disdat.watchTeam", `Team ${activeTrackKey} is playing this round. Sit back and watch!`, { team: activeTrackKey })}</p></section>`;
      }
      const activePlayer = currentParticipants().find(p => p.id === dd.activePlayerId);
      return `<section class="card player-card"><h2>Dis or Dat</h2><p class="muted">${getSnark("player.disdat.watchPlayer", `${activePlayer ? escapeHtml(getPlayerName(activePlayer)) : "A player"} is playing this round. Sit back and watch!`, { player: activePlayer ? escapeHtml(getPlayerName(activePlayer)) : "A player" })}</p></section>`;
    }
  }

  const myResponses = dd.responses[trackKey] || [];
  const bothShown = dd.answers.some(a => a === "both");

  const renderQuestionDiamond = (i) => {
    const q = dd.answers[i];
    const myAnswer = myResponses[i];
    const answered = myAnswer === "dis" || myAnswer === "dat" || myAnswer === "both";
    const isCorrect = answered && myAnswer === q;
    const btn = (value, pos, label) => {
      const chosen = myAnswer === value;
      const resultCls = answered ? (isCorrect ? " is-correct" : " is-wrong") : "";
      const chosenCls = chosen ? " is-chosen" : "";
      return `<button type="button" class="disordat-answer-btn ${pos}${resultCls}${chosenCls}" data-disordat-answer data-q="${i}" data-answer="${value}" ${answered ? "disabled" : ""}>${escapeHtml(label)}</button>`;
    };
    return `
      <div class="abxy-diamond disordat-diamond">
        ${btn("dis", "pos-x", dd.disLabel || "Dis")}
        ${btn("dat", "pos-b", dd.datLabel || "Dat")}
        ${bothShown ? btn("both", "pos-a", "Both") : ""}
        <div class="diamond-center disordat-diamond-center">${answered ? (isCorrect ? "✓" : "✗") : `Q${i + 1}`}</div>
      </div>
    `;
  };

  const answeredCount = myResponses.filter(a => a === "dis" || a === "dat" || a === "both").length;
  const answeredAll = answeredCount >= DIS_OR_DAT_QUESTION_COUNT;
  const revealShowing = isTimed && answeredCount > 0 && now() < disOrDatRevealUntil;
  const currentQ = revealShowing ? answeredCount - 1 : Math.min(answeredCount, DIS_OR_DAT_QUESTION_COUNT - 1);

  const diamond = isTimed
    ? (revealShowing || !answeredAll ? renderQuestionDiamond(currentQ) : "")
    : dd.currentQuestion < DIS_OR_DAT_QUESTION_COUNT ? renderQuestionDiamond(dd.currentQuestion) : "";

  const points = dd.pointsEarned[trackKey] || 0;
  const bonus = dd.jackBonus[trackKey] || 0;

  let body;
  if (dd.phase === "results") {
    const correctCount = myResponses.filter((a, i) => a === dd.answers[i]).length;
    body = `
      <div class="disordat-results">
        <h3>${getSnark("player.disdat.resultsTitle", "Results")}</h3>
        <p class="muted">${getSnark("player.disdat.correctCount", `${correctCount}/${DIS_OR_DAT_QUESTION_COUNT} correct`, { correct: correctCount, total: DIS_OR_DAT_QUESTION_COUNT })}</p>
        <p>Base: <strong>${points}</strong>${isTimed ? ` + Bonus: <strong>${bonus}</strong>` : ""} = <strong>${points + bonus}</strong> pts</p>
        ${isTimed && answeredAll && bonus === 0 ? `<p class="muted">${getSnark("player.disdat.bonusHint", `Finish with ${DIS_OR_DAT_BONUS_MIN_CORRECT}+ correct to claim the time bonus.`, { min: DIS_OR_DAT_BONUS_MIN_CORRECT })}</p>` : ""}
        <p class="muted">${getSnark("player.disdat.waitingHostContinue", "Waiting for the host to continue...")}</p>
      </div>
    `;
  } else {
    body = `
      ${isTimed
        ? `<div class="disordat-timer">${getSnark("player.disdat.timeLeftLabel", "Time left")}: <strong data-disordat-time-left>${formatSeconds(getDisOrDatTimeLeftCs(dd))}s</strong></div>
           ${answeredAll && !revealShowing ? "" : `<p class="muted">${getSnark("player.disdat.questionTimed", `Question ${currentQ + 1} of ${DIS_OR_DAT_QUESTION_COUNT}. Answer before the timer ends.`, { current: currentQ + 1, total: DIS_OR_DAT_QUESTION_COUNT })}</p>`}`
        : `<p class="muted">${getSnark("player.disdat.questionHostPaced", `Question ${dd.currentQuestion + 1} of ${DIS_OR_DAT_QUESTION_COUNT}. The host advances when ready.`, { current: dd.currentQuestion + 1, total: DIS_OR_DAT_QUESTION_COUNT })}</p>`}
      <div class="disordat-diamond-wrap">${diamond}</div>
      ${answeredAll && isTimed && !revealShowing ? `<p class="disordat-done">${getSnark("player.disdat.allAnswered", "All answered! Wait for results.")}</p>` : ""}
    `;
  }

  return `
    <section class="card player-card disordat-player-card">
      <h2>Dis or Dat ${teamPill}</h2>
      <div class="disordat-labels"><span class="dis">${escapeHtml(dd.disLabel || "Dis")}</span> or <span class="dat">${escapeHtml(dd.datLabel || "Dat")}</span></div>
      ${body}
    </section>
  `;
}

function renderDisOrDatAudienceDisplay(settings, players) {
  const dd = getDisOrDat();
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  const participants = players.filter(p => p.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(p.id)));
  const assignments = normalizeTeamAssignments(getTeamAssignments(), players, controllerId);
  const isSharedTeam = settings.teamModeEnabled && settings.teamScoringMode === "shared";
  const isTimed = dd.mode === "onePlayTimed" || dd.mode === "allPlayTimed";
  const modeLabel = {
    onePlayTimed: getSnark("audience.disdat.modeOnePlay", "One Play — Timed"),
    allPlayTimed: getSnark("audience.disdat.modeAllPlay", "All Play — Timed"),
    allPlayHostPaced: getSnark("audience.disdat.modeHostPaced", "All Play — Host Paced"),
  }[dd.mode] || "Dis or Dat";

  if (!dd.active) {
    return `
      <main class="layout audience-layout" data-disordat-active="true">
        <header class="hero audience-hero">
          <div><p class="prejoin-kicker">Audience display</p><h1>Dis or Dat</h1><p class="muted">${getSnark("audience.disdat.waitingGame", "Waiting for the game to start...")}</p></div>
        </header>
      </main>`;
  }

  const activeTrack = dd.mode === "onePlayTimed"
    ? getTeamTrackKey(dd.activePlayerId, settings, assignments)
    : null;
  const tracks = (activeTrack ? [activeTrack] : [...new Set(participants.map(p => getTeamTrackKey(p.id, settings, assignments)).filter(Boolean))])
    .map(track => {
      const resps = dd.responses[track] || [];
      const correctCount = resps.filter((a, i) => a === dd.answers[i]).length;
      const total = (dd.pointsEarned[track] || 0) + (dd.jackBonus[track] || 0);
      const rep = participants.find(p => getTeamTrackKey(p.id, settings, assignments) === track) || null;
      const label = TEAM_COLORS.includes(track)
        ? `Team ${track}` + (rep ? ` <small>(${getPlayerName(rep)})</small>` : "")
        : getPlayerName(rep);
      return { track, correctCount, total, label };
    })
    .sort((a, b) => b.total - a.total);
  const standings = tracks.map(({ correctCount, total, label }) => {
    return `<li><strong>${label}</strong> — ${correctCount}/${DIS_OR_DAT_QUESTION_COUNT} — ${total} pts</li>`;
  }).join("");

  const timerHtml = isTimed && dd.phase === "playing"
    ? `<div class="audience-timer">${getSnark("audience.disdat.timeLeftLabel", "Time left")}: <strong data-disordat-time-left>${formatSeconds(getDisOrDatTimeLeftCs(dd))}s</strong></div>`
    : "";
  const questionHtml = !isTimed && dd.phase === "playing"
    ? `<div class="disordat-audience-question"><h2>${getSnark("audience.disdat.audienceQuestionTitle", `Question ${dd.currentQuestion + 1}`, { number: dd.currentQuestion + 1 })}</h2><p>${escapeHtml(dd.disLabel || "Dis")} or ${escapeHtml(dd.datLabel || "Dat")}?</p></div>`
    : "";

  return `
    <main class="layout audience-layout" data-disordat-active="true">
      <header class="hero audience-hero">
        <div><p class="prejoin-kicker">Audience display</p><h1>Dis or Dat</h1><p class="muted">${getSnark("audience.misc.roomPrefix", `Room ${getRoomCode() || "..."}`, { code: getRoomCode() || "..." })}</p></div>
      </header>
      ${timerHtml}
      ${questionHtml}
      <section class="card"><h2>${getSnark("audience.disdat.finalStandings", dd.phase === "results" ? "Final Standings" : "Standings")} — ${modeLabel}</h2><ul class="bingo-standings">${standings || `<li class='muted'>${getSnark("shared.bingo.noPlayersYet", "No players yet.")}</li>`}</ul></section>
    </main>`;
}

// =============================================================================
// Player-led team selection — dedicated screens for host, players, audience
// =============================================================================
function renderTeamSelectPlayerPanel(settings, players, mePlayer) {
  const teamSelect = getTeamSelect();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), players, getControllerId());
  const cohostIds = getSafeState("cohostIds", []);
  const controllerId = getControllerId();
  const myTeam = getPlayerTeamColor(mePlayer.id, assignments);
  const maxPerTeam = Number(teamSelect.maxPerTeam) || 0;
  const teamCards = teamSelect.enabledTeams
    .map((teamColor) => {
      const members = players.filter((player) => player.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)) && assignments[player.id] === teamColor);
      const memberNames = members.length > 0
        ? members.map((p) => `<li>${escapeHtml(getPlayerName(p))}</li>`).join("")
        : `<li class="muted">${getSnark("player.teamSelect.emptyTeam", "No one here yet.")}</li>`;
      const isMine = myTeam === teamColor;
      const isFull = maxPerTeam > 0 && !isMine && members.length >= maxPerTeam;
      const countLabel = maxPerTeam > 0 ? `${members.length}/${maxPerTeam}` : `${members.length}`;
      const pickDisabled = teamSelect.locked || isFull;
      const pickLabel = isFull
        ? getSnark("player.teamSelect.fullBtn", "Full")
        : isMine ? getSnark("player.teamSelect.leaveBtn", "Leave") : getSnark("player.teamSelect.joinBtn", "Join");
      return `
        <div class="teamselect-card team-${teamColor} ${isMine ? "is-mine" : ""}">
          <div class="teamselect-card-head">
            <span class="team-pill team-${teamColor}">${teamColor}</span>
            <span class="teamselect-count">${countLabel}</span>
          </div>
          <ul class="teamselect-members">${memberNames}</ul>
          <button type="button" class="teamselect-pick" data-pick-team="${isMine ? "" : teamColor}" ${pickDisabled ? "disabled" : ""}>
            ${pickLabel}
          </button>
        </div>`;
    })
    .join("");

  return `
    <section class="card player-card">
      <h2>${getSnark("player.teamSelect.title", "Choose Your Team")}</h2>
      ${teamSelect.locked
        ? `<p class="teamselect-status is-locked">${getSnark("player.teamSelect.locked", "Teams are locked. Ask the Host to unlock them.")}</p>`
        : `<p class="muted">${getSnark("player.teamSelect.instruction", "Pick a team, see who's on it, and change whenever you like. Selections lock when the Host locks teams.")}</p>`}
      <div class="teamselect-grid">${teamCards}</div>
      <p class="muted" style="margin-top:0.7rem">${getSnark("player.teamSelect.youLabel", `You: <strong>${myTeam || getSnark("player.misc.unassigned", "Unassigned")}</strong>`, { team: myTeam || getSnark("player.misc.unassigned", "Unassigned") })}</p>
    </section>`;
}

function renderTeamSelectHostPanel(settings, round, players, controllerId) {
  const teamSelect = getTeamSelect();
  const maxPerTeam = Number(teamSelect.maxPerTeam) || 0;
  const assignments = normalizeTeamAssignments(getTeamAssignments(), players, controllerId);
  const cohostIds = getSafeState("cohostIds", []);
  const nonControllerPlayers = players.filter((player) => player.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)));
  const unassigned = nonControllerPlayers.filter((player) => !getPlayerTeamColor(player.id, assignments));
  const teamToggles = TEAM_COLORS
    .map((teamColor) => {
      const enabled = teamSelect.enabledTeams.includes(teamColor);
      const count = nonControllerPlayers.filter((player) => assignments[player.id] === teamColor).length;
      const countLabel = maxPerTeam > 0 ? `${count}/${maxPerTeam}` : `${count}`;
      return `
        <label class="teamselect-enable ${enabled ? "is-enabled" : "is-disabled"} team-${teamColor}">
          <input type="checkbox" data-teamselect-enable="${teamColor}" ${enabled ? "checked" : ""} />
          <span class="team-pill team-${teamColor}">${teamColor}</span>
          <span class="teamselect-count">${countLabel}</span>
        </label>`;
    })
    .join("");

  const rosterRows = nonControllerPlayers
    .map((player) => {
      const selected = assignments[player.id] || "";
      return `
        <div class="team-assignment-row">
          <strong>${escapeHtml(getPlayerName(player))}</strong>
          <span class="team-pill ${selected ? `team-${selected}` : "team-none"}">${selected || "unassigned"}</span>
          <select data-team-player="${player.id}">
            <option value="">Unassigned</option>
            ${TEAM_COLORS.map((color) => `<option value="${color}" ${selected === color ? "selected" : ""}>${color}</option>`).join("")}
          </select>
        </div>`;
    })
    .join("");

  return `
    <section class="card host-panel">
      <h2>Team Selection</h2>
      <p class="muted" style="font-size:0.85rem">Players are choosing their own teams. Lock to stop changes, then close this screen.</p>

      <div class="settings-section">
        <details open>
          <summary>Enabled teams</summary>
          <div class="section-body">
            <div class="teamselect-enables">${teamToggles}</div>
            <p class="setting-helper">Unchecked teams are not joinable; players already on them are moved back to unassigned.</p>
          </div>
        </details>
      </div>

      <div class="settings-section">
        <details open>
          <summary>Team size limit</summary>
          <div class="section-body">
            <label>
              Max players per team
              <input type="number" min="0" max="42" step="1" value="${teamSelect.maxPerTeam || 0}" data-teamselect-limit />
            </label>
            <p class="setting-helper">0 = no limit. When set, players can't join a full team (switching between teams is still allowed while there's room). Host overrides below still work.</p>
          </div>
        </details>
      </div>

      <div class="settings-section">
        <details open>
          <summary>Move players (host override)</summary>
          <div class="section-body">
            ${nonControllerPlayers.length === 0
              ? `<p class="muted">No non-Host participants connected yet.</p>`
              : `<div class="team-assignment-list">${rosterRows}</div>`}
            ${unassigned.length > 0
              ? `<p class="setting-helper" style="margin-top:0.4rem">${unassigned.length} player(s) unassigned — assign them before opening buzzers.</p>`
              : ""}
          </div>
        </details>
      </div>

      <div class="host-actions">
        ${teamSelect.locked
          ? `<button type="button" data-teamselect-lock="false">Unlock Teams</button>`
          : `<button type="button" data-teamselect-lock="true">Lock Teams</button>`}
        <button type="button" data-teamselect-close>Close Team Selection</button>
      </div>

      <div class="status-strip">
        <span>Status: <strong>${teamSelect.locked ? "Locked" : "Open"}</strong></span>
        <span>Teams enabled: <strong>${teamSelect.enabledTeams.length}</strong></span>
        <span>Unassigned: <strong>${unassigned.length}</strong></span>
      </div>
    </section>`;
}

function renderTeamSelectAudienceDisplay(settings, players) {
  const teamSelect = getTeamSelect();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), players, getControllerId());
  const cohostIds = getSafeState("cohostIds", []);
  const controllerId = getControllerId();
  const maxPerTeam = Number(teamSelect.maxPerTeam) || 0;
  const teamColumns = teamSelect.enabledTeams
    .map((teamColor) => {
      const members = players.filter((player) => player.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)) && assignments[player.id] === teamColor);
      const memberNames = members.length > 0
        ? members.map((p) => `<li>${escapeHtml(getPlayerName(p))}</li>`).join("")
        : `<li class="muted">${getSnark("audience.teamSelect.empty", "No one here yet.")}</li>`;
      const countLabel = maxPerTeam > 0 ? `${members.length}/${maxPerTeam}` : `${members.length}`;
      return `
        <section class="card audience-team-card team-${teamColor}">
          <h2><span class="team-pill team-${teamColor}">${teamColor}</span> <span class="teamselect-count">${countLabel}</span></h2>
          <ul class="bingo-standings">${memberNames}</ul>
        </section>`;
    })
    .join("");

  return `
    <main class="layout audience-layout" data-teamselect-active="true">
      <header class="hero audience-hero">
        <div>
          <p class="prejoin-kicker">Audience display</p>
          <h1>${getSnark("audience.teamSelect.title", "Team Selection")}</h1>
          <p class="muted">${getSnark("audience.teamSelect.subtitle", "Players are picking their teams.")}</p>
        </div>
        <div class="hero-meta">
          <span>${getSnark("audience.teamSelect.statusLabel", "Status")}: <strong>${teamSelect.locked ? "Locked" : "Open"}</strong></span>
        </div>
      </header>
      <section class="audience-grid audience-teams-grid">${teamColumns}</section>
    </main>`;
}

// =============================================================================
// Player buzzer panel — shows appropriate UI depending on game state
// (roulette, screw, buttons, text entry, etc.)
// =============================================================================
function renderBuzzerPanel(settings, round, mePlayer, timeLeftCs) {
  if (isBingoMode()) return renderBingoPlayerPanel(settings, mePlayer);
  if (isDisOrDatMode()) return renderDisOrDatPlayerPanel(settings, mePlayer);
  console.log("renderBuzzerPanel: status=", round?.status, "timeLeftCs=", timeLeftCs, "me=", mePlayer?.id);
  if (isControllerPlayer() || isCohost()) {
    return `
      <section class="card player-card controller-card">
        <h2>Host Control Screen</h2>
        <p>You are ${isCohost() ? "a Co-host" : "the Host"} and do not have a buzzer input.</p>
      </section>
    `;
  }

  const teamAssignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
  const myTeamColor = getPlayerTeamColor(mePlayer.id, teamAssignments);
  const teamButtonClass = myTeamColor ? `team-buzzer team-${myTeamColor}` : "";
  const appendTeamButtonClass = (baseClass = "") => {
    if (!teamButtonClass) {
      return baseClass;
    }
    return baseClass ? `${baseClass} ${teamButtonClass}` : teamButtonClass;
  };
  const myScore = Number(getScores()[getScoreKeyForPlayer(mePlayer.id, settings, teamAssignments)] || 0);
  const myScoreLine = `<p class="muted">${getSnark("player.buzzer.scoreLabel", "Score")}: <strong>${myScore}</strong></p>`;
  if (settings.teamModeEnabled && !myTeamColor) {
    return `
      <section class="card player-card">
        <h2>${getSnark("player.buzzer.waitingTeamAssignment", "Waiting For Team Assignment")}</h2>
        <p class="muted">${getSnark("player.buzzer.waitingTeamAssignmentBody", "The Host must assign you to an alliance before your buzzer appears.")}</p>
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
        <h2>${getSnark("player.screw.selectTitle", "Select Who to Screw")}</h2>
        <p class="muted">${getSnark("player.screw.selectPrompt", "Choose another player to screw over:")}</p>
        <div class="screw-player-list">${playerButtons}</div>
      </section>
    `;
  }

  // Show "hold up, a screw is getting used" message for other players during screw
  if (round.screw.active && mePlayer.id !== round.screw.screwerId && mePlayer.id !== round.screw.screweeId) {
    const timeText = getScrewTimerMs(round) !== null
      ? formatSeconds(Math.ceil(getScrewTimerMs(round) / 10))
      : getSnark("player.screw.pending", "pending");
    
    return `
      <section class="card player-card">
        <h2>${getSnark("player.screw.holdUp", "Hold Up!")}</h2>
        <p class="muted">${getSnark("player.screw.inUseOn", `A screw is being used by <strong>${round.screw.screwerName}</strong> on <strong>${round.screw.screeeName}</strong>.`, { screwer: `<strong>${round.screw.screwerName}</strong>`, screwee: `<strong>${round.screw.screeeName}</strong>` })}</p>
        <p class="muted">${getSnark("player.screw.timeLabel", "Time")}: <strong>${timeText}s</strong></p>
      </section>
    `;
  }

  // Show screw timer UI for the screwee
  if (round.screw.active && mePlayer.id === round.screw.screweeId) {
    const timeText = getScrewTimerMs(round) !== null
      ? formatSeconds(Math.ceil(getScrewTimerMs(round) / 10))
      : getSnark("player.screw.waiting", "waiting");
    const buzzerDisabled = getScrewTimerMs(round) === null || getScrewTimerMs(round) <= 0;
    
    if (settings.optionCount === 1) {
      return `
        <section class="card player-card">
          <h2>${getSnark("player.screw.youreScrewed", "You're Being Screwed!")}</h2>
          <p class="muted">${getSnark("player.screw.timerLabel", "Screw timer")}: <strong>${timeText}s</strong></p>
          <p class="muted">${getSnark("player.screw.answerQuickly", "Answer quickly!")}</p>
          <button type="button" class="${appendTeamButtonClass("big-red")}" data-buzz="1" ${buzzerDisabled ? "disabled" : ""}>BUZZ</button>
        </section>
      `;
    }
    
    if (settings.optionCount === 4) {
      const defaultBuzzerClass = teamButtonClass ? "" : ["", "buzzer-a", "buzzer-b", "buzzer-x", "buzzer-y"];
      const button = (opt, cls) => {
        const extraClass = defaultBuzzerClass ? defaultBuzzerClass[opt] : "";
        const fullClass = [appendTeamButtonClass(cls), extraClass].filter(Boolean).join(" ");
        return `<button type="button" class="${fullClass}" data-buzz="${opt}" ${buzzerDisabled ? "disabled" : ""}>${optionButtonLabel(opt)}</button>`;
      };
      const showValue = round.status === ROUND_STATUSES.OPEN || round.status === ROUND_STATUSES.LOCKED;
      const roundLabel = showValue
        ? settings.scoringMode === "jack"
          ? `<span class="diamond-value">${settings.jackMultiplier}x</span>`
          : `<span class="diamond-value">${computeBasePoints(settings, timeLeftCs, round)}</span>`
        : "";
      return `
        <section class="card player-card">
          <h2>${getSnark("player.screw.youreScrewed", "You're Being Screwed!")}</h2>
          <p class="muted">${getSnark("player.screw.timerLabel", "Screw timer")}: <strong>${timeText}s</strong></p>
          <p class="muted">${getSnark("player.screw.answerQuickly", "Answer quickly!")}</p>
          <div class="abxy-diamond">
            ${button(4, "pos-y")}
            ${button(3, "pos-x")}
            ${button(2, "pos-b")}
            ${button(1, "pos-a")}
            ${roundLabel ? `<div class="diamond-center">${roundLabel}</div>` : ""}
          </div>
        </section>
      `;
    }
  }

  const disabled = round.status !== ROUND_STATUSES.OPEN;
  const alreadyBuzzed = round.buzzedPlayerIds.includes(mePlayer.id);
  const rebuzzAllowed = Boolean(settings.rebuzzAllowed);
  const teamAlreadyBuzzed = settings.teamModeEnabled && settings.teamScoringMode === "shared" && !rebuzzAllowed
    ? getAllBuzzedTeamMemberIds(mePlayer.id, currentParticipants(), teamAssignments).some((id) => round.buzzedPlayerIds.includes(id))
    : false;
  const playerDisabled = !isPlayerBuzzerEnabled(settings, mePlayer.id);
  const screwInProgress = round.screw.active;
  const screwUsedByMe = round.screwsUsedBy?.includes(mePlayer.id);
  const screwAvailable = settings.allowScrewing && !screwUsedByMe && !screwInProgress;
  const globalDisabled = disabled || (!rebuzzAllowed && (alreadyBuzzed || teamAlreadyBuzzed)) || playerDisabled || screwInProgress;
  const helperText = playerDisabled
    ? getSnark("player.buzzer.buzzerDisabledByHost", "Your buzzer is disabled by the Host.")
    : disabled
    ? getSnark("player.buzzer.buzzersClosed", "Buzzers are currently closed.")
    : teamAlreadyBuzzed
      ? getSnark("player.buzzer.teamAlreadyBuzzed", "Your team already buzzed this round.")
    : !rebuzzAllowed && alreadyBuzzed
      ? getSnark("player.buzzer.alreadyBuzzed", "You already buzzed this round.")
      : screwInProgress
      ? getSnark("player.buzzer.screwInProgress", "A screw is in progress.")
      : getSnark("player.buzzer.buzzNow", "Buzz now.");
  const notice = getRecentBuzzNotice();
  const timeText = formatSeconds(timeLeftCs);
  const usingTextEntry = settings.inputMode === "text";

  if (usingTextEntry) {
    if (fYouEasterEggUnlocked) {
      return `
        <section class="card player-card easter-egg-card">
          <h2>${escapeHtml(getSnark("player.easteregg.heading", F_YOU_EASTER_EGG_H2))}</h2>
          <p class="muted">
            This F You easter egg comes about by the fact that in the series "You Don't Know Jack" which this buzzer system is designed to allow for the recreation of games of, if you were to type "Fuck You" in a text field you would get scolded by the host (something like "F*** me? no F*** you") and lose some points the first time, the second time you would get told how unoriginal you are, and the third time the game would just end, I am here to emulate that, Your score has been decreased, and im sure your scolding will come in a moment or two, I guess you are either a fan of jack and just curious if I did something like this, a programmer who found this in the README, or most likely, a 30 year old degenerate living in the basement of your parents home (or your name is either SomeNightYT, fullwizard, or Psych82, hi guys!) whichever way you found yourself here, welcome! Consider this your entry into a club you will want out of right away
            <br /><br />-- Hedgehawk11 <3
            <br /><br />P.S. You might have noticed I'm giving you the Full Stream treatment here, which means its time for the chicken:
            <a href="https://www.youtube.com/watch?v=xEDIkKXPIHs" target="_blank" rel="noopener noreferrer">https://www.youtube.com/watch?v=xEDIkKXPIHs</a>
          </p>
          <div class="easter-egg-actions">
            <button type="button" data-f-you-close>${getSnark("player.easteregg.closeButton", "Let me play again")}</button>
          </div>
        </section>
      `;
    }

    const disabledAttr = globalDisabled ? "disabled" : "";
    const textHelper = playerDisabled
      ? getSnark("player.buzzer.answerDisabledByHost", "Your answer input is disabled by the Host.")
      : disabled
      ? getSnark("player.buzzer.answersClosed", "Answers are currently closed.")
      : teamAlreadyBuzzed
        ? getSnark("player.buzzer.teamAlreadyAnswered", "Your team already answered this round.")
      : !rebuzzAllowed && alreadyBuzzed
        ? getSnark("player.buzzer.alreadyAnswered", "You already submitted an answer this round.")
        : screwInProgress
        ? getSnark("player.buzzer.screwInProgress", "A screw is in progress.")
        : getSnark("player.buzzer.typeAnswerSubmit", "Type your answer and submit.");

    return `
      <section class="card player-card">
        <h2>${getSnark("player.buzzer.yourAnswerTitle", "Your Answer")}</h2>
        <p class="muted">${textHelper}</p>
        ${myScoreLine}
        <p class="muted">${getSnark("player.buzzer.timeLeftLabel", "Time left")}: <strong data-live-time-left>${timeText}s</strong></p>
        ${notice ? `<p class="muted">${notice}</p>` : ""}
        <div class="text-entry">
          <input id="answer-entry" type="text" maxlength="120" placeholder="${getSnark("player.buzzer.answerPlaceholder", "Type your answer")}" ${disabledAttr} />
          <button class="${appendTeamButtonClass()}" data-answer-submit ${disabledAttr}>${getSnark("player.buzzer.submitAnswerButton", "Submit Answer")}</button>
        </div>
      </section>
    `;
  }

  if (settings.optionCount === 1) {
    const optionDisabled = !isOptionEnabled(settings, 1) || isPlayerAtOptionLimit(round, settings, mePlayer.id, 1);
    const disabledAttr = globalDisabled || optionDisabled ? "disabled" : "";
const screwBtn = settings.allowScrewing
    ? (screwUsedByMe
        ? `<p class="muted" style="margin-top:0.5rem">${getSnark("player.screw.usedByMe", "Your screw has been used.")}</p>`
        : screwInProgress
            ? ""
            : screwAvailable && !disabled && !playerDisabled
                ? `<button type="button" class="screw-btn" data-screw>SCREW EM'</button>`
                : `<p class="muted" style="margin-top:0.5rem">${getSnark("player.screw.available", "Screw available.")}</p>`)
    : "";
    
    return `
      <section class="card player-card">
        <h2>${getSnark("player.buzzer.yourBuzzerTitle", "Your Buzzer")}</h2>
        <p class="muted">${optionDisabled ? getSnark("player.buzzer.singleBuzzerDisabled", "This buzzer is disabled by the Host.") : helperText}</p>
        ${myScoreLine}
        <p class="muted">${getSnark("player.buzzer.timeLeftLabel", "Time left")}: <strong data-live-time-left>${timeText}s</strong></p>
        ${notice ? `<p class="muted">${notice}</p>` : ""}
        <button type="button" class="${appendTeamButtonClass("big-red")}" data-buzz="1" ${disabledAttr}>BUZZ</button>
        ${screwBtn}
      </section>
    `;
  }

  if (settings.optionCount === 6) {
    const buttons = [1, 2, 3, 4, 5, 6]
      .map((opt) => {
        const disabledAttr = globalDisabled || !isOptionEnabled(settings, opt) || isPlayerAtOptionLimit(round, settings, mePlayer.id, opt) ? "disabled" : "";
        return `<button type="button" class="${appendTeamButtonClass()}" data-buzz="${opt}" ${disabledAttr}>${opt}</button>`;
      })
      .join("");
const screwBtn = settings.allowScrewing
    ? (screwUsedByMe
        ? `<p class="muted" style="margin-top:0.5rem">${getSnark("player.screw.usedByMe", "Your screw has been used.")}</p>`
        : screwInProgress
            ? ""
            : screwAvailable && !disabled && !playerDisabled
                ? `<button type="button" class="screw-btn" data-screw>SCREW EM'</button>`
                : `<p class="muted" style="margin-top:0.5rem">${getSnark("player.screw.available", "Screw available.")}</p>`)
    : "";
    
    return `
      <section class="card player-card">
        <h2>${getSnark("player.buzzer.yourBuzzerTitle", "Your Buzzer")}</h2>
        <p class="muted">${helperText}</p>
        ${myScoreLine}
        <p class="muted">${getSnark("player.buzzer.timeLeftLabel", "Time left")}: <strong data-live-time-left>${timeText}s</strong></p>
        ${notice ? `<p class="muted">${notice}</p>` : ""}
        <div class="six-grid">${buttons}</div>
        ${screwBtn}
      </section>
    `;
  }

  if (settings.optionCount === 4) {
    const defaultBuzzerClass = teamButtonClass ? "" : ["", "buzzer-a", "buzzer-b", "buzzer-x", "buzzer-y"];
    const button = (opt, cls) => {
      const disabledAttr = globalDisabled || !isOptionEnabled(settings, opt) || isPlayerAtOptionLimit(round, settings, mePlayer.id, opt) ? "disabled" : "";
      const extraClass = defaultBuzzerClass ? defaultBuzzerClass[opt] : "";
      const fullClass = [appendTeamButtonClass(cls), extraClass].filter(Boolean).join(" ");
      return `<button type="button" class="${fullClass}" data-buzz="${opt}" ${disabledAttr}>${optionButtonLabel(opt)}</button>`;
    };
    const screwBtn = screwAvailable && !disabled && !playerDisabled
      ? `<button type="button" class="screw-btn" data-screw>SCREW</button>`
      : "";

    const showValue = round.status === ROUND_STATUSES.OPEN || round.status === ROUND_STATUSES.LOCKED;
    const roundLabel = showValue
      ? settings.scoringMode === "jack"
        ? `<span class="diamond-value">${settings.jackMultiplier}x</span>`
        : `<span class="diamond-value">${computeBasePoints(settings, timeLeftCs, round)}</span>`
      : "";

    return `
      <section class="card player-card">
        <h2>${getSnark("player.buzzer.yourBuzzerTitle", "Your Buzzer")}</h2>
        <p class="muted">${helperText}</p>
        ${myScoreLine}
        <p class="muted">${getSnark("player.buzzer.timeLeftLabel", "Time left")}: <strong data-live-time-left>${timeText}s</strong></p>
        ${notice ? `<p class="muted">${notice}</p>` : ""}
        <div class="abxy-diamond">
          ${button(4, "pos-y")}
          ${button(2, "pos-b")}
          ${button(3, "pos-x")}
          ${button(1, "pos-a")}
          ${roundLabel ? `<div class="diamond-center">${roundLabel}</div>` : ""}
        </div>
        ${screwBtn}
      </section>
    `;
  }

  const max = settings.optionCount;
  const buttons = [1, 2, 3, 4]
    .filter((opt) => opt <= max)
    .map((opt) => {
      const disabledAttr = globalDisabled || !isOptionEnabled(settings, opt) || isPlayerAtOptionLimit(round, settings, mePlayer.id, opt) ? "disabled" : "";
      return `<button type="button" class="${appendTeamButtonClass()}" data-buzz="${opt}" ${disabledAttr}>${optionButtonLabel(opt)}</button>`;
    })
    .join("");
  const screwBtn = settings.allowScrewing
    ? (screwUsedByMe
        ? `<p class="muted" style="margin-top:0.5rem">${getSnark("player.screw.usedByMe", "Your screw has been used.")}</p>`
        : screwInProgress
            ? ""
            : screwAvailable && !disabled && !playerDisabled
                ? `<button type="button" class="screw-btn" data-screw>SCREW</button>`
                : `<p class="muted" style="margin-top:0.5rem">${getSnark("player.screw.available", "Screw available.")}</p>`)
    : "";

  return `
    <section class="card player-card">
      <h2>${getSnark("player.buzzer.yourBuzzerTitle", "Your Buzzer")}</h2>
        ${myScoreLine}
      <p class="muted">${helperText}</p>
      <p class="muted">${timeText}</p>
      ${notice ? `<p class="muted">${notice}</p>` : ""}
      <div class="abxy">${buttons}</div>
      ${screwBtn}
    </section>
  `;
}

function getBuzzedParticipants(round, players) {
  const participantsById = new Map(players.map((player) => [player.id, player]));
  return (round.buzzedPlayerIds || [])
    .map((playerId) => participantsById.get(playerId))
    .filter(Boolean);
}

// =============================================================================
// Audience/projection display — shows round status, buzz leaderboard
// =============================================================================
function renderAudienceBuzzPanel(settings, round, players, timeLeftCs) {
  const isScrewActive = round.screw.active;
  const screwTimerMs = getScrewTimerMs(round);
  let timerCs;
  let timerDisplay;
  if (isScrewActive && screwTimerMs !== null) {
    timerCs = Math.ceil(screwTimerMs / 10);
    timerDisplay = `${formatSeconds(timerCs)}s`;
  } else if (isScrewActive) {
    timerCs = null;
    timerDisplay = "SCREW";
  } else {
    timerCs = timeLeftCs;
    timerDisplay = `${formatSeconds(timeLeftCs)}s`;
  }
  const buzzedPlayers = getBuzzedParticipants(round, players);
  const cohostIds = getSafeState("cohostIds", []);
  const nonControllerPlayers = players.filter((player) => player.id !== getControllerId() && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)));
  const useSingleLeader = settings.optionCount === 1 || nonControllerPlayers.length > 8;
  const leader = round.winnerId
    ? players.find((player) => player.id === round.winnerId) || buzzedPlayers[0] || null
    : buzzedPlayers[0] || null;

  const statusLabel = {
    [ROUND_STATUSES.IDLE]: getSnark("audience.buzzer.statusIdle", "Waiting for the round to start"),
    [ROUND_STATUSES.OPEN]: getSnark("audience.buzzer.statusOpen", "Buzzers open"),
    [ROUND_STATUSES.ROULETTE]: getSnark("audience.buzzer.statusRoulette", "Pick-a-value in progress"),
    [ROUND_STATUSES.LOCKED]: getSnark("audience.buzzer.statusLocked", "Buzz locked"),
    [ROUND_STATUSES.CLOSED]: getSnark("audience.buzzer.statusClosed", "Round closed"),
  }[round.status];

  const pointsUpForGrabs = round.status === ROUND_STATUSES.OPEN || round.status === ROUND_STATUSES.LOCKED
    ? computeBasePoints(settings, timeLeftCs)
    : null;

  const pointsLabel = settings.scoringMode === "jack"
    ? `${settings.jackMultiplier}x multiplier`
    : `${pointsUpForGrabs} pts`;

  const buzzSection = useSingleLeader
    ? `<div class="audience-leader">
        <span class="audience-leader-kicker">${settings.optionCount === 1 ? "First buzz" : nonControllerPlayers.length > 8 ? "Fastest buzz" : "Current leader"}</span>
        <strong>${leader ? escapeHtml(getPlayerName(leader)) : getSnark("audience.outcome.waitingForBuzz", "Waiting for a buzz")}</strong>
        <span class="muted">${leader ? `Time left: <strong>${timerDisplay}</strong>` : getSnark("audience.outcome.noBuzzYet", "No one has buzzed yet.")}</span>
      </div>`
    : `<ul class="audience-buzz-list">
        ${buzzedPlayers.length
          ? buzzedPlayers
              .map((player, index) => `<li><span>${index + 1}</span><strong>${escapeHtml(getPlayerName(player))}</strong></li>`)
              .join("")
          : `<li class="audience-empty">${getSnark("audience.outcome.noBuzzesYet", "No buzzes yet.")}</li>`}
      </ul>`;

  return `
    <section class="card audience-card">
      <div class="audience-card-header">
        <div>
          <p class="prejoin-kicker">Audience display</p>
          <h2>${statusLabel}</h2>
        </div>
        <div class="audience-meta">
          <span class="audience-timer">${timerDisplay}</span>
          ${pointsUpForGrabs !== null ? `<span class="audience-points">${pointsLabel}</span>` : ""}
        </div>
      </div>
      ${buzzSection}
    </section>
  `;
}

function renderAudienceRoulettePanel(settings, round, players) {
  const roulette = round.roulette || {};
  const currentFrame = getRouletteFrame(roulette);
  const completedCount = Array.isArray(roulette.completedPlayerIds) ? roulette.completedPlayerIds.length : 0;
  const expectedCount = getRouletteExpectedCount(roulette);
  const modeLabel = {
    additive: getSnark("audience.roulette.modeAdditive", "Additive"),
    highest: getSnark("audience.roulette.modeHighest", "Highest value"),
    "single-player": getSnark("audience.roulette.modeSingle", "Single-player"),
  }[roulette.mode || settings.rouletteMode] || getSnark("audience.roulette.modeAdditive", "Additive");
  const targetLabel = roulette.mode === "single-player"
    ? roulette.targetPlayerName
      ? getSnark("audience.roulette.onlyTarget", `Only ${roulette.targetPlayerName} can stop this round.`, { player: roulette.targetPlayerName })
      : getSnark("audience.roulette.waitingTarget", "Waiting to choose a player.")
    : getSnark("audience.roulette.everyoneStops", "Everyone can stop when they want to lock in their number.");
  const selectionCountLabel = expectedCount > 0
    ? getSnark("audience.roulette.playersLocked", `${completedCount}/${expectedCount} players locked in.`, { completed: completedCount, expected: expectedCount })
    : getSnark("audience.roulette.waitingPlayers", "Waiting for players.");
  const playerSelections = Object.values(roulette.selections || {});
  const accumulatedValue = playerSelections.reduce((total, selection) => total + (Number(selection.value) || 0), 0);
  const selections = playerSelections.length
    ? playerSelections
        .slice()
        .sort((a, b) => Number(a.stoppedAt || 0) - Number(b.stoppedAt || 0))
        .map((selection) => `<li><span>${escapeHtml(selection.playerName || "Player")}</span><strong>${Number(selection.value || 0)}</strong></li>`)
        .join("")
    : `<li class="audience-empty">${getSnark("audience.roulette.audienceNoLocked", "No one has locked in yet.")}</li>`;
  const finalValue = round.roulette?.finalValue;

  return `
    <section class="card audience-card roulette-card audience-roulette-card">
      <div class="audience-card-header">
        <div>
          <p class="prejoin-kicker">Pick-a-Value</p>
          <h2>${modeLabel} mode</h2>
        </div>
        <div class="audience-meta muted">
          <span>${getSnark("audience.roulette.topAmountLabel", `Top amount ${roulette.topAmount || normalizeRouletteTopAmount(settings.rouletteTopAmount)}`, { amount: roulette.topAmount || normalizeRouletteTopAmount(settings.rouletteTopAmount) })}</span>
          <span>${getSnark("audience.roulette.ceilingLabel", `Ceiling ${roulette.ceiling || 0}`, { ceiling: roulette.ceiling || 0 })}</span>
        </div>
      </div>

      <div class="roulette-display audience-roulette-display" aria-live="polite">
        <span class="roulette-value">${currentFrame.value}</span>
        <span class="roulette-label">${currentFrame.label}</span>
      </div>

      <p class="audience-roulette-total">${getSnark("audience.roulette.audienceTotalLabel", "Accumulated total")}: <strong>${accumulatedValue}</strong></p>
      <p class="muted">${targetLabel}</p>
      <p class="muted">${selectionCountLabel}</p>
      ${finalValue !== null && finalValue !== undefined ? `<p class="roulette-locked-note">${getSnark("audience.roulette.audienceFinalValue", `Final value: <strong>${Number(finalValue)}</strong>`, { value: `<strong>${Number(finalValue)}</strong>` })}</p>` : ""}
      <ul class="audience-roulette-list">${selections}</ul>
    </section>
  `;
}

function renderAudienceScrewPanel(round) {
  const settings = getSettings();
  if (!settings.allowScrewing) {
    return "";
  }

  const screw = round.screw || {};
  const timeText = getScrewTimerMs(round) !== null ? formatSeconds(Math.ceil(getScrewTimerMs(round) / 10)) : getSnark("audience.screw.pending", "pending");

  if (!screw.active) {
    return `
      <section class="card audience-card audience-screw-card">
        <p class="prejoin-kicker">Screws</p>
        <h2>${getSnark("audience.screw.audienceEnabled", "Enabled")}</h2>
        <p class="muted">${getSnark("audience.screw.audienceNoneActive", "No screw is active right now.")}</p>
      </section>
    `;
  }

  if (!screw.screweeId) {
    return `
      <section class="card audience-card audience-screw-card">
        <p class="prejoin-kicker">Screws</p>
        <h2>${getSnark("audience.screw.audienceTargetChoosing", "Target being chosen")}</h2>
        <p>${getSnark("audience.screw.audienceSelectingWho", `<strong>${escapeHtml(screw.screwerName || "A player")}</strong> is selecting who to screw.`, { screwer: `<strong>${escapeHtml(screw.screwerName || "A player")}</strong>` })}</p>
      </section>
    `;
  }

  return `
    <section class="card audience-card audience-screw-card">
      <p class="prejoin-kicker">Screws</p>
      <h2>${getSnark("audience.screw.audienceActiveTitle", "Active screw")}</h2>
      <p>${getSnark("audience.screw.audienceActiveOver", `<strong>${escapeHtml(screw.screwerName || "A player")}</strong> is screwing over <strong>${escapeHtml(screw.screeeName || "another player")}</strong>.`, { screwer: `<strong>${escapeHtml(screw.screwerName || "A player")}</strong>`, screwee: `<strong>${escapeHtml(screw.screeeName || "another player")}</strong>` })}</p>
      <p class="muted">${getSnark("audience.screw.audienceTimerLabel", "Timer")}: <strong>${timeText}s</strong></p>
    </section>
  `;
}

// =============================================================================
// Full audience display layout — combos primary panel + scores + screw card
// =============================================================================
// =============================================================================
// Tablet timer display — full-screen timer with player count, SCREW overlay
// =============================================================================
function renderTabletTimerNotUseful() {
  return `
    <main class="tablet-timer-layout" data-notuseful="true">
      <div class="tablet-timer-container">
        <div class="tablet-timer-value">${getSnark("tablet.misc.tabletNotUseful", "This screen is not useful right now, so stop reading, don't you have a game to be playing or hosting.")}</div>
      </div>
    </main>
  `;
}

function isTabletTimerFlashing(cs) {
  if (!Number.isFinite(cs) || cs <= 0 || cs > 500) return false;
  return Math.floor(now() / 250) % 2 === 0;
}

function renderTabletTimerDisplay(settings, round, players, timeLeftCs) {
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);

  // Bingo / Wen Dit Happn tablets are not useful.
  if (isBingoMode()) {
    return renderTabletTimerNotUseful();
  }

  if (isDisOrDatMode()) {
    const dd = getDisOrDat();
    const isTimed = dd.mode === "onePlayTimed" || dd.mode === "allPlayTimed";
    if (isTimed && dd.active && dd.phase === "playing") {
      const ddCs = getDisOrDatTimeLeftCs(dd);
      const flash = isTabletTimerFlashing(ddCs);
      return `
        <main class="tablet-timer-layout"${flash ? ' data-flash="true"' : ""}>
          <div class="tablet-timer-container">
            <div class="tablet-timer-value">${formatSeconds(ddCs)}s</div>
            <div class="tablet-timer-players">Dis or Dat</div>
          </div>
        </main>
      `;
    }
    return renderTabletTimerNotUseful();
  }

  if (round.status === ROUND_STATUSES.ROULETTE) {
    const roulette = round.roulette || {};
    const completedCount = Array.isArray(roulette.completedPlayerIds) ? roulette.completedPlayerIds.length : 0;
    const expectedCount = getRouletteExpectedCount(roulette);
    const playerSelections = Object.values(roulette.selections || {});
    const accumulatedValue = playerSelections.reduce((total, selection) => total + (Number(selection.value) || 0), 0);

    return `
      <main class="tablet-timer-layout">
        <div class="tablet-timer-container">
          <div class="tablet-timer-value roulette-total">${accumulatedValue}</div>
          <div class="tablet-timer-players">${getSnark("tablet.roulette.playersLocked", `${completedCount}/${expectedCount} players locked in`, { completed: completedCount, expected: expectedCount })}</div>
        </div>
      </main>
    `;
  }

  const buzzedCount = (round.buzzedPlayerIds || []).length;
  const totalPlayers = players.filter((player) => player.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)) && isPlayerBuzzerEnabled(settings, player.id)).length;
  const isScrewActive = round.screw.active;
  const screwTimerMs = getScrewTimerMs(round);

  let timerDisplay;
  let timerCs;
  if (isScrewActive && screwTimerMs !== null) {
    timerCs = Math.ceil(screwTimerMs / 10);
    timerDisplay = `${formatSeconds(timerCs)}s`;
  } else if (isScrewActive) {
    timerCs = 0;
    timerDisplay = "SCREW";
  } else {
    timerCs = timeLeftCs;
    timerDisplay = `${formatSeconds(timeLeftCs)}s`;
  }
  const flash = !isScrewActive && isTabletTimerFlashing(timerCs);

  return `
    <main class="tablet-timer-layout"${isScrewActive ? ' data-screw-active="true"' : ""}${flash ? ' data-flash="true"' : ""}>
      <div class="tablet-timer-container">
        <div class="tablet-timer-value">${timerDisplay}</div>
        <div class="tablet-timer-players">${getSnark("tablet.misc.tabletAnswered", `${buzzedCount}/${totalPlayers} players answered`, { buzzed: buzzedCount, total: totalPlayers })}</div>
      </div>
    </main>
  `;
}

function renderAudienceDisplay(settings, round, players, scores, timeLeftCs, pendingEntry) {
  if (isTeamSelectActive()) return renderTeamSelectAudienceDisplay(settings, players);
  if (isBingoMode()) return renderBingoAudienceDisplay(settings, players);
  if (isDisOrDatMode()) return renderDisOrDatAudienceDisplay(settings, players);
  const showScores = Boolean(settings.showScoresToAudience);
  const showScrews = Boolean(settings.allowScrewing);
  const mainColumns = showScores || showScrews ? "audience-grid" : "audience-grid audience-grid-single";
  const primaryPanel = round.status === ROUND_STATUSES.ROULETTE
    ? renderAudienceRoulettePanel(settings, round, players)
    : renderAudienceBuzzPanel(settings, round, players, timeLeftCs);

  return `
    <main class="layout audience-layout"${round.screw.active ? ' data-screw-active="true"' : ""}${isBuzzersOpenFlash(settings, round) ? ' data-buzzers-open="true"' : ""}>
      <header class="hero audience-hero">
        <div>
          <p class="prejoin-kicker">Audience display</p>
          <h1>${getSnark("audience.misc.appTitle", "Instant Buzzers")}</h1>
          <p class="muted">${getSnark("audience.misc.roomCodeLabel", "Room code")}</p>
          <div class="room-code-badge">${escapeHtml(getRoomCode() || getSnark("audience.misc.roomFallback", "...."))}</div>
        </div>
        <div class="hero-meta">
          <span>${getSnark("audience.misc.statusLabel", "Status")}: <strong>${escapeHtml(round.status || getSnark("shared.misc.statusUnknown", "unknown"))}</strong></span>
          <span>${pendingEntry ? getSnark("audience.misc.awaitingRuling", `Awaiting ruling on <strong>${escapeHtml(pendingEntry.playerName)}</strong>`, { player: `<strong>${escapeHtml(pendingEntry.playerName)}</strong>` }) : getSnark("audience.misc.liveBuzzTracking", "Live buzz tracking")}</span>
        </div>
      </header>

      <section class="${mainColumns}">
        ${primaryPanel}
        ${showScores ? renderScores(players, scores) : ""}
        ${showScrews ? renderAudienceScrewPanel(round) : ""}
      </section>
    </main>
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
  const cohostIds = getSafeState("cohostIds", []);
  const nonControllerPlayers = players.filter((player) => player.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)));
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

function renderTeamAssignmentControls(settings, players, controllerId, settingDisabledAttr) {
  if (!settings.teamModeEnabled) {
    return "";
  }

  const assignments = normalizeTeamAssignments(getTeamAssignments(), players, controllerId);
  const cohostIds = getSafeState("cohostIds", []);
  const nonControllerPlayers = players.filter((player) => player.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)));
  if (nonControllerPlayers.length === 0) {
    return `
      <div class="toggle-group team-setup-group">
        <span class="muted">Team assignments</span>
        <p class="muted">No non-Host participants connected yet.</p>
      </div>
    `;
  }

  const rows = nonControllerPlayers
    .map((player) => {
      const selected = assignments[player.id] || "";
      const teamPill = selected
        ? `<span class="team-pill team-${selected}">${selected}</span>`
        : `<span class="team-pill team-none">unassigned</span>`;
      return `
        <div class="team-assignment-row">
          <strong>${escapeHtml(getPlayerName(player))}</strong>
          ${teamPill}
          <select data-team-player="${player.id}" ${settingDisabledAttr}>
            <option value="">Unassigned</option>
            ${TEAM_COLORS.map((color) => `<option value="${color}" ${selected === color ? "selected" : ""}>${color}</option>`).join("")}
          </select>
        </div>
      `;
    })
    .join("");

  return `
    <div class="toggle-group team-setup-group">
      <span class="muted">Team assignments</span>
      <div class="team-assignment-list">${rows}</div>
      <button type="button" data-host-action="randomize-teams" ${nonControllerPlayers.length < 2 ? "disabled" : ""}>Randomize Teams</button>
    </div>
  `;
}

// =============================================================================
// Renders the co-host list for the host to manage
// =============================================================================
function renderCohostList(players) {
  const cohostIds = getSafeState("cohostIds", []);
  if (!Array.isArray(cohostIds) || cohostIds.length === 0) {
    return `<span class="muted">No co-hosts assigned.</span>`;
  }
  const rows = cohostIds
    .map((id) => {
      const player = players.find((p) => p.id === id);
      const name = player ? getPlayerName(player) : "(disconnected)";
      const removeBtn = isHost()
        ? `<button type="button" class="toggle-chip is-off" data-remove-cohost="${id}" style="margin-left:0.5rem">Remove</button>`
        : "";
      return `<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.3rem"><span>${escapeHtml(name)}</span>${removeBtn}</div>`;
    })
    .join("");
  return rows;
}

// =============================================================================
// Host settings panel — controls for timing, scoring, input mode, teams, etc.
// =============================================================================
function renderHostSettings(settings, round, timeLeftCs, players, controllerId) {
  if (!hasHostPrivileges()) {
    return "";
  }

  if (isBingoMode()) {
    if (!isHost()) return `<section class="card host-panel"><p>Co-hosts cannot control BINGO/Wen Dit Happn. The host must manage it. This is a technical restriction I think</p></section>`;
    return renderBingoHostPanel(settings, players);
  }

  if (isDisOrDatMode()) {
    if (!isHost()) return `<section class="card host-panel"><p>Co-hosts cannot control Dis or Dat. The host must manage it.</p></section>`;
    return renderDisOrDatHostPanel(settings, players);
  }

  const settingsLocked = round.status === ROUND_STATUSES.OPEN || round.status === ROUND_STATUSES.ROULETTE;
  const settingDisabledAttr = settingsLocked ? "disabled" : "";
  const cohostIds = getSafeState("cohostIds", []);
  const nonControllerPlayers = players.filter((player) => player.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)));
  const teamAssignments = normalizeTeamAssignments(getTeamAssignments(), players, controllerId);
  const missingTeamAssignments = hasUnassignedTeamPlayers(settings, players, teamAssignments);
  const roulettePlayerCount = Math.max(1, nonControllerPlayers.length);
  const rouletteCeiling = Math.max(1, Math.floor(normalizeRouletteTopAmount(settings.rouletteTopAmount) / roulettePlayerCount));

  const statusText = {
    [ROUND_STATUSES.IDLE]: "Idle",
    [ROUND_STATUSES.OPEN]: "Open",
    [ROUND_STATUSES.ROULETTE]: "Pick-a-Value",
    [ROUND_STATUSES.LOCKED]: "Locked",
    [ROUND_STATUSES.CLOSED]: "Closed",
  }[round.status];

  const toggleSwitch = (setting, value, labelOn = "On", labelOff = "Off") => {
    const isOn = value === true;
    const onCls = isOn ? "is-active" : "";
    const offCls = !isOn ? "is-active is-off-val" : "";
    return `<div class="toggle-switch">
      <button type="button" class="toggle-switch-btn ${onCls}" data-toggle-setting="${setting}" data-value="true" ${settingDisabledAttr}>${labelOn}</button>
      <button type="button" class="toggle-switch-btn ${offCls}" data-toggle-setting="${setting}" data-value="false" ${settingDisabledAttr}>${labelOff}</button>
    </div>`;
  };

  return `
    <section class="card host-panel">
      <h2>Host Controls</h2>

      <!-- Section: Round -->
      <div class="settings-section">
        <details ${settingsLocked ? "" : "open"}>
          <summary>Round</summary>
          <div class="section-body">
            <div class="control-grid">
              <label>
                Time open
                <input type="number" min="1" max="120" step="1" value="${settings.timeOpen}" data-setting="timeOpen" ${settingDisabledAttr} />
                <p class="setting-helper">How many seconds buzzers stay open each round.</p>
              </label>
              <label>
                Lock after buzz
                ${toggleSwitch("lockAfterBuzz", settings.lockAfterBuzz)}
                <p class="setting-helper">Pause the round after a player buzzes so you can rule on it.</p>
              </label>
              ${
                settings.lockAfterBuzz
                  ? `<label>
                      Close on positive ruling
                      ${toggleSwitch("closeBuzzersOnPointsGiven", settings.closeBuzzersOnPointsGiven)}
                      <p class="setting-helper">Instead of re-opening, close buzzers after awarding points.</p>
                    </label>`
                  : ""
              }
              <label>
                Re-buzz allowed
                ${toggleSwitch("rebuzzAllowed", settings.rebuzzAllowed)}
                <p class="setting-helper">Let the same player buzz multiple times per round.</p>
              </label>
              ${
                settings.rebuzzAllowed
                  ? `<label>
                      Max buzzes per option
                      <input type="number" min="1" max="50" step="1" value="${settings.maxBuzzesPerOption}" data-setting="maxBuzzesPerOption" ${settingDisabledAttr} />
                      <p class="setting-helper">How many times a player can buzz the same choice while re-buzz is on.</p>
                    </label>`
                  : ""
              }
            </div>
          </div>
        </details>
      </div>

      <!-- Section: Answer Input -->
      <div class="settings-section">
        <details ${settingsLocked ? "" : "open"}>
          <summary>Answer Input</summary>
          <div class="section-body">
            <div class="control-grid">
              <label>
                Answer mode
                <select data-setting="inputMode" ${settingDisabledAttr}>
                  <option value="buttons" ${settings.inputMode !== "text" && settings.inputMode !== "bingo" && settings.inputMode !== "wendithapn" && settings.inputMode !== "disordat" ? "selected" : ""}>Button buzzer</option>
                  <option value="text" ${settings.inputMode === "text" ? "selected" : ""}>Text entry</option>
                </select>
                <p class="setting-helper">How players give their answers.</p>
              </label>
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
                      <p class="setting-helper">How many buzzer buttons each player sees.</p>
                    </label>`
              }
            </div>

            <!-- Pre-set correct answer -->
            <div style="margin-top:0.75rem">
              <h3 style="font-size:0.85rem;margin:0 0 0.4rem;color:var(--muted)">Pre-set correct answer</h3>
              <p class="muted" style="font-size:0.8rem">Auto-award points when a player picks the right answer.</p>
              ${settings.inputMode === "text"
                ? `<label style="margin-top:0.4rem">Correct answer text
                     <input id="correct-answer-entry" type="text" maxlength="120" value="${escapeHtml(round.correctAnswer || "")}" ${settingDisabledAttr} />
                     <div style="margin-top:0.4rem">
                       <button type="button" data-set-correct-text ${settingDisabledAttr}>Set</button>
                       <button type="button" data-clear-correct ${settingDisabledAttr}>Clear</button>
                     </div>
                   </label>`
                : `<div style="margin-top:0.4rem">
                     <span class="muted">Correct options</span>
                     <div class="toggle-list" style="margin-top:0.4rem">
                       ${Array.from({ length: settings.optionCount }, (_, i) => i + 1)
                         .map((opt) => {
                           const enabled = Array.isArray(round.correctOptions) && round.correctOptions.map(Number).includes(opt);
                           const label = settings.optionCount <= 4 ? optionButtonLabel(opt) : String(opt);
                           return `<button type="button" class="toggle-chip ${enabled ? "is-on" : "is-off"}" data-correct-option="${opt}" ${settingDisabledAttr}>${label} ${enabled ? "On" : "Off"}</button>`;
                         })
                         .join("")}
                     </div>
                     <div style="margin-top:0.4rem"><button type="button" data-clear-correct ${settingDisabledAttr}>Clear</button></div>
                   </div>`}
            </div>

            ${settings.inputMode === "text" ? "" : renderBuzzerToggles(settings, settingDisabledAttr)}
          </div>
        </details>
      </div>

      <!-- Section: Scoring -->
      <div class="settings-section">
        <details ${settingsLocked ? "" : "open"}>
          <summary>Scoring</summary>
          <div class="section-body">
            <div class="control-grid">
              <label>
                Scoring mode
                <select data-setting="scoringMode" ${settingDisabledAttr}>
                  <option value="uniform" ${settings.scoringMode === "uniform" ? "selected" : ""}>Uniform (fixed points)</option>
                  <option value="jack" ${settings.scoringMode === "jack" ? "selected" : ""}>JACK (time-based)</option>
                  <option value="roulette" ${settings.scoringMode === "roulette" ? "selected" : ""}>Pick-a-value (player-determined)</option>
                </select>
                <p class="setting-helper">How each buzz is valued.</p>
              </label>
              ${
                settings.scoringMode === "uniform"
                  ? `<label>
                      Uniform points
                      <select data-setting="uniformPoints" ${settingDisabledAttr}>
                        ${VALUE_OPTIONS.map((value) => `<option value="${value}" ${settings.uniformPoints === value ? "selected" : ""}>${value}</option>`).join("")}
                      </select>
                      <p class="setting-helper">Every correct answer is worth this many points.</p>
                    </label>`
                  : settings.scoringMode === "jack"
                    ? `<label>
                        JACK multiplier
                      <select data-setting="jackMultiplier" ${settingDisabledAttr}>
                        <option value="1" ${settings.jackMultiplier === 1 ? "selected" : ""}>1x</option>
                        <option value="1.5" ${settings.jackMultiplier === 1.5 ? "selected" : ""}>1.5x</option>
                        <option value="2" ${settings.jackMultiplier === 2 ? "selected" : ""}>2x</option>
                        <option value="2.5" ${settings.jackMultiplier === 2.5 ? "selected" : ""}>2.5x</option>
                        <option value="3" ${settings.jackMultiplier === 3 ? "selected" : ""}>3x</option>
                      </select>
                      <p class="setting-helper">Points = time left × multiplier (faster buzz = more points).</p>
                    </label>`
                    : ""
              }
            </div>
            ${
              settings.scoringMode === "roulette"
                ? `<div class="control-grid" style="margin-top:0.5rem">
                    <label>
                      Pick-a-value mode
                      <select data-setting="rouletteMode" ${settingDisabledAttr}>
                        <option value="additive" ${settings.rouletteMode === "additive" ? "selected" : ""}>Additive (everyone adds up)</option>
                        <option value="highest" ${settings.rouletteMode === "highest" ? "selected" : ""}>Highest value wins</option>
                        <option value="single-player" ${settings.rouletteMode === "single-player" ? "selected" : ""}>Single-player stops it</option>
                      </select>
                      <p class="setting-helper">How the pick-a-value result is calculated from all players.</p>
                    </label>
                    <label>
                      Top amount
                      <select data-setting="rouletteTopAmount" ${settingDisabledAttr}>
                        ${VALUE_OPTIONS.map((value) => `<option value="${value}" ${normalizeRouletteTopAmount(settings.rouletteTopAmount) === value ? "selected" : ""}>${value}</option>`).join("")}
                      </select>
                      <p class="setting-helper">Maximum possible value.</p>
                    </label>
                    ${settings.rouletteMode === "single-player"
                      ? `<label>
                          Target player
                          <select data-setting="rouletteSinglePlayerTarget" ${settingDisabledAttr}>
                            <option value="random" ${settings.rouletteSinglePlayerTarget === "random" ? "selected" : ""}>Random player</option>
                            ${nonControllerPlayers
                              .map((player) => `<option value="${player.id}" ${settings.rouletteSinglePlayerTarget === player.id ? "selected" : ""}>${escapeHtml(getPlayerName(player))}</option>`)
                              .join("")}
                          </select>
                          <p class="setting-helper">Which player stops the pick-a-value.</p>
                        </label>`
                      : ""}
                    <span class="roulette-help muted">Ceiling per player: ${rouletteCeiling}.</span>
                  </div>`
                : ""
            }
          </div>
        </details>
      </div>

      <!-- Section: Teams -->
      <div class="settings-section">
        <details ${settingsLocked ? "" : "open"}>
          <summary>Teams</summary>
          <div class="section-body">
            <div class="control-grid">
              <label>
                Teams
                ${toggleSwitch("teamModeEnabled", settings.teamModeEnabled)}
                <p class="setting-helper">Group players into color teams.</p>
              </label>
              ${settings.teamModeEnabled
                ? `<label>
                    Team scoring
                    <select data-setting="teamScoringMode" ${settingDisabledAttr}>
                      <option value="alliance" ${settings.teamScoringMode === "alliance" ? "selected" : ""}>Alliance (individual + team totals)</option>
                      <option value="shared" ${settings.teamScoringMode === "shared" ? "selected" : ""}>Shared (one buzzer per team)</option>
                    </select>
                    <p class="setting-helper">"Alliance" keeps individual scores + tallies teams. "Shared" gives each team one buzzer.</p>
                  </label>`
                : ""}
            </div>
            ${settings.teamModeEnabled ? renderTeamAssignmentControls(settings, players, controllerId, settingDisabledAttr) : ""}
            ${
              settings.teamModeEnabled && !isTeamSelectActive()
                ? `<div style="margin-top:0.6rem">
                    <button type="button" class="full-width-btn" data-teamselect-open ${round.status === ROUND_STATUSES.IDLE ? "" : "disabled"}>Open Team Selection</button>
                    <p class="setting-helper">Players pick their own teams on a full-screen selection. Starts locked; unlock it to let players choose. Requires an Idle round.</p>
                  </div>`
                : ""
            }
          </div>
        </details>
      </div>

      <!-- Section: Extras -->
      <div class="settings-section">
        <details ${settingsLocked ? "" : "open"}>
          <summary>Extras</summary>
          <div class="section-body">
            <div class="control-grid">
              <label>
                Screw mechanic
                ${toggleSwitch("allowScrewing", settings.allowScrewing)}
                <p class="setting-helper">Players can force another player to answer under a 5s timer. Screwer gains 1000 if screwee gets it wrong, loses 1000 if they get it right.</p>
              </label>
              ${
                settings.allowScrewing
                  ? `<label>
                      Reopen buzzers after screw
                      ${toggleSwitch("reopenBuzzersAfterScrew", settings.reopenBuzzersAfterScrew)}
                      <p class="setting-helper">Instead of closing the round, reopen buzzers with the remaining time after a screw is ruled.</p>
                    </label>`
                  : ""
              }
              <label>
                Show scores to all
                ${toggleSwitch("showScoresToPlayers", settings.showScoresToPlayers)}
                <p class="setting-helper">Let non-host players see the scoreboard.</p>
              </label>
              <label>
                Show scores on audience display
                ${toggleSwitch("showScoresToAudience", settings.showScoresToAudience)}
                <p class="setting-helper">Show scores on the audience/projection screen.</p>
              </label>
              <label>
                UI animations
                ${toggleSwitch("uiAnimationsEnabled", settings.uiAnimationsEnabled)}
                <p class="setting-helper">Animated backgrounds and effects while buzzers are open.</p>
              </label>
              <label>
                Snark mode
                <select data-setting="snarkMode" ${settingDisabledAttr}>
                  <option value="off" ${settings.snarkMode === "off" ? "selected" : ""}>Off</option>
                  <option value="1" ${settings.snarkMode === "1" ? "selected" : ""}>Snark Level 1</option>
                  <option value="2" ${settings.snarkMode === "2" ? "selected" : ""}>Snark Level 2</option>
                </select>
                <p class="setting-helper">Swap player-facing text for snarky variants.</p>
              </label>
            </div>
            ${renderPlayerToggles(settings, players, controllerId, settingDisabledAttr)}
            <div class="control-grid" style="margin-top:0.75rem;border-top:1px solid var(--panel-border);padding-top:0.75rem">
              <label>
                Co-host password
                <div class="room-code-badge" style="font-size:1.2rem;letter-spacing:0.3em;margin-top:0.3rem">${escapeHtml(getSafeState("cohostPassword", ""))}</div>
                <p class="setting-helper">Share this 5-digit code with your co-hosts (option to co-host under host menu).</p>
              </label>
              <label>
                Co-hosts
                <div style="margin-top:0.3rem">
                  ${renderCohostList(players)}
                </div>
              </label>
            </div>
          </div>
        </details>
      </div>

      <!-- Section: Special Questions -->
      <div class="settings-section">
        <details>
          <summary>Special Questions</summary>
          <div class="section-body">
            <p class="muted" style="font-size:0.82rem">Alternative question formats that replace the normal buzzer round, little minigames from various JACK games.</p>
            <div style="margin-top:0.5rem;display:flex;flex-direction:column;gap:0.6rem">
              <div>
                <button type="button" data-set-mode="bingo" ${settingDisabledAttr} ${settings.inputMode === "bingo" ? "disabled" : ""}>Bingo</button>
                <p class="setting-helper">Players race to be the first to collect all 5 letters of a word. Set the 5-letter word, choose a target letter, then Start Cycling — players buzz to grab the lit tile. Rinse and repeat First to complete the word wins. (From YDKJ Vol. 4: The Ride, Recommended for small games (2-5 players) or team mode, not reccomended for large games)</p>
              </div>
              <div>
                <button type="button" data-set-mode="wendithapn" ${settingDisabledAttr} ${settings.inputMode === "wendithapn" ? "disabled" : ""}>Wen Dit Happn</button>
                <p class="setting-helper">Same collection race, but the tiles are "Before, Never, After". Pick the correct one for every question, then Start Cycling — players buzz to grab tiles as they light up. First to collect them all wins. (From YDKJ: Louder Faster Funnier, remade in the fangame YDKJ: The Re-ride, Recommended for small games (2-5 players) or team mode, not reccomended for large games)</p>
              </div>
              <div>
                <button type="button" data-set-mode="disordat" ${settingDisabledAttr} ${settings.inputMode === "disordat" ? "disabled" : ""}>Dis or Dat</button>
                <p class="setting-helper">The YDKJ classic itself! You read 7 things aloud; players answer Dis, Dat, or Both on their devices. Set the correct answer for each question first, then pick a mode. Timed (One Play or All Play) is a 30-second race with a finish-fast bonus; Host Paced advances each question manually. (in every JACK game, One play recommended for small games, All play recommended for large games, may not be as enjoyable in team mode, but hey, im not your parental figure)</p>
              </div>
            </div>
            ${settings.inputMode === "bingo" || settings.inputMode === "wendithapn" || settings.inputMode === "disordat"
              ? `<p class="setting-helper" style="margin-top:0.4rem">Currently active. Open the panel below to control the round.</p>`
              : ""}
          </div>
        </details>
      </div>

      <!-- Action buttons -->
      <div style="margin-top:1rem">
        <div class="host-actions">
          ${settings.scoringMode === "roulette"
            ? `<button type="button" data-host-action="start-roulette" ${round.status === ROUND_STATUSES.OPEN || round.status === ROUND_STATUSES.ROULETTE ? "disabled" : ""}>Start Pick-a-Value</button>`
            : ""}
          <button type="button" data-host-action="open" ${round.status === ROUND_STATUSES.OPEN || missingTeamAssignments ? "disabled" : ""}>Open Buzzers</button>
          <button type="button" data-host-action="close">Close Buzzers</button>
          <button type="button" data-host-action="reset">Reset Round</button>
        </div>
        <div class="host-actions" style="margin-top:0.4rem">
          ${!round.screw.active && round.status === ROUND_STATUSES.OPEN
            ? `<button type="button" class="screw-btn" data-host-screw>Screw a Player</button>`
            : ""}
          <button type="button" data-host-action="reset-screws">Refund Screws</button>
        </div>
        ${renderScrewNotice(round)}
        ${settings.allowScrewing && settings.inputMode !== "bingo" && settings.inputMode !== "wendithapn" && settings.inputMode !== "disordat" && players.length > 0
          ? `<div class="screw-status" style="margin-top:0.4rem;font-size:0.82rem">
              <span class="muted">Screw status:</span>
              ${players
                .filter(p => p.id !== controllerId)
                .map(p => `<span style="display:inline-block;margin:0 0.3rem 0.2rem 0;padding:0.1rem 0.4rem;border-radius:4px;background:${round.screwsUsedBy?.includes(p.id) ? "rgba(235,61,48,0.2)" : "rgba(29,185,84,0.2)"}">${getPlayerName(p)}</span>`)
                .join("")}
            </div>`
          : ""}
      </div>

      <div class="status-strip">
        <span>Status: <strong>${statusText}</strong></span>
        <span>Time left: <strong data-live-time-left>${formatSeconds(timeLeftCs)}s</strong></span>
        ${settings.scoringMode === "roulette" && round.roulette?.finalValue !== null && round.roulette?.finalValue !== undefined
          ? `<span>Final value: <strong>${round.roulette.finalValue}</strong></span>`
          : ""}
        ${settings.rebuzzAllowed && settings.lockAfterBuzz ? "<span>Re-Buzz is on, so lock-after-buzz is ignored.</span>" : ""}
        ${settings.lockAfterBuzz && settings.closeBuzzersOnPointsGiven ? "<span>Buzzers close after a positive ruling.</span>" : ""}
        ${settings.allowScrewing && settings.reopenBuzzersAfterScrew ? "<span>Buzzers reopen with the remaining time after a screw.</span>" : ""}
        ${round.status === ROUND_STATUSES.ROULETTE ? "<span>Pick-a-value is running.</span>" : ""}
        ${settings.teamModeEnabled && missingTeamAssignments
          ? "<span>Assign every player to a team before opening buzzers.</span>"
          : ""}
        ${settingsLocked ? "<span>Settings are locked while buzzers are open.</span>" : ""}
      </div>
    </section>
  `;
}

function renderScrewNotice(round) {
  if (!hasHostPrivileges() || !round.screw.active) {
    return "";
  }

  // Screw is active but screwee not selected yet
  if (!round.screw.screweeId) {
    const isScrewer = round.screw.screwerId === me().id;
    if (isScrewer) {
      const controllerId = getControllerId();
      const cohostIds = getSafeState("cohostIds", []);
      const targets = currentParticipants()
        .filter(p => p.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(p.id)) && p.id !== round.screw.screwerId);
      const targetButtons = targets.map(p =>
        `<button type="button" data-screw-player="${p.id}">${getPlayerName(p)}</button>`
      ).join("");
      return `
        <section class="card screw-card">
          <h3>Select a Target</h3>
          <p>Choose a player to screw:</p>
          <div class="screw-player-list">${targetButtons}</div>
        </section>
      `;
    }
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
  const timeText = formatSeconds(Math.ceil(getScrewTimerMs(round) / 10));
  return `
    <section class="card screw-card">
      <h3>Screw Timer</h3>
      <p><strong>${round.screw.screwerName}</strong> is screwing over <strong>${round.screw.screeeName}</strong>.</p>
      <p>Time left: <strong>${timeText}s</strong></p>
    </section>
  `;
}

// =============================================================================
// When lockAfterBuzz is on, show the host a Correct / Incorrect ruling prompt
// =============================================================================
function renderLockedRuling(settings, pendingEntry) {
  if (!hasHostPrivileges() || !settings.lockAfterBuzz || !pendingEntry) {
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

// =============================================================================
// Scoreboard — supports individual, team-shared, and alliance modes
// =============================================================================
function renderScores(players, scores) {
  const settings = getSettings();
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  const visiblePlayers = players.filter((player) => player.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)));
  const assignments = normalizeTeamAssignments(getTeamAssignments(), players, controllerId);

  if (settings.teamModeEnabled && settings.teamScoringMode === "shared") {
    const teamItems = TEAM_COLORS
      .map((teamColor) => {
        const members = getTeamMembers(teamColor, players, assignments);
        if (members.length === 0) {
          return "";
        }
        const teamScore = Number(scores[getTeamScoreKey(teamColor)] || 0);
        const memberNames = members.map((player) => escapeHtml(getPlayerName(player))).join(", ");
        return `<li class="team-score-row"><span><span class="team-pill team-${teamColor}">${teamColor}</span> <small>${memberNames}</small></span><strong>${teamScore}</strong></li>`;
      })
      .filter(Boolean)
      .join("");

    return `
      <section class="card score-card">
        <h2>${getSnark("shared.scores.teamScoresTitle", "Team Scores")}</h2>
        <ul>${teamItems || `<li>${getSnark("shared.scores.noTeamsYet", "No teams assigned yet.")}</li>`}</ul>
      </section>
    `;
  }

  const items = visiblePlayers
    .map((player) => {
      const value = Number(scores[player.id] || 0);
      const teamColor = getPlayerTeamColor(player.id, assignments);
      const teamPill = teamColor ? `<span class="team-pill team-${teamColor}">${teamColor}</span>` : "";
      return `<li><span>${escapeHtml(getPlayerName(player))} ${teamPill}</span><strong>${value}</strong></li>`;
    })
    .join("");

  const teamTotals = settings.teamModeEnabled
    ? TEAM_COLORS
        .map((teamColor) => {
          const members = getTeamMembers(teamColor, players, assignments);
          if (members.length === 0) {
            return "";
          }
          const total = members.reduce((sum, member) => sum + Number(scores[member.id] || 0), 0);
          return `<li class="team-score-row"><span><span class="team-pill team-${teamColor}">${teamColor}</span></span><strong>${total}</strong></li>`;
        })
        .filter(Boolean)
        .join("")
    : "";

  return `
    <section class="card score-card">
      <h2>${settings.teamModeEnabled ? getSnark("shared.scores.playerScoresTitle", "Player Scores") : getSnark("shared.scores.scoresTitle", "Scores")}</h2>
      <ul>${items || `<li>${getSnark("shared.bingo.noPlayersYet", "No players yet.")}</li>`}</ul>
      ${teamTotals ? `<h3>${getSnark("shared.scores.allianceTotalsTitle", "Alliance totals")}</h3><ul>${teamTotals}</ul>` : ""}
    </section>
  `;
}

// =============================================================================
// Game log — reverse-chronological list of every buzz, editable by host
// =============================================================================
function renderLog(log, settings) {
  const rows = [...log]
    .reverse()
    .map((entry) => {
      const controls = hasHostPrivileges()
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
            <span>${entry.scoreTarget ? `To ${escapeHtml(entry.scoreTarget)}` : ""}</span>
            <span>
              ${
                entry.answerText
                  ? `Answer \"${escapeHtml(entry.answerText)}\"`
                  : `Option ${settings.optionCount === 4 ? optionButtonLabel(entry.option) : entry.option}`
              }
            </span>
            <span>${formatSeconds(entry.timeLeftCs)}s</span>
            <span>${entry.scoringMode === "uniform" ? `U:${entry.uniformPoints}` : entry.scoringMode === "jack" ? `Jx${entry.jackMultiplier}` : `Pick-a-Value`}</span>
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

// Placeholder card for content hidden from non-host players
function renderHiddenPanel(title, helper) {
  return `
    <section class="card muted-card">
      <h2>${title}</h2>
      <p class="muted">${helper}</p>
    </section>
  `;
}

// =============================================================================
// Top-level render — assembles the entire page HTML and calls bindEvents
// =============================================================================
function render() {
  const mePlayer = me();
  const players = currentParticipants();
  const settings = getSettings();
  const round = getRound();
  const scores = getScores();
  const gameLog = getLog();
  const timeLeftCs = round.screw.active && round.screw.frozenCs != null ? round.screw.frozenCs : getTimeLeftCs(round, settings);
  const pendingLogId = getSafeState("pendingLogId", null);
  const pendingEntry = gameLog.find((entry) => entry.id === pendingLogId) || null;
  const controller = getController();
  const teamAssignments = normalizeTeamAssignments(getTeamAssignments(), players, controller?.id || null);
  const myTeamColor = getPlayerTeamColor(mePlayer.id, teamAssignments);
  const showAdminData = hasHostPrivileges();
  if (settings.teamModeEnabled && myTeamColor && !isAudienceDisplayClient()) {
    document.body.dataset.team = myTeamColor;
  } else {
    delete document.body.dataset.team;
  }
  const showScoresToPlayers = Boolean(settings.showScoresToPlayers);
  if (settings.uiAnimationsEnabled) {
    document.body.dataset.uiAnims = "on";
  } else {
    document.body.dataset.uiAnims = "off";
  }

  if (isAudienceDisplayClient()) {
    const buzzedCount = (round.buzzedPlayerIds || []).length;
    const controllerId = controller?.id || getControllerId();
    const cohostIds = getSafeState("cohostIds", []);
    const totalPlayers = players.filter((p) => p.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(p.id)) && isPlayerBuzzerEnabled(settings, p.id)).length;
    const timerRunning = round.status === ROUND_STATUSES.OPEN || round.status === ROUND_STATUSES.LOCKED;
    const allBuzzed = buzzedCount >= totalPlayers && totalPlayers > 0;
    if (!timerRunning || round.screw.active) {
      audienceTimerFrozenCs = null;
    } else if (allBuzzed) {
      if (audienceTimerFrozenCs === null) audienceTimerFrozenCs = timeLeftCs;
    } else {
      audienceTimerFrozenCs = null;
    }
    const displayTimeLeftCs = audienceTimerFrozenCs !== null ? audienceTimerFrozenCs : timeLeftCs;

    if (clientMode === "tablet_timer" || me()?.getState?.("clientMode") === "tablet_timer") {
      app.innerHTML = renderTabletTimerDisplay(settings, round, players, displayTimeLeftCs);
    } else {
      app.innerHTML = renderAudienceDisplay(settings, round, players, scores, displayTimeLeftCs, pendingEntry);
    }
    lastUiSignature = getUiSignature();
    bindEvents();
    return;
  }

  if (isTeamSelectActive()) {
    const tsBody = showAdminData ? `
      ${renderTeamSelectHostPanel(settings, round, players, controller?.id || null)}
      <section class="grid">
        ${renderScores(players, scores)}
      </section>
      ${renderLog(gameLog, settings)}` : `
      <section class="grid grid-single">
        ${renderTeamSelectPlayerPanel(settings, players, mePlayer)}
        ${showScoresToPlayers ? renderScores(players, scores) : renderHiddenPanel(getSnark("player.scores.scoresTitle", "Scores"), getSnark("player.scores.scoresHidden", "Only the Host can view scores right now."))}
      </section>` ;
    app.innerHTML = `
      <main class="layout" data-teamselect-active="true">
        <header class="hero">
          <div>
            <h1>${getSnark("player.teamSelect.title", "Choose Your Teams")}</h1>
            <p class="muted" style="margin-bottom:0.15rem">${getSnark("player.misc.roomCodeLabel", "Room code")}</p>
            <div class="room-code-badge">${getRoomCode() || "..."}</div>
          </div>
          <div class="hero-meta">
            <span>${getSnark("player.misc.youLabel", `You: ${getPlayerName(mePlayer)}`, { name: getPlayerName(mePlayer) })}</span>
            ${settings.teamModeEnabled && !isControllerPlayer() && !isCohost() ? `<span>${getSnark("player.misc.allianceLabel", "Alliance")}: <strong>${myTeamColor || getSnark("player.misc.unassigned", "Unassigned")}</strong></span>` : ""}
            <span>${getSnark("player.misc.hostLabel", `Host: ${controller ? getPlayerName(controller) : "-"}`, { name: controller ? getPlayerName(controller) : "-" })}</span>
          </div>
        </header>
        ${tsBody}
      </main>
    `;
    lastUiSignature = getUiSignature();
    bindEvents();
    return;
  }

  if (isBingoMode()) {
    const isWen = isWenDitHapnMode();
    const bingoBody = showAdminData ? `
      ${renderHostSettings(settings, round, timeLeftCs, players, controller?.id || null)}
      <section class="grid">
        ${renderScores(players, scores)}
      </section>
      ${renderLog(gameLog, settings)}` : `
      <section class="grid grid-single">
        ${renderBuzzerPanel(settings, round, mePlayer, timeLeftCs)}
        ${showScoresToPlayers ? renderScores(players, scores) : renderHiddenPanel(getSnark("player.scores.scoresTitle", "Scores"), getSnark("player.scores.scoresHidden", "Only the Host can view scores right now."))}
      </section>` ;
    app.innerHTML = `
      <main class="layout" data-bingo-active="true">
        <header class="hero">
          <div>
            <h1>${isWen ? "Wen Dit Happn" : "Bingo"}</h1>
            <p class="muted" style="margin-bottom:0.15rem">${getSnark("player.misc.roomCodeLabel", "Room code")}</p>
            <div class="room-code-badge">${getRoomCode() || "..."}</div>
          </div>
          <div class="hero-meta">
            <span>${getSnark("player.misc.youLabel", `You: ${getPlayerName(mePlayer)}`, { name: getPlayerName(mePlayer) })}</span>
            <span>${getSnark("player.misc.hostLabel", `Host: ${controller ? getPlayerName(controller) : "-"}`, { name: controller ? getPlayerName(controller) : "-" })}</span>
          </div>
        </header>
        ${bingoBody}
      </main>
    `;
    lastUiSignature = getUiSignature();
    bindEvents();
    return;
  }

  if (isDisOrDatMode()) {
    const ddBody = showAdminData ? `
      ${renderHostSettings(settings, round, timeLeftCs, players, controller?.id || null)}
      <section class="grid">
        ${renderScores(players, scores)}
      </section>
      ${renderLog(gameLog, settings)}` : `
      <section class="grid grid-single">
        ${renderBuzzerPanel(settings, round, mePlayer, timeLeftCs)}
        ${showScoresToPlayers ? renderScores(players, scores) : renderHiddenPanel(getSnark("player.scores.scoresTitle", "Scores"), getSnark("player.scores.scoresHidden", "Only the Host can view scores right now."))}
      </section>` ;
    app.innerHTML = `
      <main class="layout" data-disordat-active="true">
        <header class="hero">
          <div>
            <h1>Dis or Dat</h1>
            <p class="muted" style="margin-bottom:0.15rem">${getSnark("player.misc.roomCodeLabel", "Room code")}</p>
            <div class="room-code-badge">${getRoomCode() || "..."}</div>
          </div>
          <div class="hero-meta">
            <span>${getSnark("player.misc.youLabel", `You: ${getPlayerName(mePlayer)}`, { name: getPlayerName(mePlayer) })}</span>
            <span>${getSnark("player.misc.hostLabel", `Host: ${controller ? getPlayerName(controller) : "-"}`, { name: controller ? getPlayerName(controller) : "-" })}</span>
          </div>
        </header>
        ${ddBody}
      </main>
    `;
    lastUiSignature = getUiSignature();
    bindEvents();
    return;
  }

  app.innerHTML = `
    <main class="layout"${round.screw.active ? ' data-screw-active="true"' : ""}${isBuzzersOpenFlash(settings, round) ? ' data-buzzers-open="true"' : ""}>
      <header class="hero">
        <div>
          <h1>${getSnark("player.misc.appTitle", "Instant Buzzers")}</h1>
          <p class="muted" style="margin-bottom:0.15rem">${getSnark("player.misc.roomCodeLabel", "Room code")}</p>
          <div class="room-code-badge">${getRoomCode() || "..."}</div>
        </div>
        <div class="hero-meta">
          <span>${getSnark("player.misc.youLabel", `You: ${getPlayerName(mePlayer)}`, { name: getPlayerName(mePlayer) })}</span>
          ${isCohost() ? `<span class="cohost-badge">${getSnark("player.misc.cohostBadge", "Co-host")}</span>` : ""}
          ${settings.teamModeEnabled && !isControllerPlayer() && !isCohost() ? `<span>${getSnark("player.misc.allianceLabel", "Alliance")}: <strong>${myTeamColor || getSnark("player.misc.unassigned", "Unassigned")}</strong></span>` : ""}
          <span>${getSnark("player.misc.hostLabel", `Host: ${controller ? getPlayerName(controller) : "-"}`, { name: controller ? getPlayerName(controller) : "-" })}</span>
          <span>${getSnark("player.misc.roundLabel", "Round")}: <strong data-round-status>${escapeHtml(round.status || getSnark("shared.misc.statusUnknown", "unknown"))}</strong></span>
        </div>
      </header>
      
      ${renderHostSettings(settings, round, timeLeftCs, players, controller?.id || null)}
      <section class="grid ${showAdminData ? "" : "grid-single"}">
        ${renderBuzzerPanel(settings, round, mePlayer, timeLeftCs)}
        ${(showAdminData || showScoresToPlayers)
          ? renderScores(players, scores)
          : renderHiddenPanel(getSnark("player.scores.scoresTitle", "Scores"), getSnark("player.scores.scoresHiddenLong", "Only the Host can view scores right now, if you want to see them, ask the Host to enable."))}
      </section>

      ${renderLockedRuling(settings, pendingEntry)}
      ${showAdminData ? renderLog(gameLog, settings) : renderHiddenPanel(getSnark("player.scores.logTitle", "Game Log"), getSnark("player.scores.logHidden", "Only the Host can view the game log."))}
    </main>
  `;

  lastUiSignature = getUiSignature();
  bindEvents();
}

// =============================================================================
// Event binding — attaches listeners to every data-* attribute in the DOM
// =============================================================================
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

  app.querySelectorAll("[data-pick-team]").forEach((button) => {
    button.addEventListener("click", async () => {
      const teamColor = button.dataset.pickTeam;
      const result = await RPC.call("select-team", { teamColor }, RPC.Mode.HOST);
      if (result?.ok === false) {
        setBuzzNotice(result.reason || "Could not join that team.");
      } else if (result?.message) {
        setBuzzNotice(result.message);
      }
      render();
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

  if (hasHostPrivileges()) {
    app.querySelectorAll("[data-setting]").forEach((input) => {
      input.addEventListener("change", () => {
        const setting = input.dataset.setting;
        if (setting === "timeOpen") {
          const value = clamp(parseInt(input.value, 10) || 20, 1, 120);
          setHostSetting("timeOpen", value);
          return;
        }
        if (setting === "inputMode") {
          setHostSetting("inputMode", input.value);
          return;
        }
        if (setting === "optionCount") {
          setHostSetting("optionCount", Number(input.value));
          return;
        }
        if (setting === "scoringMode") {
          setHostSetting("scoringMode", input.value === "jack" ? "jack" : input.value === "roulette" ? "roulette" : "uniform");
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
          setHostSetting("uniformPoints", normalizeUniformPoints(input.value));
          return;
        }
        if (setting === "jackMultiplier") {
          setHostSetting("jackMultiplier", Number(input.value));
          return;
        }
        if (setting === "teamScoringMode") {
          setHostSetting("teamScoringMode", input.value === "shared" ? "shared" : "alliance");
          return;
        }
        if (setting === "snarkMode") {
          setHostSetting("snarkMode", input.value === "1" ? "1" : input.value === "2" ? "2" : "off");
          return;
        }
        if (setting === "maxBuzzesPerOption") {
          const value = clamp(parseInt(input.value, 10) || 1, 1, 50);
          setHostSetting("maxBuzzesPerOption", value);
          return;
        }
      });
    });

    // Toggle switches (On/Off button pairs)
    app.querySelectorAll("[data-toggle-setting]").forEach((button) => {
      button.addEventListener("click", () => {
        const setting = button.dataset.toggleSetting;
        const value = button.dataset.value === "true";
        button.parentElement.querySelectorAll(".toggle-switch-btn").forEach((b) => {
          b.classList.remove("is-active", "is-off-val");
        });
        button.classList.add("is-active");
        if (!value) button.classList.add("is-off-val");
        setHostSetting(setting, value);
      });
    });

    app.querySelectorAll("[data-team-player]").forEach((input) => {
      input.addEventListener("change", () => {
        setPlayerTeam(input.dataset.teamPlayer, String(input.value || ""));
      });
    });

    app.querySelectorAll("[data-host-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.hostAction;
        if (action === "randomize-teams") {
          randomizeTeams();
        } else if (action === "open") {
          openBuzzers();
        } else if (action === "start-roulette") {
          const result = startRoulettePhase();
          if (result?.ok === false) {
            setBuzzNotice(result.reason || "Could not start pick-a-value.");
            render();
          } else if (result?.message) {
            setBuzzNotice(result.message);
            render();
          }
        } else if (action === "close") {
          closeBuzzers();
        } else if (action === "reset") {
          resetRound();
        } else if (action === "reset-screws") {
          resetScrews();
        }
      });
    });

    app.querySelectorAll("[data-host-screw]").forEach((button) => {
      button.addEventListener("click", () => hostInitiateScrew());
    });

    app.querySelectorAll("[data-teamselect-open]").forEach((button) => {
      button.addEventListener("click", () => openTeamSelect());
    });

    app.querySelectorAll("[data-teamselect-close]").forEach((button) => {
      button.addEventListener("click", () => closeTeamSelect());
    });

    app.querySelectorAll("[data-teamselect-lock]").forEach((button) => {
      button.addEventListener("click", () => setTeamSelectLocked(button.dataset.teamselectLock === "true"));
    });

    app.querySelectorAll("[data-teamselect-enable]").forEach((input) => {
      input.addEventListener("change", () => {
        const current = getTeamSelect().enabledTeams || [];
        const teamColor = input.dataset.teamselectEnable;
        const next = input.checked
          ? [...new Set([...current, teamColor])]
          : current.filter((color) => color !== teamColor);
        setTeamSelectTeams(next);
      });
    });

    app.querySelectorAll("[data-teamselect-limit]").forEach((input) => {
      input.addEventListener("change", () => {
        setTeamSelectLimit(input.value);
      });
    });

    app.querySelectorAll("[data-set-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        setHostSetting("inputMode", button.dataset.setMode);
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
        setCorrectAnswerValue(val);
      });
    });

    app.querySelectorAll("[data-clear-correct]").forEach((button) => {
      button.addEventListener("click", () => {
        clearCorrectAnswerValue();
      });
    });

    app.querySelectorAll("[data-correct-option]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!hasHostPrivileges()) return;
        const opt = Number(button.dataset.correctOption);
        if (!Number.isInteger(opt)) return;
        toggleCorrectOption(opt);
      });
    });

    // Remove co-host (host only)
    app.querySelectorAll("[data-remove-cohost]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!isHost()) return;
        const removeId = button.dataset.removeCohost;
        const current = getSafeState("cohostIds", []);
        if (Array.isArray(current) && current.includes(removeId)) {
          setState("cohostIds", current.filter((id) => id !== removeId), true);
          render();
        }
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

    // Bingo host handlers
    app.querySelectorAll("[data-bingo-init]").forEach(btn => {
      btn.addEventListener("click", () => startBingo());
    });
    app.querySelectorAll("[data-bingo-end]").forEach(btn => {
      btn.addEventListener("click", () => endBingo());
    });
    app.querySelectorAll("[data-bingo-target]").forEach(sel => {
      sel.addEventListener("change", () => setBingoTarget(Number(sel.value)));
    });
    app.querySelectorAll("[data-bingo-cycle]").forEach(btn => {
      btn.addEventListener("click", () => startBingoCycling());
    });
    app.querySelectorAll("[data-bingo-stop-cycle]").forEach(btn => {
      btn.addEventListener("click", () => stopBingoCycling());
    });
    app.querySelectorAll("[data-bingo-exit]").forEach(btn => {
      btn.addEventListener("click", () => {
        endBingo();
        setHostSetting("inputMode", "buttons");
      });
    });

    // Bingo player buzz
    app.querySelectorAll("[data-bingo-buzz]").forEach(btn => {
      btn.addEventListener("pointerdown", async (event) => {
        event.preventDefault();
        if (isControllerPlayer() || isCohost()) return;
        const bState = getBingo();
        const payload = { litIndex: bState.currentLitIndex, litSlot: bState.currentLitSlot };
        try {
          const result = await RPC.call("bingo-buzz", payload, RPC.Mode.HOST);
          if (result?.ok === false && result?.reason) setBuzzNotice(result.reason);
          else if (result?.message) setBuzzNotice(result.message);
          render();
        } catch {
          setBuzzNotice(getSnark("player.buzzer.buzzSendFailedShort", "Could not send buzz."));
          render();
        }
      });
    });

    app.querySelectorAll("[data-f-you-close]").forEach((button) => {
      button.addEventListener("click", () => {
        fYouEasterEggUnlocked = false;
        render();
      });
    });

    // Dis or Dat — host setup and control (host-only)
    app.querySelectorAll("#disordat-dis-label").forEach(input => {
      input.addEventListener("change", () => {
        if (!isHost()) return;
        setState("disordat", { ...getDisOrDat(), disLabel: String(input.value || "").trim() }, true);
      });
    });
    app.querySelectorAll("#disordat-dat-label").forEach(input => {
      input.addEventListener("change", () => {
        if (!isHost()) return;
        setState("disordat", { ...getDisOrDat(), datLabel: String(input.value || "").trim() }, true);
      });
    });
    app.querySelectorAll("[data-disordat-answer-chip]").forEach(button => {
      button.addEventListener("click", () => {
        if (!isHost()) return;
        const q = Number(button.dataset.q);
        if (!Number.isInteger(q) || q < 0 || q >= DIS_OR_DAT_QUESTION_COUNT) return;
        const dd = getDisOrDat();
        const answers = [...dd.answers];
        answers[q] = button.dataset.answer;
        setState("disordat", { ...dd, answers }, true);
        render();
      });
    });
    app.querySelectorAll("[data-disordat-start]").forEach(button => {
      button.addEventListener("click", () => {
        if (!isHost()) return;
        const mode = button.dataset.disordatStart;
        if (mode === "onePlayTimed") {
          setState("disordat", { ...getDisOrDat(), mode, pendingPick: true }, true);
          render();
        } else {
          startDisOrDat(mode);
        }
      });
    });
    app.querySelectorAll("[data-disordat-pick-player]").forEach(button => {
      button.addEventListener("click", () => {
        if (!isHost()) return;
        startDisOrDat("onePlayTimed", button.dataset.disordatPickPlayer);
      });
    });
    app.querySelectorAll("[data-disordat-next]").forEach(button => {
      button.addEventListener("click", () => nextDisOrDatQuestion());
    });
    app.querySelectorAll("[data-disordat-end]").forEach(button => {
      button.addEventListener("click", () => endDisOrDat());
    });
    app.querySelectorAll("[data-disordat-reset]").forEach(button => {
      button.addEventListener("click", () => resetDisOrDat());
    });
    app.querySelectorAll("[data-disordat-exit]").forEach(button => {
      button.addEventListener("click", () => exitDisOrDat());
    });

    // Dis or Dat — player answer
    app.querySelectorAll("[data-disordat-answer]").forEach(button => {
      button.addEventListener("click", async () => {
        if (isControllerPlayer() || isCohost()) return;
        const q = Number(button.dataset.q);
        const answer = button.dataset.answer;
        try {
          const result = await RPC.call("disordat-answer", { q, answer }, RPC.Mode.HOST);
          if (result?.ok === false && result?.reason) setBuzzNotice(result.reason);
          else if (result?.message) setBuzzNotice(result.message);
          disOrDatRevealUntil = now() + DIS_OR_DAT_REVEAL_MS;
          render();
          setTimeout(() => render(), DIS_OR_DAT_REVEAL_MS + 30);
        } catch {
          setBuzzNotice(getSnark("player.disdat.answerSendFailed", "Could not send answer."));
          render();
        }
      });
    });

  if (!rouletteKeydownBound) {
    document.addEventListener("keydown", handleRouletteKeydown);
    rouletteKeydownBound = true;
  }
}


// =============================================================================
// Space bar stops the roulette for players who are allowed to stop it
// =============================================================================
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

// Player submits their roulette stop (locks in current value)
function submitRouletteStop() {
  if (isControllerPlayer() || isCohost()) {
    return;
  }

  const round = getRound();
  const roulette = round.roulette;
  if (round.status !== ROUND_STATUSES.ROULETTE || !roulette?.active) {
    return;
  }
  if (!isRoulettePlayerAllowed(roulette, me().id)) {
    setBuzzNotice(getSnark("player.roulette.cannotStop", "You cannot stop this pick-a-value."));
    render();
    return;
  }
  if (Array.isArray(roulette.completedPlayerIds) && roulette.completedPlayerIds.includes(me().id)) {
    setBuzzNotice(getSnark("player.roulette.alreadyLocked", "You already locked in your value."));
    render();
    return;
  }

  RPC.call("roulette-stop", {}, RPC.Mode.HOST)
    .then((result) => {
      if (result?.ok === false) {
        setBuzzNotice(result.reason || getSnark("player.roulette.stopBlocked", "Pick-a-value stop blocked."));
      } else if (result?.message) {
        setBuzzNotice(result.message);
      } else {
        setBuzzNotice(getSnark("player.roulette.lockedIn", "Pick-a-value locked in."));
      }
      render();
    })
    .catch(() => {
      setBuzzNotice(getSnark("player.roulette.sendFailed", "Could not send pick-a-value stop. Check connection/room."));
      render();
    });
}
// =============================================================================
// Returns true when the user is focused on an input (to ignore space key)
// =============================================================================
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

// =============================================================================
// Pre-join / landing screen — three flows: host, join, or audience display
// =============================================================================
function getSavedPlayerName() {
  return localStorage.getItem(NAME_KEY) || "";
}

function getPrejoinNameDraft() {
  const draft = app.querySelector("#prejoin-name")?.value?.trim() || "";
  return draft || getSavedPlayerName();
}

// Render the correct pre-join form (landing / host / join / display)
function renderPrejoinScreen(mode = "landing", error = "") {
  prejoinMode = mode;
  // Ensure the site footer is visible while on the prejoin screens
  try {
    document.querySelector('.site-footer')?.classList.remove('hidden');
  } catch (e) {}
  const savedName = getPrejoinNameDraft();

  if (mode === "host") {
    const isAlliance = hostPrejoinTeamSetting === "alliance";
    const isShared = hostPrejoinTeamSetting === "shared";
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

            <label>
              Team setup
              <select data-prejoin-input id="prejoin-team-mode">
                <option value="off" ${!isAlliance && !isShared ? "selected" : ""}>Off (free-for-all)</option>
                <option value="alliance" ${isAlliance ? "selected" : ""}>Alliance mode (individual buzzers + summed team score)</option>
                <option value="shared" ${isShared ? "selected" : ""}>Team mode (shared team buzzer + team score)</option>
              </select>
            </label>

            ${error ? `<p class="error-text">${escapeHtml(error)}</p>` : ""}

            <div class="prejoin-actions">
              <button class="primary-action" type="submit">Host Game</button>
              <button class="secondary-action" data-prejoin-switch="cohost" type="button">Cohost Instead</button>
              <button class="secondary-action" data-prejoin-switch="join" type="button">Join Instead</button>
            </div>
          </form>
        </section>
      </main>
    `;
  } else if (mode === "cohost") {
    app.innerHTML = `
      <main class="prejoin-layout">
        <section class="card prejoin-panel prejoin-panel-join">
          <div class="prejoin-header">
            <button class="prejoin-back" data-prejoin-back type="button">Back</button>
            <div>
              <p class="prejoin-kicker">Co-host game</p>
              <h1>Enter room code &amp; password</h1>
              <p class="muted">Ask the host for the room code and the 5-digit co-host password.</p>
            </div>
          </div>

          <form class="prejoin-form" data-prejoin-form="cohost">
            <label>
              Your name
              <input data-prejoin-input id="prejoin-name" type="text" maxlength="32" value="${escapeHtml(savedName)}" placeholder="Your name" />
            </label>

            <label>
              Room code
              <input data-prejoin-input id="prejoin-room-code" type="text" maxlength="4" placeholder="XXXX" />
            </label>

            <label>
              Co-host password
              <input data-prejoin-input id="prejoin-cohost-password" type="text" maxlength="5" placeholder="12345" />
            </label>

            ${error ? `<p class="error-text">${escapeHtml(error)}</p>` : ""}

            <div class="prejoin-actions">
              <button class="primary-action" type="submit">Join as Co-host</button>
              <button class="secondary-action" data-prejoin-switch="host" type="button">Host Instead</button>
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
              <input data-prejoin-input id="prejoin-room-code" type="text" maxlength="4" placeholder="XXXX" />
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
  } else if (mode === "display") {
    app.innerHTML = `
      <main class="prejoin-layout">
        <section class="card prejoin-panel prejoin-panel-display">
          <div class="prejoin-header">
            <button class="prejoin-back" data-prejoin-back type="button">Back</button>
            <div>
              <p class="prejoin-kicker">Audience display</p>
              <h1>Open the display screen</h1>
              <p class="muted">Enter the room code for the show screen you want to project.</p>
            </div>
          </div>

          <form class="prejoin-form" data-prejoin-form="display">
            <label>
              Room code
              <input data-prejoin-input id="prejoin-room-code" type="text" maxlength="4" placeholder="XXXX" />
            </label>

            ${error ? `<p class="error-text">${escapeHtml(error)}</p>` : ""}

            <div class="prejoin-actions">
              <button class="primary-action" type="submit">Open Display</button>
              <button class="secondary-action" data-prejoin-switch="tablet_timer" type="button">Timer Display Instead</button>
              <button class="secondary-action" data-prejoin-switch="landing" type="button">Back</button>
            </div>
          </form>
        </section>
      </main>
    `;
  } else if (mode === "tablet_timer") {
    app.innerHTML = `
      <main class="prejoin-layout">
        <section class="card prejoin-panel prejoin-panel-display">
          <div class="prejoin-header">
            <button class="prejoin-back" data-prejoin-back type="button">Back</button>
            <div>
              <p class="prejoin-kicker">Tablet Timer Display</p>
              <h1>Open the timer display</h1>
              <p class="muted">Enter the room code to show a full-screen timer with buzz count.</p>
            </div>
          </div>

          <form class="prejoin-form" data-prejoin-form="tablet_timer">
            <label>
              Room code
              <input data-prejoin-input id="prejoin-room-code" type="text" maxlength="4" placeholder="XXXX" />
            </label>

            ${error ? `<p class="error-text">${escapeHtml(error)}</p>` : ""}

            <div class="prejoin-actions">
              <button class="primary-action" type="submit">Open Timer Display</button>
              <button class="secondary-action" data-prejoin-switch="display" type="button">Display Instead</button>
              <button class="secondary-action" data-prejoin-switch="landing" type="button">Back</button>
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
            <p class="prejoin-kicker">Instant Buzzers</p>
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
              <span class="muted">Enter a room code and play.</span>
            </button>
            <button class="prejoin-choice" data-prejoin-open="display" type="button">
              <span class="prejoin-choice-label">Audience display</span>
              <span class="muted">Show the live buzzer board beside a slide deck.</span>
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
      const teamModeInput = app.querySelector("#prejoin-team-mode");

      const chosenName = nameInput?.value?.trim() || "";
      const roomCode = roomInput?.value?.trim()?.toUpperCase() || "";
      const cohostPasswordInput = app.querySelector("#prejoin-cohost-password");
      const cohostPassword = cohostPasswordInput?.value?.trim() || "";

      if (mode !== "display" && mode !== "tablet_timer" && !chosenName) {
        renderPrejoinScreen(mode || "landing", "Please choose a player name.");
        return;
      }

      if ((mode === "join" || mode === "cohost") && !roomCode) {
        renderPrejoinScreen(mode, "Enter a room code to join.");
        return;
      }

      if (mode === "display" && !roomCode) {
        renderPrejoinScreen("display", "Enter a room code for the display.");
        return;
      }

      if (mode === "tablet_timer" && !roomCode) {
        renderPrejoinScreen("tablet_timer", "Enter a room code for the timer display.");
        return;
      }

      if (mode === "cohost") {
        if (!/^\d{5}$/.test(cohostPassword)) {
          renderPrejoinScreen("cohost", "Enter a valid 5-digit co-host password.");
          return;
        }
      }

      if (mode !== "display" && mode !== "tablet_timer") {
        localStorage.setItem(NAME_KEY, chosenName);
      }

      if (mode === "host") {
        const selectedTeamSetting = String(teamModeInput?.value || "off");
        hostPrejoinTeamSetting = selectedTeamSetting === "shared" ? "shared" : selectedTeamSetting === "alliance" ? "alliance" : "off";
      }

      const submitButton = form.querySelector("button[type='submit']");
      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = true;
      }

      await launchGame({
        playerName: mode === "display" ? "Audience Display" : mode === "tablet_timer" ? "Tablet Timer" : chosenName,
        roomCode: mode === "join" || mode === "display" || mode === "tablet_timer" || mode === "cohost" ? roomCode : undefined,
        clientMode: mode === "display" ? "display" : mode === "tablet_timer" ? "tablet_timer" : "player",
        cohostPassword: mode === "cohost" ? cohostPassword : undefined,
      });
    });
  });
}

// =============================================================================
// Claim co-host status by sending the password to the host via RPC
// =============================================================================
async function claimCohost(password, maxRetries = 15) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await RPC.call("claim-cohost", { password }, RPC.Mode.HOST);
      if (result?.ok) return true;
    } catch {
      // host may not be ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// =============================================================================
// Game launch — insert coin into PlayroomKit, register RPC handlers, start loops
// =============================================================================
async function launchGame({ playerName, roomCode, clientMode: nextClientMode = "player", cohostPassword: joinCohostPassword }) {
  if (gameLaunched) {
    return;
  }

  clientMode = nextClientMode;

  // Clear any stale room code from the URL hash. PlayroomKit always prioritises
  // the hash "r" parameter over the roomCode option, so a leftover hash from a
  // previous session would make it attempt to join the old room instead of
  // creating a new one (host flow) or joining the intended room (join flow).
  history.replaceState(null, "", window.location.pathname + window.location.search);

  try {
    const insertCoinOptions = {
      skipLobby: true,
      maxPlayersPerRoom: 42,
    };
    if (clientMode === "display" || clientMode === "tablet_timer") {
      insertCoinOptions.clientMode = "display";
    }
    if (roomCode) {
      insertCoinOptions.roomCode = roomCode;
    }
    await insertCoin(insertCoinOptions);
  } catch {
    renderPrejoinScreen(prejoinMode, "Could not connect to Playroom. Try again.");
    return;
  }

  gameLaunched = true;

  // Hide the site footer once the game launches
  try {
    document.querySelector('.site-footer')?.classList.add('hidden');
  } catch (e) {}

  me().setState("displayName", playerName, true);
  me().setState("clientMode", clientMode, true);
  if (clientMode === "display" || clientMode === "tablet_timer") {
    me().setState("isAudienceDisplay", true, true);
  }

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
      return { ok: false, reason: getSnark("player.roulette.notActive", "Pick-a-value is not active.") };
    }
    if (!isRoulettePlayerAllowed(roulette, senderPlayer.id)) {
      return { ok: false, reason: getSnark("player.roulette.cannotStop", "You cannot stop this pick-a-value.") };
    }
    if (Array.isArray(roulette.completedPlayerIds) && roulette.completedPlayerIds.includes(senderPlayer.id)) {
      return { ok: false, reason: getSnark("player.roulette.alreadyLockedShort", "You already locked in.") };
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
      return { ok: true, message: getSnark("player.roulette.lockedValue", `${getPlayerName(senderPlayer)} locked in ${frame.value}.`, { player: getPlayerName(senderPlayer), value: frame.value }) };
    }

    render();
    return { ok: true, message: getSnark("player.roulette.lockedValue", `${getPlayerName(senderPlayer)} locked in ${frame.value}.`, { player: getPlayerName(senderPlayer), value: frame.value }) };
  });

  RPC.register("bingo-buzz", async (payload, senderPlayer) => {
    if (!isHost()) return { ok: false, reason: "Not host" };
    return handleBingoBuzz(senderPlayer, payload);
  });

  RPC.register("disordat-answer", async (payload, senderPlayer) => {
    if (!isHost()) return { ok: false, reason: "Not host" };
    return handleDisOrDatAnswer(senderPlayer, payload);
  });

  RPC.register("select-team", async (payload, senderPlayer) => {
    if (!isHost()) {
      return { ok: false, reason: "Not host" };
    }
    const teamColor = payload?.teamColor ? String(payload.teamColor) : "";
    return handleSelectTeam(senderPlayer, teamColor || null);
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
      return { ok: false, reason: getSnark("player.screw.noScrewInProgress", "No screw in progress") };
    }
    return selectScrewee(screweeId);
  });

  RPC.register("claim-cohost", async (payload, senderPlayer) => {
    if (!isHost()) {
      return { ok: false, reason: "Not host" };
    }
    const storedPassword = getSafeState("cohostPassword", "");
    if (payload?.password === storedPassword) {
      const current = getSafeState("cohostIds", []);
      if (!Array.isArray(current) || !current.includes(senderPlayer.id)) {
        setState("cohostIds", Array.isArray(current) ? [...current, senderPlayer.id] : [senderPlayer.id], true);
        render();
      }
      return { ok: true };
    }
    return { ok: false, reason: "Invalid co-host password." };
  });

  // Co-host actions RPC — relays co-host UI actions through the host
  const HOST_ACTIONS = {
    openBuzzers, closeBuzzers, resetRound, resetScrews,
    startRoulettePhase, startScrewTimer, closeScrewMode,
    startBingo, endBingo, setBingoTarget, startBingoCycling, stopBingoCycling,
    setHostSetting, toggleBuzzerOption, togglePlayerBuzzer,
    setPlayerTeam, randomizeTeams,
    openTeamSelect, closeTeamSelect, setTeamSelectLocked, setTeamSelectTeams, setTeamSelectLimit,
    updateScoresForLogEntry,
    setCorrectAnswerValue, clearCorrectAnswerValue, toggleCorrectOption,
  };
  RPC.register("cohost-action", async (payload, _senderPlayer) => {
    if (!isHost()) return { ok: false };
    const { fn, args } = payload || {};
    if (HOST_ACTIONS[fn]) {
      HOST_ACTIONS[fn](...(args || []));
      render();
      return { ok: true };
    }
    return { ok: false, reason: "Unknown action" };
  });

  ensureHostInit();

  if (joinCohostPassword) {
    claimCohost(joinCohostPassword).then((ok) => {
      if (!ok) {
        setBuzzNotice("Could not verify co-host password.");
      }
      render();
    });
  }
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

  // Fast re-render interval for audience display (no interaction, shows live timer)
  setInterval(() => {
    if (!isAudienceDisplayClient()) return;
    render();
  }, 25);

  // Bingo mode re-render — only fires when the bingo state actually changes,
  // so the host (and everyone else) stops re-rendering on a fixed 50ms tick.
  setInterval(() => {
    if (!isBingoMode()) return;
    const b = getBingo();
    const key = `${b.active}|${b.cycling}|${b.currentLitIndex}|${b.currentLitSlot}|${b.targetIndex}|${JSON.stringify(b.items)}|${JSON.stringify(b.itemStates)}|${JSON.stringify(b.playerItems || {})}|${JSON.stringify(b.collectedCounts || {})}|${b.winner || ""}`;
    if (key === lastBingoRenderKey) return;
    lastBingoRenderKey = key;
    render();
  }, BINGO_RENDER_INTERVAL_MS);
}

// =============================================================================
// Entry point — show the landing screen
// =============================================================================
function boot() {
  renderPrejoinScreen();
}


boot();
