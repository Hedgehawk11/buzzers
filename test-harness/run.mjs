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

// --- boot as host ---
pk._store.self = pk.makePlayer("host1", "Host");
pk._store.participants = { host1: pk._store.self };
await import("/home/hedgehawk11/Documents/GitHub/buzzers/src/main.js");

// --- submit host prejoin form (coop checked) ---
queryMap["#prejoin-name"] = { value: "Host" };
queryMap["#prejoin-team-mode"] = { value: "off" };
queryMap["#prejoin-coop"] = { checked: true };
const fakeForm = {
  dataset: { prejoinForm: "host" },
  closest: (sel) => (sel === "[data-prejoin-form]" ? fakeForm : null),
  querySelector: () => ({ disabled: false }),
};
for (const fn of mount._listeners.submit || []) {
  await fn({ preventDefault() {}, target: fakeForm });
}
await sleep(50);
check("coop enabled from prejoin", S().settings?.coopertitionEnabled === true, JSON.stringify(S().settings?.coopertitionEnabled));

// --- add device, set roster ---
const dev1 = pk.makePlayer("dev1", "GroupA");
pk._store.participants.dev1 = dev1;
let res = await pk._store.rpc["coop-roster"](
  { group: "GroupA", count: 2, names: ["Ann", "Bob"] },
  dev1,
);
check("roster ok", res?.ok === true, JSON.stringify(res));
check(
  "roster stored",
  JSON.stringify(S().coopRosters?.dev1) === JSON.stringify({ group: "GroupA", slots: ["Ann", "Bob"] }),
  JSON.stringify(S().coopRosters?.dev1),
);

// --- lock-after-buzz on, open ---
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["lockAfterBuzz", true] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
check("round open", S().round?.status === "open", S().round?.status);

// --- buzz-in then answer ---
let r = await pk._store.rpc.buzz({ coopSlot: 0, buzzIn: true }, dev1);
check("buzz-in ok", r?.ok === true, JSON.stringify(r));
check("control set", S().round?.coopControl === "coop:dev1:0", S().round?.coopControl);
r = await pk._store.rpc.buzz({ option: 3 }, dev1);
check("option pick ok", r?.ok === true, JSON.stringify(r));
const entryId = S().pendingLogId;
check("locked with pending entry", S().round?.status === "locked" && !!entryId, `${S().round?.status} ${entryId}`);
const entry = S().gameLog.find((e) => e.id === entryId);
check("entry keyed to slot", entry?.scoreKey === "coop:dev1:0", JSON.stringify(entry?.scoreKey));

// --- THE DEDUCTION TEST ---
await pk._store.rpc["cohost-action"]({ fn: "updateScoresForLogEntry", args: [entryId, -1000] }, dev1);
check("minus 1000 deducted", S().scores?.["coop:dev1:0"] === -1000, JSON.stringify(S().scores));

// --- correct ruling on fresh round + sibling lock, other groups free ---
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
await pk._store.rpc.buzz({ coopSlot: 1, buzzIn: true }, dev1);
await pk._store.rpc.buzz({ option: 2 }, dev1);
const entryId2 = S().pendingLogId;
await pk._store.rpc["cohost-action"]({ fn: "updateScoresForLogEntry", args: [entryId2, 1000] }, dev1);
check("plus 1000 awarded", S().scores?.["coop:dev1:1"] === 1000, JSON.stringify(S().scores));
check(
  "sibling locked out",
  (S().round?.buzzedPlayerIds || []).includes("coop:dev1:0"),
  JSON.stringify(S().round?.buzzedPlayerIds),
);
const dev2 = pk.makePlayer("dev2", "GroupB");
pk._store.participants.dev2 = dev2;
await pk._store.rpc["coop-roster"]({ group: "GroupB", count: 1, names: [] }, dev2);
pk._store.nextSender = dev2;
const rOther = await pk._store.rpc.buzz({ option: 1 }, dev2);
pk._store.nextSender = null;
check("other group can still buzz", rOther?.ok === true, JSON.stringify(rOther));

