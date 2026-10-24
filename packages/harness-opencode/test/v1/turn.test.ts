import { GenerateResult, type StreamPart } from "@amends-dev/harness"
import { describe, expect, it } from "@effect/vitest"
import * as Turn from "../../src/internal/bridge/v1/turn.ts"
import { answerEvents, decode, eventsOf, type RawEvent } from "./fakes.ts"

const sessionID = "ses_turn"
const directory = "/work/session"
const event = eventsOf(sessionID)

/** The parts a turn of the session streams for `events`, with `hostTools` as the host's tools. */
const translate = (events: ReadonlyArray<RawEvent>, hostTools: ReadonlyArray<string> = []) => {
  let turn = Turn.initial({ sessionID, directory, hostTools: new Set(hostTools) })
  const parts: Array<StreamPart.StreamPart> = []
  for (const raw of events) {
    const [next, translated] = Turn.translate(turn, decode(raw))
    turn = next
    parts.push(...translated)
  }
  return { turn, parts }
}

const typesOf = (parts: ReadonlyArray<StreamPart.StreamPart>) => parts.map((part) => part.type)

describe("opencode 1 turns", () => {
  it("streams a step's text as opencode streams it, and finishes once opencode stops", () => {
    const { parts, turn } = translate(answerEvents(sessionID, "hello"))

    expect(typesOf(parts)).toEqual([
      "response-metadata",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish"
    ])
    expect(new GenerateResult.GenerateResult(parts).text).toBe("hello")
    expect(parts.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
    expect(turn.finished).toBe(true)
  })

  it("streams what the deltas missed of a text once the text is whole", () => {
    const { parts } = translate([
      event.busy(),
      event.stepStarted("msg_1"),
      event.text("msg_1", "prt_text", "", false),
      event.delta("msg_1", "prt_text", "hel"),
      event.text("msg_1", "prt_text", "hello"),
      event.stepCompleted("msg_1"),
      event.idle()
    ])

    expect(parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))).toEqual(["hel", "lo"])
  })

  it("streams reasoning, whose deltas opencode names as a text's", () => {
    const { parts } = translate([
      event.busy(),
      event.stepStarted("msg_1"),
      event.reasoning("msg_1", "prt_reasoning", "", false),
      event.delta("msg_1", "prt_reasoning", "Thinking."),
      event.reasoning("msg_1", "prt_reasoning", "Thinking."),
      event.stepCompleted("msg_1"),
      event.idle()
    ])

    expect(typesOf(parts).slice(1, 4)).toEqual(["reasoning-start", "reasoning-delta", "reasoning-end"])
  })

  it("streams a call of opencode's own tool, its input whole once it runs, with its result", () => {
    const { parts } = translate([
      event.busy(),
      event.stepStarted("msg_1"),
      event.tool("msg_1", "call_1", "bash", { status: "pending" }),
      event.tool("msg_1", "call_1", "bash", { status: "running", input: { command: "make" } }),
      event.tool("msg_1", "call_1", "bash", {
        status: "completed",
        input: { command: "make" },
        output: "built",
        metadata: {}
      }),
      event.stepCompleted("msg_1", { finish: "tool-calls" }),
      ...answerEvents(sessionID, "done", "msg_2").slice(1)
    ])

    expect(typesOf(parts).slice(1, 6)).toEqual([
      "tool-params-start",
      "tool-params-delta",
      "tool-params-end",
      "tool-call",
      "tool-result"
    ])
    expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
      id: "call_1",
      name: "bash",
      params: { command: "make" },
      providerExecuted: true
    })
    expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
      result: "built",
      isFailure: false,
      providerExecuted: true
    })
    expect(parts.filter((part) => part.type === "finish-step").map((part) => part.reason)).toEqual([
      "tool-calls",
      "stop"
    ])
  })

  it("reports the file a write created or an edit modified, within the session's directory", () => {
    const write = (callID: string, file: string, exists: boolean) =>
      event.tool("msg_1", callID, "write", {
        status: "completed",
        input: { filePath: file, content: "hi" },
        output: "Wrote file successfully.",
        metadata: { filepath: file, exists }
      })
    const { parts } = translate([
      event.busy(),
      event.stepStarted("msg_1"),
      write("call_1", `${directory}/notes.txt`, false),
      write("call_2", "/elsewhere/notes.txt", true),
      event.tool("msg_1", "call_3", "edit", {
        status: "completed",
        input: { filePath: `${directory}/src/main.ts`, oldString: "a", newString: "b" },
        output: "Edit applied successfully.",
        metadata: {}
      })
    ])

    expect(parts.filter((part) => part.type === "file-change")).toEqual([
      { type: "file-change", event: "create", path: "notes.txt" },
      { type: "file-change", event: "modify", path: "/elsewhere/notes.txt" },
      { type: "file-change", event: "modify", path: "src/main.ts" }
    ])
  })

  it("reports each file of an applied patch, a move as the file it removed and the one it created", () => {
    const { parts } = translate([
      event.busy(),
      event.stepStarted("msg_1"),
      event.tool("msg_1", "call_1", "apply_patch", {
        status: "completed",
        input: { patchText: "*** Begin Patch\n*** End Patch" },
        output: "Success. Updated the following files:",
        metadata: {
          diff: "",
          files: [
            { filePath: `${directory}/haiku.txt`, relativePath: "haiku.txt", type: "add" },
            { filePath: `${directory}/src/main.ts`, relativePath: "src/main.ts", type: "update" },
            { filePath: `${directory}/old.txt`, relativePath: "old.txt", type: "delete" },
            {
              filePath: `${directory}/a.ts`,
              relativePath: "b.ts",
              type: "move",
              movePath: `${directory}/b.ts`
            },
            { filePath: "/elsewhere/notes.txt", relativePath: "../../elsewhere/notes.txt", type: "update" }
          ]
        }
      })
    ])

    expect(parts.filter((part) => part.type === "file-change")).toEqual([
      { type: "file-change", event: "create", path: "haiku.txt" },
      { type: "file-change", event: "modify", path: "src/main.ts" },
      { type: "file-change", event: "delete", path: "old.txt" },
      { type: "file-change", event: "delete", path: "a.ts" },
      { type: "file-change", event: "create", path: "b.ts" },
      { type: "file-change", event: "modify", path: "/elsewhere/notes.txt" }
    ])
  })

  it("leaves out the calls of the host's tools, of the tool opencode answers in JSON with, and of questions", () => {
    const { parts } = translate(
      [
        event.busy(),
        event.stepStarted("msg_1"),
        event.tool("msg_1", "call_1", "host_lookup_weather", { status: "running", input: {} }),
        event.tool("msg_1", "call_2", "StructuredOutput", { status: "running", input: {} }),
        event.tool("msg_1", "call_3", "question", { status: "running", input: {} })
      ],
      ["host_lookup_weather"]
    )

    expect(typesOf(parts)).toEqual(["response-metadata"])
  })

  it("writes a step's answer in JSON as its text, ending the turn as stopped", () => {
    const { parts } = translate([
      event.busy(),
      event.stepStarted("msg_1"),
      event.tool("msg_1", "call_1", "StructuredOutput", {
        status: "completed",
        input: { city: "Lisbon" },
        output: "",
        metadata: {}
      }),
      event.stepCompleted("msg_1", { finish: "tool-calls", structured: { city: "Lisbon" } }),
      event.idle()
    ])

    const result = new GenerateResult.GenerateResult(parts)
    expect(result.text).toBe('{"city":"Lisbon"}')
    expect(result.finishReason).toBe("stop")
  })

  it("reads only the steps that start during the turn, in its own session", () => {
    const other = eventsOf("ses_other")
    const { parts } = translate([
      // An earlier turn's step, which completed before.
      event.stepCompleted("msg_before"),
      event.text("msg_before", "prt_before", "before"),
      other.busy(),
      other.stepStarted("msg_other"),
      other.text("msg_other", "prt_other", "other"),
      ...answerEvents(sessionID, "mine")
    ])

    expect(new GenerateResult.GenerateResult(parts).text).toBe("mine")
  })

  it("does not finish before opencode starts working on the turn", () => {
    const { parts, turn } = translate([event.idle()])

    expect(parts).toEqual([])
    expect(turn.finished).toBe(false)
  })

  it("fails a turn opencode failed before any step, with what opencode reported", () => {
    const { parts } = translate([
      event.busy(),
      event.error("UnknownError", "Model not found: opencode/missing"),
      event.error("UnknownError", "Model not found: opencode/missing"),
      event.idle()
    ])

    expect(parts).toEqual([
      {
        type: "error",
        error: { name: "UnknownError", data: { message: "Model not found: opencode/missing" } }
      },
      expect.objectContaining({ type: "finish", reason: "error" })
    ])
  })

  it("fails a step that failed once, however opencode reports it", () => {
    const { parts } = translate([
      event.busy(),
      event.stepStarted("msg_1"),
      event.error("APIError", "Model has been deprecated."),
      event.stepCompleted("msg_1", {
        finish: undefined,
        error: { name: "APIError", data: { message: "Model has been deprecated." } }
      }),
      event.idle()
    ])

    expect(typesOf(parts)).toEqual(["response-metadata", "error", "finish-step", "finish"])
    expect(parts.at(-1)).toMatchObject({ reason: "error" })
  })

  it("fails a turn opencode stopped without a step", () => {
    const { parts } = translate([event.busy(), event.idle()])

    expect(parts).toEqual([
      {
        type: "error",
        error: {
          name: "UnknownError",
          data: { message: "opencode ended the turn without a step" }
        }
      },
      expect.objectContaining({ type: "finish", reason: "error" })
    ])
  })

  it("reports nothing of an abort, which the bridge asked for", () => {
    const { parts } = translate([
      event.busy(),
      event.stepStarted("msg_1"),
      event.error("MessageAbortedError", "Aborted")
    ])

    expect(typesOf(parts)).toEqual(["response-metadata"])
  })

  it("asks for approval when a tool asks permission", () => {
    const { parts } = translate([event.busy(), event.permission("per_1", "call_1")])

    expect(parts).toEqual([{ type: "tool-approval-request", approvalId: "per_1", toolCallId: "call_1" }])
  })

  it("streams a summary opencode writes during the turn as a compaction, not as text", () => {
    const { parts } = translate([
      event.busy(),
      event.stepStarted("msg_summary", { summary: true }),
      event.text("msg_summary", "prt_summary", "", false),
      event.delta("msg_summary", "prt_summary", "The conversation so far."),
      event.text("msg_summary", "prt_summary", "The conversation so far."),
      event.stepCompleted("msg_summary", { summary: true }),
      ...answerEvents(sessionID, "hello", "msg_2").slice(1)
    ])

    expect(typesOf(parts)).toEqual([
      "compaction",
      "response-metadata",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish"
    ])
    expect(parts[0]).toEqual({
      type: "compaction",
      trigger: "auto",
      summary: "The conversation so far."
    })
  })

  it("adds up the tokens of the turn's steps in its finish", () => {
    const { parts } = translate([
      event.busy(),
      event.stepStarted("msg_1"),
      event.stepCompleted("msg_1", { finish: "tool-calls" }),
      event.stepStarted("msg_2"),
      event.stepCompleted("msg_2"),
      event.idle()
    ])

    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      usage: { inputTokens: { uncached: 20, total: 20 }, outputTokens: { total: 10, text: 10 } }
    })
  })
})
