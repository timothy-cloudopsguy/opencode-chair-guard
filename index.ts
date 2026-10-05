import {
  appendChairReminder,
  applyV2Reminder,
  createCallGuard,
  createSessionGuard,
  fromV2ToolEvent,
  loadConfig,
  resolveConfigPath,
} from "./guard.mjs"

let sessions: ReturnType<typeof createSessionGuard> | undefined
function ensureSessions(directory: string) {
  if (!sessions) sessions = createSessionGuard(loadConfig(resolveConfigPath(directory)))
  return sessions
}

function currentSessions() {
  if (!sessions) throw new Error("chair-guard session guard is not initialized")
  return sessions
}

const guardTool = createCallGuard((sessionID, tool, args) => currentSessions().beforeTool(sessionID, tool, args))

let announced = false
function announce() {
  if (announced) return
  announced = true
  console.error("[chair-guard] loaded")
}

type ChatMessageInput = {
  sessionID?: string
  agent?: string
}

type ChatMessageOutput = {
  message?: {
    agent?: string
  }
}

type ToolBeforeInput = {
  tool?: string
  sessionID?: string
  callID?: string
}

type ToolBeforeOutput = {
  args?: unknown
}

type MessagesOutput = {
  messages?: unknown
}

type V2HookRegistration = {
  dispose?: () => void
}

type V2Context = {
  directory?: string
  tool?: {
    hook?: (name: string, handler: (event: unknown) => Promise<void>) => Promise<V2HookRegistration>
  }
  session?: {
    hook?: (name: string, handler: (event: unknown) => Promise<void>) => Promise<V2HookRegistration>
  }
}

type V1Context = {
  directory?: string
  worktree?: string
}

const plugin = async (ctx: V1Context = {}) => {
  announce()
  ensureSessions(ctx.directory ?? ctx.worktree ?? process.cwd())
  return {
    "chat.message": async (input: ChatMessageInput, output: ChatMessageOutput) => {
      currentSessions().observeAgent(input.sessionID ?? "", input.agent ?? output?.message?.agent)
    },
    "tool.execute.before": async (input: ToolBeforeInput, output: ToolBeforeOutput) => {
      guardTool(input.sessionID ?? "", input.callID ?? "", input.tool ?? "", output?.args)
    },
    "experimental.chat.messages.transform": async (_input: unknown, output: MessagesOutput) => {
      appendChairReminder(output?.messages, (sessionID) => currentSessions().agentFor(sessionID))
    },
  }
}

async function setup(ctx: V2Context) {
  announce()
  ensureSessions(ctx?.directory ?? process.cwd())
  if (!ctx || typeof ctx.tool?.hook !== "function") return async () => {}
  const disposers: Array<() => void> = []
  const remember = (registration: V2HookRegistration | undefined) => {
    if (typeof registration?.dispose === "function") disposers.push(() => registration.dispose?.())
  }
  try {
    remember(
      await ctx.tool.hook("execute.before", async (event) => {
        const record = event && typeof event === "object" ? (event as { sessionID?: string; id?: string }) : {}
        const call = fromV2ToolEvent(event)
        guardTool(record.sessionID ?? "", record.id ?? "", call.tool, call.args)
      }),
    )
  } catch (err) {
    console.error("[chair-guard] could not register the tool hook", err)
  }
  if (typeof ctx.session?.hook === "function") {
    try {
      remember(
        await ctx.session.hook("context", async (event) => {
          const record =
            event && typeof event === "object" ? (event as { sessionID?: string; agent?: string }) : {}
          if (typeof record.sessionID === "string" && typeof record.agent === "string") {
            currentSessions().observeAgent(record.sessionID, record.agent)
          }
          applyV2Reminder(event, (sessionID) => currentSessions().agentFor(sessionID))
        }),
      )
    } catch (err) {
      console.error("[chair-guard] could not register the session hook", err)
    }
  }
  return async () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // The host is already shutting down.
      }
    }
  }
}

export default {
  id: "chair-guard",
  server: plugin,
  setup,
}
