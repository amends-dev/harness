import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Prompt } from "effect/ai"
import { GenerateResult } from "../src/GenerateResult.ts"
import { recordStep } from "../src/Session.ts"
import { Step, type StreamPart, stepsOf } from "../src/StreamPart.ts"

const usage = { inputTokens: { total: 10 }, outputTokens: { total: 5 } }

/** A step that thinks, says what it will do, and reads the notes with the agent's own tool. */
const readingStep: ReadonlyArray<StreamPart> = [
  { type: "reasoning-start", id: "think" },
  { type: "reasoning-delta", id: "think", delta: "The notes " },
  { type: "text-start", id: "plan" },
  { type: "reasoning-delta", id: "think", delta: "have it." },
  { type: "reasoning-end", id: "think" },
  { type: "text-delta", id: "plan", delta: "Reading " },
  { type: "text-delta", id: "plan", delta: "the notes." },
  { type: "text-end", id: "plan" },
  { type: "tool-params-start", id: "call-read", name: "read", providerExecuted: true },
  { type: "tool-params-delta", id: "call-read", delta: '{"path":"notes.md"}' },
  { type: "tool-params-end", id: "call-read" },
  {
    type: "tool-call",
    id: "call-read",
    name: "read",
    params: { path: "notes.md" },
    providerExecuted: true
  },
  {
    type: "tool-result",
    id: "call-read",
    name: "read",
    result: "reading",
    isFailure: false,
    providerExecuted: true,
    preliminary: true
  },
  {
    type: "tool-result",
    id: "call-read",
    name: "read",
    result: "2 and 3",
    isFailure: false,
    providerExecuted: true
  },
  { type: "file-change", event: "modify", path: "notes.md" },
  { type: "finish-step", reason: "tool-calls", usage }
]

/** The step `readingStep` adds up to. */
const readingParts = [
  { type: "reasoning", text: "The notes have it." },
  { type: "text", text: "Reading the notes." },
  {
    type: "tool-call",
    id: "call-read",
    name: "read",
    params: { path: "notes.md" },
    providerExecuted: true
  },
  {
    type: "tool-result",
    id: "call-read",
    name: "read",
    result: "2 and 3",
    isFailure: false,
    providerExecuted: true
  },
  { type: "file-change", event: "modify", path: "notes.md" }
]

const answer = (text: string): ReadonlyArray<StreamPart> => [
  { type: "text-start", id: "answer" },
  { type: "text-delta", id: "answer", delta: text },
  { type: "text-end", id: "answer" }
]

describe("stepsOf", () => {
  it("adds up each step's parts, in the order they started, and ends it at its finish-step", () => {
    const steps = stepsOf([
      ...readingStep,
      ...answer("5"),
      { type: "finish-step", reason: "stop", usage },
      { type: "finish", reason: "stop", usage }
    ])

    expect(steps).toEqual([
      { parts: readingParts, finish: { type: "finish-step", reason: "tool-calls", usage } },
      {
        parts: [{ type: "text", text: "5" }],
        finish: { type: "finish-step", reason: "stop", usage }
      }
    ])
  })

  it("keeps a step the parts end partway through, as far as it got, without a finish", () => {
    const steps = stepsOf([
      ...readingStep,
      { type: "text-start", id: "answer" },
      { type: "text-delta", id: "answer", delta: "The sum is" },
      { type: "error", error: { type: "aborted", message: "The session was stopped" } },
      { type: "finish", reason: "error", usage }
    ])

    expect(steps[1]).toEqual({
      parts: [
        { type: "text", text: "The sum is" },
        { type: "error", error: { type: "aborted", message: "The session was stopped" } }
      ]
    })
  })

  it("has no step for parts that stream nothing a step keeps", () => {
    expect(stepsOf([])).toEqual([])
    expect(
      stepsOf([
        ...readingStep,
        { type: "tool-params-start", id: "call-write", name: "write" },
        { type: "finish", reason: "error", usage }
      ])
    ).toHaveLength(1)
  })

  it("merges the metadata of a text's parts, as Effect AI merges it", () => {
    const [step] = stepsOf([
      { type: "reasoning-start", id: "think", metadata: { anthropic: { kind: "thinking" } } },
      { type: "reasoning-delta", id: "think", delta: "Sums." },
      {
        type: "reasoning-end",
        id: "think",
        metadata: { anthropic: { signature: "signed" }, openai: null }
      }
    ])

    expect(step?.parts).toEqual([
      {
        type: "reasoning",
        text: "Sums.",
        metadata: { anthropic: { kind: "thinking", signature: "signed" }, openai: null }
      }
    ])
  })

  it.effect("stores a step as JSON", () =>
    Effect.gen(function* () {
      const json = Schema.fromJsonString(Schema.toCodecJson(Step))
      const [step] = stepsOf(readingStep)

      const decoded = yield* Schema.decodeEffect(json)(yield* Schema.encodeEffect(json)(step!))

      expect(decoded).toEqual(step)
    })
  )
})