// --- bingo quick-ruling NaN path ---
queryMap["#bingo-word"] = { value: "HELLO" };
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["inputMode", "bingo"] }, dev1);
check("bingo mode on", S().settings?.inputMode === "bingo", S().settings?.inputMode);
await pk._store.rpc["cohost-action"]({ fn: "startBingo", args: [] }, dev1);
check("bingo active", S().bingo?.active === true, JSON.stringify(S().bingo?.active));
await pk._store.rpc["cohost-action"]({ fn: "setBingoTarget", args: [2] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "startBingoCycling", args: [] }, dev1);
const bz = await pk._store.rpc["bingo-buzz"]({ litIndex: 2, litSlot: 0, coopSlot: 0 }, dev1);
check("bingo correct buzz", bz?.ok === true, JSON.stringify(bz));
const bingoEntry = S().gameLog.filter((e) => e.type === "bingo").pop();
const before = S().scores?.["coop:dev1:0"];
await pk._store.rpc["cohost-action"](
  { fn: "updateScoresForLogEntry", args: [bingoEntry.id, -500] },
  dev1,
);
const after = S().scores?.["coop:dev1:0"];
check("bingo re-ruling finite", Number.isFinite(after), `before=${before} after=${after}`);
check("bingo minus applied", after === before - 1000, `before=${before} after=${after}`);

