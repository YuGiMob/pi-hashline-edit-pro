// jiti smoke test for the localized pi-hashline-edit-pro fork.
// Verifies: factory registers read/replace/undo_last_replace; read and
// replace renderResult produce line-numbered output for the TUI.
import { createJiti } from "/Users/hty/.pi/agent/npm/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent":
      "/Users/hty/.nvm/versions/node/v22.19.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
  },
});

const mod = await jiti.import(
  "/Users/hty/.pi/agent/extensions/pi-hashline-edit-pro/index.ts",
);
const factory = mod.default ?? mod;

const registered = new Map();
const fakePi = {
  on() {},
  events: { on() { return () => {}; } },
  getActiveTools: () => [],
  setActiveTools() {},
  registerTool(def) { registered.set(def.name, def); },
  registerCommand() {},
};

factory(fakePi);

const names = [...registered.keys()].sort();
console.log("registered tools:", names.join(", "));

const readDef = registered.get("read");
const replaceDef = registered.get("replace");
const undoDef = registered.get("undo_last_replace");

const ok = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok: ${msg}`);
};

ok(typeof readDef.renderResult === "function", "read has renderResult");
ok(typeof replaceDef.renderResult === "function", "replace has renderResult");
ok(typeof undoDef.renderResult === "function", "undo_last_replace has renderResult");

const theme = { fg: (_color, s) => s };
const stripAnsi = (s) => s;

// --- read renderResult with offset=5 ---
const readResult = {
  content: [
    {
      type: "text",
      text: "aB3│foo\nszJ│bar\n[Showing lines 5-6 of 100. Use offset=7 to continue.]",
    },
  ],
};
const readComp = readDef.renderResult(
  readResult,
  { expanded: true },
  theme,
  { args: { offset: 5 }, isError: false, lastComponent: undefined },
);
const readLines = readComp.render(200).join("\n").split("\n").map((l) => l.trimEnd());
console.log("read render output:");
for (const l of readLines) console.log(`  ${JSON.stringify(l)}`);
ok(readLines[0] === "5 │ aB3│foo", "read row 1 numbered with offset");
ok(readLines[1] === "6 │ szJ│bar", "read row 2 numbered");
ok(readLines[2].includes("Showing lines 5-6"), "pagination hint passed through");

// --- undo renderResult with applied diff ---
const undoResult = {
  content: [{ type: "text", text: "Undone last replace on src/a.ts." }],
  details: {
    diff: " aB3│alpha\n-szJ│beta\n+kQm│BETA\n e8m│gamma",
    diffLineNumbers: [1, 2, 2, 3],
    metrics: { classification: "applied", added_lines: 1, removed_lines: 1 },
  },
};
const undoComp = undoDef.renderResult(
  undoResult,
  { expanded: true },
  theme,
  { isError: false, lastComponent: undefined, state: {} },
);
const undoLines = undoComp.render(200).join("\n").split("\n").map((l) => l.trimEnd());
console.log("undo diff render output:");
for (const l of undoLines) console.log(`  ${JSON.stringify(l)}`);
ok(undoLines[1] === "2 │ -szJ│beta", "undo removed row shows old line number");
ok(undoLines[2] === "2 │ +kQm│BETA", "undo added row shows new line number");

// --- read renderResult without offset (default start 1) ---
const readComp2 = readDef.renderResult(
  { content: [{ type: "text", text: "kQm│x\n"}], details: {} },
  { expanded: true },
  theme,
  { args: {}, isError: false, lastComponent: undefined },
);
ok(readComp2.render(200).join("\n").split("\n").map((l) => l.trimEnd())[0] === "1 │ kQm│x", "read defaults to line 1");

// --- replace renderResult with applied diff ---
const replaceResult = {
  content: [{ type: "text", text: "Successfully replaced in src/a.ts." }],
  details: {
    diff: " aB3│alpha\n-szJ│beta\n+kQm│BETA\n e8m│gamma",
    diffLineNumbers: [1, 2, 2, 3],
    metrics: { classification: "applied", added_lines: 1, removed_lines: 1 },
  },
};
const replaceComp = replaceDef.renderResult(
  replaceResult,
  { expanded: true },
  theme,
  { isError: false, lastComponent: undefined, state: {} },
);
const diffLines = replaceComp.render(200).join("\n").split("\n").map((l) => l.trimEnd());
console.log("replace diff render output:");
for (const l of diffLines) console.log(`  ${JSON.stringify(l)}`);
ok(diffLines[0] === "1 │  aB3│alpha", "diff context row numbered");
ok(diffLines[1] === "2 │ -szJ│beta", "diff removed row shows old line number");
ok(diffLines[2] === "2 │ +kQm│BETA", "diff added row shows new line number");
ok(diffLines[3] === "3 │  e8m│gamma", "diff context row 2 numbered");

console.log("\nALL SMOKE CHECKS PASSED");
