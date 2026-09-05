// =============================================================================
// Instant Buzzers — a multiplayer buzzer system built on PlayroomKit
// =============================================================================

import "./style.css";
import { RPC, getParticipants, getRoomCode, getState, insertCoin, isHost, me, setState } from "playroomkit";
import SNARK from "./snark.json";
import { scheduleRender, renderImmediate, initRenderer, delegate, getApp, computeAudienceTimerFrozenCs, showToast, trackScoreSnapshot, applyScoreDeltas, startSmoothTimer, transitionMount } from "./render.js";

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
  coopertitionEnabled: false,
  coopAllowEdit: false,
  disabledCoopSlots: [],
  bingoAlternateViewers: false,
  bingoLessRandom: true,
  bingoAllowMultipleCorrect: false,
  snarkMode: "off",
  disOrDatTimedSeconds: 30,
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
const DIS_OR_DAT_TIMED_OPTIONS = [30, 40];

const FIBBAGE_TIMES = [30, 45, 60];
const FIBBAGE_FOOL_POINTS = 500;
const FIBBAGE_TRUTH_POINTS = 1000;
const FIBBAGE_MAX_MULT = 5;

const VALUE_OPTIONS = Array.from({ length: 20 }, (_, index) => (index + 1) * 500);

const app = document.querySelector("#app") || document.getElementById("app");
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
let hostPrejoinCoopSetting = false;
let bingoCycleInterval = null;
let bingoCycleQueue = [];
let lastBingoRenderKey = "";
let audienceTimerFrozenCs = null;
let disOrDatRevealUntil = 0;
let lastAudienceParticipantCount = 0;
let audienceJoinRefreshTimeout = null;
let coopKeydownBound = false;
let coopTextSlot = 0;
let coopEditing = false;
const COOP_COUNT_KEY = "buzzer_coop_count";
const COOP_NAMES_KEY = "buzzer_coop_names";

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
  // Feature 1: also surface as toast (limit 3 handled in render.js)
  try { if (message) showToast(message, { ttlMs: 3500, variant: "info" }); } catch {}
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
  return out.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? escapeHtml(String(vars[key])) : match));
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

// =============================================================================
// Coopertition mode — up to 3 sub-players per device, each with their own
// score key (coop:{deviceId}:{slot}). 1-slot devices keep the legacy pid key.
// =============================================================================
function isCoopMode(settings = getSettings()) {
  return Boolean(settings.coopertitionEnabled);
}

function getCoopRosters() {
  return getSafeState("coopRosters", {});
}

function getCoopRoster(deviceId) {
  const rosters = getCoopRosters();
  const roster = rosters?.[deviceId];
  if (!roster || !Array.isArray(roster.slots)) return null;
  return roster;
}

function getMyCoopRoster() {
  const self = me();
  if (!self?.id) return null;
  return getCoopRoster(self.id);
}

function getCoopSlotCount(deviceId) {
  const roster = getCoopRoster(deviceId);
  if (!roster) return 1;
  return clamp(roster.slots.length, 1, 3);
}

function getCoopGroupName(deviceId, fallback = "") {
  const roster = getCoopRoster(deviceId);
  const group = roster?.group;
  if (typeof group === "string" && group.trim()) return group.trim();
  return fallback;
}

// Individual sub-player name. Single-slot devices just use the group name.
function getCoopSlotName(deviceId, slot, fallbackGroup = "") {
  const count = getCoopSlotCount(deviceId);
  const group = getCoopGroupName(deviceId, fallbackGroup);
  if (count <= 1) return group || fallbackGroup || "Player 1";
  const roster = getCoopRoster(deviceId);
  const name = roster?.slots?.[slot];
  if (typeof name === "string" && name.trim()) return name.trim();
  return `Player ${slot + 1}`;
}

function getCoopScoreKey(deviceId, slot) {
  if (getCoopSlotCount(deviceId) <= 1 && slot === 0) return deviceId;
  return `coop:${deviceId}:${slot}`;
}

function isCoopScoreKey(key) {
  return typeof key === "string" && key.startsWith("coop:");
}

function parseCoopScoreKey(key) {
  if (!isCoopScoreKey(key)) return null;
  const rest = key.slice("coop:".length);
  const sep = rest.lastIndexOf(":");
  if (sep < 0) return null;
  const deviceId = rest.slice(0, sep);
  const slot = Number(rest.slice(sep + 1));
  if (!deviceId || !Number.isInteger(slot) || slot < 0 || slot > 2) return null;
  return { deviceId, slot };
}

// A score key whose slot no longer exists on the device (device shrank).
// Its points stay on the board (frozen) but it can never buzz again.
function isCoopSlotFrozen(deviceId, slot) {
  if (!isCoopMode()) return false;
  const count = getCoopSlotCount(deviceId);
  return slot >= count;
}

function getCoopGroupTotal(deviceId, scores = getScores()) {
  const count = getCoopSlotCount(deviceId);
  let total = 0;
  for (let slot = 0; slot < 3; slot++) {
    const key = slot < count ? getCoopScoreKey(deviceId, slot) : `coop:${deviceId}:${slot}`;
    total += Number(scores[key] || 0);
  }
  return total;
}

function getCoopMoods() {
  return getSafeState("coopMoods", {});
}

function normalizeDisabledCoopSlots(disabledSlots, players) {
  const validDevices = new Set(players.map((p) => p.id));
  return [...new Set((disabledSlots || []).filter((key) => {
    const parsed = parseCoopScoreKey(key);
    return parsed && validDevices.has(parsed.deviceId);
  }))];
}

function isCoopSlotMuted(settings, deviceId, slot) {
  const key = `coop:${deviceId}:${slot}`;
  const list = normalizeDisabledCoopSlots(settings.disabledCoopSlots, currentParticipants());
  return list.includes(key);
}

// Score key for a device slot in any mode: coop key when coop is on,
// otherwise the legacy team/player mapping.
function getScoreKeyForSlot(deviceId, slot, settings = getSettings(), assignments = getTeamAssignments()) {
  if (isCoopMode(settings)) return getCoopScoreKey(deviceId, slot);
  return getScoreKeyForPlayer(deviceId, settings, assignments);
}

// Track key for bingo/disordat responses. Shared-team mode is blocked in
// coop, so coop tracks are always per-slot.
function getCoopTrackKey(deviceId, slot, settings = getSettings(), assignments = getTeamAssignments()) {
  if (isCoopMode(settings)) return getCoopScoreKey(deviceId, slot);
  return getTeamTrackKey(deviceId, settings, assignments);
}

// Display name of the slot currently holding Jeopardy control ("").
function getCoopControlName(round) {
  const parsed = parseCoopScoreKey(round?.coopControl);
  if (!parsed) return "";
  return getCoopSlotName(parsed.deviceId, parsed.slot);
}

// Q/B/P keyboard mapping: 2 players -> Q,P. 3 players -> Q,B,P.
function getCoopSlotForCode(code, slotCount) {
  if (slotCount <= 1) return 0;
  if (slotCount === 2) {
    if (code === "KeyQ") return 0;
    if (code === "KeyP") return 1;
    return null;
  }
  if (code === "KeyQ") return 0;
  if (code === "KeyB") return 1;
  if (code === "KeyP") return 2;
  return null;
}

function getCoopKeyHint(slot, slotCount) {
  if (slotCount <= 1) return "";
  if (slotCount === 2) return slot === 0 ? "Q" : "P";
  return ["Q", "B", "P"][slot] || "";
}

function isMobileDevice() {
  try {
    if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches && window.matchMedia("(max-width: 820px)").matches) return true;
    if (typeof window.ontouchstart !== "undefined" && window.innerWidth <= 820 && !window.matchMedia("(pointer: fine)").matches) return true;
  } catch {}
  return false;
}

function getSavedCoopCount() {
  const n = Number(localStorage.getItem(COOP_COUNT_KEY));
  return n >= 1 && n <= 3 ? n : 1;
}

function getSavedCoopNames() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COOP_NAMES_KEY) || "[]");
    if (Array.isArray(parsed)) return parsed.map((n) => String(n || "").slice(0, 32));
  } catch {}
  return [];
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
  const devices = currentParticipants().filter(
    (p) =>
      p.id !== controllerId &&
      !(Array.isArray(cohostIds) && cohostIds.includes(p.id)) &&
      isPlayerBuzzerEnabled(settings, p.id)
  );
  if (!isCoopMode(settings)) return devices.map((p) => p.id);
  // Coop: one entry per live slot (frozen removals and muted slots excluded).
  const ids = [];
  devices.forEach((p) => {
    const count = getCoopSlotCount(p.id);
    for (let slot = 0; slot < count; slot++) {
      if (!isCoopSlotMuted(settings, p.id, slot)) ids.push(getCoopScoreKey(p.id, slot));
    }
  });
  return ids;
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
    // Coopertition Jeopardy control: score key of the slot that buzzed in
    // first this round (null until someone buzzes). Only that slot's options
    // unlock; cleared whenever buzzers open/close/reset.
    coopControl: null,
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

// =============================================================================
// Rank badge images — if /public holds 1.png, 2.png, 3.png (or jpg/jpeg/webp/
// gif/svg/avif), show them next to the top 3 entries on the scoreboard.
// =============================================================================
const RANK_BADGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif"];
const rankBadgeUrls = { 1: null, 2: null, 3: null };
let rankBadgesProbed = false;

function probeRankBadges() {
  if (rankBadgesProbed) {
    return;
  }
  rankBadgesProbed = true;
  [1, 2, 3].forEach((rank) => probeRankBadgeCandidates(rank, 0));
}

function probeRankBadgeCandidates(rank, index) {
  if (index >= RANK_BADGE_EXTENSIONS.length) {
    return;
  }
  const url = `/${rank}.${RANK_BADGE_EXTENSIONS[index]}`;
  const img = new Image();
  img.onload = () => {
    rankBadgeUrls[rank] = url;
    if (gameLaunched) {
      render();
    }
  };
  img.onerror = () => probeRankBadgeCandidates(rank, index + 1);
  img.src = url;
}

function getRankBadgeHtml(rank) {
  const url = rankBadgeUrls[rank];
  return url ? `<img class="rank-badge" src="${url}" alt="${rank}" loading="lazy" />` : "";
}

// =============================================================================
// Coopertition character art — /public holds per-slot images using the same
// extensions as rank badges. Naming: 1.png (base/idle), 1-buzz.*, 1-dance.*,
// 1-correct.*, 1-wrong.* (slots 1..3). Correct/wrong should be horizontal
// spritesheets with square frames (frame count auto-detected); plain GIFs are
// accepted as fallback but loop instead of freezing. See public/avatars.md.
// =============================================================================
const COOP_CHAR_STATES = ["base", "buzz", "dance", "correct", "wrong"];
const coopCharUrls = { 1: { base: null, buzz: null, dance: null, correct: null, wrong: null }, 2: { base: null, buzz: null, dance: null, correct: null, wrong: null }, 3: { base: null, buzz: null, dance: null, correct: null, wrong: null } };
const coopCharFrames = { 1: { correct: 0, wrong: 0 }, 2: { correct: 0, wrong: 0 }, 3: { correct: 0, wrong: 0 } };
let coopCharsProbed = false;

function coopCharFileBase(slot, state) {
  return state === "base" ? `/${slot}` : `/${slot}-${state}`;
}

function probeCoopChars() {
  if (coopCharsProbed) return;
  coopCharsProbed = true;
  [1, 2, 3].forEach((slot) => {
    COOP_CHAR_STATES.forEach((state) => probeCoopCharCandidates(slot, state, 0));
  });
}

function probeCoopCharCandidates(slot, state, index) {
  if (index >= RANK_BADGE_EXTENSIONS.length) return;
  const url = `${coopCharFileBase(slot, state)}.${RANK_BADGE_EXTENSIONS[index]}`;
  const img = new Image();
  img.onload = () => {
    coopCharUrls[slot][state] = url;
    if ((state === "correct" || state === "wrong") && img.naturalHeight > 0 && img.naturalWidth > img.naturalHeight) {
      coopCharFrames[slot][state] = Math.max(1, Math.round(img.naturalWidth / img.naturalHeight));
    }
    if (gameLaunched) render();
  };
  img.onerror = () => probeCoopCharCandidates(slot, state, index + 1);
  img.src = url;
}

function getCoopCharMoodForKey(scoreKey, round) {
  // Audience/tablet displays stay idle 24/7 — faces are player/host only.
  try { if (isAudienceDisplayClient()) return "idle"; } catch {}
  const moods = getCoopMoods();
  const mood = moods?.[scoreKey];
  if (mood === "correct" || mood === "wrong") {
    // The active pick-a-value dancer wins over a stored face during roulette.
    if (round?.status === ROUND_STATUSES.ROULETTE && round?.roulette?.active) {
      const rep = getRouletteRepForDevice(round.roulette, scoreKey);
      if (rep) return "dance";
    }
    return mood;
  }
  if (round?.status === ROUND_STATUSES.ROULETTE && round?.roulette?.active) {
    const rep = getRouletteRepForDevice(round.roulette, scoreKey);
    if (rep) return "dance";
  }
  if ((round?.buzzedPlayerIds || []).includes(scoreKey)) return "buzz";
  return "idle";
}

// Returns avatar HTML for a coop slot (1-based character number = slot+1).
// Spritesheet moods (correct/wrong) render as stepped background divs that
// freeze on the final frame; plain images render as <img>.
function getCoopCharHtml(slot, mood = "idle", extraClass = "") {
  const charNum = clamp(slot + 1, 1, 3);
  const entry = coopCharUrls[charNum] || {};
  const want = mood === "correct" || mood === "wrong" ? mood : mood === "buzz" || mood === "dance" ? mood : "base";
  const url = entry[want] || entry.base;
  if (!url) return "";
  const cls = `coop-avatar coop-avatar-${want} ${extraClass}`.trim();
  if ((want === "correct" || want === "wrong") && coopCharFrames[charNum][want] > 1) {
    const frames = coopCharFrames[charNum][want];
    return `<span class="${cls} coop-avatar-strip" style="background-image:url('${url}');--coop-frames:${frames}" role="img" aria-label="player ${charNum} ${want}"></span>`;
  }
  return `<img class="${cls}" src="${url}" alt="player ${charNum}" loading="lazy" />`;
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

function isFibbageMode() {
  return getSettings().inputMode === "fibbage";
}

function hasAudienceDisplay() {
  try {
    const parts = Object.values(getParticipants() || {});
    return parts.some((p) => p?.getState?.("isAudienceDisplay") === true || p?.getState?.("clientMode") === "display" || p?.getState?.("clientMode") === "tablet_timer");
  } catch { return false; }
}

function shouldHideFibbageScores() {
  if (!isFibbageMode()) return false;
  const fb = getFibbage();
  return fb.active && ["lying","review","voting_ready","voting","results"].includes(fb.phase);
}

function freshFibbageState() {
  return {
    active: false,
    phase: "setup",
    truth: "",
    lieTimeSec: 30,
    voteTimeSec: 30,
    multiplier: 1,
    timeEndsAt: null,
    voteEndsAt: null,
    seed: null,
    lies: {},
    blocked: {},
    lieErrors: {},
    choices: [],
    votes: {},
    revealed: { all: false, singleIdx: null, revealedIdxs: [] },
    pointsEarned: {},
  };
}

function getFibbage() {
  return getSafeState("fibbage", freshFibbageState());
}

function getFibbageLieTimeLeftCs(fb) {
  if (!fb?.timeEndsAt) return (fb?.lieTimeSec || 30) * 100;
  return Math.max(0, Math.ceil((fb.timeEndsAt - now()) / 10));
}

function getFibbageVoteTimeLeftCs(fb) {
  if (!fb?.voteEndsAt) return (fb?.voteTimeSec || 30) * 100;
  return Math.max(0, Math.ceil((fb.voteEndsAt - now()) / 10));
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
    timedSeconds: 30,
  };
}

function getDisOrDat() {
  return getSafeState("disordat", freshDisOrDatState());
}

function getDisOrDatTimeLeftCs(dd) {
  if (!dd?.timeEndsAt) {
    const settings = getSettings();
    const timedSeconds = settings.disOrDatTimedSeconds || DIS_OR_DAT_TIMED_SECONDS;
    return timedSeconds * 100;
  }
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
  return me()?.id === getControllerId();
}

function isPlayerExcluded(playerId) {
  if (playerId === getControllerId()) return true;
  const cohostIds = getSafeState("cohostIds", []);
  return Array.isArray(cohostIds) && cohostIds.includes(playerId);
}

