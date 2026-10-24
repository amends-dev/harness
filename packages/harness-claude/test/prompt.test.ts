import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Prompt } from "effect/ai"
import { promptOf } from "../src/internal/bridge/prompt.ts"

it.effect("preserves supported image and PDF attachments", () =>
  Effect.gen(function* () {
    const message = yield* promptOf(
      Prompt.makeMessage("user", {
        content: [
          Prompt.makePart("text", { text: "read these" }),
          Prompt.makePart("file", { mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }),
          Prompt.makePart("file", { mediaType: "application/pdf", data: new URL("https://example.test/report.pdf") })
        ]
      }),
      Prompt.empty
    )
    expect(message.message.content).toEqual([
      { type: "text", text: "read these" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      { type: "document", source: { type: "url", url: "https://example.test/report.pdf" } }
    ])
  })
)
it.effect("refuses unsupported attachments before submitting the prompt", () =>
  Effect.gen(function* () {
    const error = yield* promptOf(
      Prompt.makeMessage("user", { content: [Prompt.makePart("file", { mediaType: "audio/wav", data: "AA==" })] }),
      Prompt.empty
    ).pipe(Effect.flip)
    expect(error.reason._tag).toBe("UnsupportedError")
  })
)