// --- no-lock open round: wrong answer deducts, round stays open ---
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["lockAfterBuzz", false] }, dev1);
await pk._store.rpc["cohost-action"](
  { fn: "setHostSetting", args: ["correctOptions", undefined] },
  dev1,
);
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
check("open needs preset without lock", S().round?.status !== "open", S().round?.status);
// set preset via round state path: use correctOptions through toggleCorrectOption
await pk._store.rpc["cohost-action"]({ fn: "toggleCorrectOption", args: [1] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
check("open with preset", S().round?.status === "open", S().round?.status);
const dev3 = pk.makePlayer("dev3", "GroupC");
pk._store.participants.dev3 = dev3;
await pk._store.rpc["coop-roster"]({ group: "GroupC", count: 1, names: [] }, dev3);
await pk._store.rpc.buzz({ coopSlot: 0, buzzIn: true }, dev3);
await pk._store.rpc.buzz({ option: 2 }, dev3); // wrong vs preset 1
const openEntry = S().gameLog.filter((e) => e.type === "buzz").pop();
await pk._store.rpc["cohost-action"](
  { fn: "updateScoresForLogEntry", args: [openEntry.id, -1000] },
  dev1,
);
check("open-round wrong deducts", S().scores?.dev3 === -1000, JSON.stringify(S().scores));
check("open round stays open on wrong", S().round?.status === "open", S().round?.status);
// re-edit the same ruling: flip to +1000 then back to -1000
await pk._store.rpc["cohost-action"](
  { fn: "updateScoresForLogEntry", args: [openEntry.id, 1000] },
  dev1,
);
check("re-edit to plus", S().scores?.dev3 === 1000, JSON.stringify(S().scores?.dev3));
await pk._store.rpc["cohost-action"](
  { fn: "updateScoresForLogEntry", args: [openEntry.id, -1000] },
  dev1,
);
check("re-edit back to minus", S().scores?.dev3 === -1000, JSON.stringify(S().scores?.dev3));

// --- text mode deduction ---
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["inputMode", "text"] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["lockAfterBuzz", true] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
await pk._store.rpc.buzz({ answerText: "wrong answer", coopSlot: 0 }, dev3);
const textEntry = S().gameLog.filter((e) => e.type === "buzz").pop();
await pk._store.rpc["cohost-action"](
  { fn: "updateScoresForLogEntry", args: [textEntry.id, -1000] },
  dev1,
);
check("text wrong deducts", S().scores?.dev3 === -2000, JSON.stringify(S().scores?.dev3));

// --- rendered HTML viewpoints: host, player, audience ---
const { mount: _mount } = await import("./dom-stub.mjs");
warnings.length = 0;
// host view: trigger a render via a no-op-ish host call, assert score visible
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, dev1);
check(
  "host view shows deducted score",
  _mount.innerHTML.includes("-2000"),
  `html len=${_mount.innerHTML.length}`,
);
// player view: become dev1, trigger render via a text answer on fresh round
pk._store.self = dev1;
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
await pk._store.rpc.buzz({ answerText: "player view probe", coopSlot: 0 }, dev1);
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
// audience view: become a display client, open fresh round to trigger render
const disp = pk.makePlayer("disp1", "Audience Display", "display");
pk._store.participants.disp1 = disp;
pk._store.self = disp;
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
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
await pk._store.rpc["cohost-action"]({ fn: "toggleCorrectOption", args: [1] }, dev1);
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
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
await pk._store.rpc.buzz({ option: 2 }, dev3);
const qEntry = S().gameLog.filter((e) => e.type === "buzz").pop();
const beforeQ = S().scores?.dev3;
clickQuick({ logQuick: "minus", logId: qEntry.id });
check("quick-minus deducts", S().scores?.dev3 === beforeQ - 1000, `before=${beforeQ} after=${S().scores?.dev3}`);
// ruling card path on a fresh entry
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
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
await pk._store.rpc["cohost-action"]({ fn: "toggleCorrectOption", args: [2] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
await pk._store.rpc.buzz({ option: 1 }, dev2);
const autoWrong = S().gameLog.filter((e) => e.type === "buzz").pop();
check("auto-rule wrong deducts", S().scores?.dev2 === -1000, JSON.stringify(S().scores?.dev2));
check("auto-rule wrong resolved", autoWrong?.awardedDelta === -1000, JSON.stringify(autoWrong?.awardedDelta));
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
await pk._store.rpc.buzz({ option: 2 }, dev2);
const autoRight = S().gameLog.filter((e) => e.type === "buzz").pop();
check("auto-rule correct awards", S().scores?.dev2 === 0, JSON.stringify(S().scores?.dev2));
check("auto-rule correct resolved", autoRight?.awardedDelta === 1000, JSON.stringify(autoRight?.awardedDelta));
await pk._store.rpc["cohost-action"]({ fn: "toggleCorrectOption", args: [2] }, dev1);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

// --- NON-COOP free-for-all: buzz -> minus ruling deducts ---
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", false] }, dev1);
check("coop off", S().settings?.coopertitionEnabled === false, JSON.stringify(S().settings?.coopertitionEnabled));
const plain = pk.makePlayer("plain1", "Solo");
pk._store.participants.plain1 = plain;
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
const rb = await pk._store.rpc.buzz({ option: 2 }, plain);
check("plain buzz ok", rb?.ok === true, JSON.stringify(rb));
const pEntry = S().gameLog.filter((e) => e.type === "buzz").pop();
const pBefore = S().scores?.plain1 || 0;
clickQuick({ logQuick: "minus", logId: pEntry.id });
check("non-coop quick-minus deducts", S().scores?.plain1 === pBefore - 1000, `before=${pBefore} after=${S().scores?.plain1}`);

// --- screw fully banned in coop (player RPC rejected, host button hidden) ---
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", true] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
const screwRes = await pk._store.rpc.screw({ screweeId: null }, dev1);
check("screw RPC rejected in coop", screwRes?.ok === false, JSON.stringify(screwRes));
check("no screw activated", S().round?.screw?.active !== true, JSON.stringify(S().round?.screw?.active));
check("host screw button hidden in coop", !mount.innerHTML.includes("Screw a Player"), "button present");

// --- fibbage RPCs rejected in coop ---
const lieRes = await pk._store.rpc["fibbage-lie"]({ lieText: "x" }, dev1);
const voteRes = await pk._store.rpc["fibbage-vote"]({ choiceIdx: 0 }, dev1);
check("fibbage lie rejected in coop", lieRes?.ok === false, JSON.stringify(lieRes));
check("fibbage vote rejected in coop", voteRes?.ok === false, JSON.stringify(voteRes));

// --- roster grow/shrink accounting: no orphans, no jumps ---
const dev4 = pk.makePlayer("dev4", "GroupD");
pk._store.participants.dev4 = dev4;
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["coopAllowEdit", true] }, dev1);
await pk._store.rpc["coop-roster"]({ group: "GroupD", count: 1, names: [] }, dev4);
await pk._store.rpc.buzz({ option: 1 }, dev4);
const d4e = S().gameLog.filter((e) => e.type === "buzz").pop();
await pk._store.rpc["cohost-action"]({ fn: "updateScoresForLogEntry", args: [d4e.id, 500] }, dev1);
check("1-slot earns on pid", S().scores?.dev4 === 500, JSON.stringify(S().scores?.dev4));
await pk._store.rpc["coop-roster"]({ group: "GroupD", count: 3, names: ["D1", "D2", "D3"] }, dev4);
check("grow folds pid into slot0", S().scores?.["coop:dev4:0"] === 500, JSON.stringify(S().scores));
check("grow clears pid", S().scores?.dev4 === undefined, JSON.stringify(S().scores?.dev4));
await pk._store.rpc["coop-roster"]({ group: "GroupD", count: 1, names: [] }, dev4);
check("shrink restores pid", S().scores?.dev4 === 500, JSON.stringify(S().scores?.dev4));
check("shrink clears stale slot0", S().scores?.["coop:dev4:0"] === undefined, JSON.stringify(S().scores?.["coop:dev4:0"]));

// --- disordat all-play auto-finalizes in coop ---
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["inputMode", "disordat"] }, dev1);
for (let q = 0; q < 7; q++) {
  clickBtn({ q: String(q), answer: ["dis", "dat", "dis", "dat", "dis", "dat", "dis"][q] }, "[data-disordat-answer-chip]");
}
clickBtn({ disordatStart: "allPlayTimed" }, "[data-disordat-start]");
check("disordat all-play started", S().disordat?.active === true && S().disordat?.mode === "allPlayTimed", S().disordat?.mode);
const ddBefore = S().scores?.["coop:dev1:0"] || 0;
const slotPlan = [[dev1, 0], [dev1, 1], [dev2, 0], [dev3, 0], [dev4, 0], [plain, 0]];
for (const [p, slot] of slotPlan) {
  for (let q = 0; q < 7; q++) {
    if (S().disordat?.phase !== "playing") break;
    await pk._store.rpc["disordat-answer"]({ q, answer: S().disordat.answers[q], coopSlot: slot }, p);
  }
}
check("disordat auto-finalized", S().disordat?.phase === "results", S().disordat?.phase);
check(
  "disordat credited to slot",
  (S().scores?.["coop:dev1:0"] || 0) - ddBefore >= 2100,
  `before=${ddBefore} after=${S().scores?.["coop:dev1:0"]}`,
);