describe("recordStep", () => {
  const hello = Prompt.make("Hello.")

  it("records what a step reasoned and wrote and the tools it called, with their results, as the model's own", () => {
    const [step] = stepsOf(readingStep)

    expect(recordStep(hello, step!).content).toMatchObject([
      { role: "user" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "The notes have it." },
          { type: "text", text: "Reading the notes." },
          { type: "tool-call", id: "call-read", name: "read", providerExecuted: false }
        ]
      },
      {
        role: "tool",
        content: [{ type: "tool-result", id: "call-read", result: "2 and 3", providerExecuted: false }]
      }
    ])
  })

  it("records what the model reasoned and the files it wrote, with what its provider said", () => {
    const step: Step = {
      parts: [
        { type: "reasoning", text: "Sums.", metadata: { anthropic: { signature: "sig-1" } } },
        { type: "text", text: "Here it is.", metadata: { openai: { itemId: "msg_1" } } },
        { type: "file", mediaType: "image/png", data: "iVBORw0KGgo=" }
      ]
    }

    expect(recordStep(hello, step).content[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "reasoning", text: "Sums.", options: { anthropic: { signature: "sig-1" } } },
        { type: "text", text: "Here it is.", options: { openai: { itemId: "msg_1" } } },
        { type: "file", mediaType: "image/png", data: "iVBORw0KGgo=" }
      ]
    })
  })

  it("answers a call its step ended before as interrupted, and records nothing of an empty step", () => {
    const [step] = stepsOf([{ type: "tool-call", id: "call-write", name: "write", params: { path: "sum.md" } }])

    expect(recordStep(hello, step!).content[2]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "call-write",
          isFailure: true,
          result: { type: "execution-interrupted" }
        }
      ]
    })
    expect(recordStep(hello, { parts: [{ type: "text", text: "" }] })).toEqual(hello)
  })

  it("replaces the conversation, and what the step had before, with the summary of a compaction", () => {
    const step: Step = {
      parts: [
        { type: "text", text: "Before." },
        { type: "compaction", trigger: "auto", summary: "Ada said hello." },
        { type: "text", text: "After." }
      ]
    }

    expect(recordStep(hello, step).content).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: expect.stringMatching(/\n\nAda said hello\.$/) }]
      },
      { role: "assistant", content: [{ type: "text", text: "After." }] }
    ])
  })

  it("keeps the messages a compaction kept after its summary", () => {
    const step: Step = {
      parts: [
        {
          type: "compaction",
          trigger: "auto",
          summary: "Ada said hello.",
          kept: [{ role: "user", content: "What is 2 and 3?" }]
        },
        { type: "text", text: "5." }
      ]
    }

    expect(recordStep(hello, step).content).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: expect.stringMatching(/Ada said hello\.$/) }]
      },
      { role: "user", content: [{ type: "text", text: "What is 2 and 3?" }] },
      { role: "assistant", content: [{ type: "text", text: "5." }] }
    ])
  })
})

describe("GenerateResult", () => {
  it("answers with the text of the turn's last step, and has each step", () => {
    const result = new GenerateResult([
      ...readingStep,
      ...answer("5"),
      { type: "finish-step", reason: "stop", usage },
      { type: "finish", reason: "stop", usage }
    ])

    expect(result.text).toBe("5")
    expect(result.steps.map((step) => step.finish?.reason)).toEqual(["tool-calls", "stop"])
  })
})
