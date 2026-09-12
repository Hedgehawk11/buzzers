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
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
check("round open", S().round?.status === "open", S().round?.status);

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
}

// --- bingo quick-ruling NaN path (slot key in coop, pid off-coop) ---
queryMap["#bingo-word"] = { value: "HELLO" };
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
// preset button state: no preset + no lock => open disabled (coop-only gate)
await pk._store.rpc["producer-action"]({ fn: "toggleCorrectOption", args: [1] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, prod);
if (COOP) {
  check("open disabled without preset", mount.innerHTML.includes('data-host-action="open" disabled'), "open button enabled");
} else {
  check("open allowed without preset off-coop", !mount.innerHTML.includes('data-host-action="open" disabled'), "open button disabled");
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
// --- regression: roulette roster frozen at phase start ---
await pk._store.rpc["producer-action"]({ fn: "openBuzzers", args: [] }, prod);
await pk._store.rpc["producer-action"]({ fn: "setHostSetting", args: ["valueSelectionMethod", "roulette"] }, prod);
await pk._store.rpc["producer-action"]({ fn: "startRoulettePhase", args: [] }, prod);
check("roulette starts", S().round?.status === "roulette", S().round?.status);
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
pk._store.self = pk._store.participants.host1;
pk._store.self = pk._store.participants.host1;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