function isCohost() {
  const cohostIds = getSafeState("cohostIds", []);
  return Array.isArray(cohostIds) && cohostIds.includes(me()?.id);
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

// Authorization — check if a given player can buzz for a given option.
// playerId may be a legacy participant id or a coop composite key
// (coop:{deviceId}:{slot}); all downstream bookkeeping uses the key as-is.
// =============================================================================
function canBuzz(playerId, option) {
  const round = getRound();
  const controllerId = getControllerId();
  const settings = getSettings();
  const participants = currentParticipants();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), participants, controllerId);
  // Resolve coop composite keys to their owning device.
  let deviceId = playerId;
  let slot = 0;
  let isCoopKey = false;
  const parsed = parseCoopScoreKey(playerId);
  if (parsed) {
    deviceId = parsed.deviceId;
    slot = parsed.slot;
    isCoopKey = true;
  }
  if (deviceId === controllerId) {
    return false;
  }
  const cohostIds = getSafeState("cohostIds", []);
  if (Array.isArray(cohostIds) && cohostIds.includes(deviceId)) {
    return false;
  }
  if (settings.teamModeEnabled && !getPlayerTeamColor(deviceId, assignments)) {
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
  if (!settings.rebuzzAllowed && !isCoopMode(settings) && settings.teamModeEnabled && settings.teamScoringMode === "shared") {
    const teamMemberIds = getAllBuzzedTeamMemberIds(playerId, participants, assignments);
    if (teamMemberIds.some((memberId) => round.buzzedPlayerIds.includes(memberId))) {
      return false;
    }
  }
  // Coopertition: validate the slot (range, frozen removals, per-slot mutes).
  if (isCoopMode(settings)) {
    const count = getCoopSlotCount(deviceId);
    if (isCoopKey) {
      if (slot < 0 || slot >= count) return false;
      if (isCoopSlotFrozen(deviceId, slot)) return false;
      if (isCoopSlotMuted(settings, deviceId, slot)) return false;
    } else if (count > 1) {
      // Multi-slot devices must buzz with an explicit coop key.
      return false;
    }
  }
  if (!isPlayerBuzzerEnabled(settings, deviceId)) {
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
  // audience mirrors live timer
  document.querySelectorAll("[data-audience-time-left]").forEach((element) => {
    const ms = getScrewTimerMs(round);
    if (ms != null) {
      element.textContent = `${formatSeconds(Math.ceil(ms/10))}s`;
    } else if (round.screw.active) {
      element.textContent = "SCREW";
    } else {
      element.textContent = timeLeftText;
    }
  });
  // tablet mirrors live/screw
  document.querySelectorAll("[data-tablet-time-left]").forEach((element) => {
    const ms = getScrewTimerMs(round);
    if (ms != null) {
      element.textContent = `${formatSeconds(Math.ceil(ms/10))}s`;
    } else if (round.screw.active) {
      element.textContent = "SCREW";
    } else {
      element.textContent = timeLeftText;
    }
  });
  if (isDisOrDatMode()) {
    const ddText = `${formatSeconds(getDisOrDatTimeLeftCs(getDisOrDat()))}s`;
    document.querySelectorAll("[data-disordat-time-left]").forEach((element) => {
      element.textContent = ddText;
    });
  }
  if (isFibbageMode()) {
    const fb = getFibbage();
    if (fb.phase === "lying") {
      const t = `${formatSeconds(getFibbageLieTimeLeftCs(fb))}s`;
      document.querySelectorAll("[data-fibbage-time-left]").forEach((el) => { el.textContent = t; });
    } else if (fb.phase === "voting") {
      const t = `${formatSeconds(getFibbageVoteTimeLeftCs(fb))}s`;
      document.querySelectorAll("[data-fibbage-time-left]").forEach((el) => { el.textContent = t; });
    }
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
      winnerCoopKey: round.winnerCoopKey,
      winnerTeam: round.winnerTeam,
      winnerOption: round.winnerOption,
      winnerAnswer: round.winnerAnswer,
      winnerName: round.winnerName,
      coopControl: round.coopControl,
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
      coopertitionEnabled: settings.coopertitionEnabled,
      coopAllowEdit: settings.coopAllowEdit,
      disabledCoopSlots: settings.disabledCoopSlots,
      bingoAlternateViewers: settings.bingoAlternateViewers,
      bingoLessRandom: settings.bingoLessRandom,
      snarkMode: settings.snarkMode,
    },
    coopRosters: getCoopRosters(),
    coopMoods: getCoopMoods(),
    teamAssignments: normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId()),
    teamSelect: getTeamSelect(),
    pendingLogId,
    controllerId: getControllerId(),
    cohostIds: getSafeState("cohostIds", []),
    disordat: getDisOrDat(),
    fibbage: getFibbage(),
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
        coopLockout: b.coopLockout,
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
// Now uses scheduleRender and auto-cleans when roulette ends.
// =============================================================================
function startRouletteAnimationLoop() {
  if (rouletteAnimationInterval) {
    return;
  }
  rouletteAnimationInterval = setInterval(() => {
    if (getRound().status === ROUND_STATUSES.ROULETTE) {
      scheduleRender(render);
    } else {
      clearInterval(rouletteAnimationInterval);
      rouletteAnimationInterval = null;
    }
  }, 500);
}
function stopRouletteAnimationLoop() {
  if (rouletteAnimationInterval) {
    clearInterval(rouletteAnimationInterval);
    rouletteAnimationInterval = null;
  }
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

// Coopertition pick-a-value: each group fields one rep — the slot that most
// recently earned a correct buzz ruling (fallback slot 0). Stored per device.
function getCoopLastCorrect() {
  return getSafeState("coopLastCorrect", {});
}

function getCoopRepSlot(deviceId) {
  const stored = Number((getCoopLastCorrect() || {})[deviceId]);
  const count = getCoopSlotCount(deviceId);
  if (Number.isInteger(stored) && stored >= 0 && stored < count && !isCoopSlotFrozen(deviceId, stored)) return stored;
  return 0;
}

function getRouletteRepKeyForDevice(roulette, deviceId) {
  const map = roulette?.repCoopKeys || {};
  if (typeof map[deviceId] === "string" && map[deviceId]) return map[deviceId];
  return getCoopScoreKey(deviceId, getCoopRepSlot(deviceId));
}

// Truthy when the given score key (or device id) is its device's rep for
// this roulette phase. Used for dance faces + picker highlight.
function getRouletteRepForDevice(roulette, scoreKeyOrDeviceId) {
  if (!roulette) return null;
  if (isCoopScoreKey(scoreKeyOrDeviceId)) {
    const parsed = parseCoopScoreKey(scoreKeyOrDeviceId);
    if (!parsed) return null;
    const rep = getRouletteRepKeyForDevice(roulette, parsed.deviceId);
    return rep === scoreKeyOrDeviceId ? rep : null;
  }
  if (typeof scoreKeyOrDeviceId === "string" && scoreKeyOrDeviceId) {
    return getRouletteRepKeyForDevice(roulette, scoreKeyOrDeviceId);
  }
  return null;
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

  // Leaving pick-a-value drops coop faces back to idle.
  setState("coopMoods", {}, true);

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
  const repCoopKeys = {};
  if (isCoopMode(settings)) {
    players.forEach((player) => {
      repCoopKeys[player.id] = getCoopScoreKey(player.id, getCoopRepSlot(player.id));
    });
  }

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
        coopControl: null,
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
      coopControl: null,
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
        repCoopKeys,
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
  startRouletteAnimationLoop();
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
  // Coopertition: telegraph this device's rep (last-correct slot) with dance/highlight.
  let coopRepLine = "";
  if (isCoopMode(settings) && !isControllerPlayer() && !isCohost()) {
    const repKey = getRouletteRepKeyForDevice(roulette, mePlayer.id);
    const repSlot = parseCoopScoreKey(repKey)?.slot ?? 0;
    const repName = getCoopSlotName(mePlayer.id, repSlot, getPlayerName(mePlayer));
    coopRepLine = `
      <div class="coop-slot is-picker">
        <div class="coop-slot-head">${getCoopCharHtml(repSlot, getCoopCharMoodForKey(repKey, round))}<strong>${escapeHtml(repName)}</strong><span class="muted">${getSnark("player.coop.repStopsShort", "stops for your group")}</span></div>
      </div>`;
  }

  return `
    <section class="card player-card roulette-card">
      <h2>${getSnark("player.roulette.title", "Pick a Value")}</h2>
      <p class="muted">${modeLabel} mode · Top amount ${roulette.topAmount || normalizeRouletteTopAmount(settings.rouletteTopAmount)} · Ceiling ${roulette.ceiling || 0}</p>
      ${coopRepLine}
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

  // Coopertition faces + last-correct rep tracking. Faces are multiple-choice
  // only (option set); text corrects still advance the last-correct rep.
  try {
    if (isCoopMode(settings) && entry.type === "buzz" && nextAwarded > 0 && isCoopScoreKey(entryScoreKey)) {
      const parsedKey = parseCoopScoreKey(entryScoreKey);
      if (parsedKey) setState("coopLastCorrect", { ...getCoopLastCorrect(), [parsedKey.deviceId]: parsedKey.slot }, true);
    }
    if (isCoopMode(settings) && entry.type === "buzz" && entry.option !== null && entry.option !== undefined && isCoopScoreKey(entryScoreKey)) {
      if (nextAwarded > 0) {
        setState("coopMoods", { ...getCoopMoods(), [entryScoreKey]: "correct" }, true);
        // Correct plays once, then back to idle.
        setTimeout(() => {
          try {
            if (!isHost()) return;
            const cur = getCoopMoods();
            if (cur?.[entryScoreKey] === "correct") {
              const nextMoods = { ...cur };
              delete nextMoods[entryScoreKey];
              setState("coopMoods", nextMoods, true);
              render();
            }
          } catch {}
        }, 1500);
      } else if (nextAwarded < 0) {
        setState("coopMoods", { ...getCoopMoods(), [entryScoreKey]: "wrong" }, true);
      }
    }
  } catch {}

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
function pushBuzzLogEntry(player, { option = null, answerText = null, coopSlot = null, coopKey = null } = {}, timeLeftCs) {
  const settings = getSettings();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
  const teamColor = getPlayerTeamColor(player.id, assignments);
  let scoreKey = getScoreKeyForPlayer(player.id, settings, assignments);
  let displayName = getPlayerName(player);
  if (isCoopMode(settings) && coopKey) {
    scoreKey = coopKey;
    displayName = coopSlot !== null && coopSlot !== undefined
      ? getCoopSlotName(player.id, coopSlot, getPlayerName(player))
      : getCoopGroupName(player.id, getPlayerName(player));
  }
  const points = computeBasePoints(settings, timeLeftCs);
  const entry = {
    id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "buzz",
    ts: now(),
    playerId: player.id,
    playerName: displayName,
    teamColor,
    scoreKey,
    coopSlot,
    coopKey,
    scoreTarget: scoreKey.startsWith("team:") ? `Team ${teamColor}` : displayName,
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

  // Coopertition: resolve the buzzing slot → composite score key.
  let buzzKey = player.id;
  let coopSlot = null;
  const coopActive = isCoopMode(settings);
  if (coopActive) {
    const count = getCoopSlotCount(player.id);
    if (count > 1) {
      coopSlot = Number(payload?.coopSlot);
      if (!Number.isInteger(coopSlot) || coopSlot < 0 || coopSlot >= count) {
        // Shared-grid tap carries no slot: attribute to this device's
        // controlling slot (first player in takes the points).
        const ctrl = parseCoopScoreKey(round.coopControl);
        if (ctrl && ctrl.deviceId === player.id) {
          coopSlot = ctrl.slot;
        } else {
          return { ok: false, reason: getSnark("player.coop.unknownSlot", "Unknown player slot for this device.") };
        }
      }
      if (isCoopSlotFrozen(player.id, coopSlot) || isCoopSlotMuted(settings, player.id, coopSlot)) {
        return { ok: false, reason: getSnark("player.coop.slotCannotBuzz", "That player cannot buzz right now.") };
      }
    } else {
      coopSlot = 0;
    }
    buzzKey = getCoopScoreKey(player.id, coopSlot);
  }

  if (settings.teamModeEnabled && !playerTeamColor) {
    return { ok: false, reason: getSnark("player.buzzer.notAssignedToTeam", "Host has not assigned you to a team yet.") };
  }

  if (usingTextEntry) {
    answerText = String(payload?.answerText || "").trim();
    if (!answerText) {
      return { ok: false, reason: getSnark("player.buzzer.answerEmpty", "Answer cannot be empty.") };
    }
    if (answerText.length > 120) {
      return { ok: false, reason: getSnark("player.buzzer.answerTooLong", "Answer is too long.") };
    }
  } else if (coopActive && (payload?.buzzIn === true || payload?.option === undefined || payload?.option === null)) {
    // Jeopardy buzz-in (Q/B/P key or slot BUZZ button): claims control of the
    // round for this slot without answering. No log entry — the later option
    // pick is the scored buzz.
    if (!canBuzz(buzzKey)) {
      return { ok: false, reason: getSnark("player.buzzer.buzzNotAllowed", "Buzzers are not open, disabled, or you already buzzed.") };
    }
    if (round.coopControl) {
      if (round.coopControl === buzzKey) {
        const holderName = getCoopSlotName(player.id, coopSlot, getPlayerName(player));
        return { ok: true, message: getSnark("player.coop.haveControl", `${holderName} has control — pick an answer.`, { player: holderName }) };
      }
      const holder = getCoopControlName(round);
      return { ok: false, reason: getSnark("player.coop.hasControl", `${holder} has control.`, { player: holder }) };
    }
    const holderName = getCoopSlotName(player.id, coopSlot, getPlayerName(player));
    setState("round", { ...round, coopControl: buzzKey }, true);
    render();
    return { ok: true, message: getSnark("player.coop.buzzedIn", `${holderName} buzzed in!`, { player: holderName }) };
  } else {
    validOption = Number(payload?.option);
    if (!Number.isInteger(validOption) || validOption < 1 || validOption > settings.optionCount) {
      return { ok: false, reason: getSnark("player.buzzer.invalidOption", "Invalid option.") };
    }
  }

  // Jeopardy control: only the controlling slot may answer.
  if (coopActive && round.coopControl && round.coopControl !== buzzKey) {
    const holder = getCoopControlName(round);
    return { ok: false, reason: getSnark("player.coop.hasControl", `${holder} has control.`, { player: holder }) };
  }

  if (!canBuzz(buzzKey, validOption === null ? undefined : validOption)) {
    return { ok: false, reason: getSnark("player.buzzer.buzzNotAllowed", "Buzzers are not open, disabled, or you already buzzed.") };
  }

  const timeLeftCs = round.screw.active && round.screw.frozenCs != null ? round.screw.frozenCs : getTimeLeftCs(round, settings);
  const buzzDisplayName = coopActive ? getCoopSlotName(player.id, coopSlot, getPlayerName(player)) : getPlayerName(player);
  const logEntry = pushBuzzLogEntry(
    player,
    {
      option: validOption,
      answerText,
      coopSlot,
      coopKey: coopActive ? buzzKey : null,
    },
    timeLeftCs,
  );
  const newlyBuzzedIds = coopActive
    ? [buzzKey]
    : settings.teamModeEnabled && settings.teamScoringMode === "shared"
      ? getAllBuzzedTeamMemberIds(player.id, players, assignments)
      : [player.id];
  const buzzedPlayerIds = [...new Set([...(round.buzzedPlayerIds || []), ...newlyBuzzedIds])];

  // A fresh buzz clears any stored correct/wrong face for that slot.
  if (coopActive) {
    const moods = { ...getCoopMoods() };
    if (moods[buzzKey] !== undefined) {
      delete moods[buzzKey];
      setState("coopMoods", moods, true);
    }
  }

  const nextRound = {
    ...round,
    buzzedPlayerIds,
    // Answering releases Jeopardy control so the next slot can buzz in.
    coopControl: coopActive ? null : round.coopControl,
    ...(validOption !== null && settings.rebuzzAllowed
      ? {
          buzzCounts: {
            ...(round.buzzCounts || {}),
            [buzzKey]: {
              ...((round.buzzCounts || {})[buzzKey] || {}),
              [validOption]: getPlayerOptionBuzzCount(round, buzzKey, validOption) + 1,
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
          winnerCoopKey: coopActive ? buzzKey : null,
          winnerTeam: playerTeamColor,
          winnerOption: validOption,
          winnerAnswer: answerText,
          winnerName: buzzDisplayName,
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
        winnerCoopKey: coopActive ? buzzKey : null,
        winnerTeam: playerTeamColor,
        winnerOption: validOption,
        winnerAnswer: answerText,
        winnerName: buzzDisplayName,
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
        ? getSnark("player.buzzer.lockedInAnswer", `${buzzDisplayName} locked in an answer.`, { player: buzzDisplayName })
        : getSnark("player.buzzer.lockedInOption", `${buzzDisplayName} locked in option ${validOption}.`, { player: buzzDisplayName, option: validOption })
      : usingTextEntry
        ? getSnark("player.buzzer.submittedAnswer", `${buzzDisplayName} submitted an answer.`, { player: buzzDisplayName })
        : getSnark("player.buzzer.buzzedOption", `${buzzDisplayName} buzzed option ${validOption}.`, { player: buzzDisplayName, option: validOption }),
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
  // Coopertition without lock-after-buzz needs a pre-set answer so correct
  // picks auto-award while the round stays open.
  if (isCoopMode(settings) && !settings.lockAfterBuzz) {
    const hasPreset = settings.inputMode === "text"
      ? Boolean(String(round.correctAnswer || "").trim())
      : Array.isArray(round.correctOptions) && round.correctOptions.length > 0;
    if (!hasPreset) {
      setBuzzNotice("Set a pre-set correct answer first — or enable lock-after-buzz — before opening buzzers.");
      render();
      return;
    }
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
      coopControl: null,
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
      coopControl: null,
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
  // A new target re-arms locked-out coop siblings.
  setState("bingo", { ...bingo, targetIndex: index, currentLitIndex: -1, currentLitSlot: 0, coopLockout: {} }, true);
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
  // Coopertition: resolve the buzzing slot; siblings of a correct scorer wait
  // for the next target.
  let coopSlot = 0;
  let trackKey = getTeamTrackKey(player.id, settings, assignments);
  let scoreKey = getScoreKeyForPlayer(player.id, settings, assignments);
  let buzzName = getPlayerName(player);
  const coopActive = isCoopMode(settings);
  if (coopActive) {
    const count = getCoopSlotCount(player.id);
    if (count > 1) {
      coopSlot = Number(payload?.coopSlot);
      if (!Number.isInteger(coopSlot) || coopSlot < 0 || coopSlot >= count) {
        return { ok: false, reason: getSnark("player.coop.unknownSlot", "Unknown player slot for this device.") };
      }
      if (isCoopSlotMuted(settings, player.id, coopSlot)) {
        return { ok: false, reason: getSnark("player.coop.slotCannotBuzz", "That player cannot buzz right now.") };
      }
    }
    const myKey = getCoopScoreKey(player.id, coopSlot);
    const lockout = bingo.coopLockout || {};
    if (lockout[player.id] && lockout[player.id] !== myKey) {
      return { ok: false, reason: getSnark("player.coop.bingoSiblingLocked", "Your teammate collected that one — wait for the next round.") };
    }
    trackKey = myKey;
    scoreKey = myKey;
    buzzName = getCoopSlotName(player.id, coopSlot, getPlayerName(player));
  }
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
    let newPlayerItems = playerItems;
    let collectedCounts = bingo.collectedCounts || {};
    let winner = null;
    if (isWenDitHapnMode()) {
      // Wen Dit Happn has no collection — just score, no tile ownership
      newPlayerItems = playerItems;
      collectedCounts = bingo.collectedCounts || {};
      winner = null;
    } else {
      const alreadyCollected = collected.includes(targetIndex);
      newPlayerItems = { ...playerItems };
      if (!alreadyCollected) {
        newPlayerItems[trackKey] = [...collected, targetIndex];
      }
      collectedCounts = { ...bingo.collectedCounts };
      if (!alreadyCollected) {
        collectedCounts[trackKey] = (collectedCounts[trackKey] || 0) + 1;
      }
      if ((collectedCounts[trackKey] || 0) >= bingo.items.length) {
        winner = trackKey;
      }
    }
    const scores = { ...getScores() };
    scores[scoreKey] = (scores[scoreKey] || 0) + BINGO_CORRECT_POINTS;
    setState("scores", scores, true);
    const log = getLog();
    setState("gameLog", [...log, {
      id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "bingo", ts: now(), playerId: player.id,
      playerName: coopActive ? buzzName : getPlayerName(player), teamColor,
      scoreKey,
      coopSlot: coopActive ? coopSlot : null,
      coopKey: coopActive ? scoreKey : null,
      scoreTarget: scoreKey.startsWith("team:") ? `Team ${teamColor}` : (coopActive ? buzzName : getPlayerName(player)),
      item: bingo.items[targetIndex],
      result: "correct", points: BINGO_CORRECT_POINTS,
    }], true);
    if (bingoCycleInterval) { clearInterval(bingoCycleInterval); bingoCycleInterval = null; }
    bingoCycleQueue = [];
    const settings = getSettings();
    const shouldStopCycling = !settings.bingoAllowMultipleCorrect;
    // Coop sibling lockout: teammates of the scorer wait for the next target.
    const nextLockout = coopActive ? { ...(bingo.coopLockout || {}), [player.id]: scoreKey } : bingo.coopLockout;
    setState("bingo", {
      ...bingo, playerItems: newPlayerItems,
      collectedCounts, winner, cycling: shouldStopCycling, currentLitIndex: -1, currentLitSlot: 0,
      coopLockout: nextLockout,
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
      playerName: coopActive ? buzzName : getPlayerName(player), teamColor,
      scoreKey,
      coopSlot: coopActive ? coopSlot : null,
      coopKey: coopActive ? scoreKey : null,
      scoreTarget: scoreKey.startsWith("team:") ? `Team ${teamColor}` : (coopActive ? buzzName : getPlayerName(player)),
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
// All live response tracks (coop-aware: one per slot; shared-team blocked in
// coop so tracks are always per-slot there).
function getDisOrDatTracks(settings = getSettings(), assignments = getTeamAssignments(), participants = null) {
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  const list = (participants || currentParticipants()).filter((p) => p.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(p.id)));
  if (!isCoopMode(settings)) {
    return [...new Set(list.map((p) => getTeamTrackKey(p.id, settings, assignments)).filter(Boolean))];
  }
  const tracks = [];
  list.forEach((p) => {
    const count = getCoopSlotCount(p.id);
    for (let slot = 0; slot < count; slot++) {
      if (!isCoopSlotMuted(settings, p.id, slot)) tracks.push(getCoopScoreKey(p.id, slot));
    }
  });
  return tracks;
}

// Lowest-scoring live individual (coop key) for timed one-play auto-pick.
// Ties break by earliest-joined device, lowest slot.
function getDisOrDatLowestCoopKey(settings = getSettings()) {
  const scores = getScores();
  const tracks = getDisOrDatTracks(settings);
  let best = null;
  let bestScore = Infinity;
  tracks.forEach((key) => {
    const s = Number(scores[key] || 0);
    if (s < bestScore) {
      bestScore = s;
      best = key;
    }
  });
  return best;
}

function getCoopKeyDisplayName(key, participants = currentParticipants()) {
  const parsed = parseCoopScoreKey(key);
  if (!parsed) {
    const p = participants.find((pp) => pp.id === key);
    return p ? getPlayerName(p) : key;
  }
  const group = getCoopGroupName(parsed.deviceId);
  const sub = getCoopSlotName(parsed.deviceId, parsed.slot);
  return group && sub !== group ? `${group} — ${sub}` : sub;
}

function startDisOrDat(mode, playerId) {
  if (!isHost()) return;
  const dd = getDisOrDat();
  if (dd.answers.some(a => a !== "dis" && a !== "dat" && a !== "both")) return;
  const coopActive = isCoopMode();
  const isTimed = mode === "onePlayTimed" || mode === "allPlayTimed";
  const timedSeconds = dd.timedSeconds || getSettings().disOrDatTimedSeconds || DIS_OR_DAT_TIMED_SECONDS;
  setState("disordat", {
    ...dd,
    active: true,
    phase: "playing",
    mode,
    activePlayerId: mode === "onePlayTimed" ? (coopActive ? (parseCoopScoreKey(playerId)?.deviceId || playerId) : playerId) : null,
    activeCoopKey: mode === "onePlayTimed" && coopActive ? playerId : null,
    pendingPick: false,
    timeEndsAt: isTimed ? now() + timedSeconds * 1000 : null,
    currentQuestion: 0,
    responses: {},
    pointsEarned: {},
    jackBonus: {},
    finishedPlayerIds: [],
    claims: {},
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
  const coopActive = isCoopMode(settings);
  let trackKey = getTeamTrackKey(player.id, settings, assignments);
  if (coopActive) {
    const count = getCoopSlotCount(player.id);
    let slot = 0;
    if (count > 1) {
      slot = Number(payload?.coopSlot);
      if (!Number.isInteger(slot) || slot < 0 || slot >= count) {
        return { ok: false, reason: getSnark("player.coop.unknownSlot", "Unknown player slot for this device.") };
      }
      if (isCoopSlotFrozen(player.id, slot) || isCoopSlotMuted(settings, player.id, slot)) {
        return { ok: false, reason: getSnark("player.coop.slotCannotBuzz", "That player cannot buzz right now.") };
      }
    }
    trackKey = getCoopScoreKey(player.id, slot);
  }
  const isSharedTeam = !coopActive && trackKey !== player.id;
  if (settings.teamModeEnabled && !getPlayerTeamColor(player.id, assignments)) {
    return { ok: false, reason: getSnark("player.buzzer.notAssignedToTeam", "Host has not assigned you to a team yet.") };
  }
  if (dd.mode === "onePlayTimed") {
    if (coopActive) {
      if (trackKey !== dd.activeCoopKey) {
        return { ok: false, reason: getSnark("player.disdat.notActivePlayer", "You're not the active player.") };
      }
    } else {
      const activeTrackKey = isSharedTeam ? getTeamTrackKey(dd.activePlayerId, settings, assignments) : dd.activePlayerId;
      if (player.id !== dd.activePlayerId && trackKey !== activeTrackKey) {
        return { ok: false, reason: getSnark("player.disdat.notActivePlayer", "You're not the active player.") };
      }
    }
  }
  if (dd.mode === "allPlayHostPaced" && q !== dd.currentQuestion) {
    return { ok: false, reason: getSnark("player.disdat.notLiveYet", "That question isn't live yet.") };
  }
  // Coop host-paced is buzz-and-select: a slot must claim the question first.
  if (coopActive && dd.mode === "allPlayHostPaced") {
    const claims = dd.claims || {};
    if (claims[q] !== trackKey) {
      return { ok: false, reason: getSnark("player.disdat.claimFirst", "Buzz in to claim this question first.") };
    }
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
    activeTracks = coopActive
      ? [dd.activeCoopKey].filter(Boolean)
      : [getTeamTrackKey(dd.activePlayerId, settings, assignments)].filter(Boolean);
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

// Coop host-paced buzz-and-select: a slot buzzes in to claim the live
// question, then only that slot's answers are accepted for it.
function handleDisOrDatClaim(player, payload) {
  const dd = getDisOrDat();
  if (!dd.active || dd.phase !== "playing" || dd.mode !== "allPlayHostPaced") {
    return { ok: false, reason: getSnark("player.disdat.notActive", "Dis or Dat isn't active.") };
  }
  const settings = getSettings();
  if (!isCoopMode(settings)) {
    return { ok: false, reason: getSnark("player.disdat.noClaimNeeded", "Just answer — no claim needed.") };
  }
  const q = Number(payload?.q);
  if (!Number.isInteger(q) || q !== dd.currentQuestion) {
    return { ok: false, reason: getSnark("player.disdat.notLiveYet", "That question isn't live yet.") };
  }
  const count = getCoopSlotCount(player.id);
  let slot = 0;
  if (count > 1) {
    slot = Number(payload?.coopSlot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= count) {
      return { ok: false, reason: getSnark("player.coop.unknownSlot", "Unknown player slot for this device.") };
    }
    if (isCoopSlotFrozen(player.id, slot) || isCoopSlotMuted(settings, player.id, slot)) {
      return { ok: false, reason: getSnark("player.coop.slotCannotBuzz", "That player cannot buzz right now.") };
    }
  }
  const key = getCoopScoreKey(player.id, slot);
  const claims = { ...(dd.claims || {}) };
  if (claims[q] && claims[q] !== key) {
    return { ok: false, reason: getSnark("player.disdat.alreadyClaimed", "That question is already claimed.") };
  }
  claims[q] = key;
  setState("disordat", { ...dd, claims }, true);
  render();
  const name = getCoopSlotName(player.id, slot, getPlayerName(player));
  return { ok: true, message: getSnark("player.disdat.claimed", `${name} claimed question ${q + 1}.`, { player: name, q: q + 1 }) };
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
  const tracks = getDisOrDatTracks(settings, assignments, participants);
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
  const tracks = getDisOrDatTracks(settings, assignments, participants);

  let responses = dd.responses || {};
  if (isTimed) {
    const next = {};
    for (const track of tracks) {
      const resps = responses[track] || [];
      const filled = resps.map(a => (a === "dis" || a === "dat" || a === "both") ? a : "none");
      while (filled.length < DIS_OR_DAT_QUESTION_COUNT) filled.push("none");
      next[track] = filled;
    }
    responses = next;
  } else {
    // Host-paced: pad any missing trailing questions as "none" for penalty calc
    for (const track of tracks) {
      const resps = responses[track] || [];
      if (resps.length < DIS_OR_DAT_QUESTION_COUNT) {
        const padded = [...resps];
        while (padded.length < DIS_OR_DAT_QUESTION_COUNT) padded.push("none");
        responses[track] = padded;
      }
    }
  }

  const scores = { ...getScores() };
  const log = getLog();

  for (const track of tracks) {
    const resps = responses[track] || [];
    // Pad to full length if needed
    const padded = [...resps];
    while (padded.length < DIS_OR_DAT_QUESTION_COUNT) padded.push("none");
    if (padded.length === 0) continue;
    const correctCount = padded.filter((a, i) => a === dd.answers[i]).length;
    const missingCount = padded.filter(a => a === "none").length;
    const penalty = missingCount * DIS_OR_DAT_CORRECT_POINTS;
    const base = correctCount * DIS_OR_DAT_CORRECT_POINTS;
    const bonus = dd.jackBonus[track] || 0;
    const total = base - penalty + bonus;
    const isTeamTrack = TEAM_COLORS.includes(track);
    const parsedTrack = parseCoopScoreKey(track);
    const rep = parsedTrack
      ? participants.find((p) => p.id === parsedTrack.deviceId) || null
      : participants.find((p) => getTeamTrackKey(p.id, settings, assignments) === track) || null;
    const teamColor = isTeamTrack ? track : (rep ? getPlayerTeamColor(rep.id, assignments) : null);
    const scoreKey = parsedTrack ? track : (rep ? getScoreKeyForPlayer(rep.id, settings, assignments) : track);
    scores[scoreKey] = Number(scores[scoreKey] || 0) + total;
    const missedText = missingCount > 0 ? `, ${missingCount} missed (-${penalty})` : "";
    const trackDisplayName = parsedTrack ? getCoopKeyDisplayName(track, participants) : (rep ? getPlayerName(rep) : track);
    log.push({
      id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "disordat",
      ts: now(),
      playerId: rep?.id || track,
      playerName: trackDisplayName,
      teamColor,
      scoreKey,
      coopKey: parsedTrack ? track : null,
      scoreTarget: scoreKey.startsWith("team:") ? `Team ${teamColor}` : trackDisplayName,
      option: null,
      answerText: `Dis or Dat: ${correctCount}/${DIS_OR_DAT_QUESTION_COUNT} correct${missedText}${isTimed && bonus ? ` + ${bonus} bonus` : ""} = ${total}`,
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
    activeCoopKey: null,
    pendingPick: false,
    timeEndsAt: null,
    currentQuestion: 0,
    responses: {},
    pointsEarned: {},
    jackBonus: {},
    finishedPlayerIds: [],
    claims: {},
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
// Fibbage — host enters truth, players submit lies, vote on shuffled pool
// 500 per fool, 1000 for truth, multiplier 1..5, duplicates merged
// =============================================================================
function normalizeFibbageMultiplier(v) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1) return 1;
  if (n > FIBBAGE_MAX_MULT) return FIBBAGE_MAX_MULT;
  return n;
}
function normalizeFibbageTime(v) {
  const n = Number(v);
  return FIBBAGE_TIMES.includes(n) ? n : 30;
}
function getEligibleFibbageTrackKeys() {
  const settings = getSettings();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  const players = currentParticipants().filter((p) => p.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(p.id)));
  if (players.length === 0) return [];
  const tracks = [...new Set(players.filter((p) => !settings.teamModeEnabled || getPlayerTeamColor(p.id, assignments)).map((p) => getTeamTrackKey(p.id, settings, assignments)))];
  return tracks;
}
function startFibbageLying() {
  if (!isHost()) return;
  if (!isFibbageMode()) return;
  let fb = getFibbage();
  // Auto-apply draft truth if host typed but didn't press Set Truth (pre-lying only)
  const draftInput = document.querySelector("#fibbage-truth");
  const draftVal = draftInput ? String(draftInput.value || "").trim() : "";
  if (draftVal && draftVal !== fb.truth) {
    fb = { ...fb, truth: draftVal };
    setState("fibbage", fb, true);
  }
  fb = getFibbage();
  if (!String(fb.truth || "").trim()) {
    setBuzzNotice("Set the truth before entering lies.");
    render();
    return;
  }
  const eligible = getEligibleFibbageTrackKeys();
  if (eligible.length < 2) {
    setBuzzNotice("Need at least 2 players for Fibbage.");
    render();
    return;
  }
  const lieTime = normalizeFibbageTime(fb.lieTimeSec);
  setState("fibbage", {
    ...fb,
    active: true,
    phase: "lying",
    timeEndsAt: now() + lieTime * 1000,
    voteEndsAt: null,
    seed: Math.floor(Math.random() * 2147483647) + 1,
    lies: {},
    blocked: {},
    lieErrors: {},
    choices: [],
    votes: {},
    revealed: { all: false, singleIdx: null, revealedIdxs: [] },
    pointsEarned: {},
  }, true);
  render();
}
function setFibbageTruth(val) {
  if (!isHost()) return;
  const fb = getFibbage();
  if (fb.active) {
    setBuzzNotice("Truth can only be set before lying starts.");
    render();
    return;
  }
  const raw = String(val || "").trim();
  if (!raw) {
    setBuzzNotice("Truth cannot be empty.");
    render();
    return;
  }
  if (raw.length > 120) {
    setBuzzNotice("Truth is too long.");
    render();
    return;
  }
  setState("fibbage", { ...fb, truth: raw }, true);
  render();
}
function setFibbageLieTime(sec) {
  if (!isHost()) return;
  const fb = getFibbage();
  if (fb.active && fb.phase !== "setup") return;
  setState("fibbage", { ...fb, lieTimeSec: normalizeFibbageTime(sec) }, true);
  render();
}
function setFibbageVoteTime(sec) {
  if (!isHost()) return;
  const fb = getFibbage();
  if (fb.active && fb.phase !== "setup") return;
  setState("fibbage", { ...fb, voteTimeSec: normalizeFibbageTime(sec) }, true);
  render();
}
function setFibbageMultiplier(mult) {
  if (!isHost()) return;
  const fb = getFibbage();
  if (fb.active && fb.phase !== "setup") return;
  setState("fibbage", { ...fb, multiplier: normalizeFibbageMultiplier(mult) }, true);
  render();
}
function toggleFibbageBlock(trackKey) {
  if (!isHost()) return;
  const fb = getFibbage();
  if (fb.phase !== "lying" && fb.phase !== "review") return;
  const blocked = { ...fb.blocked };
  if (blocked[trackKey]) delete blocked[trackKey];
  else blocked[trackKey] = true;
  setState("fibbage", { ...fb, blocked }, true);
  render();
}
function endFibbageLyingEarly() {
  if (!isHost()) return;
  const fb = getFibbage();
  if (fb.phase !== "lying") return;
  setState("fibbage", { ...fb, phase: "review", timeEndsAt: now() }, true);
  render();
}
function showFibbageResponses() {
  if (!isHost()) return;
  let fb = getFibbage();
  if (fb.phase !== "review") return;
  if (!String(fb.truth || "").trim()) {
    setBuzzNotice("Truth not set — it must be set before lying started.");
    render();
    return;
  }
  const settings = getSettings();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
  const blocked = fb.blocked || {};
  const normMap = new Map();
  Object.entries(fb.lies || {}).forEach(([trackKey, rawText]) => {
    if (blocked[trackKey]) return;
    const text = String(rawText || "").trim();
    if (!text) return;
    const norm = normalizeAnswerForCompare(text);
    if (!norm) return;
    if (norm === normalizeAnswerForCompare(fb.truth)) return;
    if (!normMap.has(norm)) normMap.set(norm, { text, authorKeys: [] });
    normMap.get(norm).authorKeys.push(trackKey);
  });
  const choices = [];
  normMap.forEach((entry) => {
    choices.push({ text: entry.text, norm: normalizeAnswerForCompare(entry.text), authorKeys: entry.authorKeys.sort(), isTruth: false });
  });
  const truthNorm = normalizeAnswerForCompare(fb.truth);
  choices.push({ text: String(fb.truth).trim(), norm: truthNorm, authorKeys: [], isTruth: true });
  const seed = Number(fb.seed) || 1;
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(seededFraction(seed + i * 997) * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  setState("fibbage", { ...fb, choices, votes: {}, phase: "voting_ready", revealed: { all: false, singleIdx: null, revealedIdxs: [] }, pointsEarned: {} }, true);
  render();
}
function startFibbageVoteTimer() {
  if (!isHost()) return;
  const fb = getFibbage();
  if (fb.phase !== "voting_ready") return;
  setState("fibbage", { ...fb, phase: "voting", voteEndsAt: now() + normalizeFibbageTime(fb.voteTimeSec) * 1000 }, true);
  render();
}
function finalizeFibbageScores() {
  if (!isHost()) return;
  const fb = getFibbage();
  if (fb.phase !== "voting") return;
  const settings = getSettings();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
  const participants = currentParticipants();
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  const eligibleTracks = getEligibleFibbageTrackKeys();
  const choices = fb.choices || [];
  const votes = fb.votes || {};
  const multiplier = normalizeFibbageMultiplier(fb.multiplier);
  const voteCountsByChoice = {};
  Object.entries(votes).forEach(([trackKey, idx]) => {
    const n = Number(idx);
    if (!Number.isInteger(n) || n < 0 || n >= choices.length) return;
    voteCountsByChoice[n] = (voteCountsByChoice[n] || 0) + 1;
  });
  const pointsEarned = {};
  eligibleTracks.forEach((trackKey) => { pointsEarned[trackKey] = 0; });
  choices.forEach((choice, idx) => {
    if (choice.isTruth) return;
    const count = voteCountsByChoice[idx] || 0;
    if (count <= 0) return;
    choice.authorKeys.forEach((authorKey) => {
      pointsEarned[authorKey] = (pointsEarned[authorKey] || 0) + count * FIBBAGE_FOOL_POINTS * multiplier;
    });
  });
  const truthIdx = choices.findIndex((c) => c.isTruth);
  if (truthIdx >= 0) {
    Object.entries(votes).forEach(([trackKey, idx]) => {
      if (Number(idx) === truthIdx) {
        pointsEarned[trackKey] = (pointsEarned[trackKey] || 0) + FIBBAGE_TRUTH_POINTS * multiplier;
      }
    });
  }
  const scores = { ...getScores() };
  const log = [...getLog()];
  eligibleTracks.forEach((trackKey) => {
    const pts = pointsEarned[trackKey] || 0;
    if (pts === 0 && !votes[trackKey] && !choices.some((c) => c.authorKeys.includes(trackKey))) return;
    const isTeamTrack = TEAM_COLORS.includes(trackKey);
    let rep = null;
    if (isTeamTrack) rep = participants.find((p) => getTeamTrackKey(p.id, settings, assignments) === trackKey) || null;
    else rep = participants.find((p) => p.id === trackKey) || null;
    const teamColor = isTeamTrack ? trackKey : (rep ? getPlayerTeamColor(rep.id, assignments) : null);
    const scoreKey = rep ? getScoreKeyForPlayer(rep.id, settings, assignments) : trackKey;
    if (pts !== 0) scores[scoreKey] = Number(scores[scoreKey] || 0) + pts;
    const votedIdx = votes[trackKey];
    const votedChoice = Number.isInteger(Number(votedIdx)) && choices[Number(votedIdx)] ? choices[Number(votedIdx)].text : "—";
    const myLieEntry = choices.find((c) => c.authorKeys.includes(trackKey));
    const myLieText = myLieEntry ? myLieEntry.text : (fb.lies[trackKey] || ((fb.blocked||{})[trackKey] ? "[blocked]" : "—"));
    log.push({
      id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "fibbage",
      ts: now(),
      playerId: rep?.id || trackKey,
      playerName: rep ? getPlayerName(rep) : trackKey,
      teamColor,
      scoreKey,
      scoreTarget: scoreKey.startsWith("team:") ? `Team ${teamColor}` : (rep ? getPlayerName(rep) : trackKey),
      option: null,
      answerText: `Fibbage: lie "${myLieText}" voted "${votedChoice}"`,
      timeLeftCs: 0,
      scoringMode: "fibbage",
      jackMultiplier: multiplier,
      uniformPoints: FIBBAGE_FOOL_POINTS,
      basePoints: pts,
      awardedDelta: pts,
      resolved: true,
    });
  });
  setState("scores", scores, true);
  setState("gameLog", log, true);
  setState("fibbage", { ...fb, phase: "results", voteEndsAt: null, pointsEarned, revealed: { all: false, singleIdx: null, revealedIdxs: [] } }, true);
  render();
}
function resetFibbage() {
  if (!isHost()) return;
  setState("fibbage", freshFibbageState(), true);
  render();
}
function exitFibbage() {
  if (!isHost()) return;
  const fb = getFibbage();
  if (fb.active && (fb.phase === "lying" || fb.phase === "voting")) {
    setState("fibbage", { ...fb, phase: "results", revealed: { all: true, singleIdx: null, revealedIdxs: (fb.choices || []).map((_, i) => i) } }, true);
    finalizeFibbageScores();
  }
  setHostSetting("inputMode", "buttons");
}
function handleFibbageLie(senderPlayer, payload) {
  const fb = getFibbage();
  if (!isFibbageMode() || !fb.active || fb.phase !== "lying") return { ok: false, reason: getSnark("player.fibbage.notLying", "Not accepting lies right now.") };
  const settings = getSettings();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
  const trackKey = getTeamTrackKey(senderPlayer.id, settings, assignments);
  if (senderPlayer.id === getControllerId()) return { ok: false, reason: getSnark("player.fibbage.notPlayer", "Host cannot lie.") };
  const cohostIds = getSafeState("cohostIds", []);
  if (Array.isArray(cohostIds) && cohostIds.includes(senderPlayer.id)) return { ok: false, reason: getSnark("player.fibbage.notPlayer", "Host cannot lie.") };
  if (settings.teamModeEnabled && !getPlayerTeamColor(senderPlayer.id, assignments)) return { ok: false, reason: getSnark("player.buzzer.notAssignedToTeam", "Host has not assigned you to a team yet.") };
  if (fb.lies[trackKey] !== undefined) return { ok: false, reason: getSnark("player.fibbage.alreadyLied", "You already submitted a lie.") };
  if (fb.blocked[trackKey]) return { ok: false, reason: getSnark("player.fibbage.blocked", "Your lie was blocked.") };
  const raw = String(payload?.lieText || "").trim();
  if (!raw) return { ok: false, reason: getSnark("player.fibbage.emptyLie", "Lie cannot be empty.") };
  if (raw.length > 120) return { ok: false, reason: getSnark("player.fibbage.tooLong", "Lie is too long.") };
  if (String(fb.truth || "").trim() && normalizeAnswerForCompare(raw) === normalizeAnswerForCompare(fb.truth)) {
    const newErrors = { ...(fb.lieErrors || {}), [trackKey]: "The truth is not a lie — try again" };
    setState("fibbage", { ...fb, lieErrors: newErrors }, true);
    render();
    return { ok: false, reason: getSnark("player.fibbage.truthNotLie", "The truth is not a lie — try again") };
  }
  const lies = { ...fb.lies, [trackKey]: raw };
  const lieErrors = { ...fb.lieErrors };
  delete lieErrors[trackKey];
  setState("fibbage", { ...fb, lies, lieErrors }, true);
  render();
  return { ok: true, message: getSnark("player.fibbage.lieSubmitted", "Lie submitted.") };
}
function handleFibbageVote(senderPlayer, payload) {
  const fb = getFibbage();
  if (!isFibbageMode() || !fb.active || (fb.phase !== "voting" && fb.phase !== "voting_ready")) return { ok: false, reason: getSnark("player.fibbage.notVoting", "Not voting right now.") };
  const settings = getSettings();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
  const trackKey = getTeamTrackKey(senderPlayer.id, settings, assignments);
  if (senderPlayer.id === getControllerId()) return { ok: false, reason: getSnark("player.fibbage.notPlayer", "Host cannot vote.") };
  const cohostIds = getSafeState("cohostIds", []);
  if (Array.isArray(cohostIds) && cohostIds.includes(senderPlayer.id)) return { ok: false, reason: getSnark("player.fibbage.notPlayer", "Host cannot vote.") };
  if (settings.teamModeEnabled && !getPlayerTeamColor(senderPlayer.id, assignments)) return { ok: false, reason: getSnark("player.buzzer.notAssignedToTeam", "Host has not assigned you to a team yet.") };
  if (fb.votes[trackKey] !== undefined) return { ok: false, reason: getSnark("player.fibbage.alreadyVoted", "You already voted.") };
  const idx = Number(payload?.choiceIdx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= (fb.choices || []).length) return { ok: false, reason: getSnark("player.fibbage.badChoice", "Bad choice.") };
  const choice = fb.choices[idx];
  if (choice.authorKeys.includes(trackKey)) return { ok: false, reason: getSnark("player.fibbage.ownLie", "You cannot vote for your own lie.") };
  const votes = { ...fb.votes, [trackKey]: idx };
  setState("fibbage", { ...fb, votes }, true);
  const eligible = getEligibleFibbageTrackKeys();
  if (eligible.length > 0 && eligible.every((tk) => votes[tk] !== undefined)) {
    finalizeFibbageScores();
    return { ok: true, message: getSnark("player.fibbage.voteSubmitted", "Vote submitted.") };
  }
  render();
  return { ok: true, message: getSnark("player.fibbage.voteSubmitted", "Vote submitted.") };
}
function handleFibbageTick() {
  if (!isHost()) return;
  const fb = getFibbage();
  if (!fb.active) return;
  const editingTruth = document.activeElement?.id === "fibbage-truth";
  if (fb.phase === "lying" && fb.timeEndsAt && now() >= fb.timeEndsAt) {
    setState("fibbage", { ...fb, phase: "review" }, true);
    render();
    return;
  }
  if (fb.phase === "voting" && fb.voteEndsAt && now() >= fb.voteEndsAt) {
    finalizeFibbageScores();
    return;
  }
  // Only tick timers for lying/voting; results/review/setup don't need per-second renders
  if (fb.phase === "lying" || fb.phase === "voting") {
    if (editingTruth) {
      updateTimerDisplays();
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
  setState("coopMoods", {}, true);
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
  if (isFibbageMode()) {
    handleFibbageTick();
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
        coopControl: null,
      },
      true,
    );
    setState("pendingLogId", null, true);
    render();
  }
}

// =============================================================================
// Coopertition roster + score migration (host only)
// =============================================================================
// Enabling coop carries each device's legacy pid score into its slot 0 so no
// points are lost. Disabling folds every coop slot back into the pid score.
function migrateScoresForCoopToggle(enable) {
  const players = currentParticipants();
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  const scores = { ...getScores() };
  const rosters = { ...getCoopRosters() };
  players.forEach((player) => {
    if (player.id === controllerId || (Array.isArray(cohostIds) && cohostIds.includes(player.id))) return;
    if (enable) {
      if (!rosters[player.id] || !Array.isArray(rosters[player.id].slots)) {
        const name = getPlayerName(player);
        rosters[player.id] = { group: name, slots: [name] };
      }
      const count = clamp(rosters[player.id].slots.length, 1, 3);
      const slot0Key = count <= 1 ? player.id : `coop:${player.id}:0`;
      if (slot0Key !== player.id) {
        scores[slot0Key] = Number(scores[slot0Key] || 0) + Number(scores[player.id] || 0);
        delete scores[player.id];
      }
    } else {
      let total = Number(scores[player.id] || 0);
      for (let slot = 0; slot < 3; slot++) {
        const key = `coop:${player.id}:${slot}`;
        total += Number(scores[key] || 0);
        delete scores[key];
      }
      scores[player.id] = total;
    }
  });
  setState("scores", scores, true);
  setState("coopRosters", rosters, true);
}

// Player-facing: set/confirm this device's group roster while coop is on.
function handleCoopRoster(senderPlayer, payload) {
  if (!isCoopMode()) {
    return { ok: false, reason: "Coopertition mode is not enabled." };
  }
  if (senderPlayer.id === getControllerId()) {
    return { ok: false, reason: "The host does not need a group." };
  }
  const cohostIds = getSafeState("cohostIds", []);
  if (Array.isArray(cohostIds) && cohostIds.includes(senderPlayer.id)) {
    return { ok: false, reason: "Co-hosts do not need a group." };
  }
  const existing = getCoopRoster(senderPlayer.id);
  const settings = getSettings();
  if (existing && !settings.coopAllowEdit) {
    return { ok: false, reason: "Group editing is locked. Ask the host to allow edits." };
  }
  const count = clamp(Number(payload?.count) || 1, 1, 3);
  const group = String(payload?.group || "").trim().slice(0, 32) || getPlayerName(senderPlayer);
  const rawNames = Array.isArray(payload?.names) ? payload.names : [];
  const slots = [];
  for (let i = 0; i < count; i++) {
    if (count === 1) {
      slots.push(group);
    } else {
      slots.push(String(rawNames[i] || "").trim().slice(0, 32) || `Player ${i + 1}`);
    }
  }
  const rosters = { ...getCoopRosters(), [senderPlayer.id]: { group, slots } };
  setState("coopRosters", rosters, true);
  // Seed zero scores so new slots appear on the board immediately.
  const scores = { ...getScores() };
  let touched = false;
  slots.forEach((_, slot) => {
    const key = count <= 1 ? senderPlayer.id : `coop:${senderPlayer.id}:${slot}`;
    if (scores[key] === undefined) {
      scores[key] = 0;
      touched = true;
    }
  });
  if (touched) setState("scores", scores, true);
  render();
  return { ok: true, message: count <= 1 ? `Group "${group}" confirmed.` : `Group "${group}" set with ${count} players.` };
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
  // --- Coopertition gates: JACK, screws, rebuzz, small option counts and
  // shared-team scoring are all off limits while coop is on. ---
  if (isCoopMode(next)) {
    if (key === "scoringMode" && value === "jack") {
      setBuzzNotice("JACK scoring is disabled in coopertition mode.");
      render();
      return;
    }
    if (key === "allowScrewing" && value === true) {
      setBuzzNotice("Screws are disabled in coopertition mode.");
      render();
      return;
    }
    if (key === "rebuzzAllowed" && value === true) {
      setBuzzNotice("Re-buzz is disabled in coopertition mode (one response per player).");
      render();
      return;
    }
    if (key === "teamScoringMode" && value === "shared") {
      setBuzzNotice("Shared team scoring is disabled in coopertition mode (alliances only).");
      render();
      return;
    }
    if (key === "inputMode" && (value === "fibbage" || value === "bingo" || value === "wendithapn" || value === "disordat")) {
      setBuzzNotice("That mode is off limits in coopertition mode. Switch modes from buzzer mode with coop off.");
      render();
      return;
    }
  }
  if (key === "optionCount") {
    if (isCoopMode(next) && Number(value) < 4) {
      next.optionCount = 4;
      next.disabledOptions = normalizeDisabledOptions(settings.disabledOptions, 4);
    } else {
      next.disabledOptions = normalizeDisabledOptions(settings.disabledOptions, value);
    }
  }
  if (key === "coopertitionEnabled") {
    if (value === true && settings.inputMode !== "buttons" && settings.inputMode !== "text") {
      setBuzzNotice("Switch modes from buzzer mode: return to buttons/text before enabling coopertition.");
      render();
      return;
    }
    next.coopertitionEnabled = Boolean(value);
    if (next.coopertitionEnabled) {
      // Coop locks: screws off, one response per player, uniform-style scoring, alliances only.
      next.allowScrewing = false;
      next.rebuzzAllowed = false;
      next.maxBuzzesPerOption = 1;
      if (next.scoringMode === "jack") {
        next.scoringMode = "uniform";
        next.valueSelectionMethod = "standard";
      }
      if (next.teamScoringMode === "shared") next.teamScoringMode = "alliance";
      if (Number(next.optionCount) < 4) {
        next.optionCount = 4;
        next.disabledOptions = normalizeDisabledOptions(next.disabledOptions, 4);
      }
      migrateScoresForCoopToggle(true);
    } else {
      migrateScoresForCoopToggle(false);
    }
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
        winnerOption: null, winnerAnswer: null, winnerName: null, coopControl: null,
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
        winnerOption: null, winnerAnswer: null, winnerName: null, coopControl: null,
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
    if (value === "fibbage") {
      const idleRound = {
        status: ROUND_STATUSES.IDLE, opensAt: null, closesAt: null,
        remainingCs: settings.timeOpen * 100, winnerId: null, winnerTeam: null,
        winnerOption: null, winnerAnswer: null, winnerName: null, coopControl: null,
        buzzedPlayerIds: [],
        buzzCounts: {},
        roulette: { active: false, startedAt: null, mode: settings.rouletteMode, topAmount: normalizeRouletteTopAmount(settings.rouletteTopAmount), ceiling: 0, seed: null, targetPlayerId: null, targetPlayerName: null, selections: {}, completedPlayerIds: [], finalValue: null, finishedAt: null },
        screw: { active: false, screwerId: null, screwerName: null, screweeId: null, screeeName: null, screwTimerMs: null, frozenCs: null, frozenPoints: null },
      };
      setState("round", idleRound, true);
      setState("pendingLogId", null, true);
      const fb = getFibbage();
      setState("fibbage", { ...freshFibbageState(), lieTimeSec: fb.lieTimeSec || 30, voteTimeSec: fb.voteTimeSec || 30, multiplier: fb.multiplier || 1 }, true);
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

// Host mutes/unmutes a single coop slot (whole devices mute via togglePlayerBuzzer).
function toggleCoopSlot(coopKey) {
  if (!isHost()) {
    if (isCohost()) RPC.call("cohost-action", { fn: "toggleCoopSlot", args: [coopKey] }, RPC.Mode.HOST);
    return;
  }
  const parsed = parseCoopScoreKey(coopKey);
  if (!parsed) return;
  const settings = getSettings();
  const current = normalizeDisabledCoopSlots(settings.disabledCoopSlots, currentParticipants());
  const next = current.includes(coopKey) ? current.filter((k) => k !== coopKey) : [...current, coopKey];
  setState(
    "settings",
    {
      ...settings,
      disabledCoopSlots: next,
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
  const self = me();
  if (!self?.id) return;
  setState("controllerId", self.id, true);
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
        coopertitionEnabled: Boolean(hostPrejoinCoopSetting),
      },
      true,
    );
  }
  // Coop + shared-team scoring can never coexist (alliances only).
  try {
    const s = getSettings();
    if (s.coopertitionEnabled && s.teamScoringMode === "shared") {
      setState("settings", { ...s, teamScoringMode: "alliance" }, true);
    }
  } catch {}
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
  if (!getState("coopRosters")) {
    setState("coopRosters", {}, true);
  } else {
    // Prune rosters for devices that left the room.
    const activeIds = new Set(currentParticipants().map((p) => p.id));
    const rosters = getCoopRosters();
    const pruned = {};
    Object.entries(rosters || {}).forEach(([id, roster]) => {
      if (activeIds.has(id)) pruned[id] = roster;
    });
    if (Object.keys(pruned).length !== Object.keys(rosters || {}).length) {
      setState("coopRosters", pruned, true);
    }
  }
  if (!getState("coopMoods")) {
    setState("coopMoods", {}, true);
  }
  if (!getState("coopLastCorrect")) {
    setState("coopLastCorrect", {}, true);
  }
  if (!getState("fibbage")) {
    setState("fibbage", freshFibbageState(), true);
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
      <span class="muted">Less random cycles</span>
      <div class="toggle-switch">
        <button type="button" class="toggle-switch-btn ${onCls}" data-toggle-setting="bingoLessRandom" data-value="true">On</button>
        <button type="button" class="toggle-switch-btn ${offCls}" data-toggle-setting="bingoLessRandom" data-value="false">Off</button>
      </div>
      <p class="muted">When on, every option appears once per full cycle instead of being picked randomly, so no option waits long gaps. HIGHLY RECCOMENDED</p>
    </div>`;
}

function renderBingoAllowMultipleCorrectToggle(settings) {
  const isOn = settings.bingoAllowMultipleCorrect === true;
  const onCls = isOn ? "is-active" : "";
  const offCls = !isOn ? "is-active is-off-val" : "";
  return `
    <div class="toggle-group">
      <span class="muted">Allow multiple correct answers</span>
      <div class="toggle-switch">
        <button type="button" class="toggle-switch-btn ${onCls}" data-toggle-setting="bingoAllowMultipleCorrect" data-value="true">On</button>
        <button type="button" class="toggle-switch-btn ${offCls}" data-toggle-setting="bingoAllowMultipleCorrect" data-value="false">Off</button>
      </div>
      <p class="muted">When on, cycling continues after a correct answer so other players can also buzz.</p>
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
        ${renderBingoAllowMultipleCorrectToggle(settings)}
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
        const names = members.map(m => escapeHtml(getPlayerName(m))).join(", ");
        return `<div><strong>Team ${teamColor}</strong> <small>(${names})</small>: ${collected || "none"} (${count}/${items.length})</div>`;
      }).filter(Boolean).join("")
    : nonController.map(p => {
        const collected = (bingo.playerItems?.[p.id] || []).map(i => items[i]).join(", ");
        const count = (bingo.collectedCounts?.[p.id] || 0);
        return `<div><strong>${escapeHtml(getPlayerName(p))}</strong>: ${collected || "none"} (${count}/${items.length})</div>`;
      }).join("");
  const winnerLabel = (() => {
    const raw = getCoopBingoWinnerLabel(bingo.winner, players);
    return raw ? escapeHtml(raw) : null;
  })();
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
      ${isWen ? "" : `<div class="bingo-progress"><h3>Progress</h3>${progressHtml || '<p class="muted">No players yet.</p>'}</div>`}
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
    const isMine = isWen ? false : collected.includes(i);
    let cls = "bingo-tile";
    if (isLit) cls += " is-lit";
    if (isMine) cls += " is-mine";
    return `<span class="${cls}">${item}</span>`;
  }).join("");
  const canBuzz = bingo.active && bingo.cycling && !isControllerPlayer() && !isCohost() && activeViewer;
  const coopActive = isCoopMode(settings);
  const waitHint = bingo.active && bingo.cycling && settings.bingoAlternateViewers && isSharedTeam && !activeViewer
    ? `<p class="muted bingo-wait-hint">${getSnark("player.bingo.waitForTeammate", "Wait for your teammate to call the letter!")}</p>`
    : "";
  const notice = getRecentBuzzNotice();
  const scores = getScores();
  const myScore = coopActive
    ? getCoopGroupTotal(mePlayer.id, scores)
    : scores[getScoreKeyForPlayer(mePlayer.id, settings, assignments)] || 0;
  const winnerLabel = (() => {
    const raw = getCoopBingoWinnerLabel(bingo.winner, currentParticipants());
    return raw ? escapeHtml(raw) : null;
  })();
  return `
    <section class="card player-card bingo-player-card">
      <h2>${isWen ? "Wen Dit Happn" : "Bingo"} ${teamPill}</h2>
      ${isWen ? "" : `<p class="muted">${getSnark("player.bingo.collectedLabel", "Collected")}: ${collected.length}/${items.length}</p>`}
      <div class="bingo-tile-grid ${isWen ? "bingo-three" : "bingo-five"}">${tilesHtml}</div>
      ${coopActive && !isControllerPlayer() && !isCohost() ? renderCoopBingoBuzzRow(settings, mePlayer, bingo, activeViewer, canBuzz) : `
      <div class="bingo-buzz-area">
        <button type="button" class="bingo-buzz-btn" data-bingo-buzz ${canBuzz ? "" : "disabled"}>BUZZ${canBuzz ? "!" : ""}</button>
        ${waitHint}
        ${notice ? `<p class="muted bingo-notice">${notice}</p>` : ""}
      </div>`}
      <p class="muted">${getSnark("player.bingo.score", `Score: <strong>${myScore}</strong>`, { points: `<strong>${myScore}</strong>` })}</p>
      ${winnerLabel ? `<p class="bingo-winner-msg">${getSnark("player.bingo.winnerMsg", `${winnerLabel} wins!`, { winner: winnerLabel })}</p>` : ""}
    </section>`;
}

// Coop bingo buzz row — one BUZZ button per live slot with its own name, key
// hint and collected count. Siblings of a correct scorer stay locked until
// the host sets the next target.
function renderCoopBingoBuzzRow(settings, mePlayer, bingo, activeViewer, canBuzz) {
  const deviceId = mePlayer.id;
  const count = getCoopSlotCount(deviceId);
  const lockout = bingo.coopLockout || {};
  const cols = [];
  for (let slot = 0; slot < count; slot++) {
    const key = getCoopScoreKey(deviceId, slot);
    const name = getCoopSlotName(deviceId, slot);
    const hint = getCoopKeyHint(slot, count);
    const collected = ((bingo.playerItems || {})[key] || []).length;
    const locked = lockout[deviceId] && lockout[deviceId] !== key;
    const muted = isCoopSlotMuted(settings, deviceId, slot);
    const off = !canBuzz || !activeViewer || locked || muted;
    cols.push(`
      <div class="coop-slot${locked ? " is-locked" : ""}">
        <div class="coop-slot-head">${getCoopCharHtml(slot, getCoopCharMoodForKey(key, getRound()))}<strong>${escapeHtml(name)}</strong><kbd>${hint}</kbd></div>
        <p class="muted">${isWenDitHapnMode() ? "" : `${collected}/${bingo.items.length} · `}${locked ? getSnark("player.coop.bingoSiblingLocked", "Teammate collected — wait for the next round.") : ""}</p>
        <button type="button" class="bingo-buzz-btn" data-bingo-buzz data-coop-slot="${slot}" ${off ? "disabled" : ""}>BUZZ${off ? "" : "!"}</button>
      </div>`);
  }
  return `<div class="bingo-buzz-area"><div class="coop-buzz-row coop-buzz-${count}">${cols.join("")}</div></div>`;
}

function getCoopBingoWinnerLabel(winner, players) {
  if (!winner) return null;
  if (TEAM_COLORS.includes(winner)) return `Team ${winner}`;
  const parsed = parseCoopScoreKey(winner);
  if (parsed) return getCoopSlotName(parsed.deviceId, parsed.slot);
  const found = players.find((p) => p.id === winner);
  return found ? getPlayerName(found) : null;
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
        const names = members.map(m => escapeHtml(getPlayerName(m))).join(", ");
        return `<li><span class="team-pill team-${teamColor}">${teamColor}</span> <small>(${names})</small> ${isWen ? getSnark("audience.bingo.score", `Score: ${s}`, { points: s }) : getSnark("audience.bingo.lettersScore", `${c}/${items.length} letters — ${s}pts`, { collected: c, items: items.length, points: s })}</li>`;
      }).filter(Boolean).join("");
  } else if (isCoopMode(settings)) {
    const entries = [];
    visible.forEach((p) => {
      const count = getCoopSlotCount(p.id);
      for (let slot = 0; slot < count; slot++) {
        const key = getCoopScoreKey(p.id, slot);
        entries.push({
          label: `${escapeHtml(getCoopGroupName(p.id, getPlayerName(p)))} — ${escapeHtml(getCoopSlotName(p.id, slot))}`,
          c: (bingo.collectedCounts?.[key] || 0),
          s: scores[key] || 0,
        });
      }
    });
    entries.sort((a, b) => isWen ? b.s - a.s : b.c - a.c);
    standings = entries.map(({ label, c, s }) => {
      return `<li><strong>${label}</strong> ${isWen ? getSnark("audience.bingo.score", `Score: ${s}`, { points: s }) : getSnark("audience.bingo.lettersScore", `${c}/${items.length} letters — ${s}pts`, { collected: c, items: items.length, points: s })}</li>`;
    }).join("");
  } else {
    const sorted = visible
      .sort((a, b) => {
        if (isWen) return (scores[b.id] || 0) - (scores[a.id] || 0);
        return (bingo.collectedCounts?.[b.id] || 0) - (bingo.collectedCounts?.[a.id] || 0);
      });
    standings = sorted.map(p => {
      const c = (bingo.collectedCounts?.[p.id] || 0);
      const s = scores[p.id] || 0;
      return `<li><strong>${escapeHtml(getPlayerName(p))}</strong> ${isWen ? getSnark("audience.bingo.score", `Score: ${s}`, { points: s }) : getSnark("audience.bingo.lettersScore", `${c}/${items.length} letters — ${s}pts`, { collected: c, items: items.length, points: s })}</li>`;
    }).join("");
  }
  const winnerLabel = (() => {
    const raw = getCoopBingoWinnerLabel(bingo.winner, players);
    return raw ? escapeHtml(raw) : null;
  })();
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
    // Coopertition timed one-play: the lowest-scoring individual is auto-picked
    // (host may override by picking any sub-player below).
    const coopActive = isCoopMode(settings);
    const autoPickKey = coopActive ? getDisOrDatLowestCoopKey(settings) : null;
    const pickButtons = coopActive
      ? getDisOrDatTracks(settings, assignments, nonController).map((key) => {
          const auto = key === autoPickKey ? " is-auto" : "";
          return `<button type="button" class="primary-action${auto}" data-disordat-pick-player="${escapeHtml(key)}">${escapeHtml(getCoopKeyDisplayName(key, nonController))}${auto ? " (last place)" : ""}</button>`;
        }).join("") || '<p class="muted">No players in the room yet.</p>'
      : isSharedTeam
      ? TEAM_COLORS.map(teamColor => {
          const members = getTeamMembers(teamColor, players, assignments);
          if (members.length === 0) return "";
          const names = members.map(m => escapeHtml(getPlayerName(m))).join(", ");
          return `<button type="button" class="primary-action team-${teamColor}" data-disordat-pick-player="${teamColor}">Team ${teamColor} <small>(${names})</small></button>`;
        }).join("") || '<p class="muted">No teams assigned yet.</p>'
      : nonController.map(p => `<button type="button" class="primary-action" data-disordat-pick-player="${p.id}">${escapeHtml(getPlayerName(p))}</button>`).join("") || '<p class="muted">No players in the room yet.</p>';
    const pickMenu = dd.pendingPick ? `
      <div class="disordat-pick">
        <h3>${isSharedTeam ? "Which team plays this Dis or Dat?" : "Who plays this Dis or Dat?"}</h3>
        <div class="host-actions">
          ${pickButtons}
        </div>
      </div>
    ` : "";
    const timedOptionsHtml = DIS_OR_DAT_TIMED_OPTIONS.map(opt => `<option value="${opt}" ${dd.timedSeconds === opt ? "selected" : ""}>${opt} seconds</option>`).join("");
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
          <label>Timed mode duration
            <select id="disordat-timed-seconds">
              ${timedOptionsHtml}
            </select>
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

  const coopActivePanel = isCoopMode(settings);
  const activeTrack = dd.mode === "onePlayTimed"
    ? (coopActivePanel ? dd.activeCoopKey : getTeamTrackKey(dd.activePlayerId, settings, assignments))
    : null;
  const trackRows = (activeTrack ? [activeTrack] : getDisOrDatTracks(settings, assignments, nonController))
    .map(track => {
      const resps = dd.responses[track] || [];
      const correctCount = resps.filter((a, i) => a === dd.answers[i]).length;
      const base = dd.pointsEarned[track] || 0;
      const bonus = dd.jackBonus[track] || 0;
      const answered = resps.filter(a => a === "dis" || a === "dat" || a === "both").length;
      const missing = dd.phase === "results" ? (DIS_OR_DAT_QUESTION_COUNT - answered) : 0;
      const penalty = missing * DIS_OR_DAT_CORRECT_POINTS;
      const total = base - penalty + bonus;
      const rep = nonController.find(p => getTeamTrackKey(p.id, settings, assignments) === track) || null;
      const label = coopActivePanel
        ? escapeHtml(getCoopKeyDisplayName(track, nonController))
        : TEAM_COLORS.includes(track)
          ? `Team ${track}` + (rep ? ` <small>(${escapeHtml(getPlayerName(rep))})</small>` : "")
          : escapeHtml(getPlayerName(rep) || track);
      return { track, correctCount, base, bonus, total, label };
    })
    .sort((a, b) => b.total - a.total);

  if (dd.phase === "results") {
    const rows = trackRows.map(({ track, correctCount, base, bonus, label }) => {
      const resps = (getDisOrDat().responses[track] || []);
      const answered = resps.filter(a => a === "dis" || a === "dat" || a === "both").length;
      const missing = DIS_OR_DAT_QUESTION_COUNT - answered;
      const penalty = missing * DIS_OR_DAT_CORRECT_POINTS;
      const total = base - penalty + bonus;
      const missedTxt = missing > 0 ? `, ${missing} missed (-${penalty})` : "";
      return `<li><strong>${label}</strong> — ${correctCount}/${DIS_OR_DAT_QUESTION_COUNT} correct${missedTxt}, ${base} pts${isTimed ? ` + ${bonus} bonus` : ""} = <strong>${total} pts</strong></li>`;
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
  const activePlayer = trackRows.length > 0 && dd.mode === "onePlayTimed" && !coopActivePanel
    ? nonController.find(p => getTeamTrackKey(p.id, settings, assignments) === trackRows[0].track)
    : null;
  const activeLabel = dd.mode === "onePlayTimed" && trackRows.length > 0
    ? (coopActivePanel
        ? `Player: <strong>${escapeHtml(getCoopKeyDisplayName(trackRows[0].track, nonController))}</strong>`
        : TEAM_COLORS.includes(trackRows[0].track)
          ? `Team <strong>${escapeHtml(trackRows[0].track)}</strong>`
          : activePlayer ? `Player: <strong>${escapeHtml(getPlayerName(activePlayer))}</strong>` : "")
    : "";

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

  if (isCoopMode(settings) && !isControllerPlayer() && !isCohost()) {
    return renderCoopDisOrDatPlayerPanel(settings, mePlayer, dd, isTimed, isOnePlay);
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
    const answered = myResponses.filter(a => a === "dis" || a === "dat" || a === "both").length;
    const missing = DIS_OR_DAT_QUESTION_COUNT - answered;
    const penalty = missing * DIS_OR_DAT_CORRECT_POINTS;
    const total = points - penalty + bonus;
    const missedTxt = missing > 0 ? `, ${missing} missed (-${penalty})` : "";
    body = `
      <div class="disordat-results">
        <h3>${getSnark("player.disdat.resultsTitle", "Results")}</h3>
        <p class="muted">${getSnark("player.disdat.correctCount", `${correctCount}/${DIS_OR_DAT_QUESTION_COUNT} correct`, { correct: correctCount, total: DIS_OR_DAT_QUESTION_COUNT })}${missedTxt}</p>
        <p>Base: <strong>${points}</strong>${missedTxt ? ` - <strong>${penalty}</strong> missed` : ""}${isTimed ? ` + Bonus: <strong>${bonus}</strong>` : ""} = <strong>${total}</strong> pts</p>
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

// Coop Dis or Dat player panel. Timed one-play is answered by the picked slot
// only; host-paced is buzz-and-select per slot; timed all-play gives every
// slot its own diamond.
function renderCoopDisOrDatPlayerPanel(settings, mePlayer, dd, isTimed, isOnePlay) {
  const deviceId = mePlayer.id;
  const count = getCoopSlotCount(deviceId);
  const group = getCoopGroupName(deviceId, getPlayerName(mePlayer));
  const head = `<h2>Dis or Dat — ${escapeHtml(group)}</h2>
    <div class="disordat-labels"><span class="dis">${escapeHtml(dd.disLabel || "Dis")}</span> or <span class="dat">${escapeHtml(dd.datLabel || "Dat")}</span></div>`;

  const diamondFor = (slot, q) => {
    const key = getCoopScoreKey(deviceId, slot);
    const myResponses = dd.responses[key] || [];
    const bothShown = dd.answers.some((a) => a === "both");
    const myAnswer = myResponses[q];
    const answered = myAnswer === "dis" || myAnswer === "dat" || myAnswer === "both";
    const isCorrect = answered && myAnswer === dd.answers[q];
    const btn = (value, pos, label) => {
      const chosen = myAnswer === value;
      const resultCls = answered ? (isCorrect ? " is-correct" : " is-wrong") : "";
      const chosenCls = chosen ? " is-chosen" : "";
      return `<button type="button" class="disordat-answer-btn ${pos}${resultCls}${chosenCls}" data-disordat-answer data-q="${q}" data-answer="${value}" data-coop-slot="${slot}" ${answered ? "disabled" : ""}>${escapeHtml(label)}</button>`;
    };
    return `
      <div class="abxy-diamond disordat-diamond">
        ${btn("dis", "pos-x", dd.disLabel || "Dis")}
        ${btn("dat", "pos-b", dd.datLabel || "Dat")}
        ${bothShown ? btn("both", "pos-a", "Both") : ""}
        <div class="diamond-center disordat-diamond-center">${answered ? (isCorrect ? "✓" : "✗") : `Q${q + 1}`}</div>
      </div>`;
  };

  const resultsFor = (slot) => {
    const key = getCoopScoreKey(deviceId, slot);
    const myResponses = dd.responses[key] || [];
    const correctCount = myResponses.filter((a, i) => a === dd.answers[i]).length;
    const answered = myResponses.filter((a) => a === "dis" || a === "dat" || a === "both").length;
    const missing = DIS_OR_DAT_QUESTION_COUNT - answered;
    const points = dd.pointsEarned[key] || 0;
    const bonus = dd.jackBonus[key] || 0;
    const total = points - missing * DIS_OR_DAT_CORRECT_POINTS + bonus;
    return `<div class="coop-slot"><div class="coop-slot-head"><strong>${escapeHtml(getCoopSlotName(deviceId, slot))}</strong></div>
      <p class="muted">${correctCount}/${DIS_OR_DAT_QUESTION_COUNT} correct = <strong>${total}</strong> pts</p></div>`;
  };

  if (dd.phase === "results") {
    const cols = [];
    for (let slot = 0; slot < count; slot++) cols.push(resultsFor(slot));
    return `<section class="card player-card disordat-player-card">${head}
      <h3>${getSnark("player.disdat.resultsTitle", "Results")}</h3>
      <div class="coop-buzz-row coop-buzz-${count}">${cols.join("")}</div>
      <p class="muted">${getSnark("player.disdat.waitingHostContinue", "Waiting for the host to continue...")}</p></section>`;
  }

  if (isOnePlay) {
    const myKeys = [];
    for (let slot = 0; slot < count; slot++) myKeys.push(getCoopScoreKey(deviceId, slot));
    if (!myKeys.includes(dd.activeCoopKey)) {
      const activeLabel = dd.activeCoopKey ? escapeHtml(getCoopKeyDisplayName(dd.activeCoopKey)) : "A player";
      return `<section class="card player-card">${head}<p class="muted">${getSnark("player.disdat.watchPlayer", `${activeLabel} is playing this round. Sit back and watch!`, { player: activeLabel })}</p></section>`;
    }
    const slot = parseCoopScoreKey(dd.activeCoopKey)?.slot ?? 0;
    const key = getCoopScoreKey(deviceId, slot);
    const myResponses = dd.responses[key] || [];
    const answeredCount = myResponses.filter((a) => a === "dis" || a === "dat" || a === "both").length;
    const answeredAll = answeredCount >= DIS_OR_DAT_QUESTION_COUNT;
    const revealShowing = answeredCount > 0 && now() < disOrDatRevealUntil;
    const currentQ = revealShowing ? answeredCount - 1 : Math.min(answeredCount, DIS_OR_DAT_QUESTION_COUNT - 1);
    return `<section class="card player-card disordat-player-card">${head}
      <p class="muted">${escapeHtml(getCoopSlotName(deviceId, slot))} is playing — <span data-disordat-time-left>${formatSeconds(getDisOrDatTimeLeftCs(dd))}s</span> left</p>
      <div class="disordat-diamond-wrap">${!answeredAll || revealShowing ? diamondFor(slot, currentQ) : ""}</div>
      ${answeredAll && !revealShowing ? `<p class="disordat-done">${getSnark("player.disdat.allAnswered", "All answered! Wait for results.")}</p>` : ""}</section>`;
  }

  if (!isTimed) {
    // Host-paced buzz-and-select.
    const q = dd.currentQuestion;
    const claims = dd.claims || {};
    const myClaimSlot = (() => {
      for (let slot = 0; slot < count; slot++) {
        if (claims[q] === getCoopScoreKey(deviceId, slot)) return slot;
      }
      return null;
    })();
    if (myClaimSlot !== null) {
      return `<section class="card player-card disordat-player-card">${head}
        <p class="muted">${getSnark("player.disdat.questionHostPaced", `Question ${q + 1} of ${DIS_OR_DAT_QUESTION_COUNT}. The host advances when ready.`, { current: q + 1, total: DIS_OR_DAT_QUESTION_COUNT })}</p>
        <p class="muted">${escapeHtml(getCoopSlotName(deviceId, myClaimSlot))} claimed Q${q + 1} — answer now.</p>
        <div class="disordat-diamond-wrap">${diamondFor(myClaimSlot, q)}</div></section>`;
    }
    if (claims[q]) {
      const claimLabel = escapeHtml(getCoopKeyDisplayName(claims[q]));
      return `<section class="card player-card">${head}<p class="muted">${getSnark("player.disdat.claimedWait", `${claimLabel} claimed this question.`, { player: claimLabel })}</p></section>`;
    }
    const claimBtns = [];
    for (let slot = 0; slot < count; slot++) {
      if (isCoopSlotMuted(settings, deviceId, slot)) continue;
      claimBtns.push(`<button type="button" class="bingo-buzz-btn" data-disordat-claim data-q="${q}" data-coop-slot="${slot}">${escapeHtml(getCoopSlotName(deviceId, slot))} <kbd>${getCoopKeyHint(slot, count)}</kbd></button>`);
    }
    return `<section class="card player-card disordat-player-card">${head}
      <p class="muted">${getSnark("player.disdat.claimPrompt", `Question ${q + 1}: buzz in to claim it!`, { current: q + 1 })}</p>
      <div class="coop-buzz-row coop-buzz-${count}">${claimBtns.map((b) => `<div class="coop-slot">${b}</div>`).join("")}</div></section>`;
  }

  // Timed all-play: every slot answers its own track.
  const cols = [];
  for (let slot = 0; slot < count; slot++) {
    const key = getCoopScoreKey(deviceId, slot);
    const myResponses = dd.responses[key] || [];
    const answeredCount = myResponses.filter((a) => a === "dis" || a === "dat" || a === "both").length;
    const answeredAll = answeredCount >= DIS_OR_DAT_QUESTION_COUNT;
    const revealShowing = answeredCount > 0 && now() < disOrDatRevealUntil;
    const currentQ = revealShowing ? answeredCount - 1 : Math.min(answeredCount, DIS_OR_DAT_QUESTION_COUNT - 1);
    cols.push(`<div class="coop-slot"><div class="coop-slot-head"><strong>${escapeHtml(getCoopSlotName(deviceId, slot))}</strong><kbd>${getCoopKeyHint(slot, count)}</kbd></div>
      <div class="disordat-diamond-wrap">${!answeredAll || revealShowing ? diamondFor(slot, currentQ) : `<p class="disordat-done">${getSnark("player.disdat.allAnswered", "All answered! Wait for results.")}</p>`}</div></div>`);
  }
  return `<section class="card player-card disordat-player-card">${head}
    <div class="disordat-timer">${getSnark("player.disdat.timeLeftLabel", "Time left")}: <strong data-disordat-time-left>${formatSeconds(getDisOrDatTimeLeftCs(dd))}s</strong></div>
    <div class="coop-buzz-row coop-buzz-${count}">${cols.join("")}</div></section>`;
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
      const answered = resps.filter(a => a === "dis" || a === "dat" || a === "both").length;
      const missing = dd.phase === "results" ? (DIS_OR_DAT_QUESTION_COUNT - answered) : 0;
      const penalty = missing * DIS_OR_DAT_CORRECT_POINTS;
      const base = dd.pointsEarned[track] || 0;
      const bonus = dd.jackBonus[track] || 0;
      const total = base - penalty + bonus;
      const rep = participants.find(p => getTeamTrackKey(p.id, settings, assignments) === track) || null;
      const label = TEAM_COLORS.includes(track)
        ? `Team ${track}` + (rep ? ` <small>(${escapeHtml(getPlayerName(rep))})</small>` : "")
        : escapeHtml(getPlayerName(rep) || track);
      return { track, correctCount, total, label, missing, penalty };
    })
    .sort((a, b) => b.total - a.total);
  const standings = tracks.map(({ correctCount, total, label, missing }) => {
    const missTxt = missing > 0 ? `, ${missing} missed` : "";
    return `<li><strong>${label}</strong> — ${correctCount}/${DIS_OR_DAT_QUESTION_COUNT}${missTxt} — ${total} pts</li>`;
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
// Fibbage — host / player / audience panels
// =============================================================================
function renderFibbageHostPanel(settings, players) {
  if (!hasHostPrivileges()) return `<section class="card host-panel"><p>Co-hosts cannot control Fibbage. The host must manage it.</p></section>`;
  const fb = getFibbage();
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  const assignments = normalizeTeamAssignments(getTeamAssignments(), players, controllerId);
  const isSharedTeam = settings.teamModeEnabled && settings.teamScoringMode === "shared";
  const eligibleTracks = getEligibleFibbageTrackKeys();
  const liesCount = Object.keys(fb.lies || {}).length;
  const timeOpts = FIBBAGE_TIMES.map((t) => `<option value="${t}" ${Number(fb.lieTimeSec)===t?"selected":""}>${t}s</option>`).join("");
  const voteTimeOpts = FIBBAGE_TIMES.map((t) => `<option value="${t}" ${Number(fb.voteTimeSec)===t?"selected":""}>${t}s</option>`).join("");
  const multOpts = Array.from({length:FIBBAGE_MAX_MULT},(_,i)=>i+1).map((m)=>`<option value="${m}" ${Number(fb.multiplier)===m?"selected":""}>${m}x</option>`).join("");
  if (!fb.active) {
    return `
      <section class="card host-panel bingo-host-panel" data-fibbage-active="true">
        <h2>Fibbage Setup</h2>
        <p class="muted">Set the truth (required), pick timers and multiplier, then press Enter Lies. Players submit fakes, you block bad ones, then Show Responses.</p>
        <div class="control-grid">
          <label>Lie timer
            <select id="fibbage-lie-time">${timeOpts}</select>
          </label>
          <label>Vote timer
            <select id="fibbage-vote-time">${voteTimeOpts}</select>
          </label>
          <label>Multiplier
            <select id="fibbage-mult">${multOpts}</select>
            <p class="setting-helper">500 per fool, 1000 for truth, multiplied.</p>
          </label>
        </div>
        <label>Truth (required before lying)
          <input type="text" id="fibbage-truth" maxlength="120" value="${escapeHtml(fb.truth||"")}" placeholder="The true answer" />
        </label>
        <div class="host-actions" style="margin-top:0.6rem">
          <button type="button" class="primary-action" data-fibbage-enter-lies ${eligibleTracks.length<2?"disabled":""}>Enter Lies (${eligibleTracks.length} eligible)</button>
          <button type="button" data-fibbage-set-truth>Set Truth</button>
        </div>
        ${eligibleTracks.length<2?'<p class="setting-helper">Need at least 2 eligible players.</p>':""}
        <div class="host-actions" style="margin-top:0.6rem"><button type="button" data-fibbage-exit>Return to buzzer mode</button></div>
      </section>`;
  }
  if (fb.phase === "lying") {
    const timeLeft = formatSeconds(getFibbageLieTimeLeftCs(fb));
    const lieRows = eligibleTracks.map((trackKey)=>{
      const raw = fb.lies[trackKey] || "";
      const isBlocked = !!fb.blocked[trackKey];
      const err = fb.lieErrors[trackKey] || "";
      const label = TEAM_COLORS.includes(trackKey) ? `Team ${trackKey}` : escapeHtml(players.find((p)=>p.id===trackKey)? getPlayerName(players.find((p)=>p.id===trackKey)) : trackKey);
      const status = raw ? (isBlocked? "blocked" : "submitted") : "waiting";
      return `<div class="fibbage-lie-row ${isBlocked?"is-blocked":""}">
        <strong>${escapeHtml(label)}</strong>
        <span class="muted">${status}</span>
        <span>${raw ? `"${escapeHtml(raw)}"` : "<em>—</em>"}</span>
        ${err?`<span class="error-text">${escapeHtml(err)}</span>`:""}
        <button type="button" class="toggle-chip ${isBlocked?"is-off":"is-on"}" data-fibbage-block="${trackKey}">${isBlocked?"Unblock":"Block"}</button>
      </div>`;
    }).join("") || '<p class="muted">No eligible tracks.</p>';
    return `
      <section class="card host-panel bingo-host-panel" data-fibbage-active="true">
        <h2>Fibbage — Lying (${timeLeft}s left)</h2>
        <p class="muted">Players are submitting lies. Block bad ones — truth is locked from before lying started.</p>
        <p>Time left: <strong data-fibbage-time-left>${timeLeft}s</strong> — ${liesCount}/${eligibleTracks.length} lies</p>
        <p>Truth: <strong>"${escapeHtml(fb.truth)}"</strong></p>
        <div class="fibbage-lie-list">${lieRows}</div>
        <div class="host-actions">
          <button type="button" data-fibbage-end-lying>End Lying Early</button>
          <button type="button" data-fibbage-exit>Return to buzzer mode</button>
        </div>
      </section>`;
  }
  if (fb.phase === "review") {
    const lieRows = eligibleTracks.map((trackKey)=>{
      const raw = fb.lies[trackKey] || "";
      const isBlocked = !!fb.blocked[trackKey];
      const label = TEAM_COLORS.includes(trackKey) ? `Team ${trackKey}` : escapeHtml(players.find((p)=>p.id===trackKey)? getPlayerName(players.find((p)=>p.id===trackKey)) : trackKey);
      return `<div class="fibbage-lie-row ${isBlocked?"is-blocked":""}">
        <strong>${escapeHtml(label)}</strong>
        <span>${raw ? `"${escapeHtml(raw)}"` : "<em>—</em>"}</span>
        <button type="button" class="toggle-chip ${isBlocked?"is-off":"is-on"}" data-fibbage-block="${trackKey}">${isBlocked?"Unblock":"Block"}</button>
      </div>`;
    }).join("");
    return `
      <section class="card host-panel bingo-host-panel" data-fibbage-active="true">
        <h2>Fibbage — Review</h2>
        <p class="muted">Lying ended. Truth is locked: <strong>"${escapeHtml(fb.truth)}"</strong> — block rejects (final), then Show Responses.</p>
        <div class="fibbage-lie-list">${lieRows || '<p class="muted">No lies.</p>'}</div>
        <div class="host-actions">
          <button type="button" class="primary-action" data-fibbage-show-responses>Show Responses</button>
          <button type="button" data-fibbage-reset>Reset Fibbage</button>
          <button type="button" data-fibbage-exit>Return to buzzer mode</button>
        </div>
      </section>`;
  }
  if (fb.phase === "voting_ready") {
    const choicesHtml = (fb.choices||[]).map((c,i)=>`<li>"${escapeHtml(c.text)}" ${c.isTruth?'<span class="muted">(truth)</span>':`<span class="muted">by ${c.authorKeys.map((k)=> TEAM_COLORS.includes(k)?`Team ${k}`: escapeHtml(players.find((p)=>p.id===k)?getPlayerName(players.find((p)=>p.id===k)):k)).join(" + ")}</span>`}</li>`).join("");
    return `
      <section class="card host-panel bingo-host-panel" data-fibbage-active="true">
        <h2>Fibbage — Responses Ready</h2>
        <p class="muted">Choices shuffled. Press Start Timer to let players vote (${fb.voteTimeSec}s, ends early if all vote).</p>
        <ul class="fibbage-choices-list">${choicesHtml}</ul>
        <div class="host-actions">
          <button type="button" class="primary-action" data-fibbage-start-vote>Start Timer</button>
          <button type="button" data-fibbage-reset>Reset</button>
        </div>
      </section>`;
  }
  if (fb.phase === "voting") {
    const timeLeft = formatSeconds(getFibbageVoteTimeLeftCs(fb));
    const votedCount = Object.keys(fb.votes||{}).length;
    const choices = fb.choices||[];
    const voteMap = {};
    Object.entries(fb.votes||{}).forEach(([tk,idx])=>{ const n=Number(idx); voteMap[n]=voteMap[n]||[]; voteMap[n].push(tk); });
    const rows = choices.map((c,i)=>{
      const voters = voteMap[i]||[];
      return `<li>"${escapeHtml(c.text)}" — <span class="muted">${voters.length} vote${voters.length===1?"":"s"}</span></li>`;
    }).join("");
    return `
      <section class="card host-panel bingo-host-panel" data-fibbage-active="true">
        <h2>Fibbage — Voting (${timeLeft}s)</h2>
        <p>Time left: <strong data-fibbage-time-left>${timeLeft}s</strong> — ${votedCount}/${eligibleTracks.length} voted</p>
        <ul class="fibbage-choices-list">${rows}</ul>
        <p class="muted">Votes hidden until reveal. After voting ends, use Show All or Spotlight to reveal.</p>
        <div class="host-actions"><button type="button" data-fibbage-exit>Return to buzzer mode</button></div>
      </section>`;
  }
  if (fb.phase === "results") {
    const choices = fb.choices||[];
    const voteMap = {};
    Object.entries(fb.votes||{}).forEach(([tk,idx])=>{ const n=Number(idx); voteMap[n]=voteMap[n]||[]; voteMap[n].push(tk); });
    const revealed = fb.revealed||{all:false,singleIdx:null,revealedIdxs:[]};
    const points = fb.pointsEarned||{};
    const pointsRows = eligibleTracks.map((tk)=>{
      const label = TEAM_COLORS.includes(tk)?`Team ${tk}`: escapeHtml(players.find((p)=>p.id===tk)?getPlayerName(players.find((p)=>p.id===tk)):tk);
      const pts = points[tk]||0;
      const lieChoice = choices.find((c)=>c.authorKeys.includes(tk));
      const lieText = lieChoice? lieChoice.text : (fb.lies[tk]|| (fb.blocked[tk]?"[blocked]":"—"));
      const votedIdx = fb.votes[tk];
      const votedText = Number.isInteger(Number(votedIdx)) && choices[Number(votedIdx)] ? choices[Number(votedIdx)].text : "—";
      return `<li><strong>${escapeHtml(label)}</strong>: lie "${escapeHtml(lieText)}", voted "${escapeHtml(votedText)}" — <strong>${pts} pts</strong></li>`;
    }).join("");
    const hasAudience = hasAudienceDisplay();
    const choicesWithMeta = choices.map((c,i)=>{
      const voters = voteMap[i]||[];
      const voterLabels = voters.map((tk)=> TEAM_COLORS.includes(tk)?`Team ${tk}`: escapeHtml(players.find((p)=>p.id===tk)?getPlayerName(players.find((p)=>p.id===tk)):tk)).join(", ") || "none";
      const authorLabels = c.isTruth? "TRUTH" : c.authorKeys.map((k)=> TEAM_COLORS.includes(k)?`Team ${k}`: escapeHtml(players.find((p)=>p.id===k)?getPlayerName(players.find((p)=>p.id===k)):k)).join(" + ");
      const isRevealed = revealed.all || revealed.singleIdx===i || (revealed.revealedIdxs||[]).includes(i);
      let colorCls="";
      if (isRevealed) {
        if (c.isTruth) colorCls="is-truth";
        else if (voters.length>0) colorCls="is-lie-picked";
        else colorCls="is-lie-unpicked";
      }
      const spotlightBtn = (!revealed.all) ? `<button type="button" data-fibbage-spotlight="${i}">Spotlight</button>` : "";
      const authorPart = isRevealed ? `<span class="muted">— ${escapeHtml(authorLabels)}</span>` : "";
      const voterPart = isRevealed ? `<span class="muted">picked by: ${escapeHtml(voterLabels)} (${voters.length})</span>` : `<span class="muted">${voters.length} vote${voters.length===1?"":"s"} — hidden</span>`;
      return `<li class="fibbage-choice ${colorCls}" data-fibbage-choice="${i}">
        "${escapeHtml(c.text)}"
        ${authorPart}
        ${voterPart}
        ${spotlightBtn}
      </li>`;
    }).join("");
    const pointsSection = revealed.all ? `<ul class="fibbage-points">${pointsRows || '<li class="muted">No points.</li>'}</ul>` : `<p class="muted">Points hidden until Show All.</p>`;
    const spotlightNote = hasAudience ? " Spotlight one for big screen (audience display must be connected to see big card)." : " Spotlight will appear on audience display when connected.";
    return `
      <section class="card host-panel bingo-host-panel" data-fibbage-active="true">
        <h2>Fibbage — Results</h2>
        <p class="muted">Picks hidden until revealed. Show All colors: <span style="color:var(--green)">green</span> truth, <span style="color:var(--red)">red</span> lie with picks, <span style="color:#eab308">yellow</span> unpicked.${spotlightNote}</p>
        <ul class="fibbage-choices-list" style="margin:0.6rem 0">${choicesWithMeta}</ul>
        <div class="host-actions">
          <button type="button" class="primary-action" data-fibbage-show-all>Show All</button>
          <button type="button" data-fibbage-spotlight-clear>Clear Spotlight</button>
          <button type="button" data-fibbage-reset>Play Again</button>
          <button type="button" data-fibbage-exit>Return to buzzer mode</button>
        </div>
        ${pointsSection}
      </section>`;
  }
  return `<section class="card host-panel"><p>Fibbage phase: ${escapeHtml(fb.phase)}</p></section>`;
}
function renderFibbagePlayerPanel(settings, mePlayer) {
  const fb = getFibbage();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), currentParticipants(), getControllerId());
  const isSharedTeam = settings.teamModeEnabled && settings.teamScoringMode === "shared";
  const trackKey = getTeamTrackKey(mePlayer.id, settings, assignments);
  const myTeamColor = getPlayerTeamColor(mePlayer.id, assignments);
  const teamPill = isSharedTeam && myTeamColor ? `<span class="team-pill team-${myTeamColor}">${myTeamColor}</span>` : "";
  if (isControllerPlayer() || isCohost()) {
    return `<section class="card player-card"><h2>Fibbage ${teamPill}</h2><p class="muted">Host/Co-host has no lie input.</p></section>`;
  }
  if (settings.teamModeEnabled && !myTeamColor) {
    return `<section class="card player-card"><h2>Fibbage</h2><p class="muted">${getSnark("player.buzzer.waitingTeamAssignment","Waiting For Team Assignment")}</p></section>`;
  }
  if (!fb.active) {
    return `<section class="card player-card"><h2>Fibbage ${teamPill}</h2><p class="muted">${getSnark("player.fibbage.waitingHost","Waiting for the host to start...")}</p></section>`;
  }
  const notice = getRecentBuzzNotice();
  if (fb.phase === "lying") {
    const already = fb.lies[trackKey] !== undefined;
    const blocked = !!fb.blocked[trackKey];
    const err = fb.lieErrors[trackKey] || "";
    const timeLeft = formatSeconds(getFibbageLieTimeLeftCs(fb));
    if (blocked) return `<section class="card player-card"><h2>Fibbage ${teamPill}</h2><p class="muted">Your lie was blocked by the host.</p></section>`;
    if (already) return `<section class="card player-card"><h2>Fibbage ${teamPill}</h2><p class="muted">Lie submitted: "${escapeHtml(fb.lies[trackKey])}"</p><p class="muted">Time left: <strong data-fibbage-time-left>${timeLeft}s</strong></p>${notice?`<p class="muted">${notice}</p>`:""}</section>`;
    return `
      <section class="card player-card">
        <h2>Fibbage ${teamPill}</h2>
        <p class="muted">Write a lie to fool other players. Time left: <strong data-fibbage-time-left>${timeLeft}s</strong></p>
        ${err?`<p class="error-text">${escapeHtml(err)}</p>`:""}
        ${notice?`<p class="muted">${notice}</p>`:""}
        <div class="text-entry">
          <input id="fibbage-lie-entry" type="text" maxlength="120" placeholder="Type your lie" />
          <button type="button" data-fibbage-submit-lie>Submit Lie</button>
        </div>
      </section>`;
  }
  if (fb.phase === "review" || fb.phase === "voting_ready") {
    return `<section class="card player-card"><h2>Fibbage ${teamPill}</h2><p class="muted">Waiting for host to show responses...</p></section>`;
  }
  if (fb.phase === "voting") {
    const alreadyVoted = fb.votes[trackKey] !== undefined;
    const timeLeft = formatSeconds(getFibbageVoteTimeLeftCs(fb));
    if (alreadyVoted) {
      const idx = fb.votes[trackKey];
      const choice = (fb.choices||[])[Number(idx)];
      return `<section class="card player-card"><h2>Fibbage ${teamPill}</h2><p class="muted">You voted for "${escapeHtml(choice?choice.text:"")}"</p><p class="muted">Time left: <strong data-fibbage-time-left>${timeLeft}s</strong></p></section>`;
    }
    const choices = fb.choices||[];
    const buttons = choices.map((c,i)=>{
      const isOwn = c.authorKeys.includes(trackKey);
      return `<button type="button" class="fibbage-vote-btn" data-fibbage-vote="${i}" ${isOwn?"disabled":""}>${escapeHtml(c.text)}${isOwn?' (your lie)':''}</button>`;
    }).join("");
    return `
      <section class="card player-card">
        <h2>Fibbage — Vote ${teamPill}</h2>
        <p class="muted">Pick the truth. You cannot pick your own lie. Time left: <strong data-fibbage-time-left>${timeLeft}s</strong></p>
        ${notice?`<p class="muted">${notice}</p>`:""}
        <div class="fibbage-vote-list">${buttons}</div>
      </section>`;
  }
  if (fb.phase === "results") {
    const choices = fb.choices||[];
    const voteMap = {};
    Object.entries(fb.votes||{}).forEach(([tk,idx])=>{ const n=Number(idx); voteMap[n]=voteMap[n]||[]; voteMap[n].push(tk); });
    const revealed = fb.revealed||{all:false,singleIdx:null,revealedIdxs:[]};
    const pts = (fb.pointsEarned||{})[trackKey]||0;
    const players = currentParticipants();
    const list = choices.map((c,i)=>{
      const voters = voteMap[i]||[];
      const authorLabels = c.isTruth? "TRUTH" : c.authorKeys.map((k)=> TEAM_COLORS.includes(k)?`Team ${k}`: escapeHtml(players.find((p)=>p.id===k)?getPlayerName(players.find((p)=>p.id===k)):k)).join(" + ");
      const isRevealed = revealed.all || revealed.singleIdx===i || (revealed.revealedIdxs||[]).includes(i);
      let cls="";
      if (isRevealed) {
        if (c.isTruth) cls="is-truth";
        else if (voters.length>0) cls="is-lie-picked";
        else cls="is-lie-unpicked";
      } else {
        cls="is-hidden";
      }
      const myVote = fb.votes[trackKey]===i ? " ← your pick" : "";
      return `<li class="fibbage-choice ${cls}">"${escapeHtml(c.text)}" <span class="muted">${isRevealed?`— ${escapeHtml(authorLabels)}`:""} ${myVote}</span></li>`;
    }).join("");
    return `
      <section class="card player-card">
        <h2>Fibbage — Results ${teamPill}</h2>
        <p class="muted">You earned <strong>${pts} pts</strong> (500 per fool, 1000 for truth, ×${fb.multiplier})</p>
        <ul class="fibbage-choices-list">${list}</ul>
        ${!revealed.all && revealed.singleIdx===null?'<p class="muted">Waiting for host to reveal...</p>':''}
      </section>`;
  }
  return `<section class="card player-card"><h2>Fibbage</h2><p>Phase ${escapeHtml(fb.phase)}</p></section>`;
}
function renderFibbageAudienceDisplay(settings, players) {
  const fb = getFibbage();
  const assignments = normalizeTeamAssignments(getTeamAssignments(), players, getControllerId());
  const isSharedTeam = settings.teamModeEnabled && settings.teamScoringMode === "shared";
  if (!fb.active) {
    return `<main class="layout audience-layout" data-fibbage-active="true"><header class="hero audience-hero"><div><p class="prejoin-kicker">Audience display</p><h1>Fibbage</h1><p class="muted">Waiting for the game to start...</p></div></header></main>`;
  }
  if (fb.phase === "lying") {
    const timeLeft = formatSeconds(getFibbageLieTimeLeftCs(fb));
    const eligible = getEligibleFibbageTrackKeys();
    const submitted = Object.keys(fb.lies||{}).length;
    return `<main class="layout audience-layout" data-fibbage-active="true">
      <header class="hero audience-hero"><div><p class="prejoin-kicker">Audience display</p><h1>Fibbage — Lying</h1><p class="muted">Players are writing lies</p></div><div class="hero-meta"><span class="audience-timer">${timeLeft}s</span><span>${submitted}/${eligible.length} lies</span></div></header>
      <section class="card"><h2>Lies submitted</h2><p class="muted">${submitted}/${eligible.length} — waiting for host to block/review.</p></section>
    </main>`;
  }
  if (fb.phase === "review") {
    return `<main class="layout audience-layout" data-fibbage-active="true"><header class="hero audience-hero"><div><p class="prejoin-kicker">Audience display</p><h1>Fibbage — Review</h1><p class="muted">Host is reviewing lies and truth</p></div></header></main>`;
  }
  if (fb.phase === "voting_ready") {
    const choices = fb.choices||[];
    const list = choices.map((c,i)=>`<li>"${escapeHtml(c.text)}"</li>`).join("");
    return `<main class="layout audience-layout" data-fibbage-active="true">
      <header class="hero audience-hero"><div><p class="prejoin-kicker">Audience display</p><h1>Fibbage — Vote</h1><p class="muted">Waiting for vote timer</p></div></header>
      <section class="card"><h2>Choices</h2><ul class="fibbage-choices-list">${list}</ul></section>
    </main>`;
  }
  if (fb.phase === "voting") {
    const timeLeft = formatSeconds(getFibbageVoteTimeLeftCs(fb));
    const choices = fb.choices||[];
    const list = choices.map((c,i)=>`<li>"${escapeHtml(c.text)}"</li>`).join("");
    return `<main class="layout audience-layout" data-fibbage-active="true">
      <header class="hero audience-hero"><div><p class="prejoin-kicker">Audience display</p><h1>Fibbage — Voting</h1></div><div class="hero-meta"><span class="audience-timer">${timeLeft}s</span></div></header>
      <section class="card"><h2>Choices</h2><ul class="fibbage-choices-list">${list}</ul></section>
    </main>`;
  }
  if (fb.phase === "results") {
    const choices = fb.choices||[];
    const voteMap = {};
    Object.entries(fb.votes||{}).forEach(([tk,idx])=>{ const n=Number(idx); voteMap[n]=voteMap[n]||[]; voteMap[n].push(tk); });
    const revealed = fb.revealed||{all:false,singleIdx:null};
    let focusIdx = revealed.singleIdx;
    if (focusIdx!==null && focusIdx!==undefined && choices[focusIdx]) {
      const c = choices[focusIdx];
      const voters = voteMap[focusIdx]||[];
      const voterLabels = voters.map((tk)=> TEAM_COLORS.includes(tk)?`Team ${tk}`: escapeHtml(players.find((p)=>p.id===tk)?getPlayerName(players.find((p)=>p.id===tk)):tk)).join(", ") || "none";
      const authorLabels = c.isTruth? "TRUTH" : c.authorKeys.map((k)=> TEAM_COLORS.includes(k)?`Team ${k}`: escapeHtml(players.find((p)=>p.id===k)?getPlayerName(players.find((p)=>p.id===k)):k)).join(" + ");
      let colorCls="";
      let badge="";
      if (c.isTruth) { colorCls="is-truth"; badge="TRUTH"; }
      else if (voters.length>0) { colorCls="is-lie-picked"; badge=`FOOLED ${voters.length}`; }
      else { colorCls="is-lie-unpicked"; badge="UNPICKED"; }
      return `<main class="layout audience-layout" data-fibbage-active="true">
        <header class="hero audience-hero" style="opacity:0.7"><div><p class="prejoin-kicker">Spotlight • ${badge}</p><h1 style="font-size:clamp(1.2rem,3vw,1.6rem); opacity:0.8">Fibbage</h1></div></header>
        <section class="card fibbage-spotlight ${colorCls}">
          <div>
            <div style="letter-spacing:0.18em; font-weight:900; font-size:0.85rem; opacity:0.9; margin-bottom:1rem">${badge}</div>
            <h2>"${escapeHtml(c.text)}"</h2>
            <div class="spotlight-meta">Picked by <strong>${escapeHtml(voterLabels)}</strong> — ${voters.length} vote${voters.length===1?"":"s"}</div>
            <div class="spotlight-author">— ${escapeHtml(authorLabels)}</div>
          </div>
        </section>
      </main>`;
    }
    const list = choices.map((c,i)=>{
      const voters = voteMap[i]||[];
      const voterLabels = voters.map((tk)=> TEAM_COLORS.includes(tk)?`Team ${tk}`: escapeHtml(players.find((p)=>p.id===tk)?getPlayerName(players.find((p)=>p.id===tk)):tk)).join(", ") || "none";
      const authorLabels = c.isTruth? "TRUTH" : c.authorKeys.map((k)=> TEAM_COLORS.includes(k)?`Team ${k}`: escapeHtml(players.find((p)=>p.id===k)?getPlayerName(players.find((p)=>p.id===k)):k)).join(" + ");
      let cls="";
      if (revealed.all) {
        if (c.isTruth) cls="is-truth";
        else if (voters.length>0) cls="is-lie-picked";
        else cls="is-lie-unpicked";
      }
      const showAuthor = revealed.all ? ` — ${escapeHtml(authorLabels)}` : "";
      const voterPart = revealed.all ? `<span class="muted">picked by ${escapeHtml(voterLabels)}</span>` : `<span class="muted">${voters.length} vote${voters.length===1?"":"s"} — hidden</span>`;
      return `<li class="fibbage-choice ${cls}">"${escapeHtml(c.text)}"${showAuthor} ${voterPart}</li>`;
    }).join("");
    const hideScores = shouldHideFibbageScores();
    const scoresHtml = hideScores ? "" : renderScores(players, getScores());
    return `<main class="layout audience-layout" data-fibbage-active="true">
      <header class="hero audience-hero"><div><p class="prejoin-kicker">Audience display</p><h1>Fibbage — Results</h1></div></header>
      <section class="card"><h2>All Choices ${revealed.all?"(revealed)":""}</h2><ul class="fibbage-choices-list">${list}</ul></section>
      ${scoresHtml}
    </main>`;
  }
  return `<main class="layout audience-layout" data-fibbage-active="true"><header class="hero audience-hero"><div><h1>Fibbage</h1><p>${escapeHtml(fb.phase)}</p></div></header></main>`;
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
// Coopertition player area — group setup gate, per-slot buzzers, shared text
// box, horizontal personal score strip. Slot order left-to-right: Q | B | P.
// =============================================================================
// Returns a blocking card (setup / mobile) when the device cannot play yet,
// otherwise null so the caller falls through to the mode-specific panel.
function renderCoopGate(settings, mePlayer) {
  if (!isCoopMode(settings)) return null;
  const roster = getMyCoopRoster();
  if (!roster || coopEditing) return renderCoopSetupCard(settings, mePlayer, roster);
  const count = getCoopSlotCount(mePlayer.id);
  if (count > 1 && isMobileDevice()) {
    return `
      <section class="card player-card coop-blocked-card">
        <h2>${getSnark("player.coop.mobileBlockedTitle", "Desktop play required")}</h2>
        <p class="muted">${getSnark("player.coop.mobileBlockedBody", "Groups of 2–3 need a keyboard (Q/B/P). Switch this device to 1 player or join from a computer.")}</p>
        <div class="host-actions"><button type="button" data-coop-edit>${getSnark("player.coop.editGroupButton", "Edit group")}</button></div>
      </section>
    `;
  }
  return null;
}

function renderCoopSetupCard(settings, mePlayer, roster) {
  const mount = getApp() || app;
  let count = getSavedCoopCount();
  try {
    const domCount = parseInt(mount?.querySelector("#coop-count")?.value, 10);
    if (domCount >= 1 && domCount <= 3) count = domCount;
  } catch {}
  if (roster && coopEditing && !mount?.querySelector("#coop-count")) {
    count = clamp(roster.slots.length, 1, 3);
  }
  const savedNames = getSavedCoopNames();
  const groupDefault = roster?.group || getPlayerName(mePlayer) || "";
  const nameFields = count > 1
    ? [0, 1, 2].slice(0, count).map((i) => {
        const hint = getCoopKeyHint(i, count);
        const prefill = roster?.slots?.[i] || savedNames[i] || "";
        return `
          <label>Player ${i + 1} name (key ${hint})
            <input data-coop-input id="coop-name-${i}" type="text" maxlength="32" value="${escapeHtml(prefill)}" placeholder="Player ${i + 1}" />
          </label>`;
      }).join("")
    : `<p class="muted">${getSnark("player.coop.singlePlayerHint", "With 1 player the group name is used as-is.")}</p>`;
  return `
    <section class="card player-card coop-setup-card">
      <h2>${roster ? getSnark("player.coop.editTitle", "Edit group") : getSnark("player.coop.setupTitle", "Set up your group")}</h2>
      <p class="muted">${getSnark("player.coop.setupBody", "The group name shows on the scoreboard. Each player gets their own buzzer and score.")}</p>
      <label>Group name
        <input data-coop-input id="coop-group" type="text" maxlength="32" value="${escapeHtml(mount?.querySelector("#coop-group")?.value ?? groupDefault)}" placeholder="Group name" />
      </label>
      <label>Players on this device
        <select data-coop-input id="coop-count">
          <option value="1" ${count === 1 ? "selected" : ""}>1</option>
          <option value="2" ${count === 2 ? "selected" : ""}>2</option>
          <option value="3" ${count === 3 ? "selected" : ""}>3</option>
        </select>
      </label>
      ${nameFields}
      <div class="host-actions" style="margin-top:0.6rem">
        <button type="button" class="primary-action" data-coop-submit>${getSnark("player.coop.saveButton", "Save group")}</button>
        ${roster ? `<button type="button" data-coop-cancel>${getSnark("player.coop.cancelButton", "Cancel")}</button>` : ""}
      </div>
    </section>
  `;
}

// Horizontal personal score strip — one cell per live slot, same left-to-right
// order as the buzzers above it.
function renderCoopStrip(settings, round, deviceId, count) {
  const scores = getScores();
  const isRepPhase = round.status === ROUND_STATUSES.ROULETTE && round.roulette?.active;
  const repKey = isRepPhase ? getRouletteRepKeyForDevice(round.roulette, deviceId) : null;
  const cells = [];
  for (let slot = 0; slot < count; slot++) {
    const key = getCoopScoreKey(deviceId, slot);
    const name = getCoopSlotName(deviceId, slot);
    const hint = getCoopKeyHint(slot, count);
    const score = Number(scores[key] || 0);
    const mood = getCoopCharMoodForKey(key, round);
    const muted = isCoopSlotMuted(settings, deviceId, slot);
    const picker = repKey === key ? " is-picker" : "";
    cells.push(`
      <div class="coop-strip-cell${picker}${muted ? " is-muted" : ""}" data-score-key="${escapeHtml(key)}">
        ${getCoopCharHtml(slot, mood)}
        <span class="coop-strip-name">${escapeHtml(name)}${hint ? ` <kbd>${hint}</kbd>` : ""}</span>
        <strong data-score-value>${score}</strong>
      </div>`);
  }
  return `<div class="coop-strip coop-strip-${count}">${cells.join("")}</div>`;
}

// One shared buzzer per group (Jeopardy rules): slots buzz in via Q/B/P or
// their BUZZ chip; the first slot in unlocks the shared option grid and takes
// the points. Single-player devices answer on the grid directly.
function renderCoopGroupBuzzer(settings, round, deviceId, count) {
  const control = round.coopControl || null;
  const controlParsed = parseCoopScoreKey(control);
  const mine = Boolean(controlParsed) && controlParsed.deviceId === deviceId;
  const taken = Boolean(control) && !mine;
  const controlName = control ? getCoopControlName(round) : "";
  const closed = round.status !== ROUND_STATUSES.OPEN;
  const deviceDisabled = !isPlayerBuzzerEnabled(settings, deviceId);
  const rebuzzAllowed = Boolean(settings.rebuzzAllowed);

  let buzzRow = "";
  if (count > 1) {
    const chips = [];
    for (let slot = 0; slot < count; slot++) {
      const key = getCoopScoreKey(deviceId, slot);
      const alreadyBuzzed = (round.buzzedPlayerIds || []).includes(key);
      const off = closed || taken || (!rebuzzAllowed && alreadyBuzzed)
        || deviceDisabled || isCoopSlotMuted(settings, deviceId, slot) || round.screw.active;
      const isCtrl = control === key;
      chips.push(`
        <div class="coop-slot${isCtrl ? " is-control" : ""}">
          <div class="coop-slot-head">${getCoopCharHtml(slot, getCoopCharMoodForKey(key, round))}<strong>${escapeHtml(getCoopSlotName(deviceId, slot))}</strong><kbd>${getCoopKeyHint(slot, count)}</kbd></div>
          <button type="button" class="coop-buzzin" data-coop-buzzin data-coop-slot="${slot}" ${off ? "disabled" : ""}>${isCtrl ? getSnark("player.coop.controlButton", "CONTROL") : "BUZZ"}</button>
        </div>`);
    }
    buzzRow = `<div class="coop-buzz-row coop-buzz-${count}">${chips.join("")}</div>`;
  }

  const controlKey = mine ? control : null;
  const controlBuzzed = controlKey ? (round.buzzedPlayerIds || []).includes(controlKey) : false;
  const gridOff = closed || deviceDisabled || round.screw.active
    || (count > 1 && !mine)
    || (controlKey && !rebuzzAllowed && controlBuzzed);
  const opts = [];
  for (let opt = 1; opt <= settings.optionCount; opt++) {
    const off = gridOff || !isOptionEnabled(settings, opt)
      || (controlKey && isPlayerAtOptionLimit(round, settings, controlKey, opt));
    opts.push(`<button type="button" class="coop-opt" data-coop-buzz="${opt}" ${off ? "disabled" : ""}>${settings.optionCount === 4 ? optionButtonLabel(opt) : opt}</button>`);
  }
  const stateLine = deviceDisabled
    ? getSnark("player.coop.slotDisabled", "Disabled by the host.")
    : closed
      ? getSnark("player.buzzer.buzzersClosed", "Buzzers are currently closed.")
      : taken
        ? getSnark("player.coop.hasControl", `${controlName} has control.`, { player: controlName })
        : mine
          ? getSnark("player.coop.haveControl", `${controlName} has control — pick an answer.`, { player: controlName })
          : count > 1
            ? getSnark("player.coop.firstBuzzHint", "First to buzz gets control — Q/B/P!", { })
            : getSnark("player.buzzer.buzzNow", "Buzz now.");
  const isRepPhase = round.status === ROUND_STATUSES.ROULETTE && round.roulette?.active;
  const picker = isRepPhase && mine ? " is-picker" : "";
  return `
    ${buzzRow}
    <div class="coop-slot coop-shared-grid${picker}">
      <div class="coop-opt-grid coop-opt-${settings.optionCount}">${opts.join("")}</div>
      <p class="muted coop-slot-state">${stateLine}</p>
    </div>`;
}

function renderCoopPlayerArea(settings, round, mePlayer, timeLeftCs) {
  const deviceId = mePlayer.id;
  const count = getCoopSlotCount(deviceId);
  const group = getCoopGroupName(deviceId, getPlayerName(mePlayer));
  const timeText = formatSeconds(timeLeftCs);
  const editBtn = settings.coopAllowEdit
    ? `<div class="host-actions"><button type="button" data-coop-edit>${getSnark("player.coop.editGroupButton", "Edit group")}</button></div>`
    : "";

  if (round.status === ROUND_STATUSES.ROULETTE) {
    return renderCoopRoulettePanel(settings, round, mePlayer, count, group, editBtn);
  }

  if (settings.inputMode === "text") {
    const activeSlot = clamp(coopTextSlot, 0, count - 1);
    const alreadyBuzzed = (round.buzzedPlayerIds || []).includes(getCoopScoreKey(deviceId, activeSlot));
    const rebuzzAllowed = Boolean(settings.rebuzzAllowed);
    const playerDisabled = !isPlayerBuzzerEnabled(settings, deviceId);
    const closed = round.status !== ROUND_STATUSES.OPEN;
    const controlTakenByOther = count > 1 && round.coopControl && round.coopControl !== getCoopScoreKey(deviceId, activeSlot);
    const controlName = controlTakenByOther ? getCoopControlName(round) : "";
    const disabledAttr = closed || (!rebuzzAllowed && alreadyBuzzed) || playerDisabled || controlTakenByOther ? "disabled" : "";
    const tabs = count > 1
      ? `<div class="coop-text-tabs">${[0, 1, 2].slice(0, count).map((slot) => {
          const on = slot === activeSlot ? "is-on" : "";
          return `<button type="button" class="toggle-chip ${on}" data-coop-text-tab="${slot}">${escapeHtml(getCoopSlotName(deviceId, slot))} <kbd>${getCoopKeyHint(slot, count)}</kbd></button>`;
        }).join("")}</div>`
      : "";
    const helper = playerDisabled
      ? getSnark("player.buzzer.answerDisabledByHost", "Your answer input is disabled by the Host.")
      : closed
        ? getSnark("player.buzzer.answersClosed", "Answers are currently closed.")
        : !rebuzzAllowed && alreadyBuzzed
          ? getSnark("player.buzzer.alreadyAnswered", "You already submitted an answer this round.")
          : controlTakenByOther
            ? getSnark("player.coop.hasControl", `${controlName} has control.`, { player: controlName })
            : getSnark("player.buzzer.typeAnswerSubmit", "Type your answer and submit.");
    return `
      <section class="card player-card coop-player-card">
        <h2>${escapeHtml(group)}</h2>
        <p class="muted">${helper}</p>
        <p class="muted">${getSnark("player.buzzer.timeLeftLabel", "Time left")}: <strong data-live-time-left>${timeText}s</strong></p>
        ${tabs}
        <div class="text-entry">
          <input id="answer-entry" type="text" maxlength="120" placeholder="${getSnark("player.buzzer.answerPlaceholder", "Type your answer")}" ${disabledAttr} />
          <button data-answer-submit ${disabledAttr}>${getSnark("player.buzzer.submitAnswerButton", "Submit Answer")}</button>
        </div>
        ${renderCoopStrip(settings, round, deviceId, count)}
        ${editBtn}
      </section>
    `;
  }

  return `
    <section class="card player-card coop-player-card">
      <h2>${escapeHtml(group)}</h2>
      <p class="muted">${getSnark("player.buzzer.timeLeftLabel", "Time left")}: <strong data-live-time-left>${timeText}s</strong></p>
      ${renderCoopGroupBuzzer(settings, round, deviceId, count)}
      ${renderCoopStrip(settings, round, deviceId, count)}
      ${editBtn}
    </section>
  `;
}

// Coop pick-a-value panel — the device's rep (last correct slot) stops for
// the whole group. Dance face + highlight telegraph the picker.
function renderCoopRoulettePanel(settings, round, mePlayer, count, group, editBtn) {
  const roulette = round.roulette || {};
  const deviceId = mePlayer.id;
  const repKey = getRouletteRepKeyForDevice(roulette, deviceId);
  const repSlot = parseCoopScoreKey(repKey)?.slot ?? 0;
  const repName = getCoopSlotName(deviceId, repSlot, getPlayerName(mePlayer));
  const currentFrame = getRouletteFrame(roulette);
  const playerSelection = roulette.selections?.[deviceId] || null;
  const completedCount = Array.isArray(roulette.completedPlayerIds) ? roulette.completedPlayerIds.length : 0;
  const expectedCount = getRouletteExpectedCount(roulette);
  const canStop = isRoulettePlayerAllowed(roulette, deviceId) && !playerSelection;
  const displayedValue = playerSelection ? Number(playerSelection.value || 0) : currentFrame.value;
  const displayedLabel = playerSelection ? getSnark("player.roulette.lockedLabel", "Locked") : currentFrame.label;
  return `
    <section class="card player-card roulette-card coop-player-card">
      <h2>${getSnark("player.roulette.title", "Pick a Value")}</h2>
      <p class="muted">${getSnark("player.coop.repStops", `${repName} stops for ${group}.`, { rep: repName, group })}</p>
      <div class="coop-slot is-picker">
        <div class="coop-slot-head">${getCoopCharHtml(repSlot, getCoopCharMoodForKey(repKey, round))}<strong>${escapeHtml(repName)}</strong></div>
      </div>
      <div class="roulette-display" aria-live="polite">
        <span class="roulette-value">${displayedValue}</span>
        <span class="roulette-label">${displayedLabel}</span>
      </div>
      <p class="muted">${getSnark("player.roulette.playersLocked", `${completedCount}/${expectedCount} players locked in.`, { completed: completedCount, expected: expectedCount })}</p>
      ${playerSelection
        ? `<p class="roulette-locked-note">${getSnark("player.roulette.youLocked", `You locked in ${Number(playerSelection.value || 0)}.`, { value: Number(playerSelection.value || 0) })}</p>`
        : `<button type="button" class="roulette-stop" data-roulette-stop ${canStop ? "" : "disabled"}>${getSnark("player.roulette.stopButton", "STOP")}</button>`}
      ${renderCoopStrip(settings, round, deviceId, count)}
      ${editBtn}
    </section>
  `;
}

// =============================================================================
// Player buzzer panel — shows appropriate UI depending on game state
// (roulette, screw, buttons, text entry, etc.)
// =============================================================================
function renderBuzzerPanel(settings, round, mePlayer, timeLeftCs) {
  if (isCoopMode(settings) && !isControllerPlayer() && !isCohost()) {
    const gate = renderCoopGate(settings, mePlayer);
    if (gate) return gate;
  }
  if (isBingoMode()) return renderBingoPlayerPanel(settings, mePlayer);
  if (isDisOrDatMode()) return renderDisOrDatPlayerPanel(settings, mePlayer);
  if (isFibbageMode()) return renderFibbagePlayerPanel(settings, mePlayer);
  console.log("renderBuzzerPanel: status=", round?.status, "timeLeftCs=", timeLeftCs, "me=", mePlayer?.id);
  if (isControllerPlayer() || isCohost()) {
    return `
      <section class="card player-card controller-card">
        <h2>Host Control Screen</h2>
        <p>You are ${isCohost() ? "a Co-host" : "the Host"} and do not have a buzzer input.</p>
      </section>
    `;
  }
  if (isCoopMode(settings)) {
    return renderCoopPlayerArea(settings, round, mePlayer, timeLeftCs);
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
      .map((p) => `<button type="button" data-screw-player="${p.id}">${escapeHtml(getPlayerName(p))}</button>`)
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
          <p class="muted">${getSnark("player.screw.timerLabel", "Screw timer")}: <strong data-screw-timer>${timeText}s</strong></p>
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
          <p class="muted">${getSnark("player.screw.timerLabel", "Screw timer")}: <strong data-screw-timer>${timeText}s</strong></p>
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

  if (settings.optionCount === 8) {
    const buttons = [1, 2, 3, 4, 5, 6, 7, 8]
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
        <div class="eight-grid">${buttons}</div>
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
          <span class="audience-timer" data-audience-time-left>${timerDisplay}</span>
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

  // Bingo / Wen Dit Happn / Fibbage tablets handle separately
  if (isBingoMode()) {
    return renderTabletTimerNotUseful();
  }

  if (isFibbageMode()) {
    const fb = getFibbage();
    if (fb.phase === "lying") {
      const cs = getFibbageLieTimeLeftCs(fb);
      const flash = isTabletTimerFlashing(cs);
      return `<main class="tablet-timer-layout"${flash?' data-flash="true"':""}><div class="tablet-timer-container"><div class="tablet-timer-value" data-tablet-time-left data-fibbage-time-left>${formatSeconds(cs)}s</div><div class="tablet-timer-players">Fibbage — Lie</div></div></main>`;
    }
    if (fb.phase === "voting") {
      const cs = getFibbageVoteTimeLeftCs(fb);
      const flash = isTabletTimerFlashing(cs);
      return `<main class="tablet-timer-layout"${flash?' data-flash="true"':""}><div class="tablet-timer-container"><div class="tablet-timer-value" data-tablet-time-left data-fibbage-time-left>${formatSeconds(cs)}s</div><div class="tablet-timer-players">Fibbage — Vote</div></div></main>`;
    }
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
            <div class="tablet-timer-value" data-tablet-time-left data-disordat-time-left>${formatSeconds(ddCs)}s</div>
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
        <div class="tablet-timer-value" data-tablet-time-left data-audience-time-left>${timerDisplay}</div>
        <div class="tablet-timer-players">${getSnark("tablet.misc.tabletAnswered", `${buzzedCount}/${totalPlayers} players answered`, { buzzed: buzzedCount, total: totalPlayers })}</div>
      </div>
    </main>
  `;
}

function renderAudienceDisplay(settings, round, players, scores, timeLeftCs, pendingEntry) {
  if (isTeamSelectActive()) return renderTeamSelectAudienceDisplay(settings, players);
  if (isBingoMode()) return renderBingoAudienceDisplay(settings, players);
  if (isDisOrDatMode()) return renderDisOrDatAudienceDisplay(settings, players);
  if (isFibbageMode()) return renderFibbageAudienceDisplay(settings, players);
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
      return `<button class="toggle-chip ${enabled ? "is-on" : "is-off"}" data-toggle-player="${player.id}" ${settingDisabledAttr}>${escapeHtml(getPlayerName(player))} ${enabled ? "On" : "Off"}</button>`;
    })
    .join("");

  // Coopertition: per-slot mutes under each multi-slot device (whole-device
  // mute stays on the chip above).
  let coopSlotToggles = "";
  if (isCoopMode(settings)) {
    const rows = nonControllerPlayers
      .map((player) => {
        const count = getCoopSlotCount(player.id);
        if (count <= 1) return "";
        const chips = [];
        for (let slot = 0; slot < count; slot++) {
          const key = getCoopScoreKey(player.id, slot);
          const on = !isCoopSlotMuted(settings, player.id, slot);
          chips.push(`<button class="toggle-chip ${on ? "is-on" : "is-off"}" data-toggle-coop-slot="${escapeHtml(key)}" ${settingDisabledAttr}>${escapeHtml(getCoopSlotName(player.id, slot))} ${on ? "On" : "Off"}</button>`);
        }
        return `<div class="coop-mute-row"><span class="muted">${escapeHtml(getCoopGroupName(player.id, getPlayerName(player)))}</span><div class="toggle-list">${chips.join("")}</div></div>`;
      })
      .filter(Boolean)
      .join("");
    if (rows) coopSlotToggles = `<div class="toggle-group"><span class="muted">Coop players</span>${rows}</div>`;
  }

  return `
    <div class="toggle-group">
      <span class="muted">Player buzzers</span>
      <div class="toggle-list">${toggles}</div>
    </div>
    ${coopSlotToggles}
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

  if (isFibbageMode()) {
    if (!isHost()) return `<section class="card host-panel"><p>Co-hosts cannot control Fibbage. The host must manage it.</p></section>`;
    return renderFibbageHostPanel(settings, players);
  }

  const settingsLocked = round.status === ROUND_STATUSES.OPEN || round.status === ROUND_STATUSES.ROULETTE;
  const settingDisabledAttr = settingsLocked ? "disabled" : "";
  const cohostIds = getSafeState("cohostIds", []);
  const nonControllerPlayers = players.filter((player) => player.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)));
  const teamAssignments = normalizeTeamAssignments(getTeamAssignments(), players, controllerId);
  const missingTeamAssignments = hasUnassignedTeamPlayers(settings, players, teamAssignments);
  // Coopertition without lock-after-buzz requires a pre-set answer to open.
  const coopNeedsPreset = isCoopMode(settings)
    && !settings.lockAfterBuzz
    && !(settings.inputMode === "text"
      ? Boolean(String(round.correctAnswer || "").trim())
      : Array.isArray(round.correctOptions) && round.correctOptions.length > 0);
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
                ${isCoopMode(settings)
                  ? `<p class="setting-helper">Off — coopertition allows one response per player per question.</p>`
                  : toggleSwitch("rebuzzAllowed", settings.rebuzzAllowed)}
                ${isCoopMode(settings) ? "" : `<p class="setting-helper">Let the same player buzz multiple times per round.</p>`}
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
                        ${isCoopMode(settings) ? "" : `<option value="1" ${settings.optionCount === 1 ? "selected" : ""}>1</option>
                        <option value="2" ${settings.optionCount === 2 ? "selected" : ""}>2</option>`}
                        <option value="4" ${settings.optionCount === 4 ? "selected" : ""}>4</option>
                        <option value="6" ${settings.optionCount === 6 ? "selected" : ""}>6</option>
                        <option value="8" ${settings.optionCount === 8 ? "selected" : ""}>8</option>
                      </select>
                      <p class="setting-helper">How many buzzer buttons each player sees.${isCoopMode(settings) ? " Coopertition locks this to 4+." : ""}</p>
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
                  ${isCoopMode(settings) ? "" : `<option value="jack" ${settings.scoringMode === "jack" ? "selected" : ""}>JACK (time-based)</option>`}
                  <option value="roulette" ${settings.scoringMode === "roulette" ? "selected" : ""}>Pick-a-value (player-determined)</option>
                </select>
                <p class="setting-helper">How each buzz is valued.${isCoopMode(settings) ? " JACK is disabled in coopertition mode." : ""}</p>
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
                          Target ${isCoopMode(settings) ? "group" : "player"}
                          <select data-setting="rouletteSinglePlayerTarget" ${settingDisabledAttr}>
                            <option value="random" ${settings.rouletteSinglePlayerTarget === "random" ? "selected" : ""}>Random ${isCoopMode(settings) ? "group" : "player"}</option>
                            ${nonControllerPlayers
                              .map((player) => `<option value="${player.id}" ${settings.rouletteSinglePlayerTarget === player.id ? "selected" : ""}>${escapeHtml(isCoopMode(settings) ? getCoopGroupName(player.id, getPlayerName(player)) : getPlayerName(player))}</option>`)
                              .join("")}
                          </select>
                          <p class="setting-helper">Which ${isCoopMode(settings) ? "group stops the pick-a-value (their last-correct player taps STOP)" : "player stops the pick-a-value"}.</p>
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
                      ${isCoopMode(settings) ? "" : `<option value="shared" ${settings.teamScoringMode === "shared" ? "selected" : ""}>Shared (one buzzer per team)</option>`}
                    </select>
                    <p class="setting-helper">"Alliance" keeps individual scores + tallies teams. "Shared" gives each team one buzzer.${isCoopMode(settings) ? " Shared is disabled in coopertition mode." : ""}</p>
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

      <!-- Section: Coopertition -->
      <div class="settings-section">
        <details ${settingsLocked ? "" : "open"}>
          <summary>Coopertition</summary>
          <div class="section-body">
            <div class="control-grid">
              <label>
                Coopertition mode
                ${toggleSwitch("coopertitionEnabled", settings.coopertitionEnabled)}
                <p class="setting-helper">Up to 3 players per device (Q/B/P keys). Switchable only from buzzer mode — locks screws, JACK, re-buzz and shared teams.</p>
              </label>
              ${settings.coopertitionEnabled
                ? `<label>
                    Allow group edits
                    ${toggleSwitch("coopAllowEdit", settings.coopAllowEdit)}
                    <p class="setting-helper">Let devices change player count/names mid-game.</p>
                  </label>`
                : ""}
            </div>
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
                ${isCoopMode(settings)
                  ? `<p class="setting-helper">Off — screws are disabled in coopertition mode.</p>`
                  : toggleSwitch("allowScrewing", settings.allowScrewing)}
                ${isCoopMode(settings) ? "" : `<p class="setting-helper">Players can force another player to answer under a 5s timer. Screwer gains 1000 if screwee gets it wrong, loses 1000 if they get it right.</p>`}
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
                <p class="setting-helper">The YDKJ classic itself! You read 7 things aloud; players answer Dis, Dat, or Both on their devices. Set the correct answer for each question first, then pick a mode. Timed (One Play or All Play) is a ${settings.disOrDatTimedSeconds || 30}-second race with a finish-fast bonus; Host Paced advances each question manually. (in every JACK game, One play recommended for small games, All play recommended for large games, may not be as enjoyable in team mode, but hey, im not your parental figure)</p>
              </div>
              <div>
                <button type="button" data-set-mode="fibbage" ${settingDisabledAttr} ${settings.inputMode === "fibbage" || isCoopMode(settings) ? "disabled" : ""}>Fibbage</button>
                <p class="setting-helper">The famous Jackbox fibbing game. Host sets truth (before the players start lying). Players submit lies, shows shuffled lies+truth, players vote, host reveals one-by-one or Show All. 500 per fool, 1000 for truth, (configurable).${isCoopMode(settings) ? " Off limits in coopertition mode." : ""}</p>
              </div>
            </div>
            ${settings.inputMode === "bingo" || settings.inputMode === "wendithapn" || settings.inputMode === "disordat" || settings.inputMode === "fibbage"
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
          <button type="button" data-host-action="open" ${round.status === ROUND_STATUSES.OPEN || missingTeamAssignments || coopNeedsPreset ? "disabled" : ""}>Open Buzzers</button>
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
                .map(p => `<span style="display:inline-block;margin:0 0.3rem 0.2rem 0;padding:0.1rem 0.4rem;border-radius:4px;background:${round.screwsUsedBy?.includes(p.id) ? "rgba(235,61,48,0.2)" : "rgba(29,185,84,0.2)"}">${escapeHtml(getPlayerName(p))}</span>`)
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
        ${coopNeedsPreset
          ? "<span>Set a pre-set correct answer (or enable lock-after-buzz) to open buzzers.</span>"
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
    const isScrewer = round.screw.screwerId === me()?.id;
    if (isScrewer) {
      const controllerId = getControllerId();
      const cohostIds = getSafeState("cohostIds", []);
      const targets = currentParticipants()
        .filter(p => p.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(p.id)) && p.id !== round.screw.screwerId);
      const targetButtons = targets.map(p =>
        `<button type="button" data-screw-player="${p.id}">${escapeHtml(getPlayerName(p))}</button>`
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
      <p><strong>${escapeHtml(round.screw.screwerName)}</strong> is screwing over <strong>${escapeHtml(round.screw.screeeName)}</strong>.</p>
      <p>Time left: <strong data-screw-timer>${timeText}s</strong></p>
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

  const renderedAnswer = pendingEntry.answerText ? `\"${escapeHtml(pendingEntry.answerText)}\"` : (pendingEntry.option ?? "in");

  return `
    <section class="card ruling-card">
      <h3>Locked Ruling</h3>
      <p>
        ${escapeHtml(pendingEntry.playerName)} buzzed
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
// Coopertition scoreboard — group rows sorted by group total, each with its
// sub-player breakdown (avatar, name, key hint, score). Removed slots stay
// greyed in place; rank badges keep their 1st/2nd/3rd meaning on groups.
function renderCoopScores(players, scores, settings, controllerId, cohostIds, assignments) {
  const round = getRound();
  const devices = players.filter((player) => player.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)));
  const groups = devices
    .map((player) => {
      const deviceId = player.id;
      const count = getCoopSlotCount(deviceId);
      const groupName = getCoopGroupName(deviceId, getPlayerName(player));
      const teamColor = getPlayerTeamColor(deviceId, assignments);
      const slots = [];
      for (let slot = 0; slot < count; slot++) {
        const key = getCoopScoreKey(deviceId, slot);
        slots.push({
          slot, key,
          name: getCoopSlotName(deviceId, slot),
          score: Number(scores[key] || 0),
          mood: getCoopCharMoodForKey(key, round),
          muted: isCoopSlotMuted(settings, deviceId, slot),
          frozen: false,
        });
      }
      // Frozen removals: slots that left the group but keep points.
      for (let slot = count; slot < 3; slot++) {
        const key = `coop:${deviceId}:${slot}`;
        if (Number(scores[key] || 0) === 0) continue;
        slots.push({
          slot, key,
          name: `${getCoopSlotName(deviceId, slot)} (left)`,
          score: Number(scores[key] || 0),
          mood: "idle",
          muted: true,
          frozen: true,
        });
      }
      return { deviceId, groupName, teamColor, total: getCoopGroupTotal(deviceId, scores), slots };
    })
    .sort((a, b) => b.total - a.total);

  const items = groups
    .map(({ deviceId, groupName, teamColor, total, slots }, index) => {
      const teamPill = teamColor ? `<span class="team-pill team-${teamColor}">${teamColor}</span>` : "";
      const subRows = slots
        .map(({ slot, key, name, score, mood, muted, frozen }) => {
          const hint = !frozen ? getCoopKeyHint(slot, slots.filter((s) => !s.frozen).length || getCoopSlotCount(deviceId)) : "";
          return `<li class="coop-sub-row${muted ? " is-muted" : ""}${frozen ? " is-frozen" : ""}" data-score-key="${escapeHtml(key)}"><span>${getCoopCharHtml(slot, mood)}${escapeHtml(name)}${hint ? ` <kbd>${hint}</kbd>` : ""}</span><strong data-score-value>${score}</strong></li>`;
        })
        .join("");
      return `<li class="coop-group" data-coop-group="${escapeHtml(deviceId)}"><div class="coop-group-head"><span>${getRankBadgeHtml(index + 1)}<strong>${escapeHtml(groupName)}</strong> ${teamPill}</span><strong>${total}</strong></div><ul class="coop-sub-list">${subRows || `<li class="muted">No players yet.</li>`}</ul></li>`;
    })
    .join("");

  const allianceTotals = settings.teamModeEnabled
    ? TEAM_COLORS
        .map((teamColor) => {
          const devs = groups.filter((g) => g.teamColor === teamColor);
          if (devs.length === 0) return "";
          return { teamColor, total: devs.reduce((sum, g) => sum + g.total, 0) };
        })
        .filter(Boolean)
        .sort((a, b) => b.total - a.total)
        .map(({ teamColor, total }, index) => `<li class="team-score-row" data-score-key="${escapeHtml(getTeamScoreKey(teamColor))}"><span>${getRankBadgeHtml(index + 1)}<span class="team-pill team-${teamColor}">${teamColor}</span></span><strong data-score-value>${total}</strong></li>`)
        .join("")
    : "";

  return `
    <section class="card score-card">
      <h2>${getSnark("shared.scores.coopTitle", "Group Scores")}</h2>
      <ul class="coop-group-list">${items || `<li>${getSnark("shared.bingo.noPlayersYet", "No players yet.")}</li>`}</ul>
      ${allianceTotals ? `<h3>${getSnark("shared.scores.allianceTotalsTitle", "Alliance totals")}</h3><ul>${allianceTotals}</ul>` : ""}
    </section>
  `;
}

function renderScores(players, scores) {
  const settings = getSettings();
  const controllerId = getControllerId();
  const cohostIds = getSafeState("cohostIds", []);
  const visiblePlayers = players.filter((player) => player.id !== controllerId && !(Array.isArray(cohostIds) && cohostIds.includes(player.id)));
  const assignments = normalizeTeamAssignments(getTeamAssignments(), players, controllerId);

  if (isCoopMode(settings)) {
    return renderCoopScores(players, scores, settings, controllerId, cohostIds, assignments);
  }

  if (settings.teamModeEnabled && settings.teamScoringMode === "shared") {
    const teamItems = TEAM_COLORS
      .map((teamColor) => {
        const members = getTeamMembers(teamColor, players, assignments);
        if (members.length === 0) {
          return "";
        }
        const teamScore = Number(scores[getTeamScoreKey(teamColor)] || 0);
        const memberNames = members.map((player) => escapeHtml(getPlayerName(player))).join(", ");
        return { teamColor, members, teamScore, memberNames };
      })
      .filter(Boolean)
      .sort((a, b) => b.teamScore - a.teamScore)
      .map(({ teamColor, teamScore, memberNames }, index) => `<li class="team-score-row" data-score-key="${escapeHtml(getTeamScoreKey(teamColor))}"><span>${getRankBadgeHtml(index + 1)}<span class="team-pill team-${teamColor}">${teamColor}</span> <small>${memberNames}</small></span><strong data-score-value>${teamScore}</strong></li>`)
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
      return { player, value, teamPill };
    })
    .sort((a, b) => b.value - a.value)
    .map(({ player, value, teamPill }, index) => `<li data-score-key="${escapeHtml(player.id)}"><span>${getRankBadgeHtml(index + 1)}${escapeHtml(getPlayerName(player))} ${teamPill}</span><strong data-score-value>${value}</strong></li>`)
    .join("");

  const teamTotals = settings.teamModeEnabled
    ? TEAM_COLORS
        .map((teamColor) => {
          const members = getTeamMembers(teamColor, players, assignments);
          if (members.length === 0) {
            return "";
          }
          const total = members.reduce((sum, member) => sum + Number(scores[member.id] || 0), 0);
          return { teamColor, total };
        })
        .filter(Boolean)
        .sort((a, b) => b.total - a.total)
        .map(({ teamColor, total }, index) => `<li class="team-score-row" data-score-key="${escapeHtml(getTeamScoreKey(teamColor))}"><span>${getRankBadgeHtml(index + 1)}<span class="team-pill team-${teamColor}">${teamColor}</span></span><strong data-score-value>${total}</strong></li>`)
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
            <span class="log-player">${escapeHtml(entry.playerName)}</span>
            <span>${entry.scoreTarget ? `To ${escapeHtml(entry.scoreTarget)}` : ""}</span>
            <span>
              ${
                entry.answerText
                  ? `Answer \"${escapeHtml(entry.answerText)}\"`
                  : entry.option === null || entry.option === undefined
                    ? `Buzzed in`
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

// Player notices (buzz results, control changes) live in a fixed bar at the
// bottom of the screen — not inside the answer cards.
function renderScreenNoticeBar() {
  const notice = getRecentBuzzNotice();
  if (!notice) return "";
  return `<div class="screen-notice-bar" role="status">${escapeHtml(notice)}</div>`;
}

// =============================================================================
// Top-level render — assembles the entire page HTML
// Input preservation is handled by render.js scheduler (generic, survives re-renders)
// =============================================================================
function render() {
  const mount = getApp() || app;
  if (!mount) {
    console.warn("[render] #app mount not found");
    return;
  }
  const mePlayer = me();
  if (!mePlayer) {
    // Not yet connected — show landing until PlayroomKit is ready
    try { renderPrejoinScreen(prejoinMode); } catch {}
    return;
  }
  const players = currentParticipants();
  const settings = getSettings();
  const round = getRound();
  const scores = getScores();
  // Feature 2: snapshot for delta animation (player-only, limit 3 via render.js)
  let scoreDeltas = null;
  try { if (!isAudienceDisplayClient()) scoreDeltas = trackScoreSnapshot(scores); } catch {}
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
    // Use helper without mutating global inside render; keep global in sync via computed
    const computedFrozen = computeAudienceTimerFrozenCs({ round, timeLeftCs, totalPlayers, buzzedCount, timerRunning });
    if (computedFrozen !== null && audienceTimerFrozenCs === null) audienceTimerFrozenCs = computedFrozen;
    else if (computedFrozen === null) audienceTimerFrozenCs = null;
    const displayTimeLeftCs = audienceTimerFrozenCs !== null ? audienceTimerFrozenCs : timeLeftCs;

    if (clientMode === "tablet_timer" || me()?.getState?.("clientMode") === "tablet_timer") {
      const tabletKey = isTeamSelectActive() ? "tablet-teamselect" : isBingoMode() ? "tablet-bingo" : isDisOrDatMode() ? "tablet-disordat" : isFibbageMode() ? "tablet-fibbage" : "tablet";
      const html = renderTabletTimerDisplay(settings, round, players, displayTimeLeftCs);
      if (!transitionMount(mount, html, tabletKey)) mount.innerHTML = html;
    } else {
      const audienceKey = isTeamSelectActive() ? "audience-teamselect" : isBingoMode() ? "audience-bingo" : isDisOrDatMode() ? "audience-disordat" : isFibbageMode() ? "audience-fibbage" : "audience";
      const html = renderAudienceDisplay(settings, round, players, scores, displayTimeLeftCs, pendingEntry);
      if (!transitionMount(mount, html, audienceKey)) mount.innerHTML = html;
    }
    lastUiSignature = getUiSignature();
    // audience never shows delta per spec
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
    const _html_teamselect = `
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
    if (!transitionMount(mount, _html_teamselect, "teamselect")) mount.innerHTML = _html_teamselect;
    lastUiSignature = getUiSignature();
    requestAnimationFrame(()=>{ try{ if(!isAudienceDisplayClient()) applyScoreDeltas(scoreDeltas); }catch{}});
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
    const _html_bingo = `
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
        ${renderScreenNoticeBar()}
      </main>
    `;
    if (!transitionMount(mount, _html_bingo, "bingo")) mount.innerHTML = _html_bingo;
    lastUiSignature = getUiSignature();
    requestAnimationFrame(()=>{ try{ if(!isAudienceDisplayClient()) applyScoreDeltas(scoreDeltas); }catch{}});
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
    const _html_disordat = `
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
        ${renderScreenNoticeBar()}
      </main>
    `;
    if (!transitionMount(mount, _html_disordat, "disordat")) mount.innerHTML = _html_disordat;
    lastUiSignature = getUiSignature();
    requestAnimationFrame(()=>{ try{ if(!isAudienceDisplayClient()) applyScoreDeltas(scoreDeltas); }catch{}});
    return;
  }

  if (isFibbageMode()) {
    const hideScores = shouldHideFibbageScores();
    const fibScoresHost = hideScores ? renderHiddenPanel(getSnark("player.scores.scoresTitle", "Scores"), "Scores hidden during Fibbage round.") : renderScores(players, scores);
    const fibScoresPlayer = hideScores ? renderHiddenPanel(getSnark("player.scores.scoresTitle", "Scores"), "Scores hidden during Fibbage round.") : (showScoresToPlayers ? renderScores(players, scores) : renderHiddenPanel(getSnark("player.scores.scoresTitle", "Scores"), getSnark("player.scores.scoresHidden", "Only the Host can view scores right now.")));
    const fibBody = showAdminData ? `
      ${renderHostSettings(settings, round, timeLeftCs, players, controller?.id || null)}
      <section class="grid">
        ${fibScoresHost}
      </section>
      ${renderLog(gameLog, settings)}` : `
      <section class="grid grid-single">
        ${renderBuzzerPanel(settings, round, mePlayer, timeLeftCs)}
        ${fibScoresPlayer}
      </section>` ;
    const _html_fibbage = `
      <main class="layout" data-fibbage-active="true">
        <header class="hero">
          <div>
            <h1>Fibbage</h1>
            <p class="muted" style="margin-bottom:0.15rem">${getSnark("player.misc.roomCodeLabel", "Room code")}</p>
            <div class="room-code-badge">${getRoomCode() || "..."}</div>
          </div>
          <div class="hero-meta">
            <span>${getSnark("player.misc.youLabel", `You: ${getPlayerName(mePlayer)}`, { name: getPlayerName(mePlayer) })}</span>
            <span>${getSnark("player.misc.hostLabel", `Host: ${controller ? getPlayerName(controller) : "-"}`, { name: controller ? getPlayerName(controller) : "-" })}</span>
          </div>
        </header>
        ${fibBody}
      </main>
    `;
    if (!transitionMount(mount, _html_fibbage, "fibbage")) mount.innerHTML = _html_fibbage;
    lastUiSignature = getUiSignature();
    requestAnimationFrame(()=>{ try{ if(!isAudienceDisplayClient()) applyScoreDeltas(scoreDeltas); }catch{}});
    return;
  }

  const _html_default = `
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
      ${renderScreenNoticeBar()}
    </main>
  `;

  if (!transitionMount(mount, _html_default, "default")) mount.innerHTML = _html_default;
  lastUiSignature = getUiSignature();
  requestAnimationFrame(()=>{ try{ if(!isAudienceDisplayClient()) applyScoreDeltas(scoreDeltas); }catch{}});
}

// =============================================================================
// Event binding — attaches listeners to every data-* attribute in the DOM
// =============================================================================
// Delegated event bus — bound once, survives full innerHTML wipes
// Replaces the old per-render querySelectorAll+addEventListener churn.
// See src/render.js for scheduler + input preservation.
// =============================================================================
let delegatedBound = false;
function bindEvents() {
  if (delegatedBound) return;
  delegatedBound = true;
  const mount = getApp() || app;
  initRenderer(mount, render);
  // Preserve generic inputs via render.js; legacy fib draft no longer needed.

  // Global doc listener for roulette space — kept here once
  if (!rouletteKeydownBound) {
    document.addEventListener("keydown", handleRouletteKeydown);
    rouletteKeydownBound = true;
  }
  if (!coopKeydownBound) {
    document.addEventListener("keydown", handleCoopBuzzKeydown);
    coopKeydownBound = true;
  }

  // --- Delegated handlers below ---
  delegate("pointerdown", "[data-buzz]", (e, btn) => {
    e.preventDefault();
    submitResponse({ option: Number(btn.dataset.buzz) });
  });
  delegate("pointerdown", "[data-coop-buzz]", (e, btn) => {
    e.preventDefault();
    // Shared group grid: slot attribution happens host-side via control.
    submitResponse({ option: Number(btn.dataset.coopBuzz) });
  });
  delegate("pointerdown", "[data-coop-buzzin]", (e, btn) => {
    e.preventDefault();
    submitResponse({ coopSlot: Number(btn.dataset.coopSlot), buzzIn: true });
  });
  delegate("click", "[data-coop-submit]", async () => {
    const mount = getApp() || app;
    const group = mount.querySelector("#coop-group")?.value?.trim() || "";
    const count = clamp(parseInt(mount.querySelector("#coop-count")?.value, 10) || 1, 1, 3);
    const names = [0, 1, 2].map((i) => mount.querySelector(`#coop-name-${i}`)?.value?.trim() || "");
    try {
      localStorage.setItem(COOP_COUNT_KEY, String(count));
      localStorage.setItem(COOP_NAMES_KEY, JSON.stringify(names));
    } catch {}
    try {
      const result = await RPC.call("coop-roster", { group, count, names }, RPC.Mode.HOST);
      if (result?.ok === false) setBuzzNotice(result.reason || "Could not save group.");
      else {
        if (result?.message) setBuzzNotice(result.message);
        coopEditing = false;
      }
    } catch { setBuzzNotice("Could not save group. Check connection/room."); }
    scheduleRender(render);
  });
  delegate("click", "[data-coop-edit]", () => { coopEditing = true; scheduleRender(render); });
  delegate("click", "[data-coop-cancel]", () => { coopEditing = false; scheduleRender(render); });
  delegate("change", "#coop-count", () => { scheduleRender(render); });
  delegate("click", "[data-answer-submit]", () => {
    const input = (getApp() || app).querySelector("#answer-entry");
    const answerText = String(input?.value || "").trim();
    const payload = { answerText };
    if (isCoopMode() && getCoopSlotCount(me()?.id) > 1) {
      payload.coopSlot = clamp(coopTextSlot, 0, getCoopSlotCount(me()?.id) - 1);
    }
    submitResponse(payload);
    if (input) input.value = "";
  });
  delegate("click", "[data-roulette-stop]", () => submitRouletteStop());
  delegate("click", "[data-pick-team]", async (e, btn) => {
    const teamColor = btn.dataset.pickTeam;
    const result = await RPC.call("select-team", { teamColor }, RPC.Mode.HOST);
    if (result?.ok === false) setBuzzNotice(result.reason || "Could not join that team.");
    else if (result?.message) setBuzzNotice(result.message);
    scheduleRender(render);
  });
  // #answer-entry Enter
  delegate("keydown", "#answer-entry", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const answerText = String(e.target.value || "").trim();
    const payload = { answerText };
    if (isCoopMode() && getCoopSlotCount(me()?.id) > 1) {
      payload.coopSlot = clamp(coopTextSlot, 0, getCoopSlotCount(me()?.id) - 1);
    }
    submitResponse(payload);
    e.target.value = "";
  });
  // Host-only delegated (guard at runtime)
  const requireHost = (fn) => (e, target) => { if (!hasHostPrivileges()) return; fn(e, target); };
  delegate("change", "[data-setting]", requireHost((e, input) => {
    const setting = input.dataset.setting;
    if (setting === "timeOpen") { setHostSetting("timeOpen", clamp(parseInt(input.value, 10) || 20, 1, 120)); return; }
    if (setting === "inputMode") { setHostSetting("inputMode", input.value); return; }
    if (setting === "optionCount") { setHostSetting("optionCount", Number(input.value)); return; }
    if (setting === "scoringMode") { setHostSetting("scoringMode", input.value === "jack" ? "jack" : input.value === "roulette" ? "roulette" : "uniform"); return; }
    if (setting === "rouletteMode") { setHostSetting("rouletteMode", input.value === "highest" ? "highest" : input.value === "single-player" ? "single-player" : "additive"); return; }
    if (setting === "rouletteTopAmount") { setHostSetting("rouletteTopAmount", normalizeRouletteTopAmount(input.value)); return; }
    if (setting === "rouletteSinglePlayerTarget") { setHostSetting("rouletteSinglePlayerTarget", input.value || "random"); return; }
    if (setting === "uniformPoints") { setHostSetting("uniformPoints", normalizeUniformPoints(input.value)); return; }
    if (setting === "jackMultiplier") { setHostSetting("jackMultiplier", Number(input.value)); return; }
    if (setting === "teamScoringMode") { setHostSetting("teamScoringMode", input.value === "shared" ? "shared" : "alliance"); return; }
    if (setting === "snarkMode") { setHostSetting("snarkMode", input.value === "1" ? "1" : input.value === "2" ? "2" : "off"); return; }
    if (setting === "maxBuzzesPerOption") { setHostSetting("maxBuzzesPerOption", clamp(parseInt(input.value, 10) || 1, 1, 50)); return; }
  }));
  delegate("click", "[data-toggle-setting]", requireHost((e, btn) => {
    const setting = btn.dataset.toggleSetting;
    const value = btn.dataset.value === "true";
    try {
      const parent = btn.parentElement;
      if (parent) {
        parent.querySelectorAll(".toggle-switch-btn").forEach((b) => b.classList.remove("is-active", "is-off-val"));
        btn.classList.add("is-active");
        if (!value) btn.classList.add("is-off-val");
      }
    } catch {}
    setHostSetting(setting, value);
  }));
  delegate("change", "[data-team-player]", requireHost((e, input) => setPlayerTeam(input.dataset.teamPlayer, String(input.value || ""))));
  delegate("click", "[data-host-action]", requireHost((e, btn) => {
    const action = btn.dataset.hostAction;
    if (action === "randomize-teams") randomizeTeams();
    else if (action === "open") openBuzzers();
    else if (action === "start-roulette") {
      const result = startRoulettePhase();
      if (result?.ok === false) setBuzzNotice(result.reason || "Could not start pick-a-value.");
      else if (result?.message) setBuzzNotice(result.message);
      scheduleRender(render);
    } else if (action === "close") closeBuzzers();
    else if (action === "reset") resetRound();
    else if (action === "reset-screws") resetScrews();
  }));
  delegate("click", "[data-host-screw]", requireHost(() => hostInitiateScrew()));
  delegate("click", "[data-teamselect-open]", requireHost(() => openTeamSelect()));
  delegate("click", "[data-teamselect-close]", requireHost(() => closeTeamSelect()));
  delegate("click", "[data-teamselect-lock]", requireHost((e, btn) => setTeamSelectLocked(btn.dataset.teamselectLock === "true")));
  delegate("change", "[data-teamselect-enable]", requireHost((e, input) => {
    const current = getTeamSelect().enabledTeams || [];
    const teamColor = input.dataset.teamselectEnable;
    const next = input.checked ? [...new Set([...current, teamColor])] : current.filter((c) => c !== teamColor);
    setTeamSelectTeams(next);
  }));
  delegate("change", "[data-teamselect-limit]", requireHost((e, input) => setTeamSelectLimit(input.value)));
  delegate("click", "[data-set-mode]", requireHost((e, btn) => setHostSetting("inputMode", btn.dataset.setMode)));
  delegate("click", "[data-toggle-option]", requireHost((e, btn) => toggleBuzzerOption(Number(btn.dataset.toggleOption))));
  delegate("click", "[data-toggle-player]", requireHost((e, btn) => togglePlayerBuzzer(btn.dataset.togglePlayer)));
  delegate("click", "[data-toggle-coop-slot]", requireHost((e, btn) => toggleCoopSlot(btn.dataset.toggleCoopSlot)));
  delegate("click", "[data-set-correct-text]", requireHost(() => {
    const input = (getApp() || app).querySelector("#correct-answer-entry");
    const val = String(input?.value || "").trim();
    if (!val) return;
    setCorrectAnswerValue(val);
  }));
  delegate("click", "[data-clear-correct]", requireHost(() => clearCorrectAnswerValue()));
  delegate("click", "[data-correct-option]", requireHost((e, btn) => {
    const opt = Number(btn.dataset.correctOption);
    if (!Number.isInteger(opt)) return;
    toggleCorrectOption(opt);
  }));
  delegate("click", "[data-remove-cohost]", (e, btn) => {
    if (!isHost()) return;
    const removeId = btn.dataset.removeCohost;
    const current = getSafeState("cohostIds", []);
    if (Array.isArray(current) && current.includes(removeId)) {
      setState("cohostIds", current.filter((id) => id !== removeId), true);
      scheduleRender(render);
    }
  });
  delegate("click", "[data-ruling]", requireHost((e, btn) => updateScoresForLogEntry(btn.dataset.logId, Number(btn.dataset.ruling))));
  delegate("click", "[data-log-apply]", requireHost((e, btn) => {
    const id = btn.dataset.logApply;
    const input = (getApp() || app).querySelector(`[data-log-input="${id}"]`);
    updateScoresForLogEntry(id, Number(input?.value || 0));
  }));
  delegate("click", "[data-log-quick]", requireHost((e, btn) => {
    const id = btn.dataset.logId;
    const entry = getLog().find((item) => item.id === id);
    if (!entry) return;
    updateScoresForLogEntry(id, btn.dataset.logQuick === "plus" ? entry.basePoints : -entry.basePoints);
  }));
  delegate("click", "[data-screw-start-timer]", requireHost(() => startScrewTimer()));

  // Player screw
  delegate("click", "[data-screw]", async () => {
    const self = me();
    if (!self) return;
    if (isHost()) initiateScrew(self.id);
    else {
      try {
        const result = await RPC.call("screw", { screweeId: null }, RPC.Mode.HOST);
        if (!result?.ok) setBuzzNotice(result?.reason || "Screw failed.");
      } catch { setBuzzNotice("Could not send screw. Check connection/room."); }
      scheduleRender(render);
    }
  });
  delegate("click", "[data-screw-player]", async (e, btn) => {
    const screweeId = btn.dataset.screwPlayer;
    if (isHost()) selectScrewee(screweeId);
    else {
      try {
        const result = await RPC.call("screw", { screweeId }, RPC.Mode.HOST);
        if (!result?.ok) setBuzzNotice(result?.reason || "Screw selection failed.");
      } catch { setBuzzNotice("Could not send screw selection. Check connection/room."); }
      scheduleRender(render);
    }
  });
  // Bingo
  delegate("click", "[data-bingo-init]", requireHost(() => startBingo()));
  delegate("click", "[data-bingo-end]", requireHost(() => endBingo()));
  delegate("change", "[data-bingo-target]", requireHost((e, sel) => setBingoTarget(Number(sel.value))));
  delegate("click", "[data-bingo-cycle]", requireHost(() => startBingoCycling()));
  delegate("click", "[data-bingo-stop-cycle]", requireHost(() => stopBingoCycling()));
  delegate("click", "[data-bingo-exit]", requireHost(() => { endBingo(); setHostSetting("inputMode", "buttons"); }));
  delegate("pointerdown", "[data-bingo-buzz]", async (e, btn) => {
    e.preventDefault();
    if (isControllerPlayer() || isCohost()) return;
    const slotRaw = btn?.dataset?.coopSlot;
    const slot = slotRaw === undefined || slotRaw === "" ? null : Number(slotRaw);
    await submitBingoBuzz(Number.isInteger(slot) ? slot : null);
  });
  delegate("click", "[data-f-you-close]", () => { fYouEasterEggUnlocked = false; scheduleRender(render); });
  // DisOrDat host
  delegate("change", "#disordat-dis-label", requireHost((e) => setState("disordat", { ...getDisOrDat(), disLabel: String(e.target.value || "").trim() }, true)));
  delegate("change", "#disordat-dat-label", requireHost((e) => setState("disordat", { ...getDisOrDat(), datLabel: String(e.target.value || "").trim() }, true)));
  delegate("change", "#disordat-timed-seconds", requireHost((e) => {
    const seconds = Number(e.target.value);
    if (DIS_OR_DAT_TIMED_OPTIONS.includes(seconds)) setState("disordat", { ...getDisOrDat(), timedSeconds: seconds }, true);
  }));
  delegate("click", "[data-disordat-answer-chip]", requireHost((e, btn) => {
    const q = Number(btn.dataset.q);
    if (!Number.isInteger(q) || q < 0 || q >= DIS_OR_DAT_QUESTION_COUNT) return;
    const dd = getDisOrDat();
    const answers = [...dd.answers];
    answers[q] = btn.dataset.answer;
    setState("disordat", { ...dd, answers }, true);
    scheduleRender(render);
  }));
  delegate("click", "[data-disordat-start]", requireHost((e, btn) => {
    const mode = btn.dataset.disordatStart;
    if (mode === "onePlayTimed") { setState("disordat", { ...getDisOrDat(), mode, pendingPick: true }, true); scheduleRender(render); }
    else startDisOrDat(mode);
  }));
  delegate("click", "[data-disordat-pick-player]", requireHost((e, btn) => startDisOrDat("onePlayTimed", btn.dataset.disordatPickPlayer)));
  delegate("click", "[data-disordat-next]", requireHost(() => nextDisOrDatQuestion()));
  delegate("click", "[data-disordat-end]", requireHost(() => endDisOrDat()));
  delegate("click", "[data-disordat-reset]", requireHost(() => resetDisOrDat()));
  delegate("click", "[data-disordat-exit]", requireHost(() => exitDisOrDat()));
  delegate("click", "[data-disordat-answer]", async (e, btn) => {
    if (isControllerPlayer() || isCohost()) return;
    const q = Number(btn.dataset.q);
    const answer = btn.dataset.answer;
    const slotRaw = btn?.dataset?.coopSlot;
    const payload = { q, answer };
    if (slotRaw !== undefined && slotRaw !== "") payload.coopSlot = Number(slotRaw);
    try {
      const result = await RPC.call("disordat-answer", payload, RPC.Mode.HOST);
      if (result?.ok === false && result?.reason) setBuzzNotice(result.reason);
      else if (result?.message) setBuzzNotice(result.message);
      disOrDatRevealUntil = now() + DIS_OR_DAT_REVEAL_MS;
      scheduleRender(render);
      setTimeout(() => scheduleRender(render), DIS_OR_DAT_REVEAL_MS + 30);
    } catch { setBuzzNotice(getSnark("player.disdat.answerSendFailed", "Could not send answer.")); scheduleRender(render); }
  });
  delegate("click", "[data-disordat-claim]", async (e, btn) => {
    if (isControllerPlayer() || isCohost()) return;
    const q = Number(btn.dataset.q);
    const slotRaw = btn?.dataset?.coopSlot;
    await submitDisOrDatClaim(q, slotRaw === undefined || slotRaw === "" ? null : Number(slotRaw));
  });
  delegate("click", "[data-coop-text-tab]", (e, btn) => {
    const slot = Number(btn?.dataset?.coopTextTab);
    if (Number.isInteger(slot)) {
      coopTextSlot = slot;
      scheduleRender(render);
      try {
        setTimeout(() => document.querySelector("#answer-entry")?.focus(), 60);
      } catch {}
    }
  });
  // Fibbage host
  delegate("click", "[data-fibbage-enter-lies]", requireHost(() => startFibbageLying()));
  delegate("click", "[data-fibbage-set-truth]", requireHost(() => {
    const inp = (getApp() || app).querySelector("#fibbage-truth");
    setFibbageTruth(inp ? inp.value : "");
  }));
  delegate("change", "#fibbage-lie-time", requireHost((e) => setFibbageLieTime(e.target.value)));
  delegate("change", "#fibbage-vote-time", requireHost((e) => setFibbageVoteTime(e.target.value)));
  delegate("change", "#fibbage-mult", requireHost((e) => setFibbageMultiplier(e.target.value)));
  delegate("click", "[data-fibbage-end-lying]", requireHost(() => endFibbageLyingEarly()));
  delegate("click", "[data-fibbage-show-responses]", requireHost(() => showFibbageResponses()));
  delegate("click", "[data-fibbage-start-vote]", requireHost(() => startFibbageVoteTimer()));
  delegate("click", "[data-fibbage-block]", requireHost((e, btn) => toggleFibbageBlock(btn.dataset.fibbageBlock)));
  delegate("click", "[data-fibbage-show-all]", requireHost(() => {
    const fb = getFibbage();
    setState("fibbage", { ...fb, revealed: { all: true, singleIdx: null, revealedIdxs: (fb.choices || []).map((_, i) => i) } }, true);
    scheduleRender(render);
  }));
  const handleSpotlight = (idx) => {
    if (!isHost()) return;
    const fb = getFibbage();
    const already = fb.revealed.singleIdx === idx ? null : idx;
    const revealedIdxs = already !== null ? [...new Set([...(fb.revealed.revealedIdxs || []), idx])] : (fb.revealed.revealedIdxs || []);
    setState("fibbage", { ...fb, revealed: { all: false, singleIdx: already, revealedIdxs } }, true);
    scheduleRender(render);
  };
  delegate("click", "[data-fibbage-spotlight]", requireHost((e, btn) => { e.preventDefault(); handleSpotlight(Number(btn.dataset.fibbageSpotlight)); }));
  delegate("click", "[data-fibbage-spotlight-clear]", requireHost((e) => { e.preventDefault(); const fb = getFibbage(); setState("fibbage", { ...fb, revealed: { all: false, singleIdx: null, revealedIdxs: fb.revealed.revealedIdxs || [] } }, true); scheduleRender(render); }));
  delegate("click", "[data-fibbage-reset]", requireHost(() => resetFibbage()));
  delegate("click", "[data-fibbage-exit]", requireHost(() => exitFibbage()));
  delegate("click", "[data-fibbage-submit-lie]", async () => {
    if (isControllerPlayer() || isCohost()) return;
    const inp = (getApp() || app).querySelector("#fibbage-lie-entry");
    const lieText = String(inp?.value || "").trim();
    try {
      const res = await RPC.call("fibbage-lie", { lieText }, RPC.Mode.HOST);
      if (res?.ok === false && res?.reason) setBuzzNotice(res.reason);
      else if (res?.message) setBuzzNotice(res.message);
      if (res?.ok && inp) inp.value = "";
    } catch { setBuzzNotice("Could not send lie."); }
    scheduleRender(render);
  });
  delegate("click", "[data-fibbage-vote]", async (e, btn) => {
    if (isControllerPlayer() || isCohost()) return;
    const idx = Number(btn.dataset.fibbageVote);
    try {
      const res = await RPC.call("fibbage-vote", { choiceIdx: idx }, RPC.Mode.HOST);
      if (res?.ok === false && res?.reason) setBuzzNotice(res.reason);
      else if (res?.message) setBuzzNotice(res.message);
    } catch { setBuzzNotice("Could not send vote."); }
    scheduleRender(render);
  });
  delegate("keydown", "#fibbage-lie-entry", (e) => {
    if (e.key === "Enter") { e.preventDefault(); (getApp() || app).querySelector("[data-fibbage-submit-lie]")?.click(); }
  });
  // Also keep old per-render pointerdown for buzz still uses delegate above.

  // Prejoin delegated (once) — keeps prejoin screen also resilient
  delegate("click", "[data-prejoin-open]", (e, btn) => renderPrejoinScreen(btn.dataset.prejoinOpen || "landing"));
  delegate("click", "[data-prejoin-switch]", (e, btn) => renderPrejoinScreen(btn.dataset.prejoinSwitch || "landing"));
  delegate("click", "[data-prejoin-back]", () => renderPrejoinScreen());
  delegate("input", "#prejoin-room-code", (e) => {
    const upper = e.target.value.toUpperCase();
    if (e.target.value !== upper) e.target.value = upper;
  });
  delegate("submit", "[data-prejoin-form]", async (e, form) => {
    e.preventDefault();
    const mount = getApp() || app;
    const mode = form.dataset.prejoinForm;
    const nameInput = mount.querySelector("#prejoin-name");
    const roomInput = mount.querySelector("#prejoin-room-code");
    const teamModeInput = mount.querySelector("#prejoin-team-mode");
    const chosenName = nameInput?.value?.trim() || "";
    const roomCode = roomInput?.value?.trim()?.toUpperCase() || "";
    const cohostPasswordInput = mount.querySelector("#prejoin-cohost-password");
    const cohostPassword = cohostPasswordInput?.value?.trim() || "";
    if (mode !== "display" && mode !== "tablet_timer" && !chosenName) { renderPrejoinScreen(mode || "landing", "Please choose a player name."); return; }
    if ((mode === "join" || mode === "cohost") && !roomCode) { renderPrejoinScreen(mode, "Enter a room code to join."); return; }
    if (mode === "display" && !roomCode) { renderPrejoinScreen("display", "Enter a room code for the display."); return; }
    if (mode === "tablet_timer" && !roomCode) { renderPrejoinScreen("tablet_timer", "Enter a room code for the timer display."); return; }
    if (mode === "cohost" && !/^\d{5}$/.test(cohostPassword)) { renderPrejoinScreen("cohost", "Enter a valid 5-digit co-host password."); return; }
    if (mode !== "display" && mode !== "tablet_timer") localStorage.setItem(NAME_KEY, chosenName);
    if (mode === "host") {
      const selectedTeamSetting = String(teamModeInput?.value || "off");
      hostPrejoinTeamSetting = selectedTeamSetting === "shared" ? "shared" : selectedTeamSetting === "alliance" ? "alliance" : "off";
      hostPrejoinCoopSetting = mount.querySelector("#prejoin-coop")?.checked === true;
    }
    const submitButton = form.querySelector("button[type='submit']");
    if (submitButton instanceof HTMLButtonElement) submitButton.disabled = true;
    await launchGame({
      playerName: mode === "display" ? "Audience Display" : mode === "tablet_timer" ? "Tablet Timer" : chosenName,
      roomCode: mode === "join" || mode === "display" || mode === "tablet_timer" || mode === "cohost" ? roomCode : undefined,
      clientMode: mode === "display" ? "display" : mode === "tablet_timer" ? "tablet_timer" : "player",
      cohostPassword: mode === "cohost" ? cohostPassword : undefined,
    });
  });
  // forms submit handled via submit listener below
  return;
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
  if (!isRoulettePlayerAllowed(round.roulette, me()?.id)) {
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
  if (!isRoulettePlayerAllowed(roulette, me()?.id)) {
    setBuzzNotice(getSnark("player.roulette.cannotStop", "You cannot stop this pick-a-value."));
    render();
    return;
  }
  if (Array.isArray(roulette.completedPlayerIds) && roulette.completedPlayerIds.includes(me()?.id)) {
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
// Coopertition keyboard buzzers — Q/B/P select a slot (2P: Q,P. 3P: Q,B,P).
// In buttons mode the key is a generic "buzz in" for that slot (no option);
// precise options use the on-screen per-slot buttons. In text mode the key
// switches the shared answer box tab. Bingo buzzes that slot directly.
// =============================================================================
function handleCoopBuzzKeydown(event) {
  const code = event?.code;
  if (code !== "KeyQ" && code !== "KeyB" && code !== "KeyP") return;
  if (isEditingControl()) return;
  if (isControllerPlayer() || isCohost() || isAudienceDisplayClient()) return;
  if (!isCoopMode()) return;
  const self = me();
  if (!self?.id) return;
  const count = getCoopSlotCount(self.id);
  if (count <= 1) return;
  const slot = getCoopSlotForCode(code, count);
  if (slot === null || slot === undefined) return;

  if (isBingoMode()) {
    const bState = getBingo();
    if (!bState.active || !bState.cycling) return;
    event.preventDefault();
    submitBingoBuzz(slot);
    return;
  }
  if (isDisOrDatMode()) {
    const dd = getDisOrDat();
    if (dd.active && dd.phase === "playing" && dd.mode === "allPlayHostPaced") {
      event.preventDefault();
      submitDisOrDatClaim(dd.currentQuestion, slot);
    }
    return;
  }
  if (isFibbageMode()) return;
  const round = getRound();
  if (round.status === ROUND_STATUSES.ROULETTE) return;
  if (getSettings().inputMode === "text") {
    if (round.status !== ROUND_STATUSES.OPEN) return;
    event.preventDefault();
    coopTextSlot = slot;
    scheduleRender(render);
    try {
      setTimeout(() => document.querySelector("#answer-entry")?.focus(), 60);
    } catch {}
    return;
  }
  if (round.status !== ROUND_STATUSES.OPEN) return;
  event.preventDefault();
  submitResponse({ coopSlot: slot, buzzIn: true });
}

async function submitBingoBuzz(slot = null) {
  if (isControllerPlayer() || isCohost()) return;
  const bState = getBingo();
  const payload = { litIndex: bState.currentLitIndex, litSlot: bState.currentLitSlot };
  if (slot !== null && slot !== undefined) payload.coopSlot = slot;
  try {
    const result = await RPC.call("bingo-buzz", payload, RPC.Mode.HOST);
    if (result?.ok === false && result?.reason) setBuzzNotice(result.reason);
    else if (result?.message) setBuzzNotice(result.message);
  } catch { setBuzzNotice(getSnark("player.buzzer.buzzSendFailedShort", "Could not send buzz.")); }
  scheduleRender(render);
}

async function submitDisOrDatClaim(q, slot = null) {
  if (isControllerPlayer() || isCohost()) return;
  try {
    const result = await RPC.call("disordat-claim", { q, coopSlot: slot }, RPC.Mode.HOST);
    if (result?.ok === false && result?.reason) setBuzzNotice(result.reason);
    else if (result?.message) setBuzzNotice(result.message);
  } catch { setBuzzNotice(getSnark("player.disdat.answerSendFailed", "Could not send answer.")); }
  scheduleRender(render);
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
      active.closest("[data-coop-input]") ||
      active.id === "answer-entry" ||
      active.id === "coop-group" ||
      active.id === "fibbage-lie-entry" ||
      active.id === "fibbage-truth" ||
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

  let prejoinHtml = "";
  if (mode === "host") {
    const isAlliance = hostPrejoinTeamSetting === "alliance";
    const isShared = hostPrejoinTeamSetting === "shared";
    const isCoop = hostPrejoinCoopSetting === true;
    prejoinHtml = `
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

            <label class="prejoin-check">
              <input data-prejoin-input id="prejoin-coop" type="checkbox" ${isCoop ? "checked" : ""} />
              <span>Coopertition mode (up to 3 players per device)</span>
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
    prejoinHtml = `
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
    prejoinHtml = `
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
    prejoinHtml = `
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
    prejoinHtml = `
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
    prejoinHtml = `
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
  const mount = getApp() || app;
  const prejoinKey = `prejoin-${mode}` + (error ? "-error" : "");
  if (!transitionMount(mount, prejoinHtml, prejoinKey)) mount.innerHTML = prejoinHtml;

  // Pre-join form submit + room-code uppercasing are handled via delegated handlers in bindEvents()
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
    let selName = getPlayerName(senderPlayer);
    if (isCoopMode()) {
      const repKey = getRouletteRepKeyForDevice(roulette, senderPlayer.id);
      const repSlot = parseCoopScoreKey(repKey)?.slot ?? 0;
      selName = `${getCoopGroupName(senderPlayer.id, selName)} — ${getCoopSlotName(senderPlayer.id, repSlot)}`;
    }
    const nextSelections = {
      ...(roulette.selections || {}),
      [senderPlayer.id]: {
        playerId: senderPlayer.id,
        playerName: selName,
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

  RPC.register("coop-roster", async (payload, senderPlayer) => {
    if (!isHost()) {
      return { ok: false, reason: "Not host" };
    }
    return handleCoopRoster(senderPlayer, payload);
  });

  RPC.register("disordat-claim", async (payload, senderPlayer) => {
    if (!isHost()) {
      return { ok: false, reason: "Not host" };
    }
    return handleDisOrDatClaim(senderPlayer, payload);
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

  RPC.register("fibbage-lie", async (payload, senderPlayer) => {
    if (!isHost()) return { ok: false, reason: "Not host" };
    return handleFibbageLie(senderPlayer, payload);
  });
  RPC.register("fibbage-vote", async (payload, senderPlayer) => {
    if (!isHost()) return { ok: false, reason: "Not host" };
    return handleFibbageVote(senderPlayer, payload);
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
    setHostSetting, toggleBuzzerOption, togglePlayerBuzzer, toggleCoopSlot,
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
  // Ensure delegated listeners are bound once before first render
  bindEvents();
  renderImmediate(render);
  startRouletteAnimationLoop();

  setInterval(() => {
    try { ensureHostInit(); } catch (e) { console.warn("[hostInit] failed", e); }
    try { hostTick(); } catch (e) { console.warn("[hostTick] failed", e); }
    const signature = getUiSignature();
    if (signature !== lastUiSignature) {
      scheduleRender(render);
      return;
    }
    try { updateTimerDisplays(); } catch (e) { console.warn("[timer] patch failed", e); }
  }, 1000);

  // init audience join tracker to avoid spurious 1s refresh on first poll
  try { lastAudienceParticipantCount = currentParticipants().length; } catch {}
  // Audience/tablet polling — signature-aware so it doesn't thrash transitions
  // Smooth timer handles live clock via rAF patchText; we only full-render when state changes
  setInterval(() => {
    if (!isAudienceDisplayClient()) return;
    if (isFibbageMode() && getFibbage().revealed?.singleIdx !== null) return;
    const sig = getUiSignature();
    if (sig !== lastUiSignature) {
      scheduleRender(render);
      // Refresh audience 1s after a player joins (displayName/state may arrive slightly after participant appears)
      try {
        const curCount = currentParticipants().length;
        if (curCount > lastAudienceParticipantCount) {
          clearTimeout(audienceJoinRefreshTimeout);
          audienceJoinRefreshTimeout = setTimeout(() => {
            try { scheduleRender(render); } catch {}
          }, 1000);
        }
        lastAudienceParticipantCount = curCount;
      } catch {}
    } else {
      // still keep timers crisp for audience even if smooth timer hasn't ticked yet
      try { updateTimerDisplays(); } catch {}
      try { lastAudienceParticipantCount = currentParticipants().length; } catch {}
    }
  }, 250);

  // Bingo mode re-render — only fires when the bingo state actually changes
  setInterval(() => {
    if (!isBingoMode()) return;
    const b = getBingo();
    const key = `${b.active}|${b.cycling}|${b.currentLitIndex}|${b.currentLitSlot}|${b.targetIndex}|${JSON.stringify(b.items)}|${JSON.stringify(b.itemStates)}|${JSON.stringify(b.playerItems || {})}|${JSON.stringify(b.collectedCounts || {})}|${JSON.stringify(b.coopLockout || {})}|${b.winner || ""}`;
    if (key === lastBingoRenderKey) return;
    lastBingoRenderKey = key;
    scheduleRender(render);
  }, BINGO_RENDER_INTERVAL_MS);
}

// =============================================================================
// Entry point — show the landing screen
// =============================================================================
function boot() {
  // Bind delegated handlers once before any screen renders (prejoin needs them too)
  try { bindEvents(); } catch (e) { console.warn("[boot] bindEvents failed", e); }
  // Feature 3: smooth rAF timer (display/tablet + player OPEN; audience/tablet reuse same timers)
  try {
    startSmoothTimer([
      { getCs: () => { const r=getRound(); const s=getSettings(); return getTimeLeftCs(r,s); }, selector: "[data-live-time-left]" },
      // audience main timer mirrors live timer, but shows SCREW when screw active without timer
      { getCs: () => { const r=getRound(); if (r.screw?.active && getScrewTimerMs(r)==null) return null; const s=getSettings(); return getTimeLeftCs(r,s); }, selector: "[data-audience-time-left]" },
      // tablet main timer: screw overrides live, otherwise live; SCREW shows static text
      { getCs: () => { const r=getRound(); if (r.screw?.active && getScrewTimerMs(r)==null) return null; const ms=getScrewTimerMs(r); if (ms!=null) return Math.ceil(ms/10); const s=getSettings(); return getTimeLeftCs(r,s); }, selector: "[data-tablet-time-left]" },
      { getCs: () => getDisOrDatTimeLeftCs(getDisOrDat()), selector: "[data-disordat-time-left]" },
      { getCs: () => { const fb=getFibbage(); return fb.phase==="lying"?getFibbageLieTimeLeftCs(fb): fb.phase==="voting"?getFibbageVoteTimeLeftCs(fb): null; }, selector: "[data-fibbage-time-left]" },
      { getCs: () => { const r=getRound(); const ms=getScrewTimerMs(r); return ms!=null? Math.ceil(ms/10): null; }, selector: "[data-screw-timer]" },
    ]);
  } catch (e) { console.warn("[boot] smooth timer failed", e); }
  renderPrejoinScreen();
  probeRankBadges();
  probeCoopChars();
}


boot();
