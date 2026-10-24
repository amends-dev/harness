import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import { Prompt } from "effect/ai"
import { messagesOf, promptOf } from "../../src/internal/bridge/v2/prompt.ts"

const recording = { sessionID: "ses_d3a8b1f4cffeBYbN21QzYS7lIf", now: 1_791_073_617_000 }

const messages = (conversation: Prompt.RawInput) => Result.getOrThrow(messagesOf(Prompt.make(conversation), recording))

const refusal = (conversation: Prompt.RawInput) => {
  const written = messagesOf(Prompt.make(conversation), recording)
  return Result.isFailure(written) ? written.failure : undefined
}

describe("opencode 2 prompts", () => {
  it("gives a prompt's texts as one, and its files as data: URLs", () => {
    const prompt = promptOf(
      Prompt.makeMessage("user", {
        content: [
          Prompt.makePart("text", { text: "Read these." }),
          Prompt.makePart("text", { text: "Both." }),
          Prompt.makePart("file", { mediaType: "text/plain", fileName: "a.txt", data: "aGk=" }),
          Prompt.makePart("file", { mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }),
          Prompt.makePart("file", { mediaType: "text/plain", data: "data:text/plain;base64,aGk=" }),
          Prompt.makePart("file", { mediaType: "text/plain", data: new URL("file:///work/b.txt") })
        ]
      })
    )

    expect(Result.getOrThrow(prompt)).toEqual({
      text: "Read these.\nBoth.",
      files: [
        { uri: "data:text/plain;base64,aGk=", name: "a.txt" },
        { uri: "data:image/png;base64,AQID" },
        { uri: "data:text/plain;base64,aGk=" },
        { uri: "file:///work/b.txt" }
      ]
    })
  })

  it("refuses a prompt's file at a URL opencode does not read", () => {
    const prompt = promptOf(
      Prompt.makeMessage("user", {
        content: [
          Prompt.makePart("file", {
            mediaType: "application/pdf",
            data: new URL("https://example.com/b.pdf")
          })
        ]
      })
    )

    expect(Result.isFailure(prompt) && prompt.failure).toMatchObject({
      _tag: "UnsupportedError",
      description: "opencode 2 reads files as data, not at https://example.com/b.pdf"
    })
  })

  it("records a conversation as opencode's messages, tool calls with their results", () => {
    const recorded = messages([
      { role: "system", content: "Be brief." },
      {
        role: "user",
        content: [
          { type: "text", text: "Check the weather in Lisbon." },
          { type: "file", mediaType: "text/plain", fileName: "notes.txt", data: "aGk=" }
        ]
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "I should look it up." },
          { type: "text", text: "Looking." },
          {
            type: "tool-call",
            id: "call_1",
            name: "lookup_weather",
            params: { city: "Lisbon" },
            providerExecuted: false
          },
          {
            type: "tool-call",
            id: "call_2",
            name: "lookup_time",
            params: "Lisbon",
            providerExecuted: true
          }
        ]
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "call_1",
            name: "lookup_weather",
            isFailure: false,
            result: { celsius: 14 },
            providerExecuted: false
          },
          {
            type: "tool-result",
            id: "call_2",
            name: "lookup_time",
            isFailure: true,
            result: "No clock",
            providerExecuted: false
          }
        ]
      },
      { role: "assistant", content: [{ type: "text", text: "It is 14 degrees." }] }
    ])

    const time = { created: recording.now }
    const finished = { created: recording.now, completed: recording.now }
    const history = { providerID: "amends", id: "history" }
    expect(recorded).toEqual([
      { type: "system", id: expect.any(String), time, text: "Be brief." },
      {
        type: "user",
        id: expect.any(String),
        time,
        text: "Check the weather in Lisbon.",
        files: [{ data: "aGk=", mime: "text/plain", source: { type: "inline" }, name: "notes.txt" }]
      },
      {
        type: "assistant",
        id: expect.any(String),
        time: finished,
        agent: "build",
        model: history,
        content: [
          { type: "reasoning", text: "I should look it up." },
          { type: "text", text: "Looking." },
          {
            type: "tool",
            id: "call_1",
            name: "lookup_weather",
            executed: false,
            state: {
              status: "completed",
              input: { city: "Lisbon" },
              content: [{ type: "text", text: '{"celsius":14}' }]
            },
            time: finished
          },
          {
            type: "tool",
            id: "call_2",
            name: "lookup_time",
            executed: false,
            state: {
              status: "error",
              input: { value: "Lisbon" },
              error: { type: "unknown", message: "No clock" }
            },
            time: finished
          }
        ],
        finish: "tool-calls"
      },
      {
        type: "assistant",
        id: expect.any(String),
        time: finished,
        agent: "build",
        model: history,
        content: [{ type: "text", text: "It is 14 degrees." }],
        finish: "stop"
      }
    ])
  })

  it("records a result that is opencode's content as it is, and a call without one as failed", () => {
    const [, step] = messages([
      { role: "user", content: "Run it." },
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "a", name: "shell", params: {}, providerExecuted: true },
          { type: "tool-call", id: "b", name: "shell", params: {}, providerExecuted: true },
          {
            type: "tool-result",
            id: "a",
            name: "shell",
            isFailure: false,
            result: [{ type: "text", text: "ok" }],
            providerExecuted: true
          }
        ]
      }
    ])

    expect(step?.type === "assistant" && step.content).toEqual([
      expect.objectContaining({
        id: "a",
        state: { status: "completed", input: {}, content: [{ type: "text", text: "ok" }] }
      }),
      expect.objectContaining({
        id: "b",
        state: {
          status: "error",
          input: {},
          error: { type: "unknown", message: "The conversation recorded no result of the call" }
        }
      })
    ])
  })

  it("makes ids as opencode does, unique and in order, ending with the session's random part", () => {
    const ids = messages([
      { role: "user", content: "One." },
      { role: "assistant", content: [{ type: "text", text: "Two." }] },
      { role: "user", content: "Three." }
    ]).map((message) => message.id)

    for (const id of ids) expect(id).toMatch(/^msg_[0-9a-f]{12}BYbN21QzYS7lIf$/)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })

  it("refuses a conversation opencode cannot record", () => {
    const file = { type: "file", mediaType: "text/plain", data: "aGk=" } as const

    expect(
      refusal([
        { role: "user", content: "Show me." },
        { role: "assistant", content: [file] }
      ])
    ).toMatchObject({ description: "opencode records no files that an assistant wrote" })
    expect(
      refusal([
        {
          role: "user",
          content: [{ ...file, data: new URL("https://example.com/a.txt") }]
        }
      ])
    ).toMatchObject({ description: "opencode records the files of a conversation only as data" })
    expect(
      refusal([
        { role: "user", content: "Hi." },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "a",
              name: "shell",
              isFailure: false,
              result: "ok",
              providerExecuted: false
            }
          ]
        }
      ])
    ).toMatchObject({
      description: "opencode records tool results only after the assistant message that called them"
    })
  })
})
