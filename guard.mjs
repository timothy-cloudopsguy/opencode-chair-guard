import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const CHAIR_AGENT = "orchestrator"
export const CHAIR_REMINDER_METADATA_KEY = "chair-guard.reminder"
export const CHAIR_REMINDER_TEXT =
  "[chair] You are the chair. Delegate by default with task. Do not edit files until a specialist is spawned."

const MUTATING_TOOLS = new Set(["edit", "write", "apply_patch", "ast_grep_replace"])
const DELEGATION_TOOLS = new Set(["task", "task_batch", "subagent"])

const DENY_MESSAGE =
  "[chair] File edits are refused until you delegate. Name a specialist (@explorer, @librarian, @fixer, @oracle, @designer), put the spec in task, and do not edit the file yourself."

export function defaultConfigPath() {
  return join(homedir(), ".config", "opencode", "chair-guard.json")
}

export function projectConfigPath(directory) {
  return join(directory, ".opencode", "chair-guard.json")
}

export function resolveConfigPath(directory) {
  const projectPath = projectConfigPath(directory)
  return existsSync(projectPath) ? projectPath : defaultConfigPath()
}

export function emptyState(agent) {
  return {
    agent: typeof agent === "string" && agent ? agent : undefined,
    delegated: false,
    editCount: 0,
    nudgeFired: false,
  }
}

/**
 * Absent or null keeps the wall: every chair edit is refused until a specialist spawn.
 * 0 disables the gate. A positive count restores the once-and-done nudge at that edit.
 */
export function parseSoloEdits(value) {
  if (value === undefined || value === null) return { kind: "wall" }
  if (typeof value !== "number" || !Number.isFinite(value)) return { kind: "wall" }
  if (value === 0) return { kind: "disabled" }
  if (value > 0) return { kind: "nudge", threshold: Math.floor(value) }
  return { kind: "wall" }
}

