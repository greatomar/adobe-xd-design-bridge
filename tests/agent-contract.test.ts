/**
 * Contract lint: the agent contract and skills are executable policy. These tests
 * fail if a future edit removes a mandatory rule or reintroduces a known-false claim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CFG = join(homedir(), ".config", "opencode");
const read = (p: string) => readFileSync(p, "utf8");

const AGENT = read(join(CFG, "agents", "design.md"));
const XD_SKILL = read(join(CFG, "skills", "adobe-xd-specialist", "SKILL.md"));
const DS_SKILL = read(join(CFG, "skills", "design-system-engineering", "SKILL.md"));
const QA_SKILL = read(join(CFG, "skills", "visual-qa-and-critique", "SKILL.md"));
const SCHEMA = read(
  join(process.env.LOCALAPPDATA ?? "", "OpenCode", "AdobeXD-DesignBridge", "docs", "mcp-operation-schema.md"),
);

test("agent declares both modes and blocks self-recursion", () => {
  assert.match(AGENT, /^---[\s\S]*mode: all/m);
  assert.match(AGENT, /action: subagent[\s\S]{0,80}resource: "design"[\s\S]{0,40}effect: deny/);
  assert.match(AGENT, /No self-recursion|self-recursion/i);
});

test("state machine is present, ordered, and forbids queue -> read-back shortcuts", () => {
  const states = [
    "DISCOVER", "INSPECT", "PLAN", "PREPARE", "QUEUE", "WAIT_FOR_PANEL_EXECUTION",
    "VERIFY_EXECUTION", "READ_BACK", "CONTINUE_BUILDING", "VISUAL_QA", "REPAIR",
    "EXPORT", "FINAL_VERIFY", "DELIVER",
  ];
  const positions = states.map((s) => AGENT.indexOf(s));
  positions.forEach((p, i) => assert.ok(p >= 0, `missing state ${states[i]}`));
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1], `${states[i]} must appear after ${states[i - 1]}`);
  }
  assert.match(AGENT, /QUEUE \| WAIT_FOR_PANEL_EXECUTION \| VERIFY_EXECUTION, READ_BACK, DELIVER/);
  assert.match(AGENT, /A queued response[^\n]*is \*\*not\*\* a\s*\n?state transition/i);
});

test("write protocol requires panel interaction, execution correlation and read-back", () => {
  assert.match(AGENT, /Execute pending \(N\)/);
  assert.match(AGENT, /lastEvent\.data\.results\[0\]\.results/);
  assert.match(AGENT, /Harvest GUIDs/);
  assert.match(AGENT, /Never invent a GUID/i);
  assert.match(AGENT, /Never blind-retry|blind-retry/i);
  // The contract queues a whole screen per batch (up to the 100-op panel limit)
  // instead of dripping one region per click.
  assert.match(AGENT, /Queue the whole screen in one batch/);
  assert.match(AGENT, /1–100 operations/);
  assert.doesNotMatch(AGENT, /hard ceiling 25/);
});

test("verification levels 1–7 are defined and gated", () => {
  for (const lvl of ["1 Invocation", "2 Queue", "3 Execution", "4 Scenegraph", "5 Rendering", "6 Design QA", "7 Delivery"]) {
    assert.ok(AGENT.includes(lvl), `missing level row: ${lvl}`);
  }
  assert.match(AGENT, /not structurally complete below LEVEL 4/i);
  assert.match(AGENT, /not delivered below LEVEL 7/i);
});

test("per-screen construction is mandatory and screen completeness is role-based", () => {
  assert.match(AGENT, /Per-screen UI construction \(mandatory, purpose-specific\)/);
  assert.match(AGENT, /xd_audit_screen/);
  assert.match(AGENT, /There is no fixed node quota/);
  assert.match(AGENT, /Do \*\*not\*\* stop after background, empty sections, tokens/);
  assert.match(AGENT, /screen-specific role coverage/);
});

test("text style mapping documents the real XD keys", () => {
  assert.match(AGENT, /fontStyle/);
  assert.match(AGENT, /bridge keeps `fontWeight` as a compatibility\s+alias/i);
  assert.match(AGENT, /Text\.lineSpacing/);
  assert.match(AGENT, /text colour[\s\S]*?styleRanges\[\]\.fill/i);
});

test("agent contract includes the expanded native editing and honest prototype surface", () => {
  for (const op of ["xd_create_line", "xd_create_polygon", "xd_create_path", "xd_create_image", "xd_replace_image", "xd_import_asset", "xd_delete_node", "xd_duplicate_node", "xd_align_nodes", "xd_audit_screen"]) {
    assert.ok(SCHEMA.includes(op), `missing schema entry ${op}`);
  }
  assert.match(AGENT, /xd_get_prototype_state/);
  assert.match(AGENT, /xd_validate_prototype/);
  assert.match(AGENT, /cannot\s+author them/);
  assert.match(AGENT, /not linked reusable components/i);
});

test("xd specialist skill states SceneNodeList, flat batches and queue-depth limits", () => {
  assert.match(XD_SKILL, /not an Array/i);
  assert.match(XD_SKILL, /\.at\(i\)/);
  assert.match(XD_SKILL, /flat/i);
  assert.match(XD_SKILL, /params/);
  assert.match(XD_SKILL, /queue depth|in panel memory/i);
  assert.match(XD_SKILL, /fontStyle/);
  // removed false claims from the previous version
  assert.equal(XD_SKILL.includes("xd_group_nodes"), false, "nonexistent tool must not be referenced");
  assert.equal(/creates\/updates colors, text styles/i.test(XD_SKILL), false, "native style creation is not supported");
  assert.match(XD_SKILL, /no native colour swatches|does \*\*not\*\* create|does not create/i);
});

test("design-system skill uses validation-compliant tokens and states real scope", () => {
  assert.match(DS_SKILL, /pluginData/);
  assert.match(DS_SKILL, /"value"/);
  assert.match(DS_SKILL, /text\/\*/);
  assert.match(DS_SKILL, /native colour swatches/);
});

test("QA skill requires panel execution before corrections count and structural role verification", () => {
  assert.match(QA_SKILL, /Execute pending/);
  assert.match(QA_SKILL, /actually receives image input|actually visible to the calling model/i);
  assert.match(QA_SKILL, /semantic role manifest/i);
  assert.match(QA_SKILL, /structurally finished/i);
});

test("schema reference documents the flat shape and the rejected nesting", () => {
  assert.match(SCHEMA, /Flat\. Parameters are siblings of `op`, never nested/);
  assert.match(SCHEMA, /Rejected: `\{ "op": "create_rectangle", "params"/);
  assert.match(SCHEMA, /panel queue depth is not exposed/i);
  assert.match(SCHEMA, /Execute pending/);
});