// --- bingo host progress per-slot in coop ---
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["inputMode", "bingo"] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "startBingo", args: [] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "setBingoTarget", args: [1] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "startBingoCycling", args: [] }, dev1);
await pk._store.rpc["bingo-buzz"]({ litIndex: 1, litSlot: 0, coopSlot: 0 }, dev1);
check("host progress shows slot", mount.innerHTML.includes("Ann"), "slot name missing from host panel");

// --- Wen: correct scores, no collection, no winner ---
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["inputMode", "wendithapn"] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "startBingo", args: [] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "setBingoTarget", args: [0] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "startBingoCycling", args: [] }, dev1);
const d2Before = S().scores?.dev2 || 0;
const wenRes = await pk._store.rpc["bingo-buzz"]({ litIndex: 0, litSlot: 0 }, dev2);
check("wen correct buzz", wenRes?.ok === true, JSON.stringify(wenRes));
check("wen awards 500", (S().scores?.dev2 || 0) - d2Before === 500, JSON.stringify(S().scores?.dev2));
check("wen collects nothing", Object.keys(S().bingo?.playerItems || {}).length === 0, JSON.stringify(S().bingo?.playerItems));
await pk._store.rpc["cohost-action"]({ fn: "endBingo", args: [] }, dev1);

// --- moods: wrong holds until reset; correct self-clears ---
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
await pk._store.rpc.buzz({ option: 3 }, dev2);
const moodEntry = S().gameLog.filter((e) => e.type === "buzz").pop();
await pk._store.rpc["cohost-action"]({ fn: "updateScoresForLogEntry", args: [moodEntry.id, -1000] }, dev1);
check("wrong face set", S().coopMoods?.dev2 === "wrong", JSON.stringify(S().coopMoods));
await pk._store.rpc["cohost-action"]({ fn: "resetRound", args: [] }, dev1);
check("reset clears faces", JSON.stringify(S().coopMoods) === "{}" || S().coopMoods === undefined, JSON.stringify(S().coopMoods));
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
await pk._store.rpc.buzz({ option: 4 }, dev2);
const moodEntry2 = S().gameLog.filter((e) => e.type === "buzz").pop();
await pk._store.rpc["cohost-action"]({ fn: "updateScoresForLogEntry", args: [moodEntry2.id, 1000] }, dev1);
check("correct face set", S().coopMoods?.dev2 === "correct" || S().coopMoods?.["coop:dev2:0"] === "correct", JSON.stringify(S().coopMoods));
await sleep(1800);
check("correct face self-clears", !S().coopMoods?.dev2 && !S().coopMoods?.["coop:dev2:0"], JSON.stringify(S().coopMoods));

