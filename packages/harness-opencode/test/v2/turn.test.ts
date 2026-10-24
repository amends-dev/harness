import { GenerateResult, type StreamPart } from "@amends-dev/harness"
import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import * as Turn from "../../src/internal/bridge/v2/turn.ts"
import { answerEvents, decode, eventsOf, type RawEvent } from "./fakes.ts"

const sessionID = "ses_turn"
const inboxID = "msg_prompt"
const directory = "/work/session"
const event = eventsOf(sessionID)

/** The parts a turn of the session streams for `events`, or why it failed. */
const translate = (events: ReadonlyArray<RawEvent>) => {
  let turn = Turn.initial({ inboxID, directory })
  const parts: Array<StreamPart.StreamPart> = []
  for (const raw of events) {
    const [next, translated] = Result.getOrThrow(Turn.translate(turn, decode(raw)))
    turn = next
    parts.push(...translated)
  }
  return { turn, parts }
}

/** The events of a turn whose one step writes `events`, after the step starts. */
const stepEvents = (...events: ReadonlyArray<RawEvent>) => [
  event.delivered(inboxID),
  event.executionStarted(),
  event.stepStarted("msg_1"),
  ...events
]

const typesOf = (parts: ReadonlyArray<StreamPart.StreamPart>) => parts.map((part) => part.type)

