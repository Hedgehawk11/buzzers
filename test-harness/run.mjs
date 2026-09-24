import { register } from "node:module";
register("./hooks.mjs", import.meta.url);

const { installDom, mount, queryMap } = await import("./dom-stub.mjs");
installDom();
const pk = await import("./pk-stub.mjs");

let pass = 0;
let fail = 0;
const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => {
  warnings.push(a.map(String).join(" "));
  origWarn(...a);
};
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name} ${extra}`);
  }
}
const S = () => pk._store.state;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dual-mode run: HARNESS_COOP=off starts with coopertition disabled so shared
// paths are exercised both ways. Coop-lock tests (roster, control, preset
// gate, bans) only run with coop on; each is guarded by `if (COOP)`.
const COOP = process.env.HARNESS_COOP !== "off";
console.log(`[harness] coop-${COOP ? "on" : "off"} run`);

// --- boot as host ---
pk._store.self = pk.makePlayer("host1", "Host");
pk._store.participants = { host1: pk._store.self };
await import("../src/main.js");

// --- submit host prejoin form (coop per run mode) ---
queryMap["#prejoin-name"] = { value: "Host" };
queryMap["#prejoin-team-mode"] = { value: "off" };
queryMap["#prejoin-coop"] = { checked: COOP };
const fakeForm = {
  dataset: { prejoinForm: "host" },
  closest: (sel) => (sel === "[data-prejoin-form]" ? fakeForm : null),
  querySelector: () => ({ disabled: false }),
};
for (const fn of mount._listeners.submit || []) {
  await fn({ preventDefault() {}, target: fakeForm });
}
await sleep(50);
check(`coop ${COOP ? "enabled" : "disabled"} from prejoin`, S().settings?.coopertitionEnabled === COOP, JSON.stringify(S().settings?.coopertitionEnabled));
check("pause-on-points defaults off", S().settings?.closeBuzzersOnPointsGiven === false, JSON.stringify(S().settings?.closeBuzzersOnPointsGiven));

// --- dedicated producer fixture: drives all producer-action calls below ---
const prod = pk.makePlayer("prod1", "Producer");
pk._store.participants.prod1 = prod;
pk._store.state.producerIds = ["prod1"];
const impostor = pk.makePlayer("impostor", "Impostor");
check(
  "non-producer producer-action rejected",
  (await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, impostor))?.ok === false,
  "impostor drove a host action",
);

// --- add device, set roster (roster RPC is coop-gated) ---
const dev1 = pk.makePlayer("dev1", "GroupA");
pk._store.participants.dev1 = dev1;
const dev2 = pk.makePlayer("dev2", "GroupB");
pk._store.participants.dev2 = dev2;
if (COOP) {
  const res = await pk._store.rpc["coop-roster"](
    { group: "GroupA", count: 2, names: ["Ann", "Bob"] },
    dev1,
  );
  check("roster ok", res?.ok === true, JSON.stringify(res));
  check(
    "roster stored",
    JSON.stringify(S().coopRosters?.dev1) === JSON.stringify({ group: "GroupA", slots: ["Ann", "Bob"] }),
    JSON.stringify(S().coopRosters?.dev1),
  );
} else {
  const res = await pk._store.rpc["coop-roster"](
    { group: "GroupA", count: 2, names: ["Ann", "Bob"] },
    dev1,
  );
  check("roster rejected off-coop", res?.ok === false, JSON.stringify(res));
}

// --- lock-after-buzz on, open ---
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["lockAfterBuzz", true] }, prod);
// Pin the pause-on-points toggle off for the reopen-behavior tests below;
// dedicated LAB-gating tests further down cover the default-on behavior.
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["closeBuzzersOnPointsGiven", false] }, prod);
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
check("round open", S().round?.status === "open", S().round?.status);

// Dedicated device for the pause-on-points gating probes below, so their
// rulings never shift dev1/dev2/dev3's exact-score expectations downstream.
const gate = pk.makePlayer("gate1", "Gate");
pk._store.participants.gate1 = gate;
if (COOP) {
  await pk._store.rpc["coop-roster"]({ group: "Gate", count: 1, names: [] }, gate);
}

if (COOP) {
  // --- buzz-in then answer ---
  const r = await pk._store.rpc.buzz({ coopSlot: 0, buzzIn: true }, dev1);
  check("buzz-in ok", r?.ok === true, JSON.stringify(r));
  check("control set", S().round?.coopControl === "coop:dev1:0", S().round?.coopControl);
  const r2 = await pk._store.rpc.buzz({ option: 3 }, dev1);
  check("option pick ok", r2?.ok === true, JSON.stringify(r2));
  const entryId = S().pendingLogId;
  check("locked with pending entry", S().round?.status === "locked" && !!entryId, `${S().round?.status} ${entryId}`);
  const entry = S().gameLog.find((e) => e.id === entryId);
  check("entry keyed to slot", entry?.scoreKey === "coop:dev1:0", JSON.stringify(entry?.scoreKey));

  // --- THE DEDUCTION TEST ---
  await pk._store.rpc["producer-action"]({ fn: "updateScoresForLogEntry", args: [entryId, -1000] }, prod);
  check("minus 1000 deducted", S().scores?.["coop:dev1:0"] === -1000, JSON.stringify(S().scores));

  // --- correct ruling on fresh round + sibling lock, other groups free ---
  await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
  await pk._store.rpc.buzz({ coopSlot: 1, buzzIn: true }, dev1);
  await pk._store.rpc.buzz({ option: 2 }, dev1);
  const entryId2 = S().pendingLogId;
  await pk._store.rpc["producer-action"]({ fn: "updateScoresForLogEntry", args: [entryId2, 1000] }, prod);
  check("plus 1000 awarded", S().scores?.["coop:dev1:1"] === 1000, JSON.stringify(S().scores));
  check(
    "sibling locked out",
    (S().round?.buzzedPlayerIds || []).includes("coop:dev1:0"),
    JSON.stringify(S().round?.buzzedPlayerIds),
  );
  await pk._store.rpc["coop-roster"]({ group: "GroupB", count: 1, names: [] }, dev2);
  pk._store.nextSender = dev2;
  const rOther = await pk._store.rpc.buzz({ option: 1 }, dev2);
  pk._store.nextSender = null;
  check("other group can still buzz", rOther?.ok === true, JSON.stringify(rOther));

  // --- pause-on-points is LAB-gated: toggle ON pauses after a positive ruling ---
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["closeBuzzersOnPointsGiven", true] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
  await pk._store.rpc.buzz({ coopSlot: 0, buzzIn: true }, gate);
  await pk._store.rpc.buzz({ option: 4 }, gate);
  const gateEntryId = S().pendingLogId;
  await pk._store.rpc["producer-action"]({ fn: "updateScoresForLogEntry", args: [gateEntryId, 1000] }, prod);
  check("positive ruling pauses with toggle on", S().round?.status === "closed", S().round?.status);
  // restore reopen behavior for downstream tests
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["closeBuzzersOnPointsGiven", false] }, prod);
} else {
  // --- plain equivalents: option buzz locks, ruling deducts/awards on pid ---
  const r = await pk._store.rpc.buzz({ option: 3 }, dev1);
  check("plain buzz ok", r?.ok === true, JSON.stringify(r));
  const entryId = S().pendingLogId;
  check("locked with pending entry", S().round?.status === "locked" && !!entryId, `${S().round?.status} ${entryId}`);
  const entry = S().gameLog.find((e) => e.id === entryId);
  check("entry keyed to pid", entry?.scoreKey === "dev1", JSON.stringify(entry?.scoreKey));

  // --- THE DEDUCTION TEST ---
  await pk._store.rpc["producer-action"]({ fn: "updateScoresForLogEntry", args: [entryId, -1000] }, prod);
  check("minus 1000 deducted", S().scores?.dev1 === -1000, JSON.stringify(S().scores));

  // --- correct ruling on fresh round ---
  await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
  await pk._store.rpc.buzz({ option: 2 }, dev1);
  const entryId2 = S().pendingLogId;
  await pk._store.rpc["producer-action"]({ fn: "updateScoresForLogEntry", args: [entryId2, 1000] }, prod);
  check("plus 1000 awarded", S().scores?.dev1 === 0, JSON.stringify(S().scores));

  // --- buzz-in flag is meaningless off-coop: plain option buzz still works ---
  await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
  const rOther = await pk._store.rpc.buzz({ option: 1 }, dev2);
  check("other player can still buzz", rOther?.ok === true, JSON.stringify(rOther));

  // --- pause-on-points is LAB-gated: toggle ON pauses after a positive ruling ---
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["closeBuzzersOnPointsGiven", true] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
  await pk._store.rpc.buzz({ option: 4 }, gate);
  const gateEntryId = S().pendingLogId;
  await pk._store.rpc["producer-action"]({ fn: "updateScoresForLogEntry", args: [gateEntryId, 1000] }, prod);
  check("positive ruling pauses with toggle on", S().round?.status === "closed", S().round?.status);
  // restore reopen behavior for downstream tests
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["closeBuzzersOnPointsGiven", false] }, prod);
}

// --- bingo quick-ruling NaN path (slot key in coop, pid off-coop) ---
queryMap["#bingo-word"] = { value: "BINGO" };
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "bingo"] }, prod);
check("bingo mode on", S().settings?.inputMode === "bingo", S().settings?.inputMode);
await pk._store.rpc["producer-action"]({ fn: "startBingo", args: [] }, prod);
check("bingo active", S().bingo?.active === true, JSON.stringify(S().bingo?.active));
await pk._store.rpc["producer-action"]({ fn: "setBingoTarget", args: [2] }, prod);
await pk._store.rpc["producer-action"]({ fn: "startBingoCycling", args: [] }, prod);
const bz = await pk._store.rpc["bingo-buzz"]({ litIndex: 2, litSlot: 0, coopSlot: 0 }, dev1);
check("bingo correct buzz", bz?.ok === true, JSON.stringify(bz));
const bingoEntry = S().gameLog.filter((e) => e.type === "bingo").pop();
const bingoKey = COOP ? "coop:dev1:0" : "dev1";
const before = S().scores?.[bingoKey];
await pk._store.rpc["producer-action"](
  { fn: "updateScoresForLogEntry", args: [bingoEntry.id, -500] },
  prod,
);
const after = S().scores?.[bingoKey];
check("bingo re-ruling finite", Number.isFinite(after), `before=${before} after=${after}`);
check("bingo minus applied", after === before - 1000, `before=${before} after=${after}`);

// --- no-lock open round: wrong answer deducts, round stays open ---
// (the open-requires-preset gate is coop-only)
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["lockAfterBuzz", false] }, prod);
await pk._store.rpc["producer-action"](
  { fn: "setHostSetting", args: ["correctOptions", undefined] },
  prod,
);
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
if (COOP) {
  check("open needs preset without lock", S().round?.status !== "open", S().round?.status);
} else {
  check("open without preset off-coop", S().round?.status === "open", S().round?.status);
}
// set preset via round state path: use correctOptions through toggleCorrectOption
await pk._store.rpc["producer-action"]({ fn: "toggleCorrectOption", args: [1] }, prod);
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
check("open with preset", S().round?.status === "open", S().round?.status);
const dev3 = pk.makePlayer("dev3", "GroupC");
pk._store.participants.dev3 = dev3;
if (COOP) {
  await pk._store.rpc["coop-roster"]({ group: "GroupC", count: 1, names: [] }, dev3);
  await pk._store.rpc.buzz({ coopSlot: 0, buzzIn: true }, dev3);
}
await pk._store.rpc.buzz({ option: 2 }, dev3); // wrong vs preset 1
const openEntry = S().gameLog.filter((e) => e.type === "buzz").pop();
await pk._store.rpc["producer-action"](
  { fn: "updateScoresForLogEntry", args: [openEntry.id, -1000] },
  prod,
);
check("open-round wrong deducts", S().scores?.dev3 === -1000, JSON.stringify(S().scores));
check("open round stays open on wrong", S().round?.status === "open", S().round?.status);
// re-edit the same ruling: flip to +1000 then back to -1000
await pk._store.rpc["producer-action"](
  { fn: "updateScoresForLogEntry", args: [openEntry.id, 1000] },
  prod,
);
check("re-edit to plus", S().scores?.dev3 === 1000, JSON.stringify(S().scores?.dev3));
await pk._store.rpc["producer-action"](
  { fn: "updateScoresForLogEntry", args: [openEntry.id, -1000] },
  prod,
);
check("re-edit back to minus", S().scores?.dev3 === -1000, JSON.stringify(S().scores?.dev3));
// --- toggle has no effect off-LAB: scoring waits for the close, round stays open ---
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["closeBuzzersOnPointsGiven", true] }, prod);
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
if (COOP) {
  await pk._store.rpc.buzz({ coopSlot: 0, buzzIn: true }, gate);
}
await pk._store.rpc.buzz({ option: 1 }, gate); // correct vs preset 1: held until close
const labOffEntry = S().gameLog.filter((e) => e.type === "buzz").pop();
check("off-LAB correct held while open", labOffEntry?.resolved !== true && Number(labOffEntry?.awardedDelta || 0) === 0, JSON.stringify(labOffEntry?.awardedDelta));
check("toggle has no effect off-LAB", S().round?.status === "open", S().round?.status);
await pk._store.rpc["producer-action"]({ fn: "pauseBuzzers", args: [] }, prod);
const labOffEntryClosed = S().gameLog.find((e) => e.id === labOffEntry.id);
check("off-LAB correct auto-awards on close", Number(labOffEntryClosed?.awardedDelta) > 0, JSON.stringify(labOffEntryClosed?.awardedDelta));
check("pause closes round", S().round?.status === "closed", S().round?.status);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["closeBuzzersOnPointsGiven", false] }, prod);
// Retire the gating probe: later team-mode tests (e.g. quixort shared-team
// start) require every participant to hold a team assignment.
delete pk._store.participants.gate1;
try {
  const rosters = { ...(S().coopRosters || {}) };
  delete rosters.gate1;
  pk._store.state.coopRosters = rosters;
  for (const k of Object.keys(S().scores || {})) {
    if (k === "gate1" || String(k).startsWith("coop:gate1:")) delete S().scores[k];
  }
} catch {}

// --- text mode deduction ---
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "text"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["lockAfterBuzz", true] }, prod);
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
await pk._store.rpc.buzz({ answerText: "wrong answer", coopSlot: 0 }, dev3);
const textEntry = S().gameLog.filter((e) => e.type === "buzz").pop();
await pk._store.rpc["producer-action"](
  { fn: "updateScoresForLogEntry", args: [textEntry.id, -1000] },
  prod,
);
check("text wrong deducts", S().scores?.dev3 === -2000, JSON.stringify(S().scores?.dev3));

// --- rendered HTML viewpoints: host, player, audience ---
const { mount: _mount } = await import("./dom-stub.mjs");
warnings.length = 0;
// host view: trigger a render via a no-op-ish host call, assert score visible
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
check(
  "host view shows deducted score",
  _mount.innerHTML.includes("-2000"),
  `html len=${_mount.innerHTML.length}`,
);
// player view: become dev1, trigger render via a text answer on fresh round
pk._store.self = dev1;
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
await pk._store.rpc.buzz({ answerText: "player view probe", coopSlot: 0 }, dev1);
if (COOP) {
  check(
    "player view renders group panel",
    _mount.innerHTML.includes("GroupA") || _mount.innerHTML.includes("Ann"),
    `html len=${_mount.innerHTML.length}`,
  );
  check(
    "player view shows score",
    _mount.innerHTML.includes("-1500"),
    "dev1 slot0 should show -1500",
  );
} else {
  const d1 = S().scores?.dev1 ?? 0;
  check(
    "player view renders panel",
    _mount.innerHTML.includes("GroupA"),
    `html len=${_mount.innerHTML.length}`,
  );
  check(
    "player view shows pid score",
    _mount.innerHTML.includes(`>${d1}<`),
    `dev1 should show ${d1}`,
  );
}
// audience view: become a display client, open fresh round to trigger render
const disp = pk.makePlayer("disp1", "Audience Display", "display");
pk._store.participants.disp1 = disp;
pk._store.self = disp;
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
check(
  "audience view renders",
  _mount.innerHTML.includes("audience-layout"),
  `html len=${_mount.innerHTML.length}`,
);
check(
  "audience view shows score",
  _mount.innerHTML.includes("-1000") || _mount.innerHTML.includes("-2000"),
  "audience should reflect deducted scores",
);
check(
  "no render warnings",
  !warnings.some((w) => w.includes("[render]")),
  warnings.filter((w) => w.includes("[render]")).join(" | ").slice(0, 500),
);
pk._store.self = pk._store.participants.host1;

// --- exact host click paths: quick-minus, ruling card, typed apply ---
// (clear the preset left over from the no-lock test so rulings are manual)
await pk._store.rpc["producer-action"]({ fn: "toggleCorrectOption", args: [1] }, prod);
function clickBtn(dataset, selector) {
  const scoped = {
    dataset,
    closest: (s) => (s === selector ? scoped : null),
  };
  for (const fn of mount._listeners.click || []) fn({ target: scoped });
}
function clickQuick(dataset) {
  clickBtn(dataset, dataset.logQuick !== undefined ? "[data-log-quick]" : dataset.ruling !== undefined ? "[data-ruling]" : "[data-log-apply]");
}
const qm = queryMap;
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
await pk._store.rpc.buzz({ option: 2 }, dev3);
const qEntry = S().gameLog.filter((e) => e.type === "buzz").pop();
const beforeQ = S().scores?.dev3;
clickQuick({ logQuick: "minus", logId: qEntry.id });
check("quick-minus deducts", S().scores?.dev3 === beforeQ - 1000, `before=${beforeQ} after=${S().scores?.dev3}`);
// ruling card path on a fresh entry
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
await pk._store.rpc.buzz({ option: 1 }, dev3);
const rEntry = S().gameLog.filter((e) => e.type === "buzz").pop();
const beforeR = S().scores?.dev3;
clickQuick({ ruling: String(-1000), logId: rEntry.id });
check("ruling-card minus deducts", S().scores?.dev3 === beforeR - 1000, `before=${beforeR} after=${S().scores?.dev3}`);
// typed apply path
qm[`[data-log-input="${rEntry.id}"]`] = { value: "-250" };
const beforeApply = S().scores?.dev3;
clickQuick({ logApply: rEntry.id });
check("typed apply re-rules", S().scores?.dev3 === beforeApply + 750, `before=${beforeApply} after=${S().scores?.dev3}`);

// --- auto-rule: preset judges both sides ---
await pk._store.rpc["producer-action"]({ fn: "toggleCorrectOption", args: [2] }, prod);
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
await pk._store.rpc.buzz({ option: 1 }, dev2);
const autoWrong = S().gameLog.filter((e) => e.type === "buzz").pop();
check("auto-rule wrong deducts", S().scores?.dev2 === -1000, JSON.stringify(S().scores?.dev2));
check("auto-rule wrong resolved", autoWrong?.awardedDelta === -1000, JSON.stringify(autoWrong?.awardedDelta));
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
await pk._store.rpc.buzz({ option: 2 }, dev2);
const autoRight = S().gameLog.filter((e) => e.type === "buzz").pop();
check("auto-rule correct awards", S().scores?.dev2 === 0, JSON.stringify(S().scores?.dev2));
check("auto-rule correct resolved", autoRight?.awardedDelta === 1000, JSON.stringify(autoRight?.awardedDelta));
await pk._store.rpc["producer-action"]({ fn: "toggleCorrectOption", args: [2] }, prod);

// --- NON-COOP free-for-all: buzz -> minus ruling deducts ---
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", false] }, prod);
check("coop off", S().settings?.coopertitionEnabled === false, JSON.stringify(S().settings?.coopertitionEnabled));
const plain = pk.makePlayer("plain1", "Solo");
pk._store.participants.plain1 = plain;
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
const rb = await pk._store.rpc.buzz({ option: 2 }, plain);
check("plain buzz ok", rb?.ok === true, JSON.stringify(rb));
const pEntry = S().gameLog.filter((e) => e.type === "buzz").pop();
const pBefore = S().scores?.plain1 || 0;
clickQuick({ logQuick: "minus", logId: pEntry.id });
check("non-coop quick-minus deducts", S().scores?.plain1 === pBefore - 1000, `before=${pBefore} after=${S().scores?.plain1}`);

// --- screw fully banned in coop (player RPC rejected, host button hidden);
// --- off-coop the same screw flow must initiate normally ---
if (COOP) {
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", true] }, prod);
}
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
if (COOP) {
  const screwRes = await pk._store.rpc.screw({ screweeId: null }, dev1);
  check("screw RPC rejected in coop", screwRes?.ok === false, JSON.stringify(screwRes));
  check("no screw activated", S().round?.screw?.active !== true, JSON.stringify(S().round?.screw?.active));
  check("host screw button hidden in coop", !mount.innerHTML.includes("Screw a Player"), "button present");
} else {
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["allowScrewing", true] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
  check("host screw button visible off-coop", mount.innerHTML.includes("Screw a Player"), "button missing");
  const screwRes = await pk._store.rpc.screw({ screweeId: null }, dev1);
  check("screw initiates off-coop", screwRes?.ok === true, JSON.stringify(screwRes));
  await pk._store.rpc["producer-action"]({ fn: "resetScrews", args: [] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "closeScrewMode", args: [] }, prod);
}

// --- fibbage RPCs rejected in coop (fibbage has no coop model) ---
if (COOP) {
  const lieRes = await pk._store.rpc["fibbage-lie"]({ lieText: "x" }, dev1);
  const voteRes = await pk._store.rpc["fibbage-vote"]({ choiceIdx: 0 }, dev1);
  check("fibbage lie rejected in coop", lieRes?.ok === false, JSON.stringify(lieRes));
  check("fibbage vote rejected in coop", voteRes?.ok === false, JSON.stringify(voteRes));
}

// --- disordat locked in coop: mode entry blocked, RPCs rejected ---
if (COOP) {
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "disordat"] }, prod);
  check("disordat mode blocked in coop", S().settings?.inputMode !== "disordat", S().settings?.inputMode);
  check("host disordat button disabled in coop", /data-set-mode="disordat"[^>]*disabled/.test(mount.innerHTML), "button not disabled");
  const ddAnsCoop = await pk._store.rpc["disordat-answer"]({ q: 0, answer: "dis" }, dev1);
  const ddClaimCoop = await pk._store.rpc["disordat-claim"]({ q: 0 }, dev1);
  check("disordat answer rejected in coop", ddAnsCoop?.ok === false, JSON.stringify(ddAnsCoop));
  check("disordat claim rejected in coop", ddClaimCoop?.ok === false, JSON.stringify(ddClaimCoop));
} else {
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "disordat"] }, prod);
  check("disordat mode entered off-coop", S().settings?.inputMode === "disordat", S().settings?.inputMode);
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
}

// --- roster grow/shrink accounting: no orphans, no jumps (coop-only) ---
const dev4 = pk.makePlayer("dev4", "GroupD");
pk._store.participants.dev4 = dev4;
if (COOP) {
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopAllowEdit", true] }, prod);
  await pk._store.rpc["coop-roster"]({ group: "GroupD", count: 1, names: [] }, dev4);
  await pk._store.rpc.buzz({ option: 1 }, dev4);
  const d4e = S().gameLog.filter((e) => e.type === "buzz").pop();
  await pk._store.rpc["producer-action"]({ fn: "updateScoresForLogEntry", args: [d4e.id, 500] }, prod);
  check("1-slot earns on pid", S().scores?.dev4 === 500, JSON.stringify(S().scores?.dev4));
  await pk._store.rpc["coop-roster"]({ group: "GroupD", count: 3, names: ["D1", "D2", "D3"] }, dev4);
  check("grow folds pid into slot0", S().scores?.["coop:dev4:0"] === 500, JSON.stringify(S().scores));
  check("grow clears pid", S().scores?.dev4 === undefined, JSON.stringify(S().scores?.dev4));
  await pk._store.rpc["coop-roster"]({ group: "GroupD", count: 1, names: [] }, dev4);
  check("shrink restores pid", S().scores?.dev4 === 500, JSON.stringify(S().scores?.dev4));
  check("shrink clears stale slot0", S().scores?.["coop:dev4:0"] === undefined, JSON.stringify(S().scores?.["coop:dev4:0"]));
}

// --- disordat one-play (non-coop): pick, answer all, auto-finalize + score ---
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", false] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "disordat"] }, prod);
check("disordat mode entered non-coop", S().settings?.inputMode === "disordat", S().settings?.inputMode);
for (let q = 0; q < 7; q++) {
  clickBtn({ q: String(q), answer: ["dis", "dat", "dis", "dat", "dis", "dat", "dis"][q] }, "[data-disordat-answer-chip]");
}
clickBtn({ disordatStart: "onePlayTimed" }, "[data-disordat-start]");
await sleep(20);
check("one-play pending pick", S().disordat?.pendingPick === true, JSON.stringify(S().disordat?.pendingPick));
clickBtn({ disordatPickPlayer: "dev1" }, "[data-disordat-pick-player]");
check("one-play pick honored", S().disordat?.activePlayerId === "dev1", S().disordat?.activePlayerId);
const ddOther = await pk._store.rpc["disordat-answer"]({ q: 0, answer: S().disordat.answers[0] }, dev2);
check("non-active player rejected", ddOther?.ok === false, JSON.stringify(ddOther));
const ddBefore = S().scores?.dev1 || 0;
for (let q = 0; q < 7; q++) {
  if (S().disordat?.phase !== "playing") break;
  await pk._store.rpc["disordat-answer"]({ q, answer: S().disordat.answers[q] }, dev1);
}
check("disordat auto-finalized", S().disordat?.phase === "results", S().disordat?.phase);
check(
  "disordat credited (non-coop)",
  (S().scores?.dev1 || 0) - ddBefore >= 2100,
  `before=${ddBefore} after=${S().scores?.dev1}`,
);
clickBtn({}, "[data-disordat-reset]");
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
if (COOP) {
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", true] }, prod);
  check("coop re-enabled after disordat", S().settings?.coopertitionEnabled === true, JSON.stringify(S().settings?.coopertitionEnabled));
}

// --- bingo host progress per-slot in coop ---
if (COOP) {
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "bingo"] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "startBingo", args: [] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "setBingoTarget", args: [1] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "startBingoCycling", args: [] }, prod);
  await pk._store.rpc["bingo-buzz"]({ litIndex: 1, litSlot: 0, coopSlot: 0 }, dev1);
  check("host progress shows slot", mount.innerHTML.includes("Ann"), "slot name missing from host panel");
}

// --- Wen: correct scores, no collection, no winner ---
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "wendithapn"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "startBingo", args: [] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setBingoTarget", args: [0] }, prod);
await pk._store.rpc["producer-action"]({ fn: "startBingoCycling", args: [] }, prod);
const d2Before = S().scores?.dev2 || 0;
const wenRes = await pk._store.rpc["bingo-buzz"]({ litIndex: 0, litSlot: 0 }, dev2);
check("wen correct buzz", wenRes?.ok === true, JSON.stringify(wenRes));
check("wen awards 500", (S().scores?.dev2 || 0) - d2Before === 500, JSON.stringify(S().scores?.dev2));
check("wen collects nothing", Object.keys(S().bingo?.playerItems || {}).length === 0, JSON.stringify(S().bingo?.playerItems));
await pk._store.rpc["producer-action"]({ fn: "endBingo", args: [] }, prod);

// --- moods: wrong holds until reset; correct self-clears (faces are coop-only) ---
if (COOP) {
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
  await pk._store.rpc.buzz({ option: 3 }, dev2);
  const moodEntry = S().gameLog.filter((e) => e.type === "buzz").pop();
  await pk._store.rpc["producer-action"]({ fn: "updateScoresForLogEntry", args: [moodEntry.id, -1000] }, prod);
  check("wrong face set", S().coopMoods?.dev2 === "wrong", JSON.stringify(S().coopMoods));
  await pk._store.rpc["producer-action"]({ fn: "resetRound", args: [] }, prod);
  check("reset clears faces", JSON.stringify(S().coopMoods) === "{}" || S().coopMoods === undefined, JSON.stringify(S().coopMoods));
  await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
  await pk._store.rpc.buzz({ option: 4 }, dev2);
  const moodEntry2 = S().gameLog.filter((e) => e.type === "buzz").pop();
  await pk._store.rpc["producer-action"]({ fn: "updateScoresForLogEntry", args: [moodEntry2.id, 1000] }, prod);
  check("correct face set", S().coopMoods?.dev2 === "correct" || S().coopMoods?.["coop:dev2:0"] === "correct", JSON.stringify(S().coopMoods));
  await sleep(1800);
  check("correct face self-clears", !S().coopMoods?.dev2 && !S().coopMoods?.["coop:dev2:0"], JSON.stringify(S().coopMoods));
}

// --- control mismatch: other slots/devices rejected while held (coop-only) ---
if (COOP) {
  await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
  await pk._store.rpc.buzz({ coopSlot: 0, buzzIn: true }, dev1);
  const steal = await pk._store.rpc.buzz({ coopSlot: 0, buzzIn: true }, dev2);
  check("control steal rejected", steal?.ok === false, JSON.stringify(steal));
  const sibSteal = await pk._store.rpc.buzz({ coopSlot: 1, buzzIn: true }, dev1);
  check("sibling steal rejected", sibSteal?.ok === false, JSON.stringify(sibSteal));
  await pk._store.rpc.buzz({ option: 2 }, dev1);
}

// --- NaN ruling is a silent no-op, scores untouched ---
const nanEntry = S().gameLog.filter((e) => e.type === "buzz").pop();
const nanBefore = JSON.stringify(S().scores);
await pk._store.rpc["producer-action"]({ fn: "updateScoresForLogEntry", args: [nanEntry.id, NaN] }, prod);
check("NaN ruling no-op", JSON.stringify(S().scores) === nanBefore, `${nanBefore} -> ${JSON.stringify(S().scores)}`);
await pk._store.rpc["producer-action"]({ fn: "updateScoresForLogEntry", args: [nanEntry.id, -500] }, prod);

// --- disordat host-paced (non-coop): answer direct, no claim needed ---
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", false] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "disordat"] }, prod);
clickBtn({}, "[data-disordat-reset]");
for (let q = 0; q < 7; q++) {
  clickBtn({ q: String(q), answer: "dat" }, "[data-disordat-answer-chip]");
}
clickBtn({ disordatStart: "allPlayHostPaced" }, "[data-disordat-start]");
check("host-paced started", S().disordat?.active === true && S().disordat?.mode === "allPlayHostPaced", S().disordat?.mode);
const hpAns = await pk._store.rpc["disordat-answer"]({ q: 0, answer: "dat" }, dev1);
check("host-paced answer accepted", hpAns?.ok === true, JSON.stringify(hpAns));
const hpClaim = await pk._store.rpc["disordat-claim"]({ q: 0 }, dev1);
check("host-paced claim unneeded non-coop", hpClaim?.ok === false, JSON.stringify(hpClaim));
clickBtn({}, "[data-disordat-next]");
check("host-paced advanced", S().disordat?.currentQuestion === 1, JSON.stringify(S().disordat?.currentQuestion));
const hpAns2 = await pk._store.rpc["disordat-answer"]({ q: 1, answer: "dat" }, dev1);
check("second question answered", hpAns2?.ok === true, JSON.stringify(hpAns2));
clickBtn({}, "[data-disordat-end]");
check("host-paced ended", S().disordat?.phase === "results", S().disordat?.phase);

// --- coop can't enable mid-disordat (block is disordat-based, runs both modes) ---
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", true] }, prod);
check("coop enable blocked mid-disordat", S().settings?.coopertitionEnabled !== true, JSON.stringify(S().settings?.coopertitionEnabled));
clickBtn({}, "[data-disordat-reset]");
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
if (COOP) {
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", true] }, prod);
  check("coop re-enabled from buttons", S().settings?.coopertitionEnabled === true, JSON.stringify(S().settings?.coopertitionEnabled));
} else {
  check("coop stays off after disordat", S().settings?.coopertitionEnabled === false, JSON.stringify(S().settings?.coopertitionEnabled));
}

// --- quixort locked in coop: mode entry blocked, RPCs rejected ---
if (COOP) {
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "quixort"] }, prod);
  check("quixort mode blocked in coop", S().settings?.inputMode !== "quixort", S().settings?.inputMode);
  check("host quixort button disabled in coop", /data-set-mode="quixort"[^>]*disabled/.test(mount.innerHTML), "button not disabled");
  const qxCoop = await pk._store.rpc["quixort-place"]({ insertIndex: 0 }, dev1);
  check("quixort place rejected in coop", qxCoop?.ok === false, JSON.stringify(qxCoop));
}

// --- quixort full flow (non-coop): setup validation, all-play sorting,
// distance scoring with multiplier, timeout void, shared-team rotation ---
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", false] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "quixort"] }, prod);
check("quixort mode entered non-coop", S().settings?.inputMode === "quixort", S().settings?.inputMode);
await pk._store.rpc["producer-action"]({ fn: "startQuixort", args: [] }, prod);
check("quixort start rejected with <4 items", S().quixort?.active !== true, JSON.stringify(S().quixort?.active));
for (const [i, v] of ["Alpha", "Bravo", "Charlie", "Delta"].entries()) {
  await pk._store.rpc["producer-action"]({ fn: "setQuixortItem", args: [i, v] }, prod);
}
await pk._store.rpc["producer-action"]({ fn: "setQuixortTrashItem", args: [0, "Zulu"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setQuixortMultiplier", args: [2] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setQuixortBlockSec", args: [15] }, prod);
check("quixort setup stored", S().quixort?.items?.slice(0, 4).join("|") === "Alpha|Bravo|Charlie|Delta", JSON.stringify(S().quixort?.items));
check("quixort setup shows time estimate", mount.innerHTML.includes("Estimated time"), "no estimate");
await pk._store.rpc["producer-action"]({ fn: "startQuixort", args: [] }, prod);
check("quixort started", S().quixort?.active === true && S().quixort?.phase === "playing", S().quixort?.phase);
check("quixort deck is items+trash", (S().quixort?.runs?.dev1?.deck || []).length === 5, JSON.stringify(S().quixort?.runs?.dev1?.deck?.length));
check("quixort roster frozen", (S().quixort?.expectedTracks || []).includes("dev1"), JSON.stringify(S().quixort?.expectedTracks));
// player view offers trash since host defined trash (true player branch:
// harness hardcodes isHost, so drop privileges + ungated click to re-render)
pk._store.isHost = false;
pk._store.self = dev1;
clickBtn({}, "[data-f-you-close]");
await sleep(20);
check("quixort player sees trash button", mount.innerHTML.includes("data-quixort-trash-block"), "trash button missing");
pk._store.isHost = true;
pk._store.self = pk._store.participants.host1;
// perfect dev1 run: exact inserts + trash the trash -> clean bonus at mult 2
const qxBefore = S().scores?.dev1 || 0;
let qxGuard = 0;
while (S().quixort?.runs?.dev1 && !S().quixort.runs.dev1.finished && qxGuard++ < 12) {
  const run = S().quixort.runs.dev1;
  const entry = run.deck[run.deckPos];
  if (entry.t === "trash") {
    await pk._store.rpc["quixort-place"]({ trash: true }, dev1);
  } else {
    let pos = 0;
    for (const e of run.row) if (e.t === "item" && e.ref < entry.ref) pos++;
    const res = await pk._store.rpc["quixort-place"]({ insertIndex: pos }, dev1);
    if (!res?.ok) break;
  }
}
check("quixort dev1 run finished clean", S().quixort?.runs?.dev1?.finished === true, JSON.stringify(S().quixort?.runs?.dev1?.deckPos));
// timeout voids the block and passes (dev2 run)
S().quixort.runs.dev2.blockEndsAt = Date.now() - 1000;
const qxVoidedBefore = (S().quixort.runs.dev2.voided || []).length;
const qxLate = await pk._store.rpc["quixort-place"]({ insertIndex: 0 }, dev2);
check("quixort late place rejected", qxLate?.ok === false, JSON.stringify(qxLate));
check("quixort timeout voided block", (S().quixort.runs.dev2.voided || []).length === qxVoidedBefore + 1, JSON.stringify(S().quixort.runs.dev2.voided?.length));
await pk._store.rpc["producer-action"]({ fn: "endQuixort", args: [] }, prod);
check("quixort finalized", S().quixort?.phase === "results", S().quixort?.phase);
check(
  "quixort clean bonus scored at mult 2",
  // pairwise: N=4 -> P=6 pairs, W=round(4000/6)=667; perfect = 6*667 order
  // + 1000 trash + 1500 clean bonus, x2 mult = 13004
  (S().scores?.dev1 || 0) - qxBefore === (6 * 667 + 1000 + 1500) * 2,
  `before=${qxBefore} after=${S().scores?.dev1}`,
);
check("quixort log entry", S().gameLog.filter((e) => e.type === "quixort").some((e) => e.awardedDelta > 0), "no quixort log");
check("quixort log uses pairs text", S().gameLog.filter((e) => e.type === "quixort").some((e) => /6\/6 pairs/.test(e.answerText || "")), JSON.stringify(S().gameLog.filter((e) => e.type === "quixort").map((e) => e.answerText)));
// misclass penalty: trash one real, sort the rest + trash the trash.
// 3 concordant pairs (3*667) + 1000 trash - 500 misclass, no bonus, x2 = 5002
await pk._store.rpc["producer-action"]({ fn: "resetQuixort", args: [] }, prod);
await pk._store.rpc["producer-action"]({ fn: "startQuixort", args: [] }, prod);
const qxBeforeMis = S().scores?.dev1 || 0;
let qxMisTrashedReal = false;
let qxMisGuard = 0;
while (S().quixort?.runs?.dev1 && !S().quixort.runs.dev1.finished && qxMisGuard++ < 12) {
  const run = S().quixort.runs.dev1;
  const entry = run.deck[run.deckPos];
  if (entry.t === "trash" || !qxMisTrashedReal && entry.t === "item") {
    if (entry.t === "item") qxMisTrashedReal = true;
    await pk._store.rpc["quixort-place"]({ trash: true }, dev1);
  } else {
    let pos = 0;
    for (const e of run.row) if (e.t === "item" && e.ref < entry.ref) pos++;
    const res = await pk._store.rpc["quixort-place"]({ insertIndex: pos }, dev1);
    if (!res?.ok) break;
  }
}
check("quixort misclass run trashed a real", qxMisTrashedReal === true, JSON.stringify(qxMisTrashedReal));
await pk._store.rpc["producer-action"]({ fn: "endQuixort", args: [] }, prod);
check(
  "quixort misclass penalized at mult 2",
  (S().scores?.dev1 || 0) - qxBeforeMis === (3 * 667 + 1000 - 500) * 2,
  `before=${qxBeforeMis} after=${S().scores?.dev1}`,
);
check("quixort misclass logged", S().gameLog.filter((e) => e.type === "quixort").some((e) => /1 misclass/.test(e.answerText || "")), "no misclass log");
// shared-team rotation: teammates rotate per block, off-turn rejected
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["teamModeEnabled", true] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["teamScoringMode", "shared"] }, prod);
for (const [pid, color] of [["dev1", "red"], ["dev2", "red"], ["dev3", "blue"], ["dev4", "blue"], ["plain1", "green"], ["impostor", "green"]]) {
  await pk._store.rpc["producer-action"]({ fn: "setPlayerTeam", args: [pid, color] }, prod);
}
await pk._store.rpc["producer-action"]({ fn: "resetQuixort", args: [] }, prod);
await pk._store.rpc["producer-action"]({ fn: "startQuixort", args: [] }, prod);
check("quixort shared tracks are teams", (S().quixort?.expectedTracks || []).includes("red"), JSON.stringify(S().quixort?.expectedTracks));
const redTurn = (() => {
  const members = ["dev1", "dev2"].sort();
  return members[(S().quixort?.runs?.red?.turnIndex || 0) % members.length];
})();
const offTurn = redTurn === "dev1" ? dev2 : dev1;
const onTurn = redTurn === "dev1" ? dev1 : dev2;
const qxOff = await pk._store.rpc["quixort-place"]({ insertIndex: 0 }, offTurn);
check("quixort off-turn teammate rejected", qxOff?.ok === false, JSON.stringify(qxOff));
const redRun = S().quixort.runs.red;
const redEntry = redRun.deck[redRun.deckPos];
const qxOn = redEntry.t === "trash"
  ? await pk._store.rpc["quixort-place"]({ trash: true }, onTurn)
  : await pk._store.rpc["quixort-place"]({ insertIndex: 0 }, onTurn);
check("quixort on-turn teammate accepted", qxOn?.ok === true, JSON.stringify(qxOn));
await pk._store.rpc["producer-action"]({ fn: "endQuixort", args: [] }, prod);
check("quixort team scored", Number.isFinite(S().scores?.["team:red"]), JSON.stringify(S().scores?.["team:red"]));
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["teamModeEnabled", false] }, prod);
// coop can't enable mid-quixort, then clean exit restores prior mode
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", true] }, prod);
check("coop enable blocked mid-quixort", S().settings?.coopertitionEnabled !== true, JSON.stringify(S().settings?.coopertitionEnabled));
await pk._store.rpc["producer-action"]({ fn: "resetQuixort", args: [] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
if (COOP) {
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", true] }, prod);
  check("coop re-enabled after quixort", S().settings?.coopertitionEnabled === true, JSON.stringify(S().settings?.coopertitionEnabled));
}

// --- all-answered auto-close (no-lock + preset) ---
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["lockAfterBuzz", false] }, prod);
if (!(S().round?.correctOptions || []).includes(1)) {
  await pk._store.rpc["producer-action"]({ fn: "toggleCorrectOption", args: [1] }, prod);
}
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
if (COOP) {
  const allSlots = [[dev1, 0], [dev1, 1], [dev2, undefined], [dev3, undefined], [dev4, undefined], [plain, undefined]];
  for (const [p, slot] of allSlots) {
    const payload = slot === undefined ? { option: 2 } : { coopSlot: slot, buzzIn: true };
    await pk._store.rpc.buzz(payload, p);
    if (slot !== undefined) await pk._store.rpc.buzz({ option: 2 }, p);
  }
} else {
  for (const p of [dev1, dev2, dev3, dev4, plain]) {
    await pk._store.rpc.buzz({ option: 2 }, p);
  }
}
check("all answered auto-closes", S().round?.status === "closed", S().round?.status);
// terminal close (all answers in) locks open + resume + preset until reset (rebuzz off)
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
check("open disabled on terminal close", mount.innerHTML.includes('data-host-action="open" disabled'), "open enabled after all-in");
check("resume disabled on terminal close", mount.innerHTML.includes('data-host-action="resume" disabled'), "resume enabled after all-in");
{
  const preToggle = JSON.stringify(S().round?.correctOptions);
  await pk._store.rpc["producer-action"]({ fn: "toggleCorrectOption", args: [1] }, prod);
  check("preset locked on terminal close", JSON.stringify(S().round?.correctOptions) === preToggle, `was=${preToggle} now=${JSON.stringify(S().round?.correctOptions)}`);
}
await pk._store.rpc["producer-action"]({ fn: "resumeBuzzers", args: [] }, prod);
check("resume denied on terminal close", S().round?.status === "closed", S().round?.status);
// specified continuation: reset re-arms a fresh round (and clears the preset)
await pk._store.rpc["producer-action"]({ fn: "resetRound", args: [] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
if (COOP) {
  check("open disabled without preset", mount.innerHTML.includes('data-host-action="open" disabled'), "open button enabled");
} else {
  check("open allowed after reset off-coop", !mount.innerHTML.includes('data-host-action="open" disabled'), "open button disabled");
}
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["lockAfterBuzz", true] }, prod);

// --- disable migration folds back, re-enable restores (coop-only) ---
if (COOP) {
  const d1Total = (S().scores?.["coop:dev1:0"] || 0) + (S().scores?.["coop:dev1:1"] || 0);
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", false] }, prod);
  check("disable folds to pid", S().scores?.dev1 === d1Total, `total=${d1Total} pid=${S().scores?.dev1}`);
  check("disable clears coop keys", S().scores?.["coop:dev1:0"] === undefined, JSON.stringify(S().scores?.["coop:dev1:0"]));
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", true] }, prod);
  check("re-enable restores slot0", S().scores?.["coop:dev1:0"] === d1Total, JSON.stringify(S().scores?.["coop:dev1:0"]));
}

// --- removed slots stay dead: forged slot rejected (count>1), and on a
// 1-slot device a forged slot attributes to slot 0 without touching frozen keys ---
// (coop-only: no slots exist off-coop)
if (COOP) {
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "bingo"] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "startBingo", args: [] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "setBingoTarget", args: [0] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "startBingoCycling", args: [] }, prod);
  const forgedRange = await pk._store.rpc["bingo-buzz"]({ litIndex: 0, litSlot: 0, coopSlot: 5 }, dev1);
  check("out-of-range slot rejected", forgedRange?.ok === false, JSON.stringify(forgedRange));
  await pk._store.rpc["coop-roster"]({ group: "GroupA", count: 1, names: [] }, dev1);
  const fBeforeFrozen = S().scores?.["coop:dev1:1"] || 0;
  const fBeforePid = S().scores?.dev1 || 0;
  const frozenBuzz = await pk._store.rpc["bingo-buzz"]({ litIndex: 0, litSlot: 0, coopSlot: 1 }, dev1);
  check("forged slot attributes to slot0", frozenBuzz?.ok === true, JSON.stringify(frozenBuzz));
  check("frozen key untouched", (S().scores?.["coop:dev1:1"] || 0) === fBeforeFrozen, `frozen=${S().scores?.["coop:dev1:1"]}`);
  check("slot0 credited", (S().scores?.dev1 || 0) === fBeforePid + 500, `pid=${S().scores?.dev1}`);
}
// --- regression: producer forced delta allowlisted, NaN rejected, jack clamped ---
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", false] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "resetRound", args: [] }, prod);
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
await pk._store.rpc.buzz({ option: 1 }, plain);
const fEntry = S().gameLog.filter((e) => e.type === "buzz").pop();
const fBefore = S().scores?.plain1 || 0;
await pk._store.rpc["producer-action"]({ fn: "resolveLogEntryWithForcedDelta", args: [fEntry.id, 250] }, prod);
check("producer forced delta applies", (S().scores?.plain1 || 0) === fBefore + 250 - (fEntry.awardedDelta || 0), `after=${S().scores?.plain1}`);
const forcedNanBefore = S().scores?.plain1;
await pk._store.rpc["producer-action"]({ fn: "resolveLogEntryWithForcedDelta", args: [fEntry.id, "abc"] }, prod);
check("NaN forced delta rejected", Number.isFinite(S().scores?.plain1) && S().scores?.plain1 === forcedNanBefore, `after=${S().scores?.plain1}`);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["jackMultiplier", "abc"] }, prod);
check("jackMultiplier clamped", S().settings?.jackMultiplier === 1, JSON.stringify(S().settings?.jackMultiplier));
// --- regression: screw victim hijack rejected, screwer picks ok ---
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", false] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["allowScrewing", true] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
const screwStart = await pk._store.rpc.screw({ screweeId: null }, plain);
check("screw initiates non-coop", screwStart?.ok === true, JSON.stringify(screwStart));
const hijack = await pk._store.rpc.screw({ screweeId: "dev3" }, dev2);
check("screw victim hijack rejected", hijack?.ok === false, JSON.stringify(hijack));
check("hijack left no screwee", S().round?.screw?.screweeId == null, JSON.stringify(S().round?.screw?.screweeId));
const legitPick = await pk._store.rpc.screw({ screweeId: "dev3" }, plain);
check("screwer picks victim", legitPick?.ok === true, JSON.stringify(legitPick));
// --- regression: resetRound null-invariant ---
await pk._store.rpc["producer-action"]({ fn: "resetRound", args: [] }, prod);
check("reset clears coopControl", S().round?.coopControl === null, JSON.stringify(S().round?.coopControl));
check("reset clears winnerCoopKey", S().round?.winnerCoopKey === null, JSON.stringify(S().round?.winnerCoopKey));
check("reset clears correctOptions", S().round?.correctOptions === null, JSON.stringify(S().round?.correctOptions));
check("reset clears correctAnswer", S().round?.correctAnswer === null, JSON.stringify(S().round?.correctAnswer));
// --- regression: multi-correct preset survives judging, mode cycles keep null-invariant ---
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["optionCount", 6] }, prod);
await pk._store.rpc["producer-action"]({ fn: "resetRound", args: [] }, prod);
await pk._store.rpc["producer-action"]({ fn: "toggleCorrectOption", args: [1] }, prod);
await pk._store.rpc["producer-action"]({ fn: "toggleCorrectOption", args: [3] }, prod);
check("multi-correct preset holds both", JSON.stringify((S().round?.correctOptions || []).map(Number).sort()) === JSON.stringify([1, 3]), JSON.stringify(S().round?.correctOptions));
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "bingo"] }, prod);
check("bingo cycle clears preset to null", S().round?.correctOptions === null && S().round?.correctAnswer === null, `opts=${JSON.stringify(S().round?.correctOptions)} ans=${JSON.stringify(S().round?.correctAnswer)}`);
check("bingo cycle keeps winnerCoopKey null", S().round?.winnerCoopKey === null, JSON.stringify(S().round?.winnerCoopKey));
check("bingo cycle keeps screwsUsedBy array", Array.isArray(S().round?.screwsUsedBy), JSON.stringify(S().round?.screwsUsedBy));
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
check("back to buttons preset stays null", S().round?.correctOptions === null && S().round?.correctAnswer === null, `opts=${JSON.stringify(S().round?.correctOptions)} ans=${JSON.stringify(S().round?.correctAnswer)}`);
await pk._store.rpc["producer-action"]({ fn: "toggleCorrectOption", args: [2] }, prod);
await pk._store.rpc["producer-action"]({ fn: "toggleCorrectOption", args: [4] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "text"] }, prod);
check("buttons->text preserves correctOptions", JSON.stringify((S().round?.correctOptions || []).map(Number).sort()) === JSON.stringify([2, 4]), JSON.stringify(S().round?.correctOptions));
await pk._store.rpc["producer-action"]({ fn: "setCorrectAnswerValue", args: ["hello"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
check("text->buttons preserves correctAnswer", S().round?.correctAnswer === "hello", JSON.stringify(S().round?.correctAnswer));
check("setCorrectAnswerValue clears correctOptions", S().round?.correctOptions === null, JSON.stringify(S().round?.correctOptions));
await pk._store.rpc["producer-action"]({ fn: "resetRound", args: [] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["optionCount", 6] }, prod);
await pk._store.rpc["producer-action"]({ fn: "resetRound", args: [] }, prod);
await pk._store.rpc["producer-action"]({ fn: "toggleCorrectOption", args: [5] }, prod);
await pk._store.rpc["producer-action"]({ fn: "toggleCorrectOption", args: [6] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["optionCount", 4] }, prod);
check("optionCount shrink prunes preset", S().round?.correctOptions === null, JSON.stringify(S().round?.correctOptions));
if (!COOP) {
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "fibbage"] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
  check("leaving fibbage deactivates it", S().fibbage?.active !== true, JSON.stringify(S().fibbage?.active));
}
// --- regression: roulette roster frozen at phase start ---
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["valueSelectionMethod", "roulette"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "startRoulettePhase", args: [] }, prod);
check("roulette starts", S().round?.status === "roulette", S().round?.status);
check("host panel shows live pick-a-value", _mount.innerHTML.includes("Pick-a-value:"), `html len=${_mount.innerHTML.length}`);
const frozenCount = (S().round?.roulette?.expectedPlayerIds || []).length;
const late = pk.makePlayer("late1", "Late");
pk._store.participants.late1 = late;
check("late joiner frozen out", !(S().round?.roulette?.expectedPlayerIds || []).includes("late1"), JSON.stringify(S().round?.roulette?.expectedPlayerIds));
check("frozen count stable", (S().round?.roulette?.expectedPlayerIds || []).length === frozenCount, `${frozenCount}`);
const lateStop = await pk._store.rpc["roulette-stop"]({}, late);
check("late joiner cannot stop", lateStop?.ok === false, JSON.stringify(lateStop));
// --- regression: choiceLayout grid/list modes (4-choice, 1234 labels) ---
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", false] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["optionCount", 4] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["valueSelectionMethod", "standard"] }, prod);
pk._store.self = plain;
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
check(
  "diamond default ABXY",
  _mount.innerHTML.includes("abxy-diamond") && _mount.innerHTML.includes(">A<"),
  `html len=${_mount.innerHTML.length}`,
);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["choiceLayout", "grid"] }, prod);
check(
  "grid mode 1234",
  _mount.innerHTML.includes("choice-grid") && !_mount.innerHTML.includes("abxy-diamond") && _mount.innerHTML.includes(">1<"),
  `html len=${_mount.innerHTML.length}`,
);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["choiceLayout", "list"] }, prod);
check(
  "list mode 1234",
  _mount.innerHTML.includes("choice-list") && !_mount.innerHTML.includes("abxy-diamond") && _mount.innerHTML.includes(">4<"),
  `html len=${_mount.innerHTML.length}`,
);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["choiceLayout", "bogus"] }, prod);
check("bad layout coerced", S().settings?.choiceLayout === "diamond", JSON.stringify(S().settings?.choiceLayout));
// true player branch (harness hardcodes isHost): drop privileges, force a
// re-render via an ungated click, then restore.
pk._store.isHost = false;
pk._store.self = plain;
clickBtn({}, "[data-f-you-close]");
await sleep(20);
check("player view hides game log", !_mount.innerHTML.includes("Game Log"), "log leaked to player");
pk._store.isHost = true;
pk._store.self = pk._store.participants.host1;
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["choiceLayout", "diamond"] }, prod);
check("host scores extended", _mount.innerHTML.includes("score-card-host"), "host class missing");
// --- per-player host powers: adjust, reset, rename, kick, screws ---
const solo = pk.makePlayer("solo1", "Solo1");
pk._store.participants.solo1 = solo;
const soloBefore = S().scores?.solo1 || 0;
await pk._store.rpc["producer-action"]({ fn: "adjustPlayerScore", args: ["solo1", 500] }, prod);
check("manual adjust +500", (S().scores?.solo1 || 0) === soloBefore + 500, JSON.stringify(S().scores?.solo1));
const nanAdjBefore = JSON.stringify(S().scores);
await pk._store.rpc["producer-action"]({ fn: "adjustPlayerScore", args: ["solo1", NaN] }, prod);
check("NaN adjust no-op", JSON.stringify(S().scores) === nanAdjBefore, "scores changed on NaN");
await pk._store.rpc["producer-action"]({ fn: "adjustPlayerScore", args: ["solo1", 0] }, prod);
check("zero adjust no-op", (S().scores?.solo1 || 0) === soloBefore + 500, JSON.stringify(S().scores?.solo1));
const impAdj = await pk._store.rpc["producer-action"]({ fn: "adjustPlayerScore", args: ["solo1", 100] }, impostor);
check("impostor adjust rejected", impAdj?.ok === false, JSON.stringify(impAdj));
await pk._store.rpc["producer-action"]({ fn: "resetPlayerScore", args: ["solo1"] }, prod);
check("reset single score zeroes", (S().scores?.solo1 || 0) === 0, JSON.stringify(S().scores?.solo1));
// --- reset-all scores: players + team totals zeroed, one log entry ---
S().scores = { solo1: 500, dev1: -200, "team:red": 700 };
check("host sees reset-all button", _mount.innerHTML.includes('data-host-action="reset-all-scores"'), "reset-all button missing");
{
  const logLen = S().gameLog.length;
  await pk._store.rpc["producer-action"]({ fn: "resetAllScores", args: [] }, prod);
  check("reset-all zeroes players", (S().scores?.solo1 || 0) === 0 && (S().scores?.dev1 || 0) === 0, JSON.stringify(S().scores));
  check("reset-all zeroes team totals", (S().scores?.["team:red"] || 0) === 0, JSON.stringify(S().scores?.["team:red"]));
  check("reset-all logs one entry", S().gameLog.length === logLen + 1 && S().gameLog[S().gameLog.length - 1]?.type === "manual-reset", `len=${S().gameLog.length} last=${JSON.stringify(S().gameLog[S().gameLog.length - 1]?.type)}`);
  const impReset = await pk._store.rpc["producer-action"]({ fn: "resetAllScores", args: [] }, impostor);
  check("impostor reset-all rejected", impReset?.ok === false, JSON.stringify(impReset));
}
await pk._store.rpc["producer-action"]({ fn: "setCustomPlayerName", args: ["solo1", "Renamed"] }, prod);
check("rename stored", S().customNames?.solo1 === "Renamed", JSON.stringify(S().customNames));
check("host panel shows rename", _mount.innerHTML.includes("Renamed"), "rename missing from host panel");
await pk._store.rpc["producer-action"]({ fn: "setCustomPlayerName", args: ["solo1", ""] }, prod);
check("rename clear", S().customNames?.solo1 === undefined, JSON.stringify(S().customNames));
await pk._store.rpc["producer-action"]({ fn: "setPlayerScrewBlocked", args: ["solo1", true] }, prod);
check("screw blocked", (S().settings?.screwBlockedPlayerIds || []).includes("solo1"), JSON.stringify(S().settings?.screwBlockedPlayerIds));
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
const blockedScrew = await pk._store.rpc.screw({ screweeId: null }, solo);
check("blocked screw rejected", blockedScrew?.ok === false, JSON.stringify(blockedScrew));
await pk._store.rpc["producer-action"]({ fn: "setPlayerScrewBlocked", args: ["solo1", false] }, prod);
check("screw unblocked", !(S().settings?.screwBlockedPlayerIds || []).includes("solo1"), JSON.stringify(S().settings?.screwBlockedPlayerIds));
// refund path: use a screw then refund it
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["allowScrewing", true] }, prod);
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
const sStart = await pk._store.rpc.screw({ screweeId: null }, solo);
check("solo screw starts", sStart?.ok === true, JSON.stringify(sStart));
await pk._store.rpc["producer-action"]({ fn: "resetScrews", args: [] }, prod);
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
await pk._store.rpc.screw({ screweeId: null }, solo);
await pk._store.rpc["producer-action"]({ fn: "closeScrewMode", args: [] }, prod);
check("screw use recorded", (S().round?.screwsUsedBy || []).includes("solo1"), JSON.stringify(S().round?.screwsUsedBy));
await pk._store.rpc["producer-action"]({ fn: "refundPlayerScrew", args: ["solo1"] }, prod);
check("screw refunded", !(S().round?.screwsUsedBy || []).includes("solo1"), JSON.stringify(S().round?.screwsUsedBy));
await pk._store.rpc["producer-action"]({ fn: "kickPlayer", args: ["solo1"] }, prod);
check("kick stored", (S().settings?.kickedPlayerIds || []).includes("solo1"), JSON.stringify(S().settings?.kickedPlayerIds));
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
const kickedBuzz = await pk._store.rpc.buzz({ option: 1 }, solo);
check("kicked cannot buzz", kickedBuzz?.ok === false, JSON.stringify(kickedBuzz));
check("host panel shows removed", _mount.innerHTML.includes("removed") || _mount.innerHTML.includes("Re-admit"), "kick row missing");
await pk._store.rpc["producer-action"]({ fn: "unkickPlayer", args: ["solo1"] }, prod);
check("unkick clears", !(S().settings?.kickedPlayerIds || []).includes("solo1"), JSON.stringify(S().settings?.kickedPlayerIds));
// --- audience hero (stats card removed) ---
pk._store.self = pk._store.participants.disp1 || disp;
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
check("audience join hero", _mount.innerHTML.includes("room-code-badge") && _mount.innerHTML.includes("in the room"), "join hero missing");
check("audience stats panel removed", !_mount.innerHTML.includes("audience-stats-card"), "stats panel still present");
// room-code modal: badge click opens, close button dismisses (rAF is async in stub)
check("room code badge clickable", _mount.innerHTML.includes("data-room-code-open"), "badge click hook missing");
clickBtn({}, "[data-room-code-open]");
await sleep(50);
check("room code modal opens", _mount.innerHTML.includes("room-code-mega"), "modal missing after badge click");
clickBtn({}, "[data-room-code-close]");
await sleep(50);
check("room code modal closes", !_mount.innerHTML.includes("room-code-mega"), "modal stuck open");
// --- room-code spotlight: host forces the mega modal onto displays ---
pk._store.self = pk._store.participants.host1;
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
check("host sees spotlight button", _mount.innerHTML.includes("data-room-code-spotlight-show"), "spotlight cta missing");
// producer render: overlay CTA is host-only, drive via an ungated click
pk._store.self = pk._store.participants.prod1;
pk._store.isHost = false;
clickBtn({}, "[data-coop-cancel]");
await sleep(50);
check("producer cannot spotlight", !_mount.innerHTML.includes("data-room-code-spotlight-show") && !_mount.innerHTML.includes("data-room-code-spotlight-hide"), "spotlight cta leaked to producer");
pk._store.isHost = true;
pk._store.self = pk._store.participants.host1;
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
clickBtn({}, "[data-room-code-spotlight-show]");
await sleep(50);
check("spotlight started in shared state", S().roomCodeSpotlight?.active === true && S().roomCodeSpotlight?.startedAt > 0, JSON.stringify(S().roomCodeSpotlight));
pk._store.self = pk._store.participants.disp1;
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
check("display sees spotlight modal despite players present", _mount.innerHTML.includes("room-code-mega"), "spotlight modal missing on display");
pk._store.self = pk._store.participants.host1;
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
clickBtn({}, "[data-room-code-spotlight-hide]");
await sleep(50);
check("spotlight ended in shared state", S().roomCodeSpotlight?.active === false, JSON.stringify(S().roomCodeSpotlight));
pk._store.self = pk._store.participants.disp1;
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
check("spotlight modal gone on display", !_mount.innerHTML.includes("room-code-mega"), "spotlight modal stuck");
pk._store.self = pk._store.participants.host1;
// --- F-you easter egg: on in alliance/off, off under shared team scoring ---
pk._store.self = pk._store.participants.host1;
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "text"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
const eggAlliance = await pk._store.rpc.buzz({ answerText: "fuck you" }, solo);
check("easter egg fires in alliance mode", eggAlliance?.easterEgg?.id === "f-you", JSON.stringify(eggAlliance?.easterEgg));
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["teamModeEnabled", true] }, prod);
// shared scoring is coop-locked to alliance, so drop coop first
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", false] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["teamScoringMode", "shared"] }, prod);
// team-mode open requires every non-controller/producer player assigned
for (const pid of Object.keys(pk._store.participants)) {
  if (pid === "host1" || pid === "prod1") continue;
  await pk._store.rpc["producer-action"]({ fn: "setPlayerTeam", args: [pid, "red"] }, prod);
}
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
const eggShared = await pk._store.rpc.buzz({ answerText: "fuck you" }, solo);
check("easter egg blocked in shared team mode", eggShared?.easterEgg?.id !== "f-you" && eggShared?.ok === true, JSON.stringify(eggShared?.easterEgg));
// alliance totals render above player scores on the scorecard
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["teamScoringMode", "alliance"] }, prod);
{
  const html = _mount.innerHTML;
  const totalsIdx = html.indexOf("Alliance totals");
  const playerIdx = html.indexOf('data-score-key="solo1"');
  check("alliance totals above player scores", totalsIdx !== -1 && playerIdx !== -1 && totalsIdx < playerIdx, `totals=${totalsIdx} player=${playerIdx}`);
}
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["teamScoringMode", "shared"] }, prod);
// --- roll credits broadcast: host starts, everyone but tablet watches ---
pk._store.self = pk._store.participants.host1;
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", false] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["teamModeEnabled", false] }, prod);
await sleep(50);
check("host sees roll credits button", _mount.innerHTML.includes("data-credits-start"), "cta missing for host");
S().scores = { dev1: 300, dev2: 900, plain1: 100 };
clickBtn({}, "[data-credits-start]");
await sleep(50);
check("credits started in shared state", S().credits?.active === true && S().credits?.startedAt > 0, JSON.stringify(S().credits));
{
  const html = _mount.innerHTML;
  check("credits overlay renders", html.includes("data-credits-overlay"), `html len=${html.length}`);
  const order = ["Host", "Producers", "Players", "Credits"].map((h) => html.indexOf(`<h3>${h}</h3>`));
  check("credits section order", order.every((i) => i !== -1) && order[0] < order[1] && order[1] < order[2] && order[2] < order[3], order.join(","));
  const overlay = html.slice(html.indexOf("data-credits-overlay"));
  check("credits ranks first to last", overlay.indexOf("GroupB") !== -1 && overlay.indexOf("GroupB") < overlay.indexOf("GroupA") && overlay.indexOf("GroupA") < overlay.indexOf("Solo"), "ranking wrong");
  check("credits names host", html.includes("<p><strong>Host</strong></p>"), "host name missing");
  check("credits names producer", html.includes("<p><strong>Producer</strong></p>"), "producer name missing");
}
// producer view: overlay plays, but starting is strictly a host power
pk._store.self = pk._store.participants.prod1;
pk._store.isHost = false;
// producer-action short-circuits without rendering when isHost is false,
// so drive the producer render through a no-op delegated click instead.
clickBtn({}, "[data-coop-cancel]");
await sleep(50);
check("producer sees overlay", _mount.innerHTML.includes("data-credits-overlay"), "no overlay for producer");
check("producer cannot start credits", !_mount.innerHTML.includes("data-credits-start"), "start button leaked to producer");
{
  const startedAt = S().credits?.startedAt;
  clickBtn({}, "[data-credits-start]");
  await sleep(50);
  check("non-host start is a no-op", S().credits?.startedAt === startedAt, JSON.stringify(S().credits));
}
pk._store.isHost = true;
// audience display watches too
pk._store.self = pk._store.participants.disp1;
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
check("display sees overlay", _mount.innerHTML.includes("data-credits-overlay"), "no overlay for display");
// tablet timer is excluded
const tab = pk.makePlayer("tab1", "Tab", "tablet_timer");
pk._store.participants.tab1 = tab;
pk._store.self = tab;
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
check("tablet skips overlay", !_mount.innerHTML.includes("data-credits-overlay"), "overlay leaked to tablet");
// host ends it everywhere via the real click path
pk._store.self = pk._store.participants.host1;
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
clickBtn({}, "[data-credits-end]");
await sleep(50);
check("credits ended in shared state", S().credits?.active === false, JSON.stringify(S().credits));
check("overlay gone after end", !_mount.innerHTML.includes("data-credits-overlay"), "overlay stuck");
// restart, then a local dismiss hides one screen while the broadcast lives on
clickBtn({}, "[data-credits-start]");
await sleep(50);
check("credits restarted", S().credits?.active === true, JSON.stringify(S().credits));
pk._store.self = pk._store.participants.disp1;
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
check("overlay back for display", _mount.innerHTML.includes("data-credits-overlay"), "restart did not reach display");
clickBtn({}, "[data-credits-close]");
await sleep(50);
check("local dismiss hides overlay", !_mount.innerHTML.includes("data-credits-overlay"), "dismiss failed");
check("broadcast still active after dismiss", S().credits?.active === true, JSON.stringify(S().credits));
pk._store.self = pk._store.participants.host1;
clickBtn({}, "[data-credits-end]");
await sleep(50);
check("credits ended after dismiss", S().credits?.active === false, JSON.stringify(S().credits));
// --- credits in team-individual mode still groups by team with totals ---
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["teamModeEnabled", true] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["teamScoringMode", "alliance"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setPlayerTeam", args: ["dev1", "red"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setPlayerTeam", args: ["dev2", "red"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setPlayerTeam", args: ["solo1", "blue"] }, prod);
S().scores = { dev1: 400, dev2: 100, solo1: 900 };
clickBtn({}, "[data-credits-start]");
await sleep(50);
{
  const html = _mount.innerHTML;
  const overlay = html.slice(html.indexOf("data-credits-overlay"));
  check("credits groups alliance teams", overlay.includes("team-red") && overlay.includes("team-blue"), "team pills missing");
  check("credits sums team totals", overlay.includes(">500<") && overlay.includes(">900<"), "team totals wrong");
}
clickBtn({}, "[data-credits-end]");
await sleep(50);
check("credits ended after team check", S().credits?.active === false, JSON.stringify(S().credits));
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["teamModeEnabled", false] }, prod);
// --- analytics card: current-round percentages, log badges, audience mirror ---
pk._store.self = pk._store.participants.host1;
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["lockAfterBuzz", false] }, prod);
// Preset option 1 so the correct-answer marker has something to mark
// (also satisfies the coop no-lock preset gate).
{
  const curOpts = (S().round?.correctOptions || []).map(Number);
  if (!curOpts.includes(1)) await pk._store.rpc["producer-action"]({ fn: "toggleCorrectOption", args: [1] }, prod);
}
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
check("analytics round open", S().round?.status === "open", S().round?.status);
const aDev1 = pk._store.participants.dev1, aDev2 = pk._store.participants.dev2, aDev3 = pk._store.participants.dev3;
const scoresBeforeClose = JSON.stringify(S().scores);
const ab1 = await pk._store.rpc.buzz(COOP ? { option: 1, coopSlot: 0 } : { option: 1 }, aDev1);
const ab2 = await pk._store.rpc.buzz(COOP ? { option: 2, coopSlot: 0 } : { option: 2 }, aDev2);
const ab3 = await pk._store.rpc.buzz(COOP ? { option: 2, coopSlot: 0 } : { option: 2 }, aDev3);
check("analytics picks recorded", ab1?.ok === true && ab2?.ok === true && ab3?.ok === true, JSON.stringify([ab1?.ok, ab2?.ok, ab3?.ok]));
{
  const roundNow = S().round?.roundNumber;
  const openEntries = S().gameLog.filter((e) => e?.type === "buzz" && Number(e.roundId) === Number(roundNow));
  check("scores held while open", JSON.stringify(S().scores) === scoresBeforeClose, "auto-scoring leaked while open");
  check("entries unresolved while open", openEntries.length === 3 && openEntries.every((e) => !e.resolved && Number(e.awardedDelta || 0) === 0), `n=${openEntries.length}`);
}
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
{
  const html = _mount.innerHTML;
  check("analytics waits while open", html.includes("data-analytics-card") && html.includes("still open") && !html.includes("3 picks"), "live percentages leaked while open");
}
// Closing lands scores + percentages together.
await pk._store.rpc["producer-action"]({ fn: "pauseBuzzers", args: [] }, prod);
check("analytics round closed", S().round?.status === "closed", S().round?.status);
{
  const roundNow = S().round?.roundNumber;
  const closedEntries = S().gameLog.filter((e) => e?.type === "buzz" && Number(e.roundId) === Number(roundNow));
  check("close resolves preset entries", closedEntries.length === 3 && closedEntries.every((e) => e.resolved === true), `resolved=${closedEntries.map((e) => e.awardedDelta).join(",")}`);
  check("close moves scores", JSON.stringify(S().scores) !== scoresBeforeClose, "no score movement on close");
}
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
// Re-render after an input-mode switch animates (250ms transitionMount), so
// poll for the fresh card instead of single-shot reading a stale frame.
let aHtml = "";
for (let i = 0; i < 20 && !aHtml.includes(`Round ${S().round?.roundNumber} · 3 picks`); i++) {
  await sleep(50);
  aHtml = _mount.innerHTML;
}
{
  const html = aHtml;
  check("analytics card renders for host", html.includes("data-analytics-card"), `len=${html.length}`);
  check("analytics shows majority pct", html.includes("67%"), "2/3 share missing");
  check("analytics shows minority pct", html.includes("33%"), "1/3 share missing");
  check("analytics counts picks", html.includes("3 picks"), "pick total missing");
  check("analytics marks preset", html.includes("analytics-correct"), "correct marker missing");
  check("log badges label buttons", html.includes("log-badge-buttons"), "button badge missing");
}
// spotlight auth: impostors rejected, producers allowed (host executes)
const anaImpostor = await pk._store.rpc["producer-action"]({ fn: "startAnalyticsSpotlight", args: [] }, impostor);
check("analytics spotlight rejects non-producer", anaImpostor?.ok === false, JSON.stringify(anaImpostor));
check("analytics spotlight cta for host", _mount.innerHTML.includes("data-analytics-show"), "show toggle missing");
{
  const html = _mount.innerHTML;
  const broadcastCount = html.split("data-broadcast-card").length - 1;
  check("broadcast controls merged into one card", broadcastCount === 1, `cards=${broadcastCount}`);
  check("old cta cards gone", !html.includes("credits-cta-card") && !html.includes("room-code-spotlight-cta-card") && !html.includes("analytics-cta-card"), "legacy card class leaked");
  check("broadcast card holds all toggles", html.includes("data-credits-start") && html.includes("data-room-code-spotlight-show") && html.includes("data-analytics-show"), "toggle missing from merged card");
}
clickBtn({}, "[data-analytics-show]");
await sleep(50);
check("host starts analytics spotlight", S().analyticsSpotlight?.active === true, JSON.stringify(S().analyticsSpotlight));
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
check("analytics spotlight cta flips", _mount.innerHTML.includes("data-analytics-hide"), "hide toggle missing");
pk._store.self = pk._store.participants.disp1;
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
let dHtml = "";
for (let i = 0; i < 20 && !dHtml.includes("audience-layout"); i++) {
  await sleep(50);
  dHtml = _mount.innerHTML;
}
check("display mirrors analytics", dHtml.includes("audience-layout") && dHtml.includes("data-analytics-card"), "no analytics on display");
pk._store.self = pk._store.participants.host1;
clickBtn({}, "[data-analytics-hide]");
await sleep(50);
check("analytics spotlight ended", S().analyticsSpotlight?.active === false, JSON.stringify(S().analyticsSpotlight));
const anaProd = await pk._store.rpc["producer-action"]({ fn: "startAnalyticsSpotlight", args: [] }, prod);
check("producer starts analytics spotlight", anaProd?.ok === true && S().analyticsSpotlight?.active === true, JSON.stringify(anaProd));
await pk._store.rpc["producer-action"]({ fn: "endAnalyticsSpotlight", args: [] }, prod);
check("producer ends analytics spotlight", S().analyticsSpotlight?.active === false, JSON.stringify(S().analyticsSpotlight));
// text mode groups identical answers (case-insensitive, picks counted)
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "text"] }, prod);
if (COOP) await pk._store.rpc["producer-action"]({ fn: "setCorrectAnswerValue", args: ["zzz-no-match"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
await pk._store.rpc.buzz(COOP ? { answerText: "Alpha", coopSlot: 0 } : { answerText: "Alpha" }, aDev1);
await pk._store.rpc.buzz(COOP ? { answerText: "  ALPHA ", coopSlot: 0 } : { answerText: "  ALPHA " }, aDev2);
await pk._store.rpc.buzz(COOP ? { answerText: "Beta", coopSlot: 0 } : { answerText: "Beta" }, aDev3);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
{
  const html = _mount.innerHTML;
  check("text analytics waits while open", html.includes("still open") && !html.includes("67%"), "live grouping leaked while open");
}
await pk._store.rpc["producer-action"]({ fn: "pauseBuzzers", args: [] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
{
  const html = _mount.innerHTML;
  check("text analytics groups answers", html.includes("67%") && html.includes("33%"), "grouped shares missing");
  check("log badges label text", html.includes("log-badge-text"), "text badge missing");
}
// next round resets analytics: an active mirror clears on open, old
// percentages don't linger into the new round
await pk._store.rpc["producer-action"]({ fn: "startAnalyticsSpotlight", args: [] }, prod);
check("spotlight on before new round", S().analyticsSpotlight?.active === true, JSON.stringify(S().analyticsSpotlight));
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
check("new round opened", S().round?.status === "open", S().round?.status);
check("new round clears spotlight", S().analyticsSpotlight?.active !== true, JSON.stringify(S().analyticsSpotlight));
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
await sleep(50);
{
  const html = _mount.innerHTML;
  check("new round shows waiting analytics", html.includes("data-analytics-card") && html.includes("still open") && !html.includes("67%"), "stale percentages lingered");
}
// --- episode schema v1: validator (mode-independent) ---
const eps = await import("../src/episodes/schema.js");
function validEp() {
  return {
    schemaVersion: 1,
    meta: { title: "Test Ep", author: "Host", createdAt: "2026-01-01T00:00:00.000Z" },
    defaults: { scoringMode: "uniform", uniformPoints: 1000, timeOpen: 20, lockAfterBuzz: false, rebuzzAllowed: false },
    items: [
      { id: "q1", kind: "buttons", prompt: "2+2?", optionCount: 4, correctOptions: [4], options: ["two", "three", "four", "five"], overrides: { uniformPoints: 500 } },
      { id: "q2", kind: "text", prompt: "Capital of France?", correctAnswer: "Paris" },
      { id: "q3", kind: "fibbage", prompt: "The ___ is real", truth: "thing", lieTimeSec: 30, voteTimeSec: 45, multiplier: 2 },
      { id: "q4", kind: "disordat", prompt: "Sort these", disLabel: "Dis", datLabel: "Dat", answers: ["dis", "dat", "both", "dis", "dat", "both", "dis"] },
      { id: "q5", kind: "quixort", prompt: "Sort oldest first", items: ["a", "b", "c", "d"], trash: ["zzz"], multiplier: 1, blockSec: 30 },
      { id: "q6", kind: "bingo", prompt: "Letters", word: "BINGO", rounds: [{ prompt: "Pick G", answer: "G" }] },
      { id: "q7", kind: "wendithapn", prompt: "When?", rounds: [{ prompt: "W?", answer: "N" }] },
    ],
  };
}
check("episode valid passes", eps.validateEpisode(validEp()).ok === true, JSON.stringify(eps.validateEpisode(validEp()).errors));
const badCases = [
  ["empty title", (e) => { e.meta.title = "  "; }, "meta.title"],
  ["bad schema", (e) => { e.schemaVersion = 2; }, "schemaVersion"],
  ["unknown top key", (e) => { e.junk = 1; }, "junk"],
  ["no items", (e) => { e.items = []; }, "items"],
  ["dup ids", (e) => { e.items[1].id = "q1"; }, "id"],
  ["bad kind", (e) => { e.items[0].kind = "bounce"; }, "kind"],
  ["empty prompt", (e) => { e.items[0].prompt = ""; }, "prompt"],
  ["bad optionCount", (e) => { e.items[0].optionCount = 3; }, "optionCount"],
  ["no correct options", (e) => { e.items[0].correctOptions = []; }, "correctOptions"],
  ["option out of range", (e) => { e.items[0].correctOptions = [5]; }, "correctOptions"],
  ["bad points", (e) => { e.items[0].overrides = { uniformPoints: -5 }; }, "items[0].overrides.uniformPoints"],
  ["bad override key", (e) => { e.items[0].overrides = { noSuchKey: 1 }; }, "items[0].overrides.noSuchKey"],
  ["bad jack", (e) => { e.items[0].overrides = { jackMultiplier: 9 }; }, "items[0].overrides.jackMultiplier"],
  ["bad layout", (e) => { e.items[0].overrides = { choiceLayout: "circle" }; }, "items[0].overrides.choiceLayout"],
  ["bad maxbuzz", (e) => { e.items[0].overrides = { maxBuzzesPerOption: 0 }; }, "items[0].overrides.maxBuzzesPerOption"],
  ["non-bool override", (e) => { e.items[0].overrides = { lockAfterBuzz: "yes" }; }, "items[0].overrides.lockAfterBuzz"],
  ["overrides non-object", (e) => { e.items[0].overrides = []; }, "overrides"],
  ["options length mismatch", (e) => { e.items[0].options = ["a", "b"]; }, "options"],
  ["options empty entry", (e) => { e.items[0].options = ["a", "b", " ", "d"]; }, "options"],
  ["options duplicate", (e) => { e.items[0].options = ["a", "b", "A ", "d"]; }, "options"],
  ["options non-array", (e) => { e.items[0].options = "abcd"; }, "options"],
  ["empty answer", (e) => { e.items[1].correctAnswer = ""; }, "correctAnswer"],
  ["empty truth", (e) => { e.items[2].truth = " "; }, "truth"],
  ["bad lie time", (e) => { e.items[2].lieTimeSec = 20; }, "lieTimeSec"],
  ["bad fibbage mult", (e) => { e.items[2].multiplier = 9; }, "multiplier"],
  ["disordat short", (e) => { e.items[3].answers = ["dis"]; }, "answers"],
  ["disordat bad value", (e) => { e.items[3].answers[0] = "maybe"; }, "answers"],
  ["quixort few items", (e) => { e.items[4].items = ["a", "b"]; }, "items"],
  ["quixort dupes", (e) => { e.items[4].trash = ["A "]; }, "items"],
  ["quixort bad block", (e) => { e.items[4].blockSec = 25; }, "blockSec"],
  ["bingo short word", (e) => { e.items[5].word = "HI"; }, "word"],
  ["bingo repeated letters", (e) => { e.items[5].word = "HELLO"; }, "word"],
  ["bingo missing answer", (e) => { delete e.items[5].rounds; }, "rounds"],
  ["bingo empty rounds", (e) => { e.items[5].rounds = []; }, "rounds"],
  ["bingo too many rounds", (e) => { e.items[5].rounds = ["B", "I", "N", "G", "O", "X"].map((a) => ({ answer: a })); }, "rounds"],
  ["bingo bad letter", (e) => { e.items[5].rounds = [{ answer: "7" }]; }, "rounds"],
  ["bingo letter not in word", (e) => { e.items[5].rounds = [{ answer: "Z" }]; }, "rounds"],
  ["bingo round unknown field", (e) => { e.items[5].rounds = [{ answer: "B", junk: 1 }]; }, "rounds"],
  ["wen missing answer", (e) => { delete e.items[6].rounds; }, "rounds"],
  ["wen bad answer", (e) => { e.items[6].rounds = [{ answer: "X" }]; }, "rounds"],
  ["wen too many rounds", (e) => { e.items[6].rounds = [{ answer: "B" }, { answer: "N" }, { answer: "A" }, { answer: "B" }]; }, "rounds"],
  ["bad default key", (e) => { e.defaults.junk = 1; }, "defaults.junk"],
  ["bad scoring mode", (e) => { e.defaults.scoringMode = "chaos"; }, "defaults.scoringMode"],
];
for (const [name, mutate, field] of badCases) {
  const e = validEp();
  mutate(e);
  const r = eps.validateEpisode(e);
  check(`episode invalid: ${name}`, r.ok === false && r.errors.some((x) => x.field === field), JSON.stringify(r.errors));
}
{
  // Repeat letters across rounds are allowed (fresh contest per round).
  const rep = validEp();
  rep.items[5].rounds = [{ prompt: "One?", answer: "B" }, { prompt: "Two?", answer: "b " }, { prompt: "Three?", answer: "N" }];
  rep.items[6].rounds = [{ answer: "B" }, { answer: "B" }];
  const rr = eps.validateEpisode(rep);
  check("repeat rounds allowed", rr.ok === true, JSON.stringify(rr.errors));
}
{
  const messy = validEp();
  messy.items[0].correctOptions = [4, 1, 1];
  messy.items[3].answers = ["DIS", "DAT", "Both", "dis", "dat", "both", "dis"];
  messy.items[5].word = "bingo";
  const n = eps.normalizeEpisode(messy);
  check("normalize sorts/dedupes options", JSON.stringify(n.items[0].correctOptions) === "[1,4]", JSON.stringify(n.items[0].correctOptions));
  check("normalize lowercases answers", n.items[3].answers[0] === "dis" && n.items[3].answers[2] === "both", JSON.stringify(n.items[3].answers));
  check("normalize uppercases bingo", n.items[5].word === "BINGO", n.items[5].word);
  check("normalized messy passes", eps.validateEpisode(n).ok === true, JSON.stringify(eps.validateEpisode(n).errors));
  {
    const base = validEp();
    const merged = eps.effectiveItemSettings(base, base.items[0]);
    check("override wins over default", merged.uniformPoints === 500, JSON.stringify(merged));
    const gap = eps.effectiveItemSettings(base, base.items[1]);
    check("gap falls back to default", gap.uniformPoints === 1000 && gap.scoringMode === "uniform", JSON.stringify(gap));
    check("absent keys omitted", !("jackMultiplier" in gap) && !("maxBuzzesPerOption" in gap) && !("choiceLayout" in gap) && !("closeBuzzersOnPointsGiven" in gap), JSON.stringify(gap));
  }
  {
    // Lowercase letters normalize up, then validate.
    const lower = eps.normalizeEpisode(validEp());
    lower.items[5].rounds = [{ prompt: "  pick g ", answer: "g" }];
    lower.items[6].rounds = [{ answer: "n" }];
    const fixed = eps.normalizeEpisode(lower);
    check("answers uppercase", fixed.items[5].rounds[0].answer === "G" && fixed.items[6].rounds[0].answer === "N", JSON.stringify([fixed.items[5].rounds[0].answer, fixed.items[6].rounds[0].answer]));
    check("round prompts trim", fixed.items[5].rounds[0].prompt === "pick g", JSON.stringify(fixed.items[5].rounds[0].prompt));
    check("lowercase answers valid", eps.validateEpisode(fixed).ok === true, JSON.stringify(eps.validateEpisode(fixed).errors));
  }
  {
    // Legacy single-answer episodes migrate to one round on normalize.
    const legacy = eps.normalizeEpisode({
      schemaVersion: 1,
      meta: { title: "Old" },
      defaults: {},
      items: [
        { id: "o1", kind: "bingo", prompt: "Old?", word: "bingo", answer: "b" },
        { id: "o2", kind: "wendithapn", prompt: "Old wen?", answer: "a" },
      ],
    });
    check("legacy migrates to rounds", Array.isArray(legacy.items[0].rounds) && legacy.items[0].rounds[0].answer === "B" && legacy.items[0].answer === undefined, JSON.stringify(legacy.items[0]));
    check("legacy validates after migrate", eps.validateEpisode(legacy).ok === true, JSON.stringify(eps.validateEpisode(legacy).errors));
  }
}
check("blank item per kind", eps.EPISODE_KINDS.every((k) => eps.validateEpisode({ ...validEp(), items: [{ ...eps.blankItem(k), prompt: "P", ...(k === "buttons" ? { correctOptions: [1] } : {}), ...(k === "text" ? { correctAnswer: "A" } : {}), ...(k === "fibbage" ? { truth: "T" } : {}), ...(k === "bingo" ? { word: "ABCDE", rounds: [{ answer: "A" }] } : {}), ...(k === "wendithapn" ? { rounds: [{ answer: "N" }] } : {}), ...(k === "quixort" ? { items: ["a", "b", "c", "d"] } : {}) }] }).ok), "blank failed");
// --- episode editor ops (mode-independent, DOM-free) ---
const eped = await import("../src/episodes/editor.js");
const epui = await import("../src/episodes/ui.js");
{
  let ep = eped.loadDraft();
  check("draft starts blank", Array.isArray(ep.items) && ep.items.length === 0, JSON.stringify(ep.items?.length));
  ep = eped.addItem(ep, "buttons");
  ep = eped.addItem(ep, "text");
  ep = eped.addItem(ep, "quixort");
  check("add items", ep.items.length === 3, String(ep.items.length));
  const firstId = ep.items[0].id;
  ep = eped.updateItem(ep, firstId, { prompt: "2+2?", optionCount: 4, correctOptions: [4] });
  check("update item", ep.items[0].prompt === "2+2?", ep.items[0].prompt);
  ep = eped.updateItem(ep, "missing-id", { prompt: "x" });
  check("update missing no-op", ep.items.length === 3, String(ep.items.length));
  ep = eped.moveItem(ep, firstId, 1);
  check("move item", ep.items[1].id === firstId, ep.items.map((i) => i.id).join(","));
  ep = eped.moveItem(ep, firstId, -1);
  check("move back", ep.items[0].id === firstId, ep.items.map((i) => i.id).join(","));
  ep = eped.duplicateItem(ep, firstId);
  check("duplicate item", ep.items.length === 4 && ep.items[1].prompt === "2+2?" && ep.items[1].id !== firstId, String(ep.items.length));
  const dupId = ep.items[1].id;
  ep = eped.deleteItem(ep, dupId);
  check("delete item", ep.items.length === 3 && ep.items.every((i) => i.id !== dupId), String(ep.items.length));
  ep = eped.updateMeta(ep, { title: "Night", author: "H", junk: "drop" });
  check("update meta", ep.meta.title === "Night" && ep.meta.junk === undefined, JSON.stringify(ep.meta));
  ep = eped.updateDefaults(ep, { scoringMode: "uniform", uniformPoints: 500, timeOpen: "" });
  check("update defaults", ep.defaults.scoringMode === "uniform" && ep.defaults.uniformPoints === 500 && !("timeOpen" in ep.defaults), JSON.stringify(ep.defaults));
  const textId = ep.items.find((i) => i.kind === "text").id;
  const qxId = ep.items.find((i) => i.kind === "quixort").id;
  ep = eped.updateItem(ep, textId, { prompt: "Capital?", correctAnswer: "Paris" });
  ep = eped.updateItem(ep, qxId, { prompt: "Order these", items: ["a", "b", "c", "d"], trash: [] });
  const text = eped.exportText(ep);
  const rt = eped.parseImportText(text);
  check("export/parse round-trip", rt.ok === true && rt.episode.items.length === 3, rt.errorMessage || JSON.stringify(rt.errors));
  const badJson = eped.parseImportText("{nope");
  check("import rejects non-json", badJson.ok === false, JSON.stringify(badJson));
  const badEp = eped.parseImportText(JSON.stringify({ schemaVersion: 1, meta: {}, defaults: {}, items: [] }));
  check("import rejects invalid episode", badEp.ok === false && badEp.errors.length > 0, JSON.stringify(badEp));
  check("export filename slugs title", eped.exportFileName(ep) === "night.episode.json", eped.exportFileName(ep));
  const html = epui.renderCreatorScreen({ ep, selectedId: firstId, errors: [], importErrors: [], cloudEnabled: false, esc: (s) => String(s) });
  check("creator renders toolbar", html.includes("data-ep-add") && html.includes("data-ep-export") && html.includes("data-ep-import-btn"), "toolbar missing");
  check("creator renders edit form", html.includes('id="ep-prompt"') && html.includes("data-ep-close-edit"), "edit form missing");
  check("creator cloud disabled", html.includes('data-ep-cloud-save disabled'), "cloud save not disabled");
  const htmlErr = epui.renderCreatorScreen({ ep, selectedId: null, errors: [], importErrors: [], cloudEnabled: false, cloudError: "Cloud unreachable at http://x", esc: (s) => String(s) });
  check("creator shows cloud reason", htmlErr.includes("Cloud unreachable") && htmlErr.includes("data-ep-cloud-retry"), "diagnosis missing");
  const htmlNoSel = epui.renderCreatorScreen({ ep, selectedId: null, errors: [], importErrors: [], cloudEnabled: false, esc: (s) => String(s) });
  check("creator no edit without selection", !htmlNoSel.includes('id="ep-prompt"'), "edit form leaked");
  {
    // Correct-option labels mirror the game: ABXY in diamond ≤4, else numbers.
    const mc = { id: "mc1", kind: "buttons", prompt: "P", optionCount: 4, correctOptions: [1] };
    const mcEp = { schemaVersion: 1, meta: { title: "T" }, defaults: {}, items: [mc] };
    const diamond = epui.renderCreatorScreen({ ep: mcEp, selectedId: "mc1", errors: [], importErrors: [], cloudEnabled: false, esc: (s) => String(s) });
    check("diamond labels ABXY", [">A<", ">B<", ">X<", ">Y<"].every((t) => diamond.includes(t)), "letters missing");
    const gridEp = { schemaVersion: 1, meta: { title: "T" }, defaults: { choiceLayout: "grid" }, items: [mc] };
    const grid = epui.renderCreatorScreen({ ep: gridEp, selectedId: "mc1", errors: [], importErrors: [], cloudEnabled: false, esc: (s) => String(s) });
    check("grid labels numeric", [">1<", ">2<", ">3<", ">4<"].every((t) => grid.includes(t)) && !grid.includes(">A<"), "numbers missing");
    const sixEp = { schemaVersion: 1, meta: { title: "T" }, defaults: {}, items: [{ ...mc, optionCount: 6, correctOptions: [6] }] };
    const six = epui.renderCreatorScreen({ ep: sixEp, selectedId: "mc1", errors: [], importErrors: [], cloudEnabled: false, esc: (s) => String(s) });
    check("6-option diamond numeric", six.includes(">6<") && !six.includes(">A<"), "6-option mislabeled");
    const ovEp = { schemaVersion: 1, meta: { title: "T" }, defaults: { choiceLayout: "grid" }, items: [{ ...mc, overrides: { choiceLayout: "diamond" } }] };
    const ov = epui.renderCreatorScreen({ ep: ovEp, selectedId: "mc1", errors: [], importErrors: [], cloudEnabled: false, esc: (s) => String(s) });
    check("override layout wins", ov.includes(">A<"), "override ignored");
  }
  const harvested = epui.harvestCreatorFields(null);
  check("harvest null-safe", harvested.item === null && harvested.meta.title === undefined, JSON.stringify(harvested));
}
// --- episode bulk line import (cycling modes) ---
{
  const eped2 = await import("../src/episodes/editor.js");
  const bingo = eped2.parseBulkLines("First?, B\nSecond, with comma?, I\n\n  \nThird?,o", "bingo", "BINGO");
  check("bulk bingo valid", bingo.items.length === 3 && bingo.errors.length === 0, JSON.stringify({ n: bingo.items.length, e: bingo.errors }));
  check("bulk prompts keep commas", bingo.items[1].prompt === "Second, with comma?" && bingo.items[1].rounds[0].answer === "I", JSON.stringify(bingo.items[1]));
  check("bulk builds rounds", bingo.items[0].rounds.length === 1 && bingo.items[0].rounds[0].answer === "B", JSON.stringify(bingo.items[0].rounds));
  check("bulk ids unique", new Set(bingo.items.map((i) => i.id)).size === 3, "dup ids");
  const bad = eped2.parseBulkLines("No comma here\nEmpty?, \nNot in word?, Z\n, B", "bingo", "BINGO");
  check("bulk bingo errors by line", bad.items.length === 0 && bad.errors.length === 4 && bad.errors[0].line === 1, JSON.stringify(bad.errors));
  const wen = eped2.parseBulkLines("Happened before?, b\nNever?, N\nAfter?, a", "wendithapn");
  check("bulk wen valid", wen.items.length === 3 && wen.errors.length === 0 && wen.items[0].rounds[0].answer === "B", JSON.stringify(wen));
  const wenBad = eped2.parseBulkLines("Maybe?, X", "wendithapn");
  check("bulk wen rejects letter", wenBad.items.length === 0 && wenBad.errors.length === 1 && wenBad.errors[0].line === 1, JSON.stringify(wenBad));
  const wrongKind = eped2.parseBulkLines("Q?, A", "buttons");
  check("bulk rejects other kinds", wrongKind.items.length === 0 && wrongKind.errors.length === 1, JSON.stringify(wrongKind));
}
// --- episode runner: attach + load + broadcast (driven via producer-action) ---
{
  const testEp = {
    schemaVersion: 1,
    meta: { title: "Harness Ep", author: "T" },
    defaults: { scoringMode: "uniform", uniformPoints: 777, timeOpen: 25 },
    items: [
      { id: "h1", kind: "buttons", prompt: "2+2?", optionCount: 4, correctOptions: [4], options: ["Two", "Three", "Four", "Five"], overrides: { uniformPoints: 500 } },
      { id: "h2", kind: "text", prompt: "Capital?", correctAnswer: "Paris", overrides: { timeOpen: 45 } },
      { id: "h3", kind: "fibbage", prompt: "The ___!", truth: "real", lieTimeSec: 30, voteTimeSec: 30, multiplier: 2 },
    ],
  };
  pk._store.self = pk._store.participants.host1;
  const upBefore = S().settings?.uniformPoints;
  check(
    "impostor cannot attach episode",
    (await pk._store.rpc["producer-action"]({ fn: "attachEpisode", args: [testEp] }, impostor))?.ok === false,
    "impostor attached an episode",
  );
  await pk._store.rpc["producer-action"]({ fn: "attachEpisode", args: [{ schemaVersion: 1, meta: {}, defaults: {}, items: [] }] }, prod);
  check("invalid attach rejected", S().episodePrompt === null && S().settings?.uniformPoints === upBefore, JSON.stringify(S().episodePrompt));
  await pk._store.rpc["producer-action"]({ fn: "attachEpisode", args: [testEp] }, prod);
  check("attach seeds defaults", S().settings?.uniformPoints === 777 && S().settings?.timeOpen === 25, JSON.stringify({ u: S().settings?.uniformPoints, t: S().settings?.timeOpen }));
  await pk._store.rpc["producer-action"]({ fn: "resetRound", args: [] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
  check("runner card on host", _mount.innerHTML.includes("ep-runner") && _mount.innerHTML.includes("Harness Ep"), "runner card missing");
  await pk._store.rpc["producer-action"]({ fn: "episodeRunLoad", args: [0] }, prod);
  check("load seeds MC preset", JSON.stringify(S().round?.correctOptions) === "[4]", JSON.stringify(S().round?.correctOptions));
  check("load applies point override", S().settings?.uniformPoints === 500, String(S().settings?.uniformPoints));
  check("load leaves other defaults", S().settings?.timeOpen === 25, String(S().settings?.timeOpen));
  check("load broadcasts prompt", S().episodePrompt?.prompt === "2+2?" && S().episodePrompt?.index === 0 && S().episodePrompt?.total === 3, JSON.stringify(S().episodePrompt));
  check("load broadcasts option labels", JSON.stringify(S().episodePrompt?.optionLabels) === JSON.stringify(["Two", "Three", "Four", "Five"]), JSON.stringify(S().episodePrompt?.optionLabels));
  check("load broadcasts option keys", JSON.stringify(S().episodePrompt?.optionKeys) === JSON.stringify(["A", "B", "X", "Y"]), JSON.stringify(S().episodePrompt?.optionKeys));
  pk._store.self = dev3;
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
  check("player sees prompt banner", _mount.innerHTML.includes("ep-prompt-banner") && _mount.innerHTML.includes("2+2?") && _mount.innerHTML.includes("Three"), "banner missing for player");
  pk._store.self = pk._store.participants.disp1;
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
  await sleep(50);
  check("display sees prompt banner", _mount.innerHTML.includes("ep-prompt-banner") && _mount.innerHTML.includes("2+2?"), "banner missing on display");
  pk._store.self = pk._store.participants.host1;
  await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "episodeRunLoad", args: [1] }, prod);
  check("load blocked while open", S().episodePrompt?.index === 0, JSON.stringify(S().episodePrompt));
  await pk._store.rpc["producer-action"]({ fn: "resetRound", args: [] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "episodeRunStep", args: [1] }, prod);
  check("step loads text preset", S().round?.correctAnswer === "Paris" && S().episodePrompt?.index === 1, JSON.stringify({ a: S().round?.correctAnswer, p: S().episodePrompt }));
  check("step falls back to default points", S().settings?.uniformPoints === 777, String(S().settings?.uniformPoints));
  check("step applies time override", S().settings?.timeOpen === 45, String(S().settings?.timeOpen));
  check("unlabeled clears broadcast labels", S().episodePrompt?.optionLabels === null && S().episodePrompt?.optionKeys === null, JSON.stringify({ l: S().episodePrompt?.optionLabels, k: S().episodePrompt?.optionKeys }));
  if (!COOP) {
    await pk._store.rpc["producer-action"]({ fn: "episodeRunStep", args: [1] }, prod);
    check("step loads fibbage truth", S().fibbage?.truth === "real" && S().episodePrompt?.index === 2, JSON.stringify({ t: S().fibbage?.truth, p: S().episodePrompt }));
    await pk._store.rpc["producer-action"]({ fn: "episodeRunStep", args: [1] }, prod);
    check("step stops at end", S().episodePrompt?.index === 2, JSON.stringify(S().episodePrompt));
  }
  await pk._store.rpc["producer-action"]({ fn: "episodeRunEnd", args: [] }, prod);
  check("end clears prompt", S().episodePrompt === null, JSON.stringify(S().episodePrompt));
  pk._store.self = pk._store.participants.disp1;
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
  await sleep(50);
  check("banner gone after end", !_mount.innerHTML.includes("ep-prompt-banner"), "stale banner on display");
  pk._store.self = pk._store.participants.host1;
}
// --- episode cycling modes: word+target seeding, start preserves it ---
{
  const cycleEp = {
    schemaVersion: 1,
    meta: { title: "Cycle Ep" },
    defaults: {},
    items: [
      {
        id: "c1", kind: "bingo", prompt: "Collect!", word: "GAMES",
        rounds: [{ prompt: "First?", answer: "G" }, { prompt: "Second?", answer: "E" }],
      },
      { id: "c2", kind: "wendithapn", prompt: "When?", rounds: [{ prompt: "W?", answer: "N" }] },
    ],
  };
  pk._store.self = pk._store.participants.host1;
  await pk._store.rpc["producer-action"]({ fn: "attachEpisode", args: [cycleEp] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "resetRound", args: [] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "episodeRunLoad", args: [0] }, prod);
  check("bingo load seeds word", S().bingo?.word === "GAMES" && S().bingo?.items?.join("") === "GAMES", JSON.stringify(S().bingo?.word));
  check("bingo load seeds first target", S().bingo?.targetIndex === 0, String(S().bingo?.targetIndex));
  check("bingo load resets play", S().bingo?.active === false && S().bingo?.winner === null, JSON.stringify({ a: S().bingo?.active, w: S().bingo?.winner }));
  check("bingo prompt is round prompt", S().episodePrompt?.prompt === "First?" && S().episodePrompt?.roundIndex === 0 && S().episodePrompt?.roundTotal === 2, JSON.stringify(S().episodePrompt));
  // startBingo reads the setup input headlessly via queryMap.
  queryMap["#bingo-word"] = { value: "HELLO" };
  await pk._store.rpc["producer-action"]({ fn: "startBingo", args: [] }, prod);
  check("live start rejects repeats", S().bingo?.active === false && S().bingo?.targetIndex === 0, JSON.stringify({ a: S().bingo?.active, t: S().bingo?.targetIndex }));
  queryMap["#bingo-word"] = { value: "GAMES" };
  await pk._store.rpc["producer-action"]({ fn: "startBingo", args: [] }, prod);
  check("start preserves seeded target", S().bingo?.active === true && S().bingo?.targetIndex === 0, JSON.stringify({ a: S().bingo?.active, t: S().bingo?.targetIndex }));
  await pk._store.rpc["producer-action"]({ fn: "setBingoTarget", args: [4] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "startBingo", args: [] }, prod);
  check("mid-game restart resets target", S().bingo?.targetIndex === -1, String(S().bingo?.targetIndex));
  // Reload to replay the collection flow below.
  await pk._store.rpc["producer-action"]({ fn: "episodeRunLoad", args: [0] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "startBingo", args: [] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "startBingoCycling", args: [] }, prod);
  // dev1's roster was shrunk to 1 slot by an earlier test, so its track key
  // collapses to the pid (same rule as getCoopScoreKey) — derive it live.
  const dev1Slots = (S().coopRosters?.dev1?.slots || []).length;
  const trackKey = COOP && dev1Slots > 1 ? "coop:dev1:0" : "dev1";
  const bz1 = await pk._store.rpc["bingo-buzz"]({ litIndex: 0, litSlot: 0, coopSlot: 0 }, dev1);
  check("collect first letter", bz1?.ok === true && (S().bingo?.playerItems?.[trackKey] || []).includes(0), JSON.stringify(bz1));
  await pk._store.rpc["producer-action"]({ fn: "episodeRunLetter", args: [1] }, prod);
  check("letter nav moves target", S().bingo?.targetIndex === 3, String(S().bingo?.targetIndex));
  check("letter nav switches prompt", S().episodePrompt?.prompt === "Second?" && S().episodePrompt?.roundIndex === 1, JSON.stringify(S().episodePrompt));
  check("letter nav keeps collection", (S().bingo?.playerItems?.[trackKey] || []).includes(0), JSON.stringify(S().bingo?.playerItems?.[trackKey]));
  check("letter nav clears per-target scores", Object.keys(S().bingo?.scoredTracks || {}).length === 0, JSON.stringify(S().bingo?.scoredTracks));
  await pk._store.rpc["producer-action"]({ fn: "episodeRunLetter", args: [1] }, prod);
  check("letter nav stops at end", S().bingo?.targetIndex === 3 && S().episodePrompt?.roundIndex === 1, JSON.stringify({ t: S().bingo?.targetIndex }));
  await pk._store.rpc["bingo-buzz"]({ litIndex: 3, litSlot: 0, coopSlot: 0 }, dev1);
  check("collect second letter", (S().bingo?.playerItems?.[trackKey] || []).join(",") === "0,3", JSON.stringify(S().bingo?.playerItems?.[trackKey]));
  // Audience view: pk-stub hardcodes isHost=true, so bingo-mode *player*
  // screens always render the host panel headlessly — assert the banner on
  // the display client instead (same component, no isHost involvement).
  pk._store.self = pk._store.participants.disp1;
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
  await sleep(600);
  check("banner shows letter position", _mount.innerHTML.includes("Second?") && _mount.innerHTML.includes("Letter 2 of 2"), "position missing");
  pk._store.self = pk._store.participants.host1;
  await pk._store.rpc["producer-action"]({ fn: "episodeRunLetter", args: [-1] }, prod);
  check("letter nav steps back", S().bingo?.targetIndex === 0 && S().episodePrompt?.prompt === "First?", JSON.stringify({ t: S().bingo?.targetIndex, p: S().episodePrompt?.prompt }));
  await pk._store.rpc["producer-action"]({ fn: "endBingo", args: [] }, prod);
  delete queryMap["#bingo-word"];
  await pk._store.rpc["producer-action"]({ fn: "resetRound", args: [] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "episodeRunLoad", args: [1] }, prod);
  check("wen load seeds target", S().bingo?.targetIndex === 1 && S().bingo?.items?.join(",") === "Before,Never,After", JSON.stringify({ t: S().bingo?.targetIndex, i: S().bingo?.items }));
  await pk._store.rpc["producer-action"]({ fn: "startBingo", args: [] }, prod);
  check("wen start keeps target", S().bingo?.active === true && S().bingo?.targetIndex === 1, String(S().bingo?.targetIndex));
  await pk._store.rpc["producer-action"]({ fn: "endBingo", args: [] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "episodeRunEnd", args: [] }, prod);
  pk._store.self = pk._store.participants.host1;
}
// --- episode setting locks: refuse managed, allow the rest, relock, unlock ---
{
  const lockEp = {
    schemaVersion: 1,
    meta: { title: "Lock Ep" },
    defaults: { scoringMode: "uniform", uniformPoints: 600, timeOpen: 22, lockAfterBuzz: true },
    items: [
      { id: "k1", kind: "buttons", prompt: "Q1?", optionCount: 4, correctOptions: [1], overrides: { uniformPoints: 650 } },
      { id: "k2", kind: "text", prompt: "Q2?", correctAnswer: "A" },
    ],
  };
  pk._store.self = pk._store.participants.host1;
  await pk._store.rpc["producer-action"]({ fn: "attachEpisode", args: [lockEp] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "resetRound", args: [] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "episodeRunLoad", args: [0] }, prod);
  check("load applies override points", S().settings?.uniformPoints === 650, String(S().settings?.uniformPoints));
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["uniformPoints", 999] }, prod);
  check("locked points refused", S().settings?.uniformPoints === 650, String(S().settings?.uniformPoints));
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["timeOpen", 99] }, prod);
  check("locked buzz time refused", S().settings?.timeOpen === 22, String(S().settings?.timeOpen));
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["lockAfterBuzz", false] }, prod);
  check("locked toggle refused", S().settings?.lockAfterBuzz === true, String(S().settings?.lockAfterBuzz));
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["choiceLayout", "grid"] }, prod);
  check("unlocked setting allowed", S().settings?.choiceLayout === "grid", String(S().settings?.choiceLayout));
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["choiceLayout", "diamond"] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
  {
    const html = _mount.innerHTML;
    check("runner shows lock note", html.includes("Locked by episode") && html.includes("Points"), "lock note missing");
    check("locked select disabled", /data-setting="uniformPoints"\s+disabled/.test(html), "points select enabled");
    check("locked input disabled", /data-setting="timeOpen"\s+disabled/.test(html), "time input enabled");
    check("locked toggle disabled", /data-toggle-setting="lockAfterBuzz"[^>]*disabled/.test(html), "lock toggle enabled");
    check("unlocked select enabled", !/data-setting="choiceLayout"\s+disabled/.test(html), "layout select disabled");
  }
  await pk._store.rpc["producer-action"]({ fn: "episodeRunStep", args: [1] }, prod);
  check("step falls back to default points", S().settings?.uniformPoints === 600, String(S().settings?.uniformPoints));
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["uniformPoints", 999] }, prod);
  check("default-managed stays locked", S().settings?.uniformPoints === 600, String(S().settings?.uniformPoints));
  await pk._store.rpc["producer-action"]({ fn: "episodeRunEnd", args: [] }, prod);
  await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["uniformPoints", 999] }, prod);
  check("end unlocks settings", S().settings?.uniformPoints === 999, String(S().settings?.uniformPoints));
  pk._store.self = pk._store.participants.host1;
}
// --- episode cloud: API server + client over real HTTP (in-memory store) ---
{
  const epApi = await import("../src/episodes/api.js");
  const epServer = await import("../server/index.js");
  check("cloud disabled when unconfigured", (await epApi.isEpisodeCloudEnabled()) === false, "cloud on without server");
  check("diagnosis reports unconfigured", (() => { const d = epApi.episodeCloudDiagnosis(); return d.url === "" && d.ok === false; })(), JSON.stringify(epApi.episodeCloudDiagnosis()));
  const hash = await epServer.hashOwnerPassword("secret-1");
  check("owner hash verifies", (await epServer.verifyOwnerPassword("secret-1", hash)) === true, "verify failed");
  check("owner hash rejects wrong", (await epServer.verifyOwnerPassword("nope", hash)) === false, "verify passed wrong password");
  check("share code shape", /^[A-Z2-9]{6}$/.test(epServer.makeShareCode()), epServer.makeShareCode());
  const mem = new Map();
  const fakeStore = {
    async findOne({ code }) { return mem.get(code) || null; },
    async insertOne(doc) {
      if (mem.has(doc.code)) { const e = new Error("duplicate key"); e.code = 11000; throw e; }
      mem.set(doc.code, { ...doc });
      return { insertedId: doc.code };
    },
    async updateOne({ code }, { $set }) {
      const cur = mem.get(code);
      if (cur) mem.set(code, { ...cur, ...$set });
      return { modifiedCount: cur ? 1 : 0 };
    },
  };
  const srv = await new Promise((resolve) => {
    const s = epServer.createApp(fakeStore).listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  epApi.configureEpisodeApiUrl(base);
  let rateLimitCode = null;
  let rateLimitEp = null;
  try {
    check("cloud enabled with server", (await epApi.isEpisodeCloudEnabled()) === true, "health check failed");
    check("diagnosis reports reachable", (() => { const d = epApi.episodeCloudDiagnosis(); return d.url === base && d.ok === true; })(), JSON.stringify(epApi.episodeCloudDiagnosis()));
    const cloudEp = {
      schemaVersion: 1,
      meta: { title: "Cloud Ep" },
      defaults: {},
      items: [{ id: "c1", kind: "text", prompt: "Q?", correctAnswer: "A" }],
    };
    const saved = await epApi.saveEpisode(cloudEp, "secret-1");
    rateLimitCode = saved.code;
    rateLimitEp = cloudEp;
    check("save mints code", /^[A-Z2-9]{6}$/.test(saved.code), JSON.stringify(saved));
    let threw = null;
    try { await epApi.saveEpisode({ schemaVersion: 1, meta: {}, defaults: {}, items: [] }, "secret-1"); } catch (e) { threw = e; }
    check("save rejects invalid episode", threw?.status === 400, String(threw?.status));
    threw = null;
    try { await epApi.saveEpisode(cloudEp, "x"); } catch (e) { threw = e; }
    check("save rejects short password", threw?.status === 400, String(threw?.status));
    const loaded = await epApi.loadEpisode(saved.code.toLowerCase());
    check("load returns copy", loaded.episode?.meta?.title === "Cloud Ep" && loaded.episode?.items?.length === 1, JSON.stringify(loaded.episode?.meta));
    threw = null;
    try { await epApi.loadEpisode("ZZZZZZ"); } catch (e) { threw = e; }
    check("load 404s unknown code", threw?.status === 404, String(threw?.status));
    const raw = await (await fetch(`${base}/api/episodes/${saved.code}`)).json();
    check("hash never leaks", raw && !("ownerHash" in raw), Object.keys(raw || {}).join(","));
    threw = null;
    try { await epApi.overwriteEpisode(saved.code, "wrong", { ...cloudEp, meta: { title: "Hijacked" } }); } catch (e) { threw = e; }
    check("overwrite rejects wrong password", threw?.status === 401, String(threw?.status));
    const still = await epApi.loadEpisode(saved.code);
    check("failed overwrite keeps original", still.episode?.meta?.title === "Cloud Ep", JSON.stringify(still.episode?.meta));
    const over = await epApi.overwriteEpisode(saved.code, "secret-1", { ...cloudEp, meta: { title: "Cloud Ep v2" } });
    check("overwrite keeps code", over.code === saved.code, JSON.stringify(over));
    const after = await epApi.loadEpisode(saved.code);
    check("overwrite applies", after.episode?.meta?.title === "Cloud Ep v2", JSON.stringify(after.episode?.meta));
  } finally {
    epApi.configureEpisodeApiUrl("");
    await new Promise((resolve) => srv.close(resolve));
  }
  // Rate limits: tiny buckets prove the wiring without hammering hundreds
  // of requests. Separate apps so the general bucket doesn't trip the
  // overwrite test (every /api/ request counts toward general).
  const generalSrv = await new Promise((resolve) => {
    const s = epServer
      .createApp(fakeStore, { limits: { general: { windowMs: 60000, max: 5 } } })
      .listen(0, "127.0.0.1", () => resolve(s));
  });
  const generalBase = `http://127.0.0.1:${generalSrv.address().port}`;
  try {
    // CORS must work or no browser (vite dev, PWA, static host) can use the API.
    const corsRes = await fetch(`${generalBase}/api/health`);
    check("cors header on GET", corsRes.headers.get("access-control-allow-origin") === "*", "ACAO missing");
    const preflight = await fetch(`${generalBase}/api/episodes`, { method: "OPTIONS" });
    check("preflight handled", preflight.status === 204 && preflight.headers.get("access-control-allow-methods")?.includes("PUT"), `${preflight.status}`);
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await fetch(`${generalBase}/api/health`)).status);
    }
    check("general limit trips", JSON.stringify(statuses) === "[200,200,200,200]", JSON.stringify(statuses));
    const limitedRes = await fetch(`${generalBase}/api/health`);
    const limitedBody = await limitedRes.json().catch(() => ({}));
    check("limited response shape", limitedRes.status === 429 && limitedBody.ok === false && typeof limitedBody.reason === "string", `${limitedRes.status} ${JSON.stringify(limitedBody)}`);
    check("retry-after header", limitedRes.headers.get("retry-after") !== null, "no Retry-After");
  } finally {
    await new Promise((resolve) => generalSrv.close(resolve));
  }
  const guessSrv = await new Promise((resolve) => {
    const s = epServer
      .createApp(fakeStore, { limits: { general: { windowMs: 60000, max: 1000 }, overwrite: { windowMs: 60000, max: 2 } } })
      .listen(0, "127.0.0.1", () => resolve(s));
  });
  const guessBase = `http://127.0.0.1:${guessSrv.address().port}`;
  try {
    // Overwrite bucket is per IP+code and runs before auth: two bad guesses
    // 401, the third 429s without ever reaching scrypt.
    const putStatuses = [];
    for (let i = 0; i < 3; i++) {
      putStatuses.push(
        (await fetch(`${guessBase}/api/episodes/${rateLimitCode}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ episode: rateLimitEp, ownerPassword: "wrong" }),
        })).status,
      );
    }
    check("overwrite guesses limited", JSON.stringify(putStatuses) === "[401,401,429]", JSON.stringify(putStatuses));
  } finally {
    await new Promise((resolve) => guessSrv.close(resolve));
  }
  // Vercel serverless handlers (api/): same core over mock req/res, backed
  // by the same in-memory store via the __EPISODE_TEST_STORE__ seam.
  const mockRes = () => ({
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v); return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  });
  const mockReq = ({ method = "GET", query = {}, body = {}, headers = {} } = {}) => ({
    method, query, body, headers, socket: { remoteAddress: "127.0.0.1" },
  });
  globalThis.__EPISODE_TEST_STORE__ = fakeStore;
  try {
    const healthFn = (await import("../api/health.js")).default;
    const saveFn = (await import("../api/episodes/index.js")).default;
    const codeFn = (await import("../api/episodes/[code].js")).default;
    const vercel = await import("../server/vercel.js");
    let res = mockRes();
    await healthFn(mockReq({ method: "GET" }), res);
    check("fn health ok", res.statusCode === 200 && res.body?.ok === true, String(res.statusCode));
    res = mockRes();
    await healthFn(mockReq({ method: "POST" }), res);
    check("fn health rejects POST", res.statusCode === 405, String(res.statusCode));
    check("fn ip prefers forwarded", vercel.vercelIp(mockReq({ headers: { "x-forwarded-for": "9.9.9.9, 1.1.1.1" } })) === "9.9.9.9", "xff ignored");
    const fnEp = {
      schemaVersion: 1, meta: { title: "Fn Ep" }, defaults: {},
      items: [{ id: "f1", kind: "text", prompt: "Q?", correctAnswer: "A" }],
    };
    res = mockRes();
    await saveFn(mockReq({ method: "POST", body: { episode: fnEp, ownerPassword: "pw-for-fn" } }), res);
    check("fn save mints", res.statusCode === 201 && /^[A-Z2-9]{6}$/.test(res.body?.code), `${res.statusCode} ${JSON.stringify(res.body)}`);
    const fnCode = res.body?.code;
    res = mockRes();
    await saveFn(mockReq({ method: "POST", body: { episode: { schemaVersion: 1 }, ownerPassword: "pw-for-fn" } }), res);
    check("fn save validates", res.statusCode === 400, String(res.statusCode));
    res = mockRes();
    await codeFn(mockReq({ method: "GET", query: { code: fnCode.toLowerCase() } }), res);
    check("fn load ok", res.statusCode === 200 && res.body?.episode?.meta?.title === "Fn Ep" && !("ownerHash" in res.body), `${res.statusCode}`);
    res = mockRes();
    await codeFn(mockReq({ method: "GET", query: { code: "ZZZZZZ" } }), res);
    check("fn load 404s", res.statusCode === 404, String(res.statusCode));
    res = mockRes();
    await codeFn(mockReq({ method: "PUT", query: { code: fnCode }, body: { episode: fnEp, ownerPassword: "wrong" } }), res);
    check("fn overwrite auth", res.statusCode === 401, String(res.statusCode));
    res = mockRes();
    await codeFn(mockReq({ method: "PUT", query: { code: fnCode }, body: { episode: { ...fnEp, meta: { title: "Fn Ep v2" } }, ownerPassword: "pw-for-fn" } }), res);
    check("fn overwrite ok", res.statusCode === 200 && res.body?.code === fnCode, `${res.statusCode}`);
    res = mockRes();
    await codeFn(mockReq({ method: "GET", query: { code: fnCode } }), res);
    check("fn overwrite applied", res.body?.episode?.meta?.title === "Fn Ep v2", JSON.stringify(res.body?.episode?.meta));
    res = mockRes();
    await codeFn(mockReq({ method: "DELETE", query: { code: fnCode } }), res);
    check("fn rejects DELETE", res.statusCode === 405, String(res.statusCode));
  } finally {
    globalThis.__EPISODE_TEST_STORE__ = null;
  }
  check("cloud disabled after reset", (await epApi.isEpisodeCloudEnabled()) === false, "override stuck");
  epApi.configureEpisodeApiUrl("http://127.0.0.1:1");
  check("dead server disables", (await epApi.isEpisodeCloudEnabled(true)) === false, "dead server enabled");
  check("diagnosis reports unreachable", (() => { const d = epApi.episodeCloudDiagnosis(); return d.url === "http://127.0.0.1:1" && d.ok === false && d.error !== ""; })(), JSON.stringify(epApi.episodeCloudDiagnosis()));
  epApi.configureEpisodeApiUrl("");
}
// --- episode creator opens pre-launch (regression: helpers must be
// top-level scope — a nested-in-bindEvents helper broke this silently) ---
{
  const firePrejoin = async (selector, dataset = {}) => {
    const t = { dataset, closest: (s) => (s === selector ? t : null) };
    for (const fn of mount._listeners.click || []) await fn({ target: t, preventDefault() {} });
    await sleep(600);
  };
  const handlerErrors = [];
  const origWarn2 = console.warn;
  console.warn = (...a) => {
    const s = a.map(String).join(" ");
    if (s.includes("delegated handler failed")) handlerErrors.push(s);
    origWarn2(...a);
  };
  try {
    await firePrejoin("[data-prejoin-open]", { prejoinOpen: "creator" });
    check("creator opens from landing", _mount.innerHTML.includes("ep-panel") && _mount.innerHTML.includes("data-ep-add"), "creator panel missing");
    await firePrejoin("[data-ep-add]");
    check("creator add works headless", _mount.innerHTML.includes('id="ep-prompt"'), "edit form missing after add");
    await firePrejoin("[data-ep-close-edit]");
    check("creator close works headless", !_mount.innerHTML.includes('id="ep-prompt"'), "edit form stuck open");
    check("no creator handler errors", handlerErrors.length === 0, handlerErrors.join(" || ").slice(0, 300));
  } finally {
    console.warn = origWarn2;
  }
}
// --- episode checkbox gate on the host prejoin form ---
{
  const fireClick = async (selector, dataset = {}) => {
    const t = { dataset, closest: (s) => (s === selector ? t : null) };
    for (const fn of mount._listeners.click || []) await fn({ target: t, preventDefault() {} });
    await sleep(200);
  };
  const fireSubmitHost = async () => {
    const fakeHost = {
      dataset: { prejoinForm: "host" },
      closest: (s) => (s === "[data-prejoin-form]" ? fakeHost : null),
      querySelector: () => ({ disabled: false }),
    };
    for (const fn of mount._listeners.submit || []) await fn({ preventDefault() {}, target: fakeHost });
    await sleep(700);
  };
  queryMap["#prejoin-name"] = { value: "Host" };
  queryMap["#prejoin-team-mode"] = { value: "off" };
  queryMap["#prejoin-coop"] = { checked: false };
  // Checked with nothing attached (pendingEpisode starts null) → error, no attach.
  queryMap["#prejoin-episode"] = { checked: true };
  await fireSubmitHost();
  check("episode box without attach errors", _mount.innerHTML.includes("Attach an episode"), "gate missing");
  check("failed gate attaches nothing", S().episodePrompt === null, JSON.stringify(S().episodePrompt));
  // Unchecked → success path, still nothing attached.
  queryMap["#prejoin-episode"] = { checked: false };
  await fireSubmitHost();
  check("unchecked box attaches nothing", S().episodePrompt === null, JSON.stringify(S().episodePrompt));
  // Full path: save to cloud → load by code on the host form → submit →
  // hostTick consumes the attach and seeds lobby defaults.
  const epApi2 = await import("../src/episodes/api.js");
  const epServer2 = await import("../server/index.js");
  const lobbyMem = new Map();
  const lobbyStore = {
    async findOne({ code }) { return lobbyMem.get(code) || null; },
    async insertOne(doc) {
      if (lobbyMem.has(doc.code)) { const e = new Error("duplicate key"); e.code = 11000; throw e; }
      lobbyMem.set(doc.code, { ...doc });
      return { insertedId: doc.code };
    },
    async updateOne({ code }, { $set }) {
      const cur = lobbyMem.get(code);
      if (cur) lobbyMem.set(code, { ...cur, ...$set });
      return { modifiedCount: cur ? 1 : 0 };
    },
  };
  const lobbySrv = await new Promise((resolve) => {
    const s = epServer2.createApp(lobbyStore).listen(0, "127.0.0.1", () => resolve(s));
  });
  epApi2.configureEpisodeApiUrl(`http://127.0.0.1:${lobbySrv.address().port}`);
  try {
    const lobbyEp = {
      schemaVersion: 1,
      meta: { title: "Lobby Path Ep" },
      defaults: { scoringMode: "uniform", uniformPoints: 1750 },
      items: [{ id: "l1", kind: "text", prompt: "Q?", correctAnswer: "A" }],
    };
    const savedLobby = await epApi2.saveEpisode(lobbyEp, "lobby-pw");
    // Entering creator runs the probe, which enables the cloud row.
    const opener = { dataset: { prejoinOpen: "creator" }, closest: (s) => (s === "[data-prejoin-open]" ? opener : null) };
    for (const fn of mount._listeners.click || []) await fn({ target: opener, preventDefault() {} });
    await sleep(700);
    queryMap["#ep-attach-code"] = { value: savedLobby.code };
    await fireClick("[data-ep-attach-cloud]");
    queryMap["#prejoin-episode"] = { checked: true };
    await fireSubmitHost();
    check("cloud-attached episode passes gate", !_mount.innerHTML.includes("Attach an episode"), "gate blocked a valid attach");
    await sleep(1600);
    check("lobby seeded cloud defaults", S().settings?.uniformPoints === 1750, String(S().settings?.uniformPoints));
  } finally {
    epApi2.configureEpisodeApiUrl("");
    queryMap["#prejoin-episode"] = { checked: false };
    delete queryMap["#ep-attach-code"];
    await new Promise((resolve) => lobbySrv.close(resolve));
  }
}
// --- host form renders the episode checkbox + cloud retry ---
{
  // Empty name forces the validation-error render of the host form.
  queryMap["#prejoin-name"] = { value: "" };
  const badName = {
    dataset: { prejoinForm: "host" },
    closest: (s) => (s === "[data-prejoin-form]" ? badName : null),
    querySelector: () => ({ disabled: false }),
  };
  for (const fn of mount._listeners.submit || []) await fn({ preventDefault() {}, target: badName });
  await sleep(700);
  check("host form has episode checkbox", _mount.innerHTML.includes('id="prejoin-episode"'), "checkbox missing");
  check("host form hides picker hook", _mount.innerHTML.includes("ep-attach-options"), "options block missing");
  queryMap["#prejoin-name"] = { value: "Host" };
  // Force the cloud state back to disabled (a prior test's probe enabled it),
  // then re-render the form: the retry affordance must appear.
  const retry = { dataset: {}, closest: (s) => (s === "[data-ep-attach-cloud-retry]" ? retry : null) };
  for (const fn of mount._listeners.click || []) await fn({ target: retry, preventDefault() {} });
  await sleep(300);
  queryMap["#prejoin-name"] = { value: "" };
  for (const fn of mount._listeners.submit || []) await fn({ preventDefault() {}, target: badName });
  await sleep(700);
  check("host form has cloud retry", _mount.innerHTML.includes("data-ep-attach-cloud-retry"), "retry missing");
  check("cloud retry re-renders hint", _mount.innerHTML.includes("Cloud codes need the episode server"), "hint text missing");
  queryMap["#prejoin-name"] = { value: "Host" };
}
pk._store.self = pk._store.participants.host1;
pk._store.self = pk._store.participants.host1;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
