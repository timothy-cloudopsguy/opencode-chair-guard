import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  CHAIR_REMINDER_METADATA_KEY,
  CHAIR_REMINDER_TEXT,
  appendChairReminder,
  applyV2Reminder,
  createCallGuard,
  createSessionGuard,
  decide,
  emptyState,
  fromV2ToolEvent,
  loadConfig,
  parseSoloEdits,
} from "./guard.mjs"

const wall = { kind: "wall" }

function edit(state, mode = wall, tool = "edit") {
  return decide(state, { mode, tool, args: { filePath: "a.ts" } })
}

test("wall mode denies the first orchestrator edit and keeps denying", () => {
  const first = edit(emptyState("orchestrator"))
  assert.equal(first.deny, true)
  assert.match(first.message, /@fixer/)
  const second = edit(first.state)
  assert.equal(second.deny, true)
  assert.equal(second.state.delegated, false)
})

test("task with subagent_type disarms the wall and a later edit is allowed", () => {
  let state = emptyState("orchestrator")
  const spawned = decide(state, {
    mode: wall,
    tool: "task",
    args: { subagent_type: "fixer", prompt: "update the parser" },
  })
  assert.equal(spawned.deny, false)
  assert.equal(spawned.state.delegated, true)
  state = spawned.state
  const after = edit(state)
  assert.equal(after.deny, false)
})

test("task without a specialist does not disarm", () => {
  const spawned = decide(emptyState("orchestrator"), {
    mode: wall,
    tool: "task",
    args: { prompt: "update the parser" },
  })
  assert.equal(spawned.state.delegated, false)
  assert.equal(edit(spawned.state).deny, true)
})

test("task_batch and v2 subagent spawns disarm", () => {
  const batch = decide(emptyState("orchestrator"), {
    mode: wall,
    tool: "task_batch",
    args: { tasks: [{ subagent_type: "explorer", prompt: "find call sites" }] },
  })
  assert.equal(batch.state.delegated, true)
  const subagent = decide(emptyState("orchestrator"), {
    mode: wall,
    tool: "subagent",
    args: { agent: "librarian", prompt: "read the docs" },
  })
  assert.equal(subagent.state.delegated, true)
})

test("a non-orchestrator session is never blocked", () => {
  assert.equal(edit(emptyState("fixer")).deny, false)
  assert.equal(edit(emptyState(undefined)).deny, false)
  assert.equal(edit(emptyState("orchestrator"), wall, "bash").deny, false)
})

test("soloEdits 0 disables the gate", () => {
  const result = edit(emptyState("orchestrator"), { kind: "disabled" })
  assert.equal(result.deny, false)
})

test("soloEdits 3 denies once on the third edit and then stays quiet", () => {
  const mode = { kind: "nudge", threshold: 3 }
  let state = emptyState("orchestrator")
  const first = edit(state, mode)
  const second = edit(first.state, mode)
  assert.equal(first.deny, false)
  assert.equal(second.deny, false)
  const third = edit(second.state, mode)
  assert.equal(third.deny, true)
  assert.equal(third.state.nudgeFired, true)
  const fourth = edit(third.state, mode)
  assert.equal(fourth.deny, false)
})

test("a spawn before the nudge threshold disarms the rest of the session", () => {
  const mode = { kind: "nudge", threshold: 3 }
  const spawned = decide(emptyState("orchestrator"), {
    mode,
    tool: "Task",
    args: { subagent_type: " explorer " },
  })
  assert.equal(edit(spawned.state, mode).deny, false)
})

test("parseSoloEdits maps null, zero, and positive counts", () => {
  assert.deepEqual(parseSoloEdits(undefined), { kind: "wall" })
  assert.deepEqual(parseSoloEdits(null), { kind: "wall" })
  assert.deepEqual(parseSoloEdits(0), { kind: "disabled" })
  assert.deepEqual(parseSoloEdits(3), { kind: "nudge", threshold: 3 })
  assert.deepEqual(parseSoloEdits(3.9), { kind: "nudge", threshold: 3 })
})

