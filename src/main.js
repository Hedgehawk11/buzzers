import "./style.css";
import { RPC, getParticipants, getRoomCode, getState, insertCoin, isHost, me, setState } from "playroomkit";

const DEFAULT_SETTINGS = {
  timeOpen: 20,
  lockAfterBuzz: true,
  optionCount: 4,
  scoringMode: "uniform",
  uniformPoints: 1000,
  jackMultiplier: 1,
};

const ROUND_STATUSES = {
  IDLE: "idle",
  OPEN: "open",
  LOCKED: "locked",
  CLOSED: "closed",
};

const app = document.querySelector("#app");
const NAME_KEY = "buzzer_player_name";
let gameLaunched = false;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const now = () => Date.now();

function getSafeState(key, fallback) {
  const value = getState(key);
  return value === undefined || value === null ? fallback : value;
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

function getRound() {
  return getSafeState("round", {
    status: ROUND_STATUSES.IDLE,
    opensAt: null,
    closesAt: null,
    remainingCs: null,
    winnerId: null,
    winnerOption: null,
    winnerName: null,
    buzzedPlayerIds: [],
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

function canBuzz(playerId) {
  const round = getRound();
  const controllerId = getControllerId();
  if (playerId === controllerId) {
    return false;
  }
  if (round.status !== ROUND_STATUSES.OPEN) {
    return false;
  }
  return !round.buzzedPlayerIds.includes(playerId);
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

function computeBasePoints(settings, timeLeftCs) {
  if (settings.scoringMode === "uniform") {
    return settings.uniformPoints;
  }
  return Math.max(0, Math.round(timeLeftCs * settings.jackMultiplier));
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
  const oldAwarded = Number(entry.awardedDelta || 0);
  const nextAwarded = Number(newAwardedDelta || 0);
  const diff = nextAwarded - oldAwarded;

  const scores = getScores();
  scores[entry.playerId] = Number(scores[entry.playerId] || 0) + diff;

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
    const round = getRound();
    if (round.status === ROUND_STATUSES.LOCKED) {
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
    }
  }
}

function pushBuzzLogEntry(player, option, timeLeftCs) {
  const settings = getSettings();
  const points = computeBasePoints(settings, timeLeftCs);
  const entry = {
    id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "buzz",
    ts: now(),
    playerId: player.id,
    playerName: getPlayerName(player),
    option,
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

function hostHandleBuzz(player, option) {
  const settings = getSettings();
  const round = getRound();

  if (!canBuzz(player.id)) {
    return { ok: false, reason: "Buzzers are not open or you already buzzed." };
  }

  const validOption = Number(option);
  if (!Number.isInteger(validOption) || validOption < 1 || validOption > settings.optionCount) {
    return { ok: false, reason: "Invalid option." };
  }

  const timeLeftCs = getTimeLeftCs(round, settings);
  const logEntry = pushBuzzLogEntry(player, validOption, timeLeftCs);
  const buzzedPlayerIds = [...round.buzzedPlayerIds, player.id];

  if (settings.lockAfterBuzz) {
    setState(
      "round",
      {
        ...round,
        status: ROUND_STATUSES.LOCKED,
        winnerId: player.id,
        winnerOption: validOption,
        winnerName: getPlayerName(player),
        remainingCs: timeLeftCs,
        buzzedPlayerIds,
      },
      true,
    );
    setState("pendingLogId", logEntry.id, true);
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

  return {
    ok: true,
    message: settings.lockAfterBuzz
      ? `${getPlayerName(player)} locked in option ${validOption}.`
      : `${getPlayerName(player)} buzzed option ${validOption}.`,
  };
}

async function submitBuzz(option) {
  if (isControllerPlayer()) {
    return;
  }
  try {
    await RPC.call("buzz", { option }, RPC.Mode.HOST);
  } catch {
    // Ignore noisy transport errors in UI.
  }
}

function openBuzzers() {
  if (!isHost()) {
    return;
  }
  const settings = getSettings();
  const openedAt = now();
  const closesAt = openedAt + settings.timeOpen * 1000;

  setState(
    "round",
    {
      status: ROUND_STATUSES.OPEN,
      opensAt: openedAt,
      closesAt,
      remainingCs: settings.timeOpen * 100,
      winnerId: null,
      winnerOption: null,
      winnerName: null,
      buzzedPlayerIds: [],
    },
    true,
  );
  setState("pendingLogId", null, true);
}

function closeBuzzers() {
  if (!isHost()) {
    return;
  }
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
      winnerName: null,
    },
    true,
  );
  setState("pendingLogId", null, true);
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
      winnerName: null,
      buzzedPlayerIds: [],
    },
    true,
  );
  setState("pendingLogId", null, true);
}

function hostTick() {
  if (!isHost()) {
    return;
  }
  const round = getRound();
  if (round.status !== ROUND_STATUSES.OPEN) {
    return;
  }
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
        winnerName: null,
      },
      true,
    );
    setState("pendingLogId", null, true);
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
  setState("settings", next, true);
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

function renderBuzzerPanel(settings, round, mePlayer) {
  if (isControllerPlayer()) {
    return `
      <section class="card player-card controller-card">
        <h2>Player 1 Control Screen</h2>
        <p>You are Player 1 and do not have a buzzer input.</p>
      </section>
    `;
  }

  const disabled = round.status !== ROUND_STATUSES.OPEN;
  const alreadyBuzzed = round.buzzedPlayerIds.includes(mePlayer.id);
  const notAllowed = disabled || alreadyBuzzed;

  const disabledAttr = notAllowed ? "disabled" : "";
  const helperText = disabled
    ? "Buzzers are currently closed."
    : alreadyBuzzed
      ? "You already buzzed this round."
      : "Buzz now.";

  if (settings.optionCount === 1) {
    return `
      <section class="card player-card">
        <h2>Your Buzzer</h2>
        <p class="muted">${helperText}</p>
        <button class="big-red" data-buzz="1" ${disabledAttr}>BUZZ</button>
      </section>
    `;
  }

  if (settings.optionCount === 6) {
    const buttons = [1, 2, 3, 4, 5, 6]
      .map((opt) => `<button data-buzz="${opt}" ${disabledAttr}>${opt}</button>`)
      .join("");
    return `
      <section class="card player-card">
        <h2>Your Buzzer</h2>
        <p class="muted">${helperText}</p>
        <div class="six-grid">${buttons}</div>
      </section>
    `;
  }

  const max = settings.optionCount;
  const buttons = [1, 2, 3, 4]
    .filter((opt) => opt <= max)
    .map((opt) => `<button data-buzz="${opt}" ${disabledAttr}>${optionButtonLabel(opt)}</button>`)
    .join("");

  return `
    <section class="card player-card">
      <h2>Your Buzzer</h2>
      <p class="muted">${helperText}</p>
      <div class="abxy">${buttons}</div>
    </section>
  `;
}

function renderHostSettings(settings, round, timeLeftCs) {
  if (!isControllerPlayer()) {
    return "";
  }

  const settingsLocked = round.status === ROUND_STATUSES.OPEN;
  const settingDisabledAttr = settingsLocked ? "disabled" : "";

  const statusText = {
    [ROUND_STATUSES.IDLE]: "Idle",
    [ROUND_STATUSES.OPEN]: "Open",
    [ROUND_STATUSES.LOCKED]: "Locked",
    [ROUND_STATUSES.CLOSED]: "Closed",
  }[round.status];

  return `
    <section class="card host-panel">
      <h2>Player 1 Controls</h2>
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
          Option count
          <select data-setting="optionCount" ${settingDisabledAttr}>
            <option value="1" ${settings.optionCount === 1 ? "selected" : ""}>1</option>
            <option value="2" ${settings.optionCount === 2 ? "selected" : ""}>2</option>
            <option value="4" ${settings.optionCount === 4 ? "selected" : ""}>4</option>
            <option value="6" ${settings.optionCount === 6 ? "selected" : ""}>6</option>
          </select>
        </label>

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
      </div>

      <div class="host-actions">
        <button data-host-action="open" ${round.status === ROUND_STATUSES.OPEN ? "disabled" : ""}>Open Buzzers</button>
        <button data-host-action="close">Close Buzzers</button>
        <button data-host-action="reset">Reset Round</button>
      </div>

      <div class="status-strip">
        <span>Status: <strong>${statusText}</strong></span>
        <span>Time left: <strong>${formatSeconds(timeLeftCs)}s</strong></span>
        ${settingsLocked ? "<span>Settings are locked while buzzers are open.</span>" : ""}
      </div>
    </section>
  `;
}

function renderLockedRuling(settings, pendingEntry) {
  if (!isControllerPlayer() || !settings.lockAfterBuzz || !pendingEntry) {
    return "";
  }

  const plusVal = pendingEntry.basePoints;
  const minusVal = -pendingEntry.basePoints;

  return `
    <section class="card ruling-card">
      <h3>Locked Ruling</h3>
      <p>
        ${pendingEntry.playerName} buzzed <strong>${pendingEntry.option}</strong> with
        <strong>${formatSeconds(pendingEntry.timeLeftCs)}s</strong> left.
      </p>
      <p>Base points: <strong>${pendingEntry.basePoints}</strong></p>
      <div class="ruling-actions">
        <button class="green" data-ruling="${plusVal}" data-log-id="${pendingEntry.id}">Correct (+${plusVal})</button>
        <button class="red" data-ruling="${minusVal}" data-log-id="${pendingEntry.id}">Incorrect (${minusVal})</button>
      </div>
    </section>
  `;
}

function renderScores(players, scores) {
  const items = players
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
            <button data-log-apply="${entry.id}">Apply</button>
            <button class="green" data-log-quick="plus" data-log-id="${entry.id}">+${entry.basePoints}</button>
            <button class="red" data-log-quick="minus" data-log-id="${entry.id}">-${entry.basePoints}</button>
          </div>
        `
        : "";

      return `
        <li>
          <div class="log-main">
            <span class="log-player">${entry.playerName}</span>
            <span>Option ${entry.option}</span>
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

  app.innerHTML = `
    <main class="layout">
      <header class="hero">
        <div>
          <h1>Playroom Buzzers</h1>
          <p>Room: <strong>${getRoomCode() || "..."}</strong></p>
        </div>
        <div class="hero-meta">
          <span>You: ${getPlayerName(mePlayer)}</span>
          <span>Player 1: ${controller ? getPlayerName(controller) : "-"}</span>
        </div>
      </header>

      ${renderHostSettings(settings, round, timeLeftCs)}

      <section class="grid">
        ${renderBuzzerPanel(settings, round, mePlayer)}
        ${renderScores(players, scores)}
      </section>

      ${renderLockedRuling(settings, pendingEntry)}
      ${renderLog(gameLog, settings)}
    </main>
  `;

  bindEvents();
}

function bindEvents() {
  app.querySelectorAll("[data-buzz]").forEach((button) => {
    button.addEventListener("click", () => {
      submitBuzz(Number(button.dataset.buzz));
    });
  });

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
        if (setting === "optionCount") {
          setHostSetting("optionCount", Number(input.value));
          return;
        }
        if (setting === "scoringMode") {
          setHostSetting("scoringMode", input.value);
          return;
        }
        if (setting === "uniformPoints") {
          setHostSetting("uniformPoints", Number(input.value));
          return;
        }
        if (setting === "jackMultiplier") {
          setHostSetting("jackMultiplier", Number(input.value));
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
  }
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
      active.id === "player-name" ||
      active.id === "join-room-code",
  );
}

function renderJoinScreen(error = "") {
  const savedName = localStorage.getItem(NAME_KEY) || "";
  app.innerHTML = `
    <main class="prejoin-layout">
      <section class="card prejoin-card">
        <h1>Playroom Buzzers</h1>
        <p class="muted">Choose a name, then host a room or join by code.</p>

        <label>
          Name
          <input id="player-name" type="text" maxlength="32" value="${savedName}" placeholder="Your name" />
        </label>

        <label>
          Room code (for Join)
          <input id="join-room-code" type="text" maxlength="12" placeholder="ABCD" />
        </label>

        ${error ? `<p class="error-text">${error}</p>` : ""}

        <div class="prejoin-actions">
          <button data-prejoin="host">Host Game</button>
          <button data-prejoin="join">Join Game</button>
        </div>
      </section>
    </main>
  `;

  app.querySelectorAll("[data-prejoin]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mode = button.dataset.prejoin;
      const nameInput = app.querySelector("#player-name");
      const roomInput = app.querySelector("#join-room-code");

      const chosenName = nameInput?.value?.trim() || "";
      const roomCode = roomInput?.value?.trim()?.toUpperCase() || "";

      if (!chosenName) {
        renderJoinScreen("Please choose a player name.");
        return;
      }

      if (mode === "join" && !roomCode) {
        renderJoinScreen("Enter a room code to join.");
        return;
      }

      localStorage.setItem(NAME_KEY, chosenName);
      button.disabled = true;

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
      roomCode,
    });
  } catch {
    renderJoinScreen("Could not connect to Playroom. Try again.");
    return;
  }

  gameLaunched = true;

  me().setState("displayName", playerName, true);

  RPC.register("buzz", async (payload, senderPlayer) => {
    if (!isHost()) {
      return { ok: false, reason: "Not host" };
    }
    return hostHandleBuzz(senderPlayer, Number(payload?.option));
  });

  ensureHostInit();
  render();

  setInterval(() => {
    ensureHostInit();
    hostTick();
      if (isEditingControl()) {
        return;
      }
    render();
  }, 100);
}

function boot() {
  renderJoinScreen();
}

boot();