// --- control mismatch: other slots/devices rejected while held ---
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
await pk._store.rpc.buzz({ coopSlot: 0, buzzIn: true }, dev1);
const steal = await pk._store.rpc.buzz({ coopSlot: 0, buzzIn: true }, dev2);
check("control steal rejected", steal?.ok === false, JSON.stringify(steal));
const sibSteal = await pk._store.rpc.buzz({ coopSlot: 1, buzzIn: true }, dev1);
check("sibling steal rejected", sibSteal?.ok === false, JSON.stringify(sibSteal));
await pk._store.rpc.buzz({ option: 2 }, dev1);

// --- NaN ruling is a silent no-op, scores untouched ---
const nanEntry = S().gameLog.filter((e) => e.type === "buzz").pop();
const nanBefore = JSON.stringify(S().scores);
await pk._store.rpc["cohost-action"]({ fn: "updateScoresForLogEntry", args: [nanEntry.id, NaN] }, dev1);
check("NaN ruling no-op", JSON.stringify(S().scores) === nanBefore, `${nanBefore} -> ${JSON.stringify(S().scores)}`);
await pk._store.rpc["cohost-action"]({ fn: "updateScoresForLogEntry", args: [nanEntry.id, -500] }, dev1);

// --- disordat one-play: auto-pick highlighted, override works, gating ---
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["inputMode", "disordat"] }, dev1);
clickBtn({}, "[data-disordat-reset]");
for (let q = 0; q < 7; q++) {
  clickBtn({ q: String(q), answer: "dis" }, "[data-disordat-answer-chip]");
}
clickBtn({ disordatStart: "onePlayTimed" }, "[data-disordat-start]");
await sleep(20);
check("one-play pending pick", S().disordat?.pendingPick === true, JSON.stringify(S().disordat?.pendingPick));
check("last-place auto-pick shown", mount.innerHTML.includes("(last place)"), "auto tag missing");
clickBtn({ disordatPickPlayer: "dev2" }, "[data-disordat-pick-player]");
check("override pick honored", S().disordat?.activeCoopKey === "dev2", S().disordat?.activeCoopKey);
const ddWrongSlot = await pk._store.rpc["disordat-answer"]({ q: 0, answer: "dis", coopSlot: 0 }, dev1);
check("non-active slot rejected", ddWrongSlot?.ok === false, JSON.stringify(ddWrongSlot));
const ddRightSlot = await pk._store.rpc["disordat-answer"]({ q: 0, answer: "dis" }, dev2);
check("active slot answers", ddRightSlot?.ok === true, JSON.stringify(ddRightSlot));
clickBtn({}, "[data-disordat-reset]");

// --- disordat host-paced: claim then answer, others blocked ---
for (let q = 0; q < 7; q++) {
  clickBtn({ q: String(q), answer: "dat" }, "[data-disordat-answer-chip]");
}
clickBtn({ disordatStart: "allPlayHostPaced" }, "[data-disordat-start]");
const claimNoQ = await pk._store.rpc["disordat-claim"]({ q: 1, coopSlot: 0 }, dev1);
check("claim wrong question rejected", claimNoQ?.ok === false, JSON.stringify(claimNoQ));
const claimOk = await pk._store.rpc["disordat-claim"]({ q: 0, coopSlot: 0 }, dev1);
check("claim accepted", claimOk?.ok === true, JSON.stringify(claimOk));
const unclaimed = await pk._store.rpc["disordat-answer"]({ q: 0, answer: "dat", coopSlot: 1 }, dev1);
check("unclaimed slot rejected", unclaimed?.ok === false, JSON.stringify(unclaimed));
const claimed = await pk._store.rpc["disordat-answer"]({ q: 0, answer: "dat", coopSlot: 0 }, dev1);
check("claimant answers", claimed?.ok === true, JSON.stringify(claimed));
clickBtn({}, "[data-disordat-reset]");

