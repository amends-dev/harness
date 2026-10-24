import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const home = process.env.CODEX_HOME
const threadFile = join(home, "thread.json")
const logFile = join(home, "requests.jsonl")
const config = Bun.TOML.parse(readFileSync(join(home, "config.toml"), "utf8"))
const pending = new Map()
let turnCount = 0
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (request, result = {}) => write({ id: request.id, result })
const event = (method, params) => write({ method, params })
const complete = (threadId, turnId, text) => {
  event("item/started", {
    threadId,
    turnId,
    item: { id: "text", type: "agentMessage", text: "", phase: "final_answer" }
  })
  event("item/agentMessage/delta", { threadId, turnId, itemId: "text", delta: text })
  event("item/completed", { threadId, turnId, item: { id: "text", type: "agentMessage", text, phase: "final_answer" } })
  const total = { inputTokens: 20, cachedInputTokens: 5, outputTokens: 6, reasoningOutputTokens: 2 }
  event("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total, last: total } })
  event("turn/completed", { threadId, turn: { id: turnId, status: "completed", error: null } })
}
const callMcp = async (method, params) => {
  const server = config.mcp_servers.host
  const response = await fetch(server.url, {
    method: "POST",
    headers: { ...server.http_headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 91, method, params })
  })
  const text = await response.text()
  return JSON.parse(
    text.startsWith("event:")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          .slice(6)
      : text
  )
}
async function handle(request) {
  appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...request })}\n`)
  if (request.method === undefined) {
    const answer = pending.get(request.id)
    if (answer) {
      pending.delete(request.id)
      answer(request.result)
    }
    return
  }
  switch (request.method) {
    case "initialize":
      return reply(request, {})
    case "initialized":
      return
    case "thread/start":
      return reply(request, { thread: { id: "thread-1" } })
    case "thread/inject_items":
      writeFileSync(threadFile, JSON.stringify(request.params.items))
      return reply(request)
    case "thread/resume":
      return existsSync(threadFile)
        ? reply(request, { thread: { id: "thread-1" } })
        : write({ id: request.id, error: { code: -32600, message: "no rollout found for thread id thread-1" } })
    case "thread/archive":
      return reply(request)
    case "thread/delete":
      unlinkSync(threadFile)
      return reply(request)
    case "turn/interrupt":
      return reply(request)
    case "turn/start": {
      const threadId = request.params.threadId
      const turnId = `turn-${++turnCount}`
      reply(request, { turn: { id: turnId } })
      const prompt = request.params.input.find((part) => part.type === "text")?.text ?? ""
      if (prompt === "phases") {
        const commentary = {
          id: "commentary",
          type: "agentMessage",
          text: "I'll inspect the files.",
          phase: "commentary"
        }
        event("item/started", { threadId, turnId, item: { ...commentary, text: "" } })
        event("item/agentMessage/delta", { threadId, turnId, itemId: commentary.id, delta: commentary.text })
        event("item/completed", { threadId, turnId, item: commentary })
        const total = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1 }
        event("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total, last: total } })
        event("item/started", {
          threadId,
          turnId,
          item: { id: "inspect", type: "commandExecution", command: "pwd", status: "inProgress" }
        })
        event("item/completed", {
          threadId,
          turnId,
          item: {
            id: "inspect",
            type: "commandExecution",
            command: "pwd",
            status: "completed",
            aggregatedOutput: "/workspace"
          }
        })
        return complete(threadId, turnId, "The files look good.")
      }
      if (prompt === "wait") {
        event("item/agentMessage/delta", { threadId, turnId, itemId: "waiting", delta: "waiting" })
        return
      }
      if (prompt === "malformed") {
        process.stdout.write("not-json\n")
        return
      }
      if (prompt === "approve") {
        event("item/started", {
          threadId,
          turnId,
          item: {
            id: "command",
            type: "commandExecution",
            command: "pwd",
            cwd: request.params.cwd ?? "/workspace",
            status: "inProgress"
          }
        })
        const approved = new Promise((resolve) => pending.set(400, resolve))
        write({
          id: 400,
          method: "item/commandExecution/requestApproval",
          params: { threadId, turnId, itemId: "command" }
        })
        const response = await approved
        event("item/completed", {
          threadId,
          turnId,
          item: {
            id: "command",
            type: "commandExecution",
            command: "pwd",
            status: response.decision === "accept" ? "completed" : "declined",
            aggregatedOutput: "/workspace"
          }
        })
        return complete(threadId, turnId, response.decision)
      }
      if (prompt === "tool") {
        const list = await callMcp("tools/list", {})
        const tool = list.result.tools[0]
        if (!tool) throw new Error("No host tools")
        const result = await callMcp("tools/call", { name: tool.name, arguments: { value: "hello" } })
        return complete(threadId, turnId, result.result.content[0].text)
      }
      if (prompt === "failed") {
        event("turn/completed", {
          threadId,
          turn: { id: turnId, status: "failed", error: { message: "model failed" } }
        })
        return
      }
      // Another thread's completion must never end this stream.
      event("turn/completed", { threadId: "other", turn: { id: turnId, status: "completed" } })
      complete(threadId, turnId, "Hello from Codex")
    }
  }
}
let buffer = ""
const decoder = new TextDecoder()
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true })
  let newline
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line)
      void handle(JSON.parse(line)).catch((error) => {
        process.stderr.write(String(error))
        process.exit(1)
      })
  }
}