export function loadConfig(path = defaultConfigPath()) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    return parseSoloEdits(parsed?.soloEdits)
  } catch (err) {
    if (err && err.code === "ENOENT") return { kind: "wall" }
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[chair-guard] could not read ${path}: ${message}; using wall mode`)
    return { kind: "wall" }
  }
}

function toolName(tool) {
  return typeof tool === "string" ? tool.toLowerCase().trim() : ""
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function specialistFromRecord(record) {
  if (!record || typeof record !== "object") return undefined
  return nonEmptyString(record.subagent_type) ?? nonEmptyString(record.agent)
}

export function spawnedSpecialist(tool, args) {
  const name = toolName(tool)
  if (!DELEGATION_TOOLS.has(name)) return undefined
  if (name === "task_batch") {
    const tasks = args && typeof args === "object" ? args.tasks : undefined
    if (!Array.isArray(tasks)) return undefined
    for (const task of tasks) {
      const specialist = specialistFromRecord(task)
      if (specialist) return specialist
    }
    return undefined
  }
  return specialistFromRecord(args)
}

export function decide(state, event) {
  const next = {
    agent: state.agent,
    delegated: state.delegated,
    editCount: state.editCount,
    nudgeFired: state.nudgeFired,
  }
  const mode = event.mode ?? { kind: "wall" }

  if (spawnedSpecialist(event.tool, event.args)) {
    next.delegated = true
    return { deny: false, state: next }
  }

  if (!MUTATING_TOOLS.has(toolName(event.tool))) {
    return { deny: false, state: next }
  }
  if (next.agent !== CHAIR_AGENT) return { deny: false, state: next }
  if (mode.kind === "disabled") return { deny: false, state: next }
  if (next.delegated) return { deny: false, state: next }

  if (mode.kind === "nudge") {
    next.editCount += 1
    if (state.nudgeFired || next.editCount < mode.threshold) {
      return { deny: false, state: next }
    }
    next.nudgeFired = true
    return {
      deny: true,
      message: `${DENY_MESSAGE} This deny fires once for the session.`,
      state: next,
    }
  }

  return { deny: true, message: DENY_MESSAGE, state: next }
}

export function fromV2ToolEvent(event) {
  const raw = typeof event?.tool === "string" ? event.tool : ""
  const input = event?.input && typeof event.input === "object" ? event.input : {}
  if (raw.toLowerCase() === "subagent") {
    return {
      tool: "task",
      args: {
        ...input,
        subagent_type: input.subagent_type ?? input.agent,
      },
    }
  }
  return { tool: raw, args: input }
}

export function applyV2Reminder(event, agentForSession = () => undefined) {
  if (!event || !Array.isArray(event.messages)) return
  const knownAgent =
    nonEmptyString(event.agent) ??
    (typeof event.sessionID === "string" ? agentForSession(event.sessionID) : undefined)
  for (const message of event.messages) {
    if (!message || typeof message !== "object") continue
    if (message.sessionID === undefined && typeof event.sessionID === "string") message.sessionID = event.sessionID
    if (message.agent === undefined && knownAgent) message.agent = knownAgent
  }
  const adapted = event.messages.map((message) => ({
    info: message,
    parts: Array.isArray(message?.content) ? message.content : [],
  }))
  appendChairReminder(adapted, agentForSession)
  event.messages = adapted.map((message) => {
    message.info.content = message.parts
    return message.info
  })
}

export function createCallGuard(beforeTool) {
  const decisions = new Map()
  return (sessionID, callID, tool, args) => {
    const key = typeof callID === "string" && callID ? `${sessionID}\0${callID}` : ""
    if (key && decisions.has(key)) {
      const message = decisions.get(key)
      if (message) throw new Error(message)
      return
    }
    try {
      beforeTool(sessionID, tool, args)
      if (key) decisions.set(key, "")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (key) decisions.set(key, message)
      throw err
    }
  }
}

export function createSessionGuard(mode) {
  const agents = new Map()
  const states = new Map()

  function stateFor(sessionID) {
    const existing = states.get(sessionID)
    if (existing) {
      existing.agent = agents.get(sessionID) ?? existing.agent
      return existing
    }
    const created = emptyState(agents.get(sessionID))
    states.set(sessionID, created)
    return created
  }

  return {
    observeAgent(sessionID, agent) {
      if (typeof sessionID !== "string" || !sessionID) return
      if (typeof agent !== "string" || !agent) return
      agents.set(sessionID, agent)
      const existing = states.get(sessionID)
      if (existing) existing.agent = agent
    },
    beforeTool(sessionID, tool, args) {
      if (typeof sessionID !== "string" || !sessionID) return
      const result = decide(stateFor(sessionID), { mode, tool, args })
      states.set(sessionID, result.state)
      if (result.deny) throw new Error(result.message)
    },
    agentFor(sessionID) {
      return agents.get(sessionID)
    },
  }
}

function isRecord(value) {
  return !!value && typeof value === "object"
}

function isUserMessage(message) {
  return isRecord(message) && isRecord(message.info) && message.info.role === "user" && Array.isArray(message.parts)
}

function hasChairReminder(message) {
  return message.parts.some(
    (part) =>
      isRecord(part) &&
      part.synthetic === true &&
      isRecord(part.metadata) &&
      part.metadata[CHAIR_REMINDER_METADATA_KEY] === true,
  )
}

export function appendChairReminder(messages, agentForSession = () => undefined) {
  if (!Array.isArray(messages)) return
  let latest
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isUserMessage(messages[index])) {
      latest = messages[index]
      break
    }
  }
  if (!latest) return
  const sessionID = typeof latest.info.sessionID === "string" ? latest.info.sessionID : undefined
  const latestAgent =
    nonEmptyString(latest.info.agent) ?? (sessionID ? agentForSession(sessionID) : undefined)
  if (latestAgent !== CHAIR_AGENT) return

  for (const message of messages) {
    if (!isUserMessage(message)) continue
    if (sessionID && message.info.sessionID && message.info.sessionID !== sessionID) continue
    const messageAgent =
      nonEmptyString(message.info.agent) ??
      (typeof message.info.sessionID === "string" ? agentForSession(message.info.sessionID) : undefined) ??
      latestAgent
    if (messageAgent !== CHAIR_AGENT) continue
    if (hasChairReminder(message)) continue
    message.parts.push({
      type: "text",
      synthetic: true,
      text: CHAIR_REMINDER_TEXT,
      metadata: { [CHAIR_REMINDER_METADATA_KEY]: true },
    })
  }
}