describe("opencode 2 turns", () => {
  it("streams a step's text as opencode streams it, and finishes once opencode stops", () => {
    const { parts, turn } = translate(answerEvents(sessionID, inboxID, "hello"))

    expect(typesOf(parts)).toEqual([
      "response-metadata",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish"
    ])
    expect(new GenerateResult.GenerateResult(parts).text).toBe("hello")
    expect(parts[0]).toEqual({
      type: "response-metadata",
      id: "msg_answer",
      modelId: "opencode/default-model",
      timestamp: new Date(1_791_073_617_000).toISOString()
    })
    expect(parts.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
    expect(turn.finished).toBe(true)
  })

  it("streams what the deltas missed of a text or a reasoning once it is whole", () => {
    const { parts } = translate(
      stepEvents(
        event.started("reasoning", "msg_1"),
        event.delta("reasoning", "msg_1", "Thin"),
        event.ended("reasoning", "msg_1", "Thinking."),
        event.started("text", "msg_1"),
        event.ended("text", "msg_1", "hello")
      )
    )

    expect(
      parts.flatMap((part) => (part.type === "reasoning-delta" || part.type === "text-delta" ? [part.delta] : []))
    ).toEqual(["Thin", "king.", "hello"])
    expect(typesOf(parts).slice(1)).toEqual([
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end"
    ])
  })

  it("ignores what came before opencode delivered the turn's prompt", () => {
    const { parts } = translate([
      event.stepStarted("msg_before"),
      event.started("text", "msg_before"),
      event.ended("text", "msg_before", "earlier"),
      event.delivered("msg_other"),
      event.succeeded(),
      ...answerEvents(sessionID, inboxID, "mine")
    ])

    expect(new GenerateResult.GenerateResult(parts).text).toBe("mine")
  })

  it("streams a call of opencode's own tool, its input as the model writes it, with its result", () => {
    const { parts } = translate(
      stepEvents(
        event.inputStarted("msg_1", "call_1", "shell"),
        event.inputDelta("msg_1", "call_1", '{"command":'),
        event.inputEnded("msg_1", "call_1", '{"command":"make"}'),
        event.called("msg_1", "call_1", { command: "make" }),
        event.succeededCall("msg_1", "call_1", "built"),
        event.inputStarted("msg_1", "call_2", "shell"),
        event.inputEnded("msg_1", "call_2", "{}"),
        event.called("msg_1", "call_2", {}),
        event.failedCall("msg_1", "call_2", "no command"),
        event.stepEnded("msg_1", "tool-calls")
      )
    )

    expect(parts.filter((part) => part.type.startsWith("tool-"))).toEqual([
      { type: "tool-params-start", id: "call_1", name: "shell", providerExecuted: true },
      { type: "tool-params-delta", id: "call_1", delta: '{"command":' },
      { type: "tool-params-delta", id: "call_1", delta: '"make"}' },
      { type: "tool-params-end", id: "call_1" },
      {
        type: "tool-call",
        id: "call_1",
        name: "shell",
        params: { command: "make" },
        providerExecuted: true
      },
      {
        type: "tool-result",
        id: "call_1",
        name: "shell",
        result: [{ type: "text", text: "built" }],
        isFailure: false,
        providerExecuted: true
      },
      { type: "tool-params-start", id: "call_2", name: "shell", providerExecuted: true },
      { type: "tool-params-delta", id: "call_2", delta: "{}" },
      { type: "tool-params-end", id: "call_2" },
      { type: "tool-call", id: "call_2", name: "shell", params: {}, providerExecuted: true },
      {
        type: "tool-result",
        id: "call_2",
        name: "shell",
        result: "no command",
        isFailure: true,
        providerExecuted: true
      }
    ])
    expect(parts.at(-1)).toMatchObject({ type: "finish-step", reason: "tool-calls" })
  })

  it("fails a call whose input it did not see start", () => {
    let turn = Turn.initial({ inboxID, directory })
    for (const raw of stepEvents()) {
      turn = Result.getOrThrow(Turn.translate(turn, decode(raw)))[0]
    }

    const failed = Turn.translate(turn, decode(event.called("msg_1", "call_9", {})))

    expect(Result.isFailure(failed) && failed.failure._tag).toBe("AgentContractError")
  })

  it("reports the files that write, edit, and patch changed, within the session's directory", () => {
    const call = (id: string, name: string, text: string, metadata?: Record<string, unknown>) => [
      event.inputStarted("msg_1", id, name),
      event.inputEnded("msg_1", id, "{}"),
      event.called("msg_1", id, {}),
      event.succeededCall("msg_1", id, text, metadata)
    ]
    const { parts } = translate(
      stepEvents(
        ...call("call_1", "write", "Created file successfully: notes.txt"),
        ...call("call_2", "write", "Wrote file successfully: src/main.ts"),
        ...call("call_3", "edit", "Edited a.ts (1 replacement)", {
          files: [{ file: "a.ts", patch: "", additions: 1, deletions: 1, status: "modified" }]
        }),
        ...call("call_4", "patch", "Applied", {
          files: [
            { file: `${directory}/b.ts`, patch: "", additions: 1, deletions: 0, status: "added" },
            { file: "/elsewhere/c.ts", patch: "", additions: 0, deletions: 1, status: "deleted" }
          ]
        }),
        ...call("call_5", "shell", "Created file successfully: not.txt")
      )
    )

    expect(parts.filter((part) => part.type === "file-change")).toEqual([
      { type: "file-change", event: "create", path: "notes.txt" },
      { type: "file-change", event: "modify", path: "src/main.ts" },
      { type: "file-change", event: "modify", path: "a.ts" },
      { type: "file-change", event: "create", path: "b.ts" },
      { type: "file-change", event: "delete", path: "/elsewhere/c.ts" }
    ])
  })

  it("adds up the tokens of the turn's steps in its finish", () => {
    const { parts } = translate(
      stepEvents(
        event.stepEnded("msg_1", "tool-calls"),
        event.stepStarted("msg_2"),
        event.stepEnded("msg_2"),
        event.succeeded()
      )
    )

    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      reason: "stop",
      usage: { inputTokens: { uncached: 20, total: 20 }, outputTokens: { total: 10, text: 10 } }
    })
  })

  it("fails a step once, however opencode reports it", () => {
    const { parts } = translate(
      stepEvents(event.stepFailed("msg_1", "Model has been deprecated."), event.failed("Model has been deprecated."))
    )

    expect(typesOf(parts)).toEqual(["response-metadata", "error", "finish-step", "finish"])
    expect(parts.at(-1)).toMatchObject({ reason: "error" })
  })

  it("fails a turn opencode failed or stopped before any step, with what opencode reported", () => {
    const failed = translate([event.delivered(inboxID), event.failed("Model not found: opencode/missing")])
    const interrupted = translate([event.delivered(inboxID), event.interrupted("shutdown")])
    const empty = translate([event.delivered(inboxID), event.succeeded()])

    expect(failed.parts).toEqual([
      {
        type: "error",
        error: { type: "provider.error", message: "Model not found: opencode/missing" }
      },
      expect.objectContaining({ type: "finish", reason: "error" })
    ])
    expect(interrupted.parts[0]).toEqual({
      type: "error",
      error: { type: "interrupted", message: "opencode stopped the turn, interrupted by shutdown" }
    })
    expect(empty.parts[0]).toEqual({
      type: "error",
      error: { type: "unknown", message: "opencode ended the turn without a step" }
    })
  })

  it("asks for approval when a tool asks permission", () => {
    const { parts } = translate([event.delivered(inboxID), event.permission("per_1", "call_1")])

    expect(parts).toEqual([{ type: "tool-approval-request", approvalId: "per_1", toolCallId: "call_1" }])
  })

  it("streams a summary opencode writes during the turn as a compaction", () => {
    const { parts } = translate([event.delivered(inboxID), event.compacted("auto", "The conversation so far.")])

    expect(parts).toEqual([{ type: "compaction", trigger: "auto", summary: "The conversation so far." }])
  })
})