// --- all-answered auto-close (no-lock + preset) ---
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["inputMode", "buttons"] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["lockAfterBuzz", false] }, dev1);
if (!(S().round?.correctOptions || []).includes(1)) {
  await pk._store.rpc["cohost-action"]({ fn: "toggleCorrectOption", args: [1] }, dev1);
}
await pk._store.rpc["cohost-action"]({ fn: "openBuzzers", args: [] }, dev1);
const allSlots = [[dev1, 0], [dev1, 1], [dev2, undefined], [dev3, undefined], [dev4, undefined], [plain, undefined]];
for (const [p, slot] of allSlots) {
  const payload = slot === undefined ? { option: 2 } : { coopSlot: slot, buzzIn: true };
  await pk._store.rpc.buzz(payload, p);
  if (slot !== undefined) await pk._store.rpc.buzz({ option: 2 }, p);
}
check("all answered auto-closes", S().round?.status === "closed", S().round?.status);
// preset button state: no preset + no lock => open disabled
await pk._store.rpc["cohost-action"]({ fn: "toggleCorrectOption", args: [1] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["snarkMode", "off"] }, dev1);
check("open disabled without preset", mount.innerHTML.includes('data-host-action="open" disabled'), "open button enabled");
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["lockAfterBuzz", true] }, dev1);

// --- disable migration folds back, re-enable restores ---
const d1Total = (S().scores?.["coop:dev1:0"] || 0) + (S().scores?.["coop:dev1:1"] || 0);
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", false] }, dev1);
check("disable folds to pid", S().scores?.dev1 === d1Total, `total=${d1Total} pid=${S().scores?.dev1}`);
check("disable clears coop keys", S().scores?.["coop:dev1:0"] === undefined, JSON.stringify(S().scores?.["coop:dev1:0"]));
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["coopertitionEnabled", true] }, dev1);
check("re-enable restores slot0", S().scores?.["coop:dev1:0"] === d1Total, JSON.stringify(S().scores?.["coop:dev1:0"]));

// --- removed slots stay dead: forged slot rejected (count>1), and on a
// 1-slot device a forged slot attributes to slot 0 without touching frozen keys ---
await pk._store.rpc["cohost-action"]({ fn: "setHostSetting", args: ["inputMode", "bingo"] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "startBingo", args: [] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "setBingoTarget", args: [0] }, dev1);
await pk._store.rpc["cohost-action"]({ fn: "startBingoCycling", args: [] }, dev1);
const forgedRange = await pk._store.rpc["bingo-buzz"]({ litIndex: 0, litSlot: 0, coopSlot: 5 }, dev1);
check("out-of-range slot rejected", forgedRange?.ok === false, JSON.stringify(forgedRange));
await pk._store.rpc["coop-roster"]({ group: "GroupA", count: 1, names: [] }, dev1);
const fBeforeFrozen = S().scores?.["coop:dev1:1"] || 0;
const fBeforePid = S().scores?.dev1 || 0;
const frozenBuzz = await pk._store.rpc["bingo-buzz"]({ litIndex: 0, litSlot: 0, coopSlot: 1 }, dev1);
check("forged slot attributes to slot0", frozenBuzz?.ok === true, JSON.stringify(frozenBuzz));
check("frozen key untouched", (S().scores?.["coop:dev1:1"] || 0) === fBeforeFrozen, `frozen=${S().scores?.["coop:dev1:1"]}`);
check("slot0 credited", (S().scores?.dev1 || 0) === fBeforePid + 500, `pid=${S().scores?.dev1}`);
process.exit(fail ? 1 : 0);