test("loadConfig uses wall mode when the file is missing or soloEdits is null", () => {
  assert.deepEqual(loadConfig(join(tmpdir(), "chair-guard-missing.json")), { kind: "wall" })
  const dir = mkdtempSync(join(tmpdir(), "chair-guard-"))
  const path = join(dir, "chair-guard.json")
  writeFileSync(path, JSON.stringify({ soloEdits: null }))
  assert.deepEqual(loadConfig(path), { kind: "wall" })
  writeFileSync(path, JSON.stringify({ soloEdits: 0 }))
  assert.deepEqual(loadConfig(path), { kind: "disabled" })
})

test("the session hook throws on a chair edit and allows it after task", () => {
  const guard = createSessionGuard({ kind: "wall" })
  guard.observeAgent("ses_chair", "orchestrator")
  assert.throws(() => guard.beforeTool("ses_chair", "write", { filePath: "a.ts" }), /do not edit the file yourself/i)
  guard.beforeTool("ses_chair", "task", { subagent_type: "fixer", prompt: "apply the change" })
  assert.doesNotThrow(() => guard.beforeTool("ses_chair", "edit", { filePath: "a.ts" }))
})

test("the session hook does not block a specialist session", () => {
  const guard = createSessionGuard({ kind: "wall" })
  guard.observeAgent("ses_fixer", "fixer")
  assert.doesNotThrow(() => guard.beforeTool("ses_fixer", "edit", { filePath: "a.ts" }))
})

test("v2 subagent events count as task spawns and reminders attach to message content", () => {
  const call = fromV2ToolEvent({
    tool: "subagent",
    input: { agent: "fixer", prompt: "edit the parser" },
  })
  assert.equal(call.tool, "task")
  assert.equal(call.args.subagent_type, "fixer")
  const event = {
    sessionID: "ses_chair",
    agent: "orchestrator",
    messages: [{ role: "user", content: [{ type: "text", text: "fix the parser" }] }],
  }
  applyV2Reminder(event)
  applyV2Reminder(event)
  assert.equal(event.messages[0].content.length, 2)
  assert.equal(event.messages[0].content[1].text, CHAIR_REMINDER_TEXT)
})

test("duplicate hook delivery denies once and does not double-count a nudge", () => {
  const guard = createSessionGuard({ kind: "nudge", threshold: 3 })
  guard.observeAgent("ses_chair", "orchestrator")
  const once = createCallGuard((sessionID, tool, args) => guard.beforeTool(sessionID, tool, args))
  once("ses_chair", "call_1", "edit", {})
  once("ses_chair", "call_1", "edit", {})
  assert.doesNotThrow(() => once("ses_chair", "call_2", "edit", {}))
  assert.throws(() => once("ses_chair", "call_3", "edit", {}), /fires once/)
  assert.throws(() => once("ses_chair", "call_3", "edit", {}), /fires once/)
  assert.doesNotThrow(() => once("ses_chair", "call_4", "edit", {}))
})

test("reminder is appended once to orchestrator turns only", () => {
  const messages = [
    { info: { role: "user", agent: "orchestrator", sessionID: "ses_chair" }, parts: [{ type: "text", text: "fix the parser" }] },
    { info: { role: "assistant", agent: "orchestrator", sessionID: "ses_chair" }, parts: [{ type: "text", text: "ok" }] },
  ]
  appendChairReminder(messages)
  appendChairReminder(messages)
  const reminders = messages[0].parts.filter((part) => part.metadata?.[CHAIR_REMINDER_METADATA_KEY])
  assert.equal(reminders.length, 1)
  assert.equal(reminders[0].text, CHAIR_REMINDER_TEXT)
  assert.equal(messages[1].parts.length, 1)

  const specialist = [
    { info: { role: "user", agent: "fixer", sessionID: "ses_fixer" }, parts: [{ type: "text", text: "edit it" }] },
  ]
  appendChairReminder(specialist)
  assert.equal(specialist[0].parts.length, 1)
})
