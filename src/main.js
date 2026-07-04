import "./style.css";
import { RPC, getParticipants, getRoomCode, getState, insertCoin, isHost, me, setState } from "playroomkit";

const TEAM_COLORS = [
  { name: "Red", hex: "#eb3d30" },
  { name: "Blue", hex: "#22a6f2" },
  { name: "Green", hex: "#1db954" },
  { name: "Purple", hex: "#b44dff" },
  { name: "Gray", hex: "#8e99a4" },
  { name: "Orange", hex: "#ff8b24" },
  { name: "Magenta", hex: "#eb30a6" },
];

const GAME_MODES = { STANDARD: "standard", TEAM: "team" };

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
  teamModeType: "alliance",
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
let clientMode = "player";
let buzzNotice = "";
let buzzNoticeTs = 0;
let lastUiSignature = "";
let prejoinMode = "landing";
let rouletteAnimationInterval = null;
let rouletteKeydownBound = false;
let fYouEasterEggUnlocked = false;

const F_YOU_EASTER_EGG_H2 = "Congratulations! You typed F*** You!";

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
  if (!buzzNotice) return "";
  if (now() - buzzNoticeTs > maxAgeMs) return "";
  return buzzNotice;
}

function currentParticipants() {
  const participants = Object.values(getParticipants() || {}).filter((player) => {
    const mode = player?.getState?.("clientMode");
    return mode !== "display" && player?.getState?.("isAudienceDisplay") !== true;
  });
  return participants.sort((a, b) => a.id.localeCompare(b.id));
}

function isAudienceDisplayClient() {
  return clientMode === "display" || me()?.getState?.("clientMode") === "display";
}

function getPlayerName(player) {
  const custom = player?.getState?.("displayName");
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  return player?.getProfile?.()?.name || "Player";
}

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...getSafeState("settings", {}) };
}

function getGameMode() {
  return getSafeState("gameMode", "standard");
}

function getTeams() {
  return getSafeState("teams", {});
}

function getPlayerTeam(playerId) {
  const teams = getTeams();
  for (const [teamName, team] of Object.entries(teams)) {
    if ((team.playerIds || []).includes(playerId)) {
      return { teamName, teamConfig: team };
    }
  }
  return null;
}

function getPlayerTeamColor(playerId) {
  const playerTeam = getPlayerTeam(playerId);
  return playerTeam ? playerTeam.teamConfig.color : "#8e99a4";
}

function getTeamColor(teamName) {
  const teams = getTeams();
  const team = teams[teamName];
  return team ? team.color : "#8e99a4";
}

function getAllianceTeamScore(teamName) {
  if (getSettings().teamModeType !== "alliance") return null;
  const teams = getTeams();
  const team = teams[teamName];
  if (!team || !team.playerIds) return null;
  const scores = getScores();
  return team.playerIds.reduce((sum, pid) => sum + (Number(scores[pid]) || 0), 0);
}

function getTeamBuzzerState(teamName) {
  if (getSettings().teamModeType !== "shared") return null;
  const teams = getTeams();
  const team = teams[teamName];
  if (!team || !team.playerIds) return null;
  const round = getRound();
  const anyBuzzed = team.playerIds.some(pid => round.buzzedPlayerIds.includes(pid));
  const winnerId = anyBuzzed ? round.winnerId : null;
  const winnerName = winnerId ? getPlayerName(Object.values(getParticipants()).find(p => p.id === winnerId)) : null;
  return { buzzed: anyBuzzed, winnerId, winnerName };
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
  if (playerId === controllerId) return false;
  const disabledPlayerIds = normalizeDisabledPlayerIds(settings.disabledPlayerIds, currentParticipants(), controllerId);
  return !disabledPlayerIds.includes(playerId);
}

function formatSeconds(cs) {
  return Math.max(0, Math.ceil(cs / 100));
}

