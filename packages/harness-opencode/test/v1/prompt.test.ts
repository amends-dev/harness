import { describe, expect, it } from "@effect/vitest"
import { Prompt } from "effect/ai"
import { conversationPartsOf, promptPartsOf } from "../../src/internal/bridge/v1/prompt.ts"

describe("opencode 1 prompts", () => {
  it("gives a prompt's texts as they are, and its files by URL", () => {
    const parts = promptPartsOf(
      Prompt.makeMessage("user", {
        content: [
          Prompt.makePart("text", { text: "Read these." }),
          Prompt.makePart("file", { mediaType: "text/plain", fileName: "a.txt", data: "aGk=" }),
          Prompt.makePart("file", { mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }),
          Prompt.makePart("file", {
            mediaType: "application/pdf",
            data: new URL("https://example.com/b.pdf")
          }),
          Prompt.makePart("file", { mediaType: "text/plain", data: "data:text/plain;base64,aGk=" })
        ]
      })
    )

    expect(parts).toEqual([
      { type: "text", text: "Read these." },
      { type: "file", mime: "text/plain", url: "data:text/plain;base64,aGk=", filename: "a.txt" },
      { type: "file", mime: "image/png", url: "data:image/png;base64,AQID" },
      { type: "file", mime: "application/pdf", url: "https://example.com/b.pdf" },
      { type: "file", mime: "text/plain", url: "data:text/plain;base64,aGk=" }
    ])
  })

  it("writes nothing for an empty conversation", () => {
    expect(conversationPartsOf(Prompt.empty)).toEqual([])
  })

  it("writes a conversation as one text for the model, with the files the user gave", () => {
    const parts = conversationPartsOf(
      Prompt.make([
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
            {
              type: "tool-call",
              id: "call_1",
              name: "lookup_weather",
              params: { city: "Lisbon" },
              providerExecuted: false
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
            }
          ]
        },
        { role: "assistant", content: [{ type: "text", text: "It is 14 degrees." }] }
      ])
    )

    expect(parts).toEqual([
      {
        type: "text",
        synthetic: true,
        text: [
          "This conversation continues one held earlier, which went as follows.",
          "",
          "System: Be brief.",
          "User: Check the weather in Lisbon.",
          "User attached the file notes.txt.",
          'Assistant called the tool lookup_weather with {"city":"Lisbon"}.',
          'The tool lookup_weather returned {"celsius":14}.',
          "Assistant: It is 14 degrees."
        ].join("\n")
      },
      {
        type: "file",
        mime: "text/plain",
        url: "data:text/plain;base64,aGk=",
        filename: "notes.txt"
      }
    ])
  })
})