function seededFraction(n) {
  let s = n * 12.9898 + 78.233;
  s = Math.sin(s) * 43758.5453;
  return s - Math.floor(s);
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
    roulette: { active: false, startedAt: null, mode: "additive", topAmount: 1000, ceiling: 0, targetPlayerId: null, targetPlayerName: null, selections: {}, completedPlayerIds: [], finalValue: null, finishedAt: null },
    screw: { active: false, screwerId: null, screwerName: null, screweeId: null, screeeName: null, screwTimerMs: null },
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

function assignControllerIfNeeded() {
  if (!isHost()) return;
  const current = getControllerId();
  if (current) return;
  setState("controllerId", me().id, true);
}

function ensureHostInit() {
  if (!isHost()) return;
  if (!getState("settings")) { setState("settings", DEFAULT_SETTINGS, true); }
  if (!getState("round")) { resetRound(); }
  if (!getState("scores")) { setState("scores", {}, true); }
  if (!getState("gameLog")) { setState("gameLog", [], true); }
  if (getState("pendingLogId") === undefined) { setState("pendingLogId", null, true); }
  assignControllerIfNeeded();
}

function optionButtonLabel(option) {
  const labels = { 1: "A", 2: "B", 3: "X", 4: "Y" };
  return labels[option] || String(option);
}

function resetRound() {
  if (!isHost()) return;
  const settings = getSettings();
  const currentRound = getRound();
  setState(
    "round",
    {
      status: ROUND_STATUSES.IDLE,
      opensAt: null, closesAt: null, remainingCs: settings.timeOpen * 100,
      winnerId: null, winnerOption: null, winnerAnswer: null, winnerName: null,
      buzzedPlayerIds: [],
      roulette: { active: false, startedAt: null, mode: settings.rouletteMode, topAmount: normalizeRouletteTopAmount(settings.rouletteTopAmount), ceiling: 0, targetPlayerId: null, targetPlayerName: null, selections: {}, completedPlayerIds: [], finalValue: currentRound.roulette?.finalValue ?? null, finishedAt: null },
      screw: { active: false, screwerId: null, screwerName: null, screweeId: null, screeeName: null, screwTimerMs: null },
      screwsUsed: 0,
    },
    true,
  );
  setState("pendingLogId", null, true);
  render();
}

function resetScrews() {
  if (!isHost()) return;
  const round = getRound();
  setState(
    "round",
    { ...round, screwsUsed: Math.max(0, (round.screwsUsed || 0) - 1) },
    true,
  );
  render();
}

function getTimeLeftCs(round, settings) {
  if (!round || round.status === ROUND_STATUSES.IDLE) return settings.timeOpen * 100;
  if ((round.status === ROUND_STATUSES.LOCKED || round.status === ROUND_STATUSES.CLOSED) && typeof round.remainingCs === "number") return round.remainingCs;
  if (round.status === ROUND_STATUSES.OPEN && round.closesAt) {
    const msLeft = Math.max(0, round.closesAt - now());
    return Math.ceil(msLeft / 10);
  }
  return settings.timeOpen * 100;
}

function getUiSignature() {
  const round = getRound();
  const scores = getScores();
  const gameMode = getGameMode();
  const teams = getTeams();
  return JSON.stringify({ round: round.status, roundWinner: round.winnerId, scores: Object.keys(scores).length, gameMode, teamCount: Object.keys(teams).length });
}

function normalizeRouletteTopAmount(val) {
  const n = Number(val);
  if (isNaN(n)) return 1000;
  return Math.max(500, Math.min(3000, n));
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
  if (!roulette?.active) return false;
  if (roulette.mode === "single-player") return playerId === roulette.targetPlayerId;
  return playerId !== getControllerId();
}

function getRouletteExpectedCount(roulette) {
  if (!roulette?.active) return 0;
  if (roulette.mode === "single-player") return 1;
  return getRoulettePlayers().length;
}

function getRouletteFinalValue(roulette) {
  const values = Object.values(roulette?.selections || {}).map((selection) => Number(selection.value) || 0);
  if (values.length === 0) return 0;
  if (roulette.mode === "highest") return Math.max(...values);
  if (roulette.mode === "single-player") { const t = roulette.selections?.[roulette.targetPlayerId]; return Number(t?.value || 0); }
  return values.reduce((total, value) => total + value, 0);
}

function startRouletteAnimationLoop() {
  if (rouletteAnimationInterval) return;
  rouletteAnimationInterval = setInterval(() => {
    if (getRound().status === ROUND_STATUSES.ROULETTE) render();
  }, 500);
}

function getSelectedRouletteTarget(settings, players) {
  if (settings.rouletteMode !== "single-player" || players.length === 0) return null;
  const preferredId = settings.rouletteSinglePlayerTarget;
  if (typeof preferredId === "string" && preferredId !== "random") { const pp = players.find(p => p.id === preferredId); if (pp) return pp; }
  return players[Math.floor(Math.random() * players.length)] || null;
}

function maybeFinalizeRoulettePhase() {
  if (!isHost()) return false;
  const round = getRound(); const roulette = round.roulette;
  if (round.status !== ROUND_STATUSES.ROULETTE || !roulette?.active) return false;
  const expectedCount = getRouletteExpectedCount(roulette);
  const completedCount = Array.isArray(roulette.completedPlayerIds) ? roulette.completedPlayerIds.length : 0;
  if (completedCount < expectedCount) return false;
  const settings = getSettings();
  const finalValue = clamp(getRouletteFinalValue(roulette), 1, roulette.ceiling || normalizeRouletteTopAmount(settings.rouletteTopAmount));
  setState("round", { ...round, status: ROUND_STATUSES.CLOSED, opensAt: null, closesAt: null, remainingCs: settings.timeOpen * 100, winnerId: null, winnerOption: null, winnerAnswer: null, winnerName: null, roulette: { ...roulette, active: false, finalValue, finishedAt: now() } }, true);
  render();
  return true;
}

function openBuzzers() {
  if (!isHost()) return;
  const settings = getSettings(); const round = getRound();
  if (settings.valueSelectionMethod === "roulette" && (round.roulette?.finalValue === null || round.roulette?.finalValue === undefined)) { setBuzzNotice("Start roulette first."); render(); return; }
  const openedAt = now();
  setState(
    "round",
    { ...round, status: ROUND_STATUSES.OPEN, opensAt: openedAt, closesAt: openedAt + settings.timeOpen * 1000, remainingCs: settings.timeOpen * 100, winnerId: null, winnerOption: null, winnerAnswer: null, winnerName: null, buzzedPlayerIds: [], roulette: { ...round.roulette, active: false, startedAt: null, mode: settings.rouletteMode, topAmount: normalizeRouletteTopAmount(settings.rouletteTopAmount), ceiling: 0, targetPlayerId: null, targetPlayerName: null, selections: {}, completedPlayerIds: [], finalValue: round.roulette?.finalValue ?? null, finishedAt: null }, screw: { active: false, screwerId: null, screwerName: null, screweeId: null, screeeName: null, screwTimerMs: null } },
    true,
  );
  setState("pendingLogId", null, true);
  render();
}

function closeBuzzers() {
  if (!isHost()) return;
  const round = getRound();
  setState(
    "round",
    { ...round, status: ROUND_STATUSES.CLOSED, remainingCs: getTimeLeftCs(round, getSettings()), winnerId: null, winnerOption: null, winnerAnswer: null, winnerName: null, roulette: { ...round.roulette, active: false }, screw: { active: false, screwerId: null, screwerName: null, screweeId: null, screeeName: null, screwTimerMs: null } },
    true,
  );
  setState("pendingLogId", null, true);
  render();
}

function startRoulettePhase() {
  if (!isHost()) return { ok: false, reason: "Only host can start roulette." };
  const settings = getSettings(); const round = getRound(); const players = getRoulettePlayers();
  const topAmount = normalizeRouletteTopAmount(settings.rouletteTopAmount);
  const ceiling = settings.rouletteMode === "additive" ? Math.max(1, Math.floor(topAmount / Math.max(1, players.length || 1))) : topAmount;
  const targetPlayer = getSelectedRouletteTarget(settings, players);

  if (players.length === 0) {
    setState("round", { ...round, status: ROUND_STATUSES.OPEN, opensAt: now(), closesAt: now() + settings.timeOpen * 1000, remainingCs: settings.timeOpen * 100, winnerId: null, winnerOption: null, winnerAnswer: null, winnerName: null, buzzedPlayerIds: [], roulette: { ...round.roulette, active: false, startedAt: null, mode: settings.rouletteMode, topAmount, ceiling, targetPlayerId: null, targetPlayerName: null, selections: {}, completedPlayerIds: [], finalValue: null, finishedAt: now() }, screw: { active: false, screwerId: null, screwerName: null, screweeId: null, screeeName: null, screwTimerMs: null } }, true);
    setState("pendingLogId", null, true); render();
    return { ok: true, message: "No players available for roulette, opening buzzers." };
  }

  setState(
    "round",
    { ...round, status: ROUND_STATUSES.ROULETTE, opensAt: null, closesAt: null, remainingCs: settings.timeOpen * 100, winnerId: null, winnerOption: null, winnerAnswer: null, winnerName: null, buzzedPlayerIds: [], roulette: { active: true, startedAt: now(), mode: settings.rouletteMode, topAmount, ceiling, targetPlayerId: targetPlayer?.id ?? null, targetPlayerName: targetPlayer ? getPlayerName(targetPlayer) : null, selections: {}, completedPlayerIds: [], finalValue: null, finishedAt: null }, screw: { active: false, screwerId: null, screwerName: null, screweeId: null, screeeName: null, screwTimerMs: null } },
    true,
  );
  setState("pendingLogId", null, true); render();
  return { ok: true, message: targetPlayer ? `${getPlayerName(targetPlayer)} will stop the roulette.` : "Roulette started." };
}

function updateScoresForLogEntry(logId, newAwardedDelta) {
  if (!isHost()) return;
  const log = getLog(); const entryIndex = log.findIndex(e => e.id === logId); if (entryIndex < 0) return;
  const entry = log[entryIndex]; const round = getRound(); let nextAwarded = Number(newAwardedDelta || 0);
  if (round.screw.active && round.screw.screweeId === entry.playerId) nextAwarded = -nextAwarded;
  const diff = nextAwarded - Number(entry.awardedDelta || 0);
  const scores = { ...getScores() };
  scores[entry.playerId] = Number(scores[entry.playerId] || 0) + diff;
  if (round.screw.active && round.screw.screwerId) scores[round.screw.screwerId] = Number(scores[round.screw.screwerId] || 0) - diff;
  const updatedLog = [...log]; updatedLog[entryIndex] = { ...entry, awardedDelta: nextAwarded, resolved: true, updatedAt: now() };
  setState("scores", scores, true); setState("gameLog", updatedLog, true);
  const pendingId = getSafeState("pendingLogId", null);
  if (pendingId === logId) { setState("pendingLogId", null, true); render(); }
}

function resolveLogEntryWithForcedDelta(logId, forcedDelta) {
  if (!isHost()) return;
  const log = getLog(); const entryIndex = log.findIndex(e => e.id === logId); if (entryIndex < 0) return;
  const entry = log[entryIndex]; const round = getRound();
  const diff = forcedDelta - Number(entry.awardedDelta || 0);
  const scores = { ...getScores() }; scores[entry.playerId] = Number(scores[entry.playerId] || 0) + diff;
  if (round.screw.active && round.screw.screwerId) scores[round.screw.screwerId] = Number(scores[round.screw.screwerId] || 0) - diff;
  const updatedLog = [...log]; updatedLog[entryIndex] = { ...entry, awardedDelta: forcedDelta, resolved: true, updatedAt: now() };
  setState("scores", scores, true); setState("gameLog", updatedLog, true);
}

function canBuzz(playerId, option) {
  const round = getRound(); const controllerId = getControllerId(); const settings = getSettings();
  if (playerId === controllerId) return false;
  if (round.status !== ROUND_STATUSES.OPEN) return false;
  if (round.screw.active && round.screw.screwTimerMs !== null && round.screw.screwTimerMs > 0) return playerId === round.screw.screweeId;
  if (round.screw.active) return false;
  if (!settings.rebuzzAllowed && round.buzzedPlayerIds.includes(playerId)) return false;
  if (!isPlayerBuzzerEnabled(settings, playerId)) return false;
  if (option !== undefined && !isOptionEnabled(settings, option)) return false;
  return true;
}

function getBuzzedParticipants(round, players) {
  const participantsById = new Map(players.map((p) => [p.id, p]));
  return (round.buzzedPlayerIds || [])
    .map((playerId) => participantsById.get(playerId))
    .filter(Boolean);
}

function hostHandleBuzz(player, payload) {
  if (!isHost()) return { ok: false, reason: "Not host" };
  const round = getRound(); const settings = getSettings(); const controllerId = getControllerId();
  const timeLeftMs = round.status === ROUND_STATUSES.OPEN ? Math.max(0, (round.closesAt || now() + settings.timeOpen * 1000) - now()) : Infinity;
  const shouldLockAfterBuzz = Boolean(settings.lockAfterBuzz);
  const validOption = payload?.option !== undefined ? Number(payload.option) : null;
  const answerText = payload?.answerText !== undefined ? String(payload.answerText) : "";
  
  if (!canBuzz(player.id, validOption ?? undefined)) { return { ok: false, reason: "Cannot buzz." }; }
  
  let basePoints = settings.scoringMode === "uniform" ? settings.uniformPoints : settings.scoringMode === "jack" ? Math.round(settings.uniformPoints * settings.jackMultiplier) : (round.roulette?.finalValue || 0);
  if (settings.scoringMode === "roulette") basePoints = round.roulette?.finalValue || 1000;

  const logEntry = { id: `log-${now()}-${player.id}`, playerId: player.id, playerName: getPlayerName(player), option: validOption, answer: answerText, basePoints, awardedDelta: 0, timestamp: now(), resolved: false };
  setState("gameLog", [...getLog(), logEntry], true);

  const buzzedPlayerIds = round.buzzedPlayerIds.includes(player.id) ? round.buzzedPlayerIds : [...round.buzzedPlayerIds, player.id];
  
  if (usingTextEntry && isFYouEasterEggAnswer(answerText) && !isFYouCorrectAnswer(round)) {
    setState("round", { ...round, status: shouldLockAfterBuzz ? ROUND_STATUSES.LOCKED : round.status, winnerId: shouldLockAfterBuzz ? player.id : null, winnerOption: validOption, winnerAnswer: answerText, winnerName: getPlayerName(player), remainingCs: timeLeftMs / 10, buzzedPlayerIds }, true);
    resolveLogEntryWithForcedDelta(logEntry.id, -(logEntry.basePoints * 2));
    return { ok: true, message: F_YOU_EASTER_EGG_H2, easterEgg: { id: "f-you" } };
  }

  const usingTextEntry = settings.inputMode === "text";
  
  if (shouldLockAfterBuzz) {
    setState(
      "round",
      { ...round, status: ROUND_STATUSES.LOCKED, winnerId: player.id, winnerOption: validOption, winnerAnswer: answerText, winnerName: getPlayerName(player), remainingCs: timeLeftMs / 10, buzzedPlayerIds },
      true,
    );
    setState("pendingLogId", logEntry.id, true);

    try {
      let isCorrect = false;
      if (settings.inputMode === "text" && round.correctAnswer) { const correct = String(round.correctAnswer || "").trim().toLowerCase(); if (answerText && String(answerText).trim().toLowerCase() === correct) isCorrect = true; }
      else if (settings.inputMode !== "text" && Array.isArray(round.correctOptions) && round.correctOptions.length > 0) { if (validOption !== null && round.correctOptions.map(Number).includes(Number(validOption))) isCorrect = true; }
      if (isCorrect) updateScoresForLogEntry(logEntry.id, logEntry.basePoints);
    } catch(e) {}
  } else {
    setState("round", { ...round, buzzedPlayerIds }, true);
  }

  render();
  return { ok: true, message: shouldLockAfterBuzz ? (usingTextEntry ? `${getPlayerName(player)} locked in an answer.` : `${getPlayerName(player)} locked in option ${validOption}.`) : (usingTextEntry ? `${getPlayerName(player)} submitted an answer.` : `${getPlayerName(player)} buzzed option ${validOption}.`), logId: logEntry.id };
}

function submitResponse(payload) {
  if (isControllerPlayer()) return;
  submitResponseAsync(payload);
}

async function submitResponseAsync(payload) {
  try {
    const result = await RPC.call("buzz", payload, RPC.Mode.HOST);
    if (result?.ok === false) { setBuzzNotice(result.reason || "Buzz blocked."); render(); return; }
    if (result?.easterEgg?.id === "f-you") fYouEasterEggUnlocked = true;
    setBuzzNotice(result?.message || "Buzz sent.");
    render();
  } catch { setBuzzNotice("Could not send buzz."); render(); }
}

function openBuzzersHost() { openBuzzers(); }
function closeBuzzersHost() { closeBuzzers(); }

function initiateScrew(screwerId) {
  if (!isHost()) return { ok: false, reason: "Only host can initiate screw." };
  const round = getRound(); const settings = getSettings();
  if (!settings.allowScrewing) return { ok: false, reason: "Screwing not enabled." };
  if (round.status !== ROUND_STATUSES.OPEN) return { ok: false, reason: "Buzzers not open." };
  if (round.screw.active) return { ok: false, reason: "Screw in progress." };
  if (round.screwsUsed >= 1) return { ok: false, reason: "Screw already used." };
  const screwer = currentParticipants().find(p => p.id === screwerId);
  if (!screwer) return { ok: false, reason: "Invalid screwer." };
  setState("round", { ...round, screw: { ...round.screw, active: true, screwerId, screwerName: getPlayerName(screwer), screweeId: null, screeeName: null, screwTimerMs: null } }, true);
  setBuzzNotice("A screw is being used..."); render();
  return { ok: true, message: `${getPlayerName(screwer)} initiated a screw.` };
}

function selectScrewee(screweeId) {
  if (!isHost()) return { ok: false, reason: "Only host can select screwee." };
  const round = getRound(); if (!round.screw.active) return { ok: false, reason: "No screw in progress." };
  if (round.screw.screweeId !== null) return { ok: false, reason: "Screwee already selected." };
  const screwee = currentParticipants().find(p => p.id === screweeId);
  if (!screwee) return { ok: false, reason: "Invalid screwee." };
  if (screwee.id === getControllerId()) return { ok: false, reason: "Cannot screw the host." };
  if (screwee.id === round.screw.screwerId) return { ok: false, reason: "Cannot screw yourself." };
  setState("round", { ...round, screw: { ...round.screw, screweeId, screeeName: getPlayerName(screwee), screwTimerMs: null } }, true);
  render(); return { ok: true, message: `${round.screw.screwerName} is screwing over ${getPlayerName(screwee)}.` };
}

function startScrewTimer() {
  if (!isHost()) return { ok: false, reason: "Only host can start screw timer." };
  const round = getRound(); if (!round.screw.active || !round.screw.screweeId) return { ok: false, reason: "No screw in progress." };
  setState("round", { ...round, screw: { ...round.screw, screwTimerMs: 5000 } }, true); render();
  return { ok: true, message: "Screw timer started." };
}

function closeScrewMode() {
  if (!isHost()) return;
  const round = getRound();
  setState(
    "round",
    { ...round, screw: { active: false, screwerId: null, screwerName: null, screweeId: null, screeeName: null, screwTimerMs: null } },
    true,
  );
  render();
}

function getScrewTimeLeft(round) {
  if (!round.screw.active || !round.screw.screwTimerMs) return null;
  return Math.max(0, Math.ceil(round.screw.screwTimerMs / 10));
}

function hostTick() {
  const round = getRound();
  if (round.status === ROUND_STATUSES.OPEN || round.status === ROUND_STATUSES.ROULETTE) {
    if (round.screw.active && round.screw.screwTimerMs !== null) {
      setState("round", { ...round, screw: { ...round.screw, screwTimerMs: round.screw.screwTimerMs - 100 } }, true);
      if (round.screw.screwTimerMs <= 0) {
        const basePoints = getSettings().scoringMode === "roulette" ? (round.roulette?.finalValue || 1000) : getSettings().uniformPoints;
        const scores = { ...getScores() };
        scores[round.screw.screweeId] = Number(scores[round.screw.screweeId] || 0) - basePoints;
        scores[round.screw.screwerId] = Number(scores[round.screw.screwerId] || 0) + basePoints;
        setState("scores", scores, true);
        closeScrewMode();
      }
      render(); return;
    }
    if (round.screw.active) { render(); return; }
  }
}

function hostTickLoop() {
  const round = getRound();
  if (round.status === ROUND_STATUSES.OPEN && !round.screw.active) {
    const settings = getSettings();
    const timeLeftCs = getTimeLeftCs(round, settings);
    if (timeLeftCs <= 0) {
      setState("round", { ...round, status: ROUND_STATUSES.CLOSED, remainingCs: 0, winnerId: null, winnerOption: null, winnerAnswer: null, winnerName: null }, true);
      setState("pendingLogId", null, true); render(); return;
    }
  }
}

// ========== Team Management Functions ==========

function generateTeamConfig(teamIndex) {
  const colorInfo = TEAM_COLORS[teamIndex % TEAM_COLORS.length];
  return {
    name: colorInfo.name,
    color: colorInfo.hex,
    playerIds: [],
  };
}

function getAvailableTeamIndex() {
  const teams = getTeams();
  let idx = 0;
  while (teams[TEAM_COLORS[idx % TEAM_COLORS.length].name]) {
    idx++;
  }
  return idx;
}

function addPlayerToTeam(playerId, teamColorName) {
  if (!isHost()) return;
  const teams = getTeams();
  const colorInfo = TEAM_COLORS.find(c => c.name === teamColorName);
  if (!colorInfo) return;
  
  let targetTeam = teams[teamColorName];
  if (!targetTeam) {
    targetTeam = generateTeamConfig(TEAM_COLORS.indexOf(colorInfo));
    teams[teamColorName] = targetTeam;
  }
  if (!targetTeam.playerIds.includes(playerId)) {
    targetTeam.playerIds = [...targetTeam.playerIds, playerId];
  }
  setState("teams", teams, true);
  render();
}

function removePlayerFromTeam(playerId) {
  if (!isHost()) return;
  const teams = getTeams();
  for (const [name, team] of Object.entries(teams)) {
    team.playerIds = (team.playerIds || []).filter(id => id !== playerId);
    if (team.playerIds.length === 0) delete teams[name];
  }
  setState("teams", teams, true);
  render();
}

function assignPlayerToTeam(playerId, teamColorName) {
  if (!isHost()) return;
  removePlayerFromTeam(playerId);
  addPlayerToTeam(playerId, teamColorName);
}

function getUnassignedPlayers() {
  const teams = getTeams();
  const allAssigned = new Set();
  for (const team of Object.values(teams)) {
    if (team.playerIds) team.playerIds.forEach(id => allAssigned.add(id));
  }
  return currentParticipants().filter(p => p.id !== getControllerId() && !allAssigned.has(p.id));
}

function areAllPlayersAssigned() {
  const unassigned = getUnassignedPlayers();
  if (unassigned.length === 0) return true;
  // Check if all non-host participants have been assigned at least once
  return false;
}

function hasTeamAssignmentStarted() {
  const teams = getTeams();
  return Object.keys(teams).length > 0;
}

function setTeamModeType(type) {
  if (!isHost()) return;
  const settings = getSettings();
  setState("settings", { ...settings, teamModeType: type }, true);
  render();
}

function isTeamGame() {
  return getGameMode() === "team";
}

function hasTeamsBeenSetup() {
  if (!isTeamGame()) return false;
  const teams = getTeams();
  return Object.keys(teams).length > 0;
}

function renderScrewNotice(round) {
  if (!getSettings().allowScrewing || !round.screw.active) return "";
  const timeText = round.screw.screwTimerMs !== null
    ? formatSeconds(Math.ceil(round.screw.screwTimerMs / 10))
    : "pending";
  return `<section class="card host-panel screw-notice-card">
    <h2>Screw Active</h2>
    <p><strong>${escapeHtml(round.screw.screwerName)}</strong> is screwing over <strong>${escapeHtml(round.screw.screeeName || "TBD")}</strong></p>
    <p class="muted">Timer: <strong>${timeText}s</strong></p>
    ${!round.screw.screwTimerMs ? `<button type="button" class="primary-action" data-host-action="start-screw-timer">Start Timer</button>` : ""}
  </section>`;
}

function renderLockedRuling(settings, pendingEntry) {
  if (!pendingEntry || settings.scoringMode === "roulette") return "";
  const quickPoints = settings.scoringMode === "jack" ? Math.round(settings.uniformPoints * settings.jackMultiplier) : settings.scoringMode === "uniform" ? settings.uniformPoints : (getRound().roulette?.finalValue || 1000);
  return `
    <section class="card ruling-card">
      <h2>Awaiting Ruling</h2>
      <p><strong>${escapeHtml(pendingEntry.playerName)}</strong>'s answer: ${pendingEntry.answer ? `"${escapeHtml(pendingEntry.answer)}"` : `Option ${pendingEntry.option}`}</p>
      <div class="ruling-actions">
        <button type="button" class="green" data-ruling="${pendingEntry.id}" data-log-quick="plus">+${quickPoints}</button>
        <button type="button" class="red" data-ruling="${pendingEntry.id}" data-log-quick="minus">-${quickPoints}</button>
        ${settings.scoringMode === "uniform" ? `<button type="button" class="red" data-ruling="${pendingEntry.id}">0</button>` : ""}
        <input type="number" value="0" placeholder="Custom" data-log-input="${pendingEntry.id}" style="width:80px" />
        <button type="button" data-ruling-apply="${pendingEntry.id}" class="secondary-action">Apply</button>
      </div>
    </section>`;
}

function renderLog(log, settings) {
  const rows = [...log].reverse().map((entry) => {
    const controls = isControllerPlayer() ? `
      <div class="log-controls">
        <input type="number" value="${Number(entry.awardedDelta || 0)}" data-log-input="${entry.id}" />
        <button type="button" data-log-apply="${entry.id}">Apply</button>
        <button type="button" class="green" data-log-quick="plus" data-log-id="${entry.id}">+${entry.basePoints}</button>
        <button type="button" class="red" data-log-quick="minus" data-log-id="${entry.id}">-${entry.basePoints}</button>
      </div>` : "";
    return `<li><div class="log-main"><span class="log-player">${escapeHtml(entry.playerName)}</span>${entry.option !== null ? `<span>Option ${entry.option}</span>` : ""}${entry.answer ? `<span>"${escapeHtml(entry.answer)}"</span>` : ""}<span>${formatTimestamp(entry.timestamp)}</span></div>${controls}</li>`;
  });
  return `<section class="card log-card"><h2>Game Log</h2><ul class="log-list">${rows.join("") || "<li>No entries yet.</li>"}</ul></section>`;
}

function formatTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.${String(d.getMilliseconds()).padStart(3,'0')}`;
}

function renderHostSettings(settings, round, timeLeftCs, players, controllerId) {
  if (!isControllerPlayer()) return "";
  const settingsLocked = round.status === ROUND_STATUSES.OPEN || round.status === ROUND_STATUSES.ROULETTE;
  const settingDisabledAttr = settingsLocked ? "disabled" : "";
  const nonControllerPlayers = players.filter(p => p.id !== controllerId);
  const teamModeType = settings.teamModeType || "alliance";
  
  let gameModeHtml = "";
  if (isTeamGame() && !settingsLocked) {
    gameModeHtml = `
      <div class="team-mode-toggle-group">
        <span class="muted">Team Scoring</span>
        <div class="toggle-list">
          <button type="button" class="toggle-chip ${teamModeType === 'alliance' ? 'is-on' : 'is-off'}" data-team-mode="alliance" ${settingDisabledAttr}>Alliance</button>
          <button type="button" class="toggle-chip ${teamModeType === 'shared' ? 'is-on' : 'is-off'}" data-team-mode="shared" ${settingDisabledAttr}>Shared</button>
        </div>
      </div>`;
  }

  let teamAssignmentHtml = "";
  if (isTeamGame() && hasTeamsBeenSetup()) {
    const teams = getTeams();
    const unassigned = getUnassignedPlayers();
    const teamButtons = TEAM_COLORS.map(c => {
      const team = teams[c.name];
      const count = team ? (team.playerIds?.length || 0) : 0;
      const active = !!team;
      return `<button type="button" class="team-assign-chip" data-team-assign="${c.name}" style="--chip-color:${c.hex}">${c.name} <span>(${count})</span></button>`;
    }).join("");
    
    teamAssignmentHtml = `
      <section class="card team-assignment-panel">
        <h2>Team Management</h2>
        ${unassigned.length > 0 ? `
          <p class="muted">Unassigned: <strong>${unassigned.map(p => escapeHtml(getPlayerName(p))).join(", ")}</strong></p>
          <div class="team-assign-grid">${teamButtons}</div>
        ` : `<p class="muted">All players assigned.</p>`}
        <h3 style="margin-top:0.75rem">Players</h3>
        <div class="player-team-list">
          ${nonControllerPlayers.map(p => {
            const pt = getPlayerTeam(p.id);
            return `<div class="player-team-row"><span>${escapeHtml(getPlayerName(p))}</span><span class="team-color-dot" style="background:${pt ? pt.teamConfig.color : '#8e99a4'}">${pt ? pt.teamConfig.name : "Unassigned"}</span></div>`;
          }).join("")}
        </div>
      </section>`;
  } else if (isTeamGame()) {
    const unassigned = getUnassignedPlayers();
    teamAssignmentHtml = `
      <section class="card team-assignment-panel">
        <h2>Team Assignment</h2>
        <p class="muted">${unassigned.length > 0 ? `${unassigned.length} player${unassigned.length > 1 ? 's' : ''} waiting to join.` : "All players assigned."}</p>
        ${nonControllerPlayers.length > 0 ? `
          <div class="team-assign-grid">
            ${TEAM_COLORS.map(c => `<button type="button" class="team-assign-chip" data-team-create="${c.name}" style="--chip-color:${c.hex}">${c.name} <span>(0)</span></button>`).join("")}
          </div>
        ` : ""}
      </section>`;
  }

  const statusText = { [ROUND_STATUSES.IDLE]: "Idle", [ROUND_STATUSES.OPEN]: "Open", [ROUND_STATUSES.ROULETTE]: "Roulette", [ROUND_STATUSES.LOCKED]: "Locked", [ROUND_STATUSES.CLOSED]: "Closed" }[round.status];
  const roulettePlayerCount = Math.max(1, nonControllerPlayers.length);
  const rouletteCeiling = Math.max(1, Math.floor(normalizeRouletteTopAmount(settings.rouletteTopAmount) / roulettePlayerCount));

  return `
    <section class="card host-panel">
      <h2>Host Controls</h2>
      <div class="control-grid">
        <label>Time open<input type="number" min="1" max="120" step="1" value="${settings.timeOpen}" data-setting="timeOpen" ${settingDisabledAttr} /></label>
        <label>Lock after buzz<select data-setting="lockAfterBuzz" ${settingDisabledAttr}><option value="true" ${settings.lockAfterBuzz ? "selected" : ""}>On</option><option value="false" ${!settings.lockAfterBuzz ? "selected" : ""}>Off</option></select></label>
        <label>Re-Buzz allowed<select data-setting="rebuzzAllowed" ${settingDisabledAttr}><option value="true" ${settings.rebuzzAllowed ? "selected" : ""}>On</option><option value="false" ${!settings.rebuzzAllowed ? "selected" : ""}>Off</option></select></label>
        <label>Show scores to players<select data-setting="showScoresToPlayers" ${settingDisabledAttr}><option value="true" ${settings.showScoresToPlayers ? "selected" : ""}>On</option><option value="false" ${!settings.showScoresToPlayers ? "selected" : ""}>Off</option></select></label>
        <label>Answer mode<select data-setting="inputMode" ${settingDisabledAttr}><option value="buttons" ${settings.inputMode !== "text" ? "selected" : ""}>Button buzzer</option><option value="text" ${settings.inputMode === "text" ? "selected" : ""}>Text entry</option></select></label>
        ${settings.lockAfterBuzz ? `<label>Close on points given<select data-setting="closeBuzzersOnPointsGiven"><option value="true" ${settings.closeBuzzersOnPointsGiven ? "selected" : ""}>On</option><option value="false" ${!settings.closeBuzzersOnPointsGiven ? "selected" : ""}>Off</option></select></label>` : ""}
        ${settings.inputMode === "text" ? "" : `<label>Option count<select data-setting="optionCount"><option value="1" ${settings.optionCount===1?"selected":""}>1</option><option value="2" ${settings.optionCount===2?"selected":""}>2</option><option value="4" ${settings.optionCount===4?"selected":""}>4</option><option value="6" ${settings.optionCount===6?"selected":""}>6</option></select></label>`}
        <label>Scoring<select data-setting="scoringMode"><option value="uniform" ${settings.scoringMode==="uniform"?"selected":""}>Uniform</option><option value="jack" ${settings.scoringMode==="jack"?"selected":""}>JACK</option><option value="roulette" ${settings.scoringMode==="roulette"?"selected":""}>Roulette</option></select></label>
        ${settings.scoringMode === "uniform" ? `<label>Uniform points<select data-setting="uniformPoints"><option value="1000" ${settings.uniformPoints===1000?"selected":""}>1000</option><option value="2000" ${settings.uniformPoints===2000?"selected":""}>2000</option><option value="3000" ${settings.uniformPoints===3000?"selected":""}>3000</option></select></label>` : `<label>JACK multiplier<select data-setting="jackMultiplier"><option value="1" ${settings.jackMultiplier===1?"selected":""}>1x</option><option value="2" ${settings.jackMultiplier===2?"selected":""}>2x</option><option value="3" ${settings.jackMultiplier===3?"selected":""}>3x</option></select></label>`}
        ${settings.scoringMode === "roulette" ? `<label>Roulette mode<select data-setting="rouletteMode"><option value="additive" ${settings.rouletteMode==="additive"?"selected":""}>Additive</option><option value="highest" ${settings.rouletteMode==="highest"?"selected":""}>Highest</option><option value="single-player" ${settings.rouletteMode==="single-player"?"selected":""}>Single</option></select></label><label>Top amount<select data-setting="rouletteTopAmount"><option value="500" ${normalizeRouletteTopAmount(settings.rouletteTopAmount)===500?"selected":""}>500</option><option value="1000" ${normalizeRouletteTopAmount(settings.rouletteTopAmount)===1000?"selected":""}>1000</option><option value="2000" ${normalizeRouletteTopAmount(settings.rouletteTopAmount)===2000?"selected":""}>2000</option><option value="3000" ${normalizeRouletteTopAmount(settings.rouletteTopAmount)===3000?"selected":""}>3000</option></select></label>` : ""}
        <label>Allow screwing<select data-setting="allowScrewing"><option value="true" ${settings.allowScrewing?"selected":""}>On</option><option value="false" ${!settings.allowScrewing?"selected":""}>Off</option></select></label>
      </div>
      <div class="control-actions">
        <button type="button" data-host-action="open" class="primary-action">Open Buzzers</button>
        ${isTeamGame() ? `<button type="button" data-host-action="start-roulette" class="secondary-action">Start Roulette</button>` : `<button type="button" data-host-action="start-roulette" class="secondary-action">Roulette</button>`}
        <button type="button" data-host-action="close" class="secondary-action">Close Buzzers</button>
        <button type="button" data-host-action="reset" class="secondary-action">Reset Round</button>
        ${settings.allowScrewing ? `<button type="button" data-host-action="reset-screws" class="secondary-action">Undo Screw</button>` : ""}
      </div>
      ${gameModeHtml}
      ${teamAssignmentHtml}
    </section>`;
}

// ========== Score Rendering ==========

function renderScores(players, scores) {
  const controllerId = getControllerId();
  const visiblePlayers = players.filter(p => p.id !== controllerId);
  const teams = getTeams();
  const gameMode = getGameMode();
  
  if (isTeamGame() && Object.keys(teams).length > 0) {
    return renderTeamScores(players, scores, teams);
  }
  
  // Standard score display
  const items = visiblePlayers.map(p => `<li><span>${escapeHtml(getPlayerName(p))}</span><strong>${Number(scores[p.id] || 0)}</strong></li>`).join("");
  return `<section class="card score-card"><h2>Scores</h2><ul>${items || "<li>No players yet.</li>"}</ul></section>`;
}

function renderTeamScores(players, scores, teams) {
  const teamModeType = getSettings().teamModeType || "alliance";
  const teamOrder = TEAM_COLORS.map(c => c.name).filter(name => teams[name]);
  
  let html = `<h2>Teams</h2><ul class="team-score-list">`;
  
  for (const teamName of teamOrder) {
    const team = teams[teamName];
    const color = team.color;
    const members = team.playerIds || [];
    
    if (teamModeType === "shared") {
      // Shared team score
      let teamScore = 0;
      members.forEach(pid => { teamScore += Number(scores[pid] || 0); });
      html += `<li class="team-score-row" style="--team-color:${color}"><span class="team-name-badge" style="background:${color}">${escapeHtml(team.name)}</span><span class="team-total-score"><strong>${teamScore}</strong></span></li>`;
    } else {
      // Alliance mode: show team as parent, players indented
      let allianceScore = 0;
      const memberRows = members.map(pid => {
        const pScore = Number(scores[pid] || 0);
        allianceScore += pScore;
        const playerName = getPlayerName(players.find(p => p.id === pid)) || "Player";
        return `<li class="team-member-row"><span>${escapeHtml(playerName)}</span><strong>${pScore}</strong></li>`;
      }).join("");
      html += `<li class="team-score-row" style="--team-color:${color}"><span class="team-name-badge" style="background:${color}">${escapeHtml(team.name)} <small>(alliance: ${allianceScore})</small></span></li>${memberRows}`;
    }
  }
  
  html += "</ul>";
  return `<section class="card score-card">${html}</section>`;
}

function getRound() {
  return getSafeState("round", {
    status: ROUND_STATUSES.IDLE, opensAt: null, closesAt: null, remainingCs: null, winnerId: null, winnerOption: null, winnerAnswer: null, winnerName: null, buzzedPlayerIds: [],
    roulette: { active: false, startedAt: null, mode: "additive", topAmount: 1000, ceiling: 0, targetPlayerId: null, targetPlayerName: null, selections: {}, completedPlayerIds: [], finalValue: null, finishedAt: null },
    screw: { active: false, screwerId: null, screwerName: null, screweeId: null, screeeName: null, screwTimerMs: null }, screwsUsed: 0,
  });
}

// ========== Player Buzzer Panel ==========

function renderBuzzerPanel(settings, round, mePlayer, timeLeftCs) {
  if (isControllerPlayer()) {
    return `<section class="card player-card controller-card"><h2>Host Control Screen</h2><p>You are the Host and do not have a buzzer input.</p></section>`;
  }

  // Show team assignment phase for team mode players
  if (isTeamGame() && !hasTeamsBeenSetup()) {
    return `
      <section class="card player-card waiting-card">
        <h2>Waiting</h2>
        <p class="muted">The host is setting up teams. Your buzzer will appear shortly.</p>
      </section>`;
  }

  if (round.status === ROUND_STATUSES.ROULETTE) return renderRoulettePanel(settings, round, mePlayer);

  // Screw player selection
  if (round.screw.active && !round.screw.screweeId && mePlayer.id === round.screw.screwerId) {
    const nonHostPlayers = currentParticipants().filter(p => p.id !== getControllerId() && p.id !== mePlayer.id);
    return `<section class="card player-card"><h2>Select Who to Screw</h2><div class="screw-player-list">${nonHostPlayers.map(p => `<button type="button" data-screw-player="${p.id}">${escapeHtml(getPlayerName(p))}</button>`).join("")}</div></section>`;
  }

  // Screw waiting for non-active players
  if (round.screw.active && mePlayer.id !== round.screw.screwerId && mePlayer.id !== round.screw.screweeId) {
    const timeText = round.screw.screwTimerMs !== null ? formatSeconds(Math.ceil(round.screw.screwTimerMs / 10)) : "pending";
    return `<section class="card player-card"><h2>Hold Up!</h2><p class="muted">A screw is being used.</p></section>`;
  }

  // Screwee buzzer
  if (round.screw.active && mePlayer.id === round.screw.screweeId) {
    const timeText = round.screw.screwTimerMs !== null ? formatSeconds(Math.ceil(round.screw.screwTimerMs / 10)) : "waiting";
    const buzzerDisabled = !round.screw.screwTimerMs || round.screw.screwTimerMs <= 0;
    const teamInfo = getPlayerTeam(mePlayer.id);
    const teamBadge = teamInfo ? `<span class="team-badge" style="background:${teamInfo.teamConfig.color}">${escapeHtml(teamInfo.teamConfig.name)}</span>` : "";
    if (settings.optionCount === 1) return `
      <section class="card player-card"><h2>${teamBadge} You're Being Screwed!</h2><p class="muted">Timer: <strong>${timeText}s</strong></p><button type="button" class="big-red" data-buzz="1" ${buzzerDisabled ? "disabled" : ""}>BUZZ</button></section>`;
    const btn = (opt, cls) => `<button type="button" class="${cls}" data-buzz="${opt}" ${buzzerDisabled ? "disabled" : ""}>${optionButtonLabel(opt)}</button>`;
    return `
      <section class="card player-card"><h2>${teamBadge} You're Being Screwed!</h2><p class="muted">Timer: <strong>${timeText}s</strong></p><div class="abxy-diamond">${btn(4,"pos-y")}${btn(2,"pos-b")}${btn(3,"pos-x")}${btn(1,"pos-a")}</div></section>`;
  }

  const disabled = round.status !== ROUND_STATUSES.OPEN;
  const alreadyBuzzed = round.buzzedPlayerIds.includes(mePlayer.id);
  const rebuzzAllowed = Boolean(settings.rebuzzAllowed);
  const playerDisabled = !isPlayerBuzzerEnabled(settings, mePlayer.id);
  const screwInProgress = round.screw.active;
  const globalDisabled = disabled || (!rebuzzAllowed && alreadyBuzzed) || playerDisabled || screwInProgress;
  const helperText = playerDisabled ? "Your buzzer is disabled by the Host." : disabled ? "Buzzers are currently closed." : !rebuzzAllowed && alreadyBuzzed ? "You already buzzed this round." : screwInProgress ? "A screw is in progress." : "Buzz now.";

  const teamInfo = getPlayerTeam(mePlayer.id);
  const teamBadge = teamInfo ? `<span class="team-badge" style="background:${teamInfo.teamConfig.color}">${escapeHtml(teamInfo.teamConfig.name)}</span>` : "";
  
  // Shared mode buzzer display: show team buzzer state
  if (isTeamGame() && teamInfo && getSettings().teamModeType === "shared") {
    const buzzed = round.buzzedPlayerIds.includes(mePlayer.id);
    return `
      <section class="card player-card team-buzzer-card" style="--team-color:${teamInfo.teamConfig.color}">
        ${teamBadge}
        <h2>${teamInfo.teamConfig.name} Buzzer</h2>
        <p class="muted">${helperText}</p>
        ${buzzed ? `<button type="button" disabled class="big-red buzzed-team-buzzer"><span>Your team has already buzzed</span></button>` : `<button type="button" class="big-red" data-buzz="1" ${disabled || playerDisabled || screwInProgress ? "disabled" : ""}>${teamInfo.teamConfig.name} BUZZ</button>`}
        <p class="muted" style="margin-top:0.5rem">Timer: <strong data-live-time-left>${formatSeconds(timeLeftCs)}s</strong></p>
      </section>`;
  }

  const usingTextEntry = settings.inputMode === "text";
  const notice = getRecentBuzzNotice();

  if (usingTextEntry) {
    return `
      <section class="card player-card">
        ${teamBadge}
        <h2>${alreadyBuzzed ? "You buzzed!" : "Enter your answer"}</h2>
        <p class="muted">${helperText}</p>
        <div class="text-entry"><input id="answer-entry" type="text" placeholder="Type your answer..." data-buzz-answer /><button type="button" data-answer-submit ${globalDisabled ? "disabled" : ""}>Submit</button></div>
        <p class="muted">Timer: <strong data-live-time-left>${formatSeconds(timeLeftCs)}s</strong></p>
      </section>`;
  }

  let buttonsHtml = "";
  if (settings.optionCount === 1) {
    buttonsHtml = `<button type="button" class="big-red" data-buzz="1" ${globalDisabled ? "disabled" : ""}>BUZZ</button>`;
  } else if (settings.optionCount === 4) {
    const btn = (opt, cls) => `<button type="button" class="${cls}" data-buzz="${opt}" ${globalDisabled ? "disabled" : ""}>${optionButtonLabel(opt)}</button>`;
    buttonsHtml = `<div class="abxy-diamond">${btn(4,"pos-y")}${btn(2,"pos-b")}${btn(3,"pos-x")}${btn(1,"pos-a")}</div>`;
  } else {
    const btns = Array.from({length: settings.optionCount}, (_,i) => i+1);
    buttonsHtml = `<div class="six-grid">${btns.map(o => `<button type="button" data-buzz="${o}" ${globalDisabled ? "disabled" : ""}>${optionButtonLabel(o)}</button>`).join("")}</div>`;
  }

  return `
    <section class="card player-card">
      ${teamBadge}
      <h2>${alreadyBuzzed ? "You buzzed!" : helperText}</h2>
      <div class="${settings.optionCount === 4 ? 'abxy-diamond' : settings.optionCount === 6 ? 'six-grid' : ''}">${buttonsHtml}</div>
      ${notice ? `<p class="muted" style="color:#1db954;font-weight:700">${escapeHtml(notice)}</p>` : ""}
      <p class="muted">Timer: <strong data-live-time-left>${formatSeconds(timeLeftCs)}s</strong></p>
    </section>`;
}
