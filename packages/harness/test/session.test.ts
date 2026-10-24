import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Ref, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { SessionId } from "../src/Agent.ts"
import * as Harness from "../src/Harness.ts"
import { HarnessError, UnavailableError, UnsupportedError } from "../src/HarnessError.ts"
import type { Session } from "../src/Session.ts"
import type { StreamPart } from "../src/StreamPart.ts"
import { type FakeAgentOptions, makeFakeAgent, makeFakeSandbox, readUntil, reply, type Script } from "./fakes.ts"

const id = SessionId.make("session-one")

const Add = Tool.make("Add", {
  parameters: Schema.Struct({ a: Schema.Finite, b: Schema.Finite }),
  success: Schema.Finite
})
const MathToolkit = Toolkit.make(Add)
const MathHandlers = MathToolkit.toLayer({ Add: ({ a, b }) => Effect.succeed(a + b) })

const answers: Script = (prompt) => Stream.fromIterable(reply(`codex answers ${prompt}`))

/** A step that reads the notes with the agent's own tool. */
const readingStep: ReadonlyArray<StreamPart> = [
  { type: "text-start", id: "plan" },
  { type: "text-delta", id: "plan", delta: "Reading the notes first." },
  { type: "text-end", id: "plan" },
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
  { type: "finish-step", reason: "tool-calls", usage: { inputTokens: {}, outputTokens: {} } }
]

/** The messages that record `readingStep` in a conversation. */
const readingMessages = [
  {
    role: "assistant",
    content: [
      { type: "text", text: "Reading the notes first." },
      { type: "tool-call", id: "call-read", name: "read", providerExecuted: false }
    ]
  },
  {
    role: "tool",
    content: [{ type: "tool-result", id: "call-read", result: "2 and 3", isFailure: false }]
  }
]

/** Creates a session on a fake agent following `script`. */
const createSession = (script: Script, options?: FakeAgentOptions) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeAgent("codex", script, options)
    const { sandbox } = yield* makeFakeSandbox
    const session = yield* Harness.make(fake.agent).createSession({ sandbox, id })
    return { fake, session }
  })

/** A host tool that deletes a file, which needs approval, and counts how often it ran. */
const makeDeleteToolkit = Effect.gen(function* () {
  const runs = yield* Ref.make(0)
  const Delete = Tool.make("Delete", {
    parameters: Schema.Struct({ path: Schema.String }),
    success: Schema.String,
    needsApproval: true
  })
  const DeleteToolkit = Toolkit.make(Delete)
  const toolkit = yield* DeleteToolkit.pipe(
    Effect.provide(
      DeleteToolkit.toLayer({
        Delete: ({ path }) =>
          Effect.as(
            Ref.update(runs, (count) => count + 1),
            `deleted ${path}`
          )
      })
    )
  )
  return { toolkit, runs }
})

/** An agent that calls `Delete` once and answers with what the host gives back. */
const callingDelete: Script = (_prompt, host) =>
  Stream.concat(
    Stream.make({
      type: "tool-call",
      id: "call-delete",
      name: "Delete",
      params: { path: "notes.md" }
    }),
    Stream.unwrap(Effect.map(host.toolResult, (result) => Stream.fromIterable(reply(JSON.stringify(result)))))
  )

/** Answers each approval request of a turn with `answer`, as the caller reading the turn would. */
const answering =
  (session: Session, answer: { readonly approved: boolean; readonly reason?: string }) =>
  <E, R>(turn: Stream.Stream<StreamPart, E, R>) =>
    Stream.tap(turn, (part) =>
      part.type === "tool-approval-request" ? session.approve({ approvalId: part.approvalId, ...answer }) : Effect.void
    )

/** The tool calls, approval requests, and tool results of a turn, in order, as the calls they name. */
const toolActivity = (parts: Iterable<StreamPart>) =>
  Array.from(parts).flatMap((part) => {
    switch (part.type) {
      case "tool-call":
        return [`call ${part.id}`]
      case "tool-approval-request":
        return [`ask ${part.toolCallId}`]
      case "tool-result":
        return [`result ${part.id}`]
      default:
        return []
    }
  })

describe("Session", () => {
  it.effect("streams a turn's parts as the agent sends them, and returns the whole turn", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession(answers)

      const parts = yield* Stream.runCollect(session.stream({ prompt: "hello" }))
      const result = yield* session.generate({ prompt: "again" })

      expect(parts).toEqual(reply("codex answers hello"))
      expect(result.text).toBe("codex answers again")
      expect(result.finishReason).toBe("stop")
    })
  )

  it.effect("runs the host's tool the agent calls and gives the agent its result", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession((_prompt, host) =>
        Stream.concat(
          Stream.make({ type: "tool-call", id: "call-one", name: "Add", params: { a: 2, b: 3 } }),
          Stream.unwrap(Effect.map(host.toolResult, (sum) => Stream.fromIterable(reply(`The sum is ${String(sum)}`))))
        )
      )

      const result = yield* session.generate({ prompt: "add", toolkit: yield* MathToolkit })

      expect(fake.turns[0]?.tools.map((tool) => tool.name)).toEqual(["Add"])
      expect(fake.submitted).toEqual([5])
      expect(result.toolResults).toEqual([
        {
          type: "tool-result",
          id: "call-one",
          name: "Add",
          result: 5,
          isFailure: false,
          providerExecuted: false,
          preliminary: false
        }
      ])
      expect(result.text).toBe("The sum is 5")
    }).pipe(Effect.provide(MathHandlers))
  )

  it.effect("fails with AgentContractError when the agent calls a tool the host does not have", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession(() =>
        Stream.make({ type: "tool-call", id: "call-one", name: "Delete", params: {} })
      )

      const error = yield* Effect.flip(session.generate({ prompt: "delete" }))

      expect(error).toMatchObject({ _tag: "HarnessError", reason: { _tag: "AgentContractError" } })
    })
  )

  it.effect("asks for JSON and decodes the answer with the schema", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession(() => Stream.fromIterable(reply('{"answer":42}')))

      const result = yield* session.generateObject({
        prompt: "answer",
        schema: Schema.Struct({ answer: Schema.Finite })
      })

      expect(fake.turns[0]?.responseFormat.type).toBe("json")
      expect(result.value).toEqual({ answer: 42 })
    })
  )

  it.effect("fails as Effect AI's generateObject does, keeping the answer that did not decode", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession(() => Stream.fromIterable(reply("not JSON")))

      const error = yield* Effect.flip(
        session.generateObject({
          prompt: "answer",
          schema: Schema.Struct({ answer: Schema.Finite })
        })
      )

      expect(error).toMatchObject({
        _tag: "AiError",
        reason: {
          _tag: "StructuredOutputError",
          responseText: "not JSON"
        }
      })
      expect(error.message).toContain("Harness.generateObject")
    })
  )

  it.effect("fails generate with TurnFailedError when the agent reports a failure, which stream shows", () =>
    Effect.gen(function* () {
      const failure = { message: "The key was rejected" }
      const { session } = yield* createSession(() =>
        Stream.make(
          { type: "error", error: failure },
          { type: "finish", reason: "error", usage: { inputTokens: {}, outputTokens: {} } }
        )
      )

      const parts = yield* Stream.runCollect(session.stream({ prompt: "hello" }))
      const error = yield* Effect.flip(session.generate({ prompt: "hello" }))

      expect(parts[0]).toEqual({ type: "error", error: failure })
      expect(error).toMatchObject({
        _tag: "HarnessError",
        reason: {
          _tag: "TurnFailedError",
          error: failure
        }
      })
    })
  )

  it.effect("refuses a turn while another runs, and takes one again once that turn is interrupted", () =>
    Effect.gen(function* () {
      const running = yield* Deferred.make<void>()
      const { session } = yield* createSession((prompt, host) =>
        prompt === "slow"
          ? Stream.concat(Stream.fromEffectDrain(Deferred.succeed(running, undefined)), Stream.never)
          : answers(prompt, host)
      )

      const slow = yield* Stream.runCollect(session.stream({ prompt: "slow" })).pipe(Effect.forkChild)
      yield* Deferred.await(running)
      const refused = yield* Effect.flip(session.generate({ prompt: "hello" }))
      yield* Fiber.interrupt(slow)
      const result = yield* session.generate({ prompt: "hello" })

      expect(refused).toMatchObject({ _tag: "HarnessError", reason: { _tag: "TurnInProgressError" } })
      expect(result.text).toBe("codex answers hello")
    })
  )

  it.effect("suspends a running turn, ending its stream, and returns it unfinished", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession(() =>
        Stream.concat(Stream.make({ type: "text-start", id: "answer" }), Stream.never)
      )

      const slow = yield* readUntil(session.stream({ prompt: "slow" }), () => true)
      const state = yield* session.suspendTurn
      const parts = yield* Fiber.join(slow)
      const refused = yield* Effect.flip(session.generate({ prompt: "hello" }))

      expect(parts).toEqual([{ type: "text-start", id: "answer" }])
      expect(state.unfinishedTurn?.agentState).toEqual({ agent: "codex", turn: true })
      expect(state.history.content).toEqual([])
      expect(refused).toMatchObject({ _tag: "HarnessError", reason: { _tag: "SessionReleasedError" } })
    })
  )

  it.effect("destroys a session already released, and again after it is destroyed", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession(answers)
      yield* session.detach

      yield* session.destroy
      yield* session.destroy
      const refused = yield* Effect.flip(session.generate({ prompt: "hello" }))

      expect(refused.reason._tag).toBe("SessionReleasedError")
    })
  )

  it.effect("records a turn that finishes while the session suspends, and leaves no turn unfinished", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const answering = yield* Deferred.make<void>()
      const answered = yield* Deferred.make<void>()
      const { session } = yield* createSession(
        () =>
          Stream.concat(
            Stream.fromEffectDrain(Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(answering))),
            Stream.fromIterable(reply("Done"))
          ),
        // The turn finishes while the agent releases it.
        {
          beforeLettingGo: Effect.andThen(Deferred.succeed(answering, undefined), Deferred.await(answered))
        }
      )

      const reading = yield* session.stream({ prompt: "hello" }).pipe(
        Stream.runForEach((part) => (part.type === "finish" ? Deferred.succeed(answered, undefined) : Effect.void)),
        Effect.forkChild
      )
      yield* Deferred.await(started)
      const state = yield* session.suspendTurn
      yield* Fiber.join(reading)

      expect(state.unfinishedTurn).toBeUndefined()
      expect(state.history.content).toMatchObject([
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Done" }] }
      ])
    })
  )

  it.effect("ends a turn stop aborted with an error, keeping it as far as it got", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession(() =>
        Stream.concat(
          Stream.fromIterable<StreamPart>([
            ...readingStep,
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "The notes s" }
          ]),
          Stream.never
        )
      )

      const reading = yield* readUntil(
        session.stream({ prompt: "Read the notes" }),
        (part) => part.type === "text-delta" && part.id === "answer"
      )
      const state = yield* session.stop
      const parts = yield* Fiber.join(reading)

      expect(parts.slice(-2)).toMatchObject([
        { type: "error", error: { type: "aborted" } },
        { type: "finish", reason: "error" }
      ])
      expect(state.unfinishedTurn).toBeUndefined()
      expect(state.history.content).toMatchObject([
        { role: "user", content: [{ type: "text", text: "Read the notes" }] },
        ...readingMessages,
        { role: "assistant", content: [{ type: "text", text: "The notes s" }] }
      ])
    })
  )

  it.effect("keeps a turn the caller stopped reading in the conversation, answering the call it left", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession(() =>
        Stream.concat(Stream.fromIterable(readingStep.slice(0, 4)), Stream.never)
      )

      yield* session.stream({ prompt: "Read the notes" }).pipe(
        Stream.takeUntil((part) => part.type === "tool-call"),
        Stream.runDrain
      )
      const state = yield* session.detach

      expect(state.history.content).toMatchObject([
        { role: "user", content: [{ type: "text", text: "Read the notes" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading the notes first." },
            { type: "tool-call", id: "call-read" }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "call-read",
              isFailure: true,
              result: { type: "execution-interrupted" }
            }
          ]
        }
      ])
    })
  )

  it.effect("answers the calls of a turn that failed partway through a step", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession(() =>
        Stream.fromIterable<StreamPart>([
          ...readingStep.slice(0, 4),
          { type: "error", error: { message: "The connection broke" } },
          { type: "finish", reason: "error", usage: { inputTokens: {}, outputTokens: {} } }
        ])
      )

      yield* Effect.flip(session.generate({ prompt: "Read the notes" }))
      const state = yield* session.detach

      expect(state.history.content.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(state.history.content[2]).toMatchObject({
        content: [{ type: "tool-result", id: "call-read", isFailure: true }]
      })
    })
  )

  it.effect("runs the host's tools the agent calls together side by side, streaming results as they come", () =>
    Effect.gen(function* () {
      const opened = yield* Deferred.make<void>()
      const Wait = Tool.make("Wait", { success: Schema.String })
      const Open = Tool.make("Open", { success: Schema.String })
      const GateToolkit = Toolkit.make(Wait, Open)
      const toolkit = yield* GateToolkit.pipe(
        Effect.provide(
          GateToolkit.toLayer({
            Wait: () => Effect.as(Deferred.await(opened), "waited"),
            Open: () => Effect.as(Deferred.succeed(opened, undefined), "opened")
          })
        )
      )
      const { fake, session } = yield* createSession((_prompt, host) =>
        Stream.concat(
          Stream.make(
            { type: "tool-call", id: "call-wait", name: "Wait", params: {} },
            { type: "tool-call", id: "call-open", name: "Open", params: {} }
          ),
          Stream.unwrap(Effect.as(Effect.andThen(host.toolResult, host.toolResult), Stream.fromIterable(reply("Done"))))
        )
      )

      const parts = yield* Stream.runCollect(session.stream({ prompt: "gate", toolkit }))

      // The turn ends only if Open runs while Wait waits for it.
      expect(fake.submitted).toHaveLength(2)
      expect(toolActivity(parts).sort()).toEqual([
        "call call-open",
        "call call-wait",
        "result call-open",
        "result call-wait"
      ])
    })
  )

  it.effect("ends a step only once the tools it called have answered", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession((_prompt, host) =>
        Stream.concat(
          Stream.make(
            { type: "tool-call", id: "call-one", name: "Add", params: { a: 2, b: 3 } },
            {
              type: "finish-step",
              reason: "tool-calls",
              usage: { inputTokens: {}, outputTokens: {} }
            }
          ),
          Stream.unwrap(Effect.map(host.toolResult, (sum) => Stream.fromIterable(reply(`The sum is ${String(sum)}`))))
        )
      )

      const parts = yield* Stream.runCollect(session.stream({ prompt: "add", toolkit: yield* MathToolkit }))

      // The agent ended the step before the result; the step the caller reads ends after it.
      expect(parts.map((part) => part.type).slice(0, 3)).toEqual(["tool-call", "tool-result", "finish-step"])
    }).pipe(Effect.provide(MathHandlers))
  )

  it.effect("asks before running a host tool that needs approval, and runs it once approved", () =>
    Effect.gen(function* () {
      const { toolkit, runs } = yield* makeDeleteToolkit
      const { fake, session } = yield* createSession(callingDelete)
      const whenAsked: Array<{ readonly runs: number; readonly submitted: number }> = []

      const parts = yield* Stream.runCollect(
        session.stream({ prompt: "clean", toolkit }).pipe(
          Stream.tap((part) =>
            part.type === "tool-approval-request"
              ? Effect.gen(function* () {
                  whenAsked.push({ runs: yield* Ref.get(runs), submitted: fake.submitted.length })
                  yield* session.approve({ approvalId: part.approvalId, approved: true })
                })
              : Effect.void
          )
        )
      )

      // Neither the tool nor the agent had anything before the answer.
      expect(whenAsked).toEqual([{ runs: 0, submitted: 0 }])
      expect(yield* Ref.get(runs)).toBe(1)
      expect(fake.submitted).toEqual(["deleted notes.md"])
      expect(toolActivity(parts)).toEqual(["call call-delete", "ask call-delete", "result call-delete"])
    })
  )

  it.effect("answers a call that approve refuses as denied, and does not run the tool", () =>
    Effect.gen(function* () {
      const { toolkit, runs } = yield* makeDeleteToolkit
      const { fake, session } = yield* createSession(callingDelete)

      const parts = yield* Stream.runCollect(
        session.stream({ prompt: "clean", toolkit }).pipe(answering(session, { approved: false, reason: "Not now" }))
      )
      const state = yield* session.detach

      const denied = { type: "execution-denied", reason: "Not now" }
      expect(yield* Ref.get(runs)).toBe(0)
      expect(fake.submitted).toEqual([denied])
      expect(Array.from(parts).filter((part) => part.type === "tool-result")).toMatchObject([
        { id: "call-delete", isFailure: true, providerExecuted: false, result: denied }
      ])
      // The conversation records the call and its denial, which any model reads.
      expect(state.history.content.find((message) => message.role === "tool")).toMatchObject({
        content: [{ type: "tool-result", id: "call-delete", isFailure: true, result: denied }]
      })
    })
  )

  it.effect("gives a refusal without a reason one the agent can read", () =>
    Effect.gen(function* () {
      const { toolkit } = yield* makeDeleteToolkit
      const { fake, session } = yield* createSession(callingDelete)

      yield* Stream.runDrain(session.stream({ prompt: "clean", toolkit }).pipe(answering(session, { approved: false })))

      expect(fake.submitted).toEqual([{ type: "execution-denied", reason: expect.stringMatching(/\S/) }])
    })
  )

  it.effect("decides per call when needsApproval is a function of the params and the conversation", () =>
    Effect.gen(function* () {
      const seen: Array<{
        readonly amount: number
        readonly toolCallId: string
        readonly roles: ReadonlyArray<string>
      }> = []
      const Transfer = Tool.make("Transfer", {
        parameters: Schema.Struct({ amount: Schema.Finite }),
        success: Schema.String,
        needsApproval: ({ amount }, { toolCallId, messages }) => {
          seen.push({ amount, toolCallId, roles: messages.map((message) => message.role) })
          return amount > 100
        }
      })
      const TransferToolkit = Toolkit.make(Transfer)
      const toolkit = yield* TransferToolkit.pipe(
        Effect.provide(
          TransferToolkit.toLayer({
            Transfer: ({ amount }) => Effect.succeed(`moved ${amount}`)
          })
        )
      )
      const { fake, session } = yield* createSession((_prompt, host) =>
        Stream.concat(
          Stream.make(
            { type: "tool-call", id: "call-small", name: "Transfer", params: { amount: 50 } },
            { type: "tool-call", id: "call-large", name: "Transfer", params: { amount: 500 } }
          ),
          Stream.unwrap(Effect.as(Effect.andThen(host.toolResult, host.toolResult), Stream.fromIterable(reply("Done"))))
        )
      )

      const parts = yield* Stream.runCollect(
        session.stream({ prompt: "pay", toolkit }).pipe(answering(session, { approved: true }))
      )

      // Only the large transfer asks; the conversation the function reads holds the turn's prompt.
      const activity = toolActivity(parts)
      expect([...activity].sort()).toEqual([
        "ask call-large",
        "call call-large",
        "call call-small",
        "result call-large",
        "result call-small"
      ])
      expect(activity.indexOf("ask call-large")).toBeLessThan(activity.indexOf("result call-large"))
      expect(fake.submitted).toEqual(["moved 50", "moved 500"])
      expect(seen).toEqual([
        { amount: 50, toolCallId: "call-small", roles: ["user"] },
        { amount: 500, toolCallId: "call-large", roles: ["user"] }
      ])
    })
  )

  it.effect("asks about the calls the agent makes together at once, answered in any order", () =>
    Effect.gen(function* () {
      const { toolkit, runs } = yield* makeDeleteToolkit
      const { fake, session } = yield* createSession((_prompt, host) =>
        Stream.concat(
          Stream.make(
            { type: "tool-call", id: "call-a", name: "Delete", params: { path: "a.md" } },
            { type: "tool-call", id: "call-b", name: "Delete", params: { path: "b.md" } }
          ),
          Stream.unwrap(Effect.as(Effect.andThen(host.toolResult, host.toolResult), Stream.fromIterable(reply("Done"))))
        )
      )
      /** The requests read so far, by the call each is for. */
      const asked = new Map<string, string>()
      const approve = (toolCallId: string) =>
        session.approve({ approvalId: asked.get(toolCallId) ?? "", approved: true })

      const parts = yield* Stream.runCollect(
        session.stream({ prompt: "clean", toolkit }).pipe(
          Stream.tap((part) => {
            if (part.type === "tool-approval-request") asked.set(part.toolCallId, part.approvalId)
            // Both requests arrive before either is answered: b first, then a once b has run.
            if (asked.size === 2 && part.type === "tool-approval-request") return approve("call-b")
            if (part.type === "tool-result" && part.id === "call-b") return approve("call-a")
            return Effect.void
          })
        )
      )

      const activity = toolActivity(parts)
      expect(activity.slice(0, 4).sort()).toEqual(["ask call-a", "ask call-b", "call call-a", "call call-b"])
      expect(activity.slice(4)).toEqual(["result call-b", "result call-a"])
      expect(fake.submitted).toEqual(["deleted b.md", "deleted a.md"])
      expect(yield* Ref.get(runs)).toBe(2)
    })
  )

  it.effect("denies approval requests in a turn it returns whole, and does not run the tool", () =>
    Effect.gen(function* () {
      const { toolkit, runs } = yield* makeDeleteToolkit
      const { fake, session } = yield* createSession(callingDelete)

      const result = yield* session.generate({ prompt: "clean", toolkit })

      expect(yield* Ref.get(runs)).toBe(0)
      expect(fake.submitted).toMatchObject([{ type: "execution-denied" }])
      expect(result.toolResults).toMatchObject([
        { id: "call-delete", isFailure: true, result: { type: "execution-denied" } }
      ])
    })
  )

  it.effect("passes on approvals it did not ask for, also once the stream that asked ended", () =>
    Effect.gen(function* () {
      const { toolkit, runs } = yield* makeDeleteToolkit
      const { fake, session } = yield* createSession(callingDelete)
      const asked = yield* Deferred.make<string>()
      const reading = yield* Effect.forkChild(
        Stream.runDrain(
          session
            .stream({ prompt: "clean", toolkit })
            .pipe(
              Stream.tap((part) =>
                part.type === "tool-approval-request" ? Deferred.succeed(asked, part.approvalId) : Effect.void
              )
            )
        )
      )
      const approvalId = yield* Deferred.await(asked)
      yield* Fiber.interrupt(reading)

      // The request ended with its stream, so its answer is the agent's to take, as is any other.
      yield* session.approve({ approvalId, approved: true })
      yield* session.approve({ approvalId: "agent-asked", approved: false, reason: "No" })

      expect(fake.approvals).toEqual([
        { approvalId, approved: true },
        { approvalId: "agent-asked", approved: false, reason: "No" }
      ])
      expect(yield* Ref.get(runs)).toBe(0)
    })
  )

  it.effect("leaves a turn the agent refused before it began out of the conversation", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession(() =>
        Stream.fail(
          new HarnessError({
            agent: "codex",
            reason: new UnsupportedError({ description: "No such model" })
          })
        )
      )

      yield* Effect.flip(session.generate({ prompt: "hello" }))
      const state = yield* session.detach

      expect(state.history.content).toEqual([])
    })
  )

  it.effect("starts no turn while it releases the session", () =>
    Effect.gen(function* () {
      const lettingGo = yield* Deferred.make<void>()
      const letGo = yield* Deferred.make<void>()
      const { fake, session } = yield* createSession(answers, {
        beforeLettingGo: Effect.andThen(Deferred.succeed(lettingGo, undefined), Deferred.await(letGo))
      })

      const detaching = yield* Effect.forkChild(session.detach)
      yield* Deferred.await(lettingGo)
      const refused = yield* Effect.flip(session.generate({ prompt: "hello" }))
      yield* Deferred.succeed(letGo, undefined)
      const state = yield* Fiber.join(detaching)

      expect(refused.reason._tag).toBe("SessionReleasedError")
      expect(fake.turns).toEqual([])
      expect(state.history.content).toEqual([])
    })
  )

  it.effect("stays open when the agent fails to release the session, so that it can be tried again", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const unavailable = new HarnessError({ agent: "codex", reason: new UnavailableError({}) })
      const { session } = yield* createSession(answers, {
        beforeLettingGo: Effect.flatMap(
          Ref.getAndUpdate(attempts, (n) => n + 1),
          (attempt) => (attempt === 0 ? Effect.fail(unavailable) : Effect.void)
        )
      })

      const failed = yield* Effect.flip(session.stop)
      const result = yield* session.generate({ prompt: "hello" })
      const state = yield* session.stop

      expect(failed.reason._tag).toBe("UnavailableError")
      expect(result.text).toBe("codex answers hello")
      expect(state.history.content).toMatchObject([
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "codex answers hello" }] }
      ])
    })
  )

  it.effect("refuses to detach while a turn runs", () =>
    Effect.gen(function* () {
      const running = yield* Deferred.make<void>()
      const { session } = yield* createSession(() =>
        Stream.concat(Stream.fromEffectDrain(Deferred.succeed(running, undefined)), Stream.never)
      )

      yield* Stream.runCollect(session.stream({ prompt: "slow" })).pipe(Effect.forkChild)
      yield* Deferred.await(running)
      const refused = yield* Effect.flip(session.detach)

      expect(refused.reason._tag).toBe("TurnInProgressError")
    })
  )

  it.effect("records each step of a turn, with the tools called and their results, whoever ran them", () =>
    Effect.gen(function* () {
      const usage = { inputTokens: {}, outputTokens: {} }
      const readStep: ReadonlyArray<StreamPart> = [
        ...readingStep,
        { type: "tool-call", id: "call-add", name: "Add", params: { a: 2, b: 3 } }
      ]
      const { session } = yield* createSession((_prompt, host) =>
        Stream.concat(
          Stream.fromIterable(readStep),
          Stream.unwrap(
            Effect.map(host.toolResult, (sum) =>
              Stream.fromIterable<StreamPart>([
                { type: "finish-step", reason: "tool-calls", usage },
                ...reply(`The sum is ${String(sum)}`)
              ])
            )
          )
        )
      )

      yield* session.generate({
        prompt: "Add the numbers in notes.md",
        toolkit: yield* MathToolkit
      })
      const state = yield* session.detach

      expect(state.history.content).toMatchObject([
        { role: "user", content: [{ type: "text", text: "Add the numbers in notes.md" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading the notes first." },
            {
              type: "tool-call",
              id: "call-read",
              name: "read",
              params: { path: "notes.md" },
              providerExecuted: false
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "call-read",
              name: "read",
              result: "2 and 3",
              isFailure: false,
              providerExecuted: false
            }
          ]
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              id: "call-add",
              name: "Add",
              params: { a: 2, b: 3 },
              providerExecuted: false
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "call-add",
              name: "Add",
              result: 5,
              isFailure: false,
              providerExecuted: false
            }
          ]
        },
        { role: "assistant", content: [{ type: "text", text: "The sum is 5" }] }
      ])
    }).pipe(Effect.provide(MathHandlers))
  )

  it.effect("records each finished turn's prompt and answer in the conversation it returns", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession(answers)

      yield* session.generate({ prompt: "hello" })
      yield* session.generate({ prompt: "again" })
      const state = yield* session.detach

      expect(
        state.history.content.map((message) => [
          message.role,
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
        ])
      ).toEqual([
        ["user", "hello"],
        ["assistant", "codex answers hello"],
        ["user", "again"],
        ["assistant", "codex answers again"]
      ])
      expect(state.agentState).toEqual({ agent: "codex" })
    })
  )
})

describe("Session compaction", () => {
  /** The user message a compacted conversation starts with, holding `summary`. */
  const summaryMessage = (summary: string) => ({
    role: "user",
    content: [{ type: "text", text: expect.stringMatching(new RegExp(`\n\n${summary}$`)) }]
  })

  it.effect("keeps a compaction the agent makes during a turn in place of what came before", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession((prompt, host) =>
        prompt === "long"
          ? Stream.fromIterable([
              ...readingStep,
              { type: "compaction", trigger: "auto", summary: "codex read the notes" },
              ...reply("The sum is 5")
            ])
          : answers(prompt, host)
      )

      yield* session.generate({ prompt: "hello" })
      const parts = yield* Stream.runCollect(session.stream({ prompt: "long" }))
      yield* session.generate({ prompt: "again" })
      const state = yield* session.detach

      expect(parts).toContainEqual({
        type: "compaction",
        trigger: "auto",
        summary: "codex read the notes"
      })
      expect(state.history.content).toMatchObject([
        summaryMessage("codex read the notes"),
        { role: "assistant", content: [{ type: "text", text: "The sum is 5" }] },
        { role: "user", content: [{ type: "text", text: "again" }] },
        { role: "assistant", content: [{ type: "text", text: "codex answers again" }] }
      ])
    })
  )

  it.effect("compacts between turns, and the conversation goes on from the summary", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession(answers)

      yield* session.generate({ prompt: "hello" })
      const compaction = yield* session.compact("keep the greeting")
      yield* session.generate({ prompt: "again" })
      const state = yield* session.detach

      expect(compaction).toEqual({
        type: "compaction",
        trigger: "manual",
        summary: "codex summarizes, keep the greeting"
      })
      expect(state.history.content).toMatchObject([
        summaryMessage("codex summarizes, keep the greeting"),
        { role: "user", content: [{ type: "text", text: "again" }] },
        { role: "assistant", content: [{ type: "text", text: "codex answers again" }] }
      ])
    })
  )

  it.effect("refuses to compact while a turn runs", () =>
    Effect.gen(function* () {
      const running = yield* Deferred.make<void>()
      const { session } = yield* createSession(() =>
        Stream.concat(Stream.fromEffectDrain(Deferred.succeed(running, undefined)), Stream.never)
      )

      yield* Stream.runCollect(session.stream({ prompt: "slow" })).pipe(Effect.forkChild)
      yield* Deferred.await(running)
      const refused = yield* Effect.flip(session.compact())

      expect(refused.reason._tag).toBe("TurnInProgressError")
    })
  )

  it.effect("starts no turn while it compacts", () =>
    Effect.gen(function* () {
      const compacting = yield* Deferred.make<void>()
      const compacted = yield* Deferred.make<void>()
      const { fake, session } = yield* createSession(answers, {
        beforeCompacting: Effect.andThen(Deferred.succeed(compacting, undefined), Deferred.await(compacted))
      })

      const compaction = yield* Effect.forkChild(session.compact())
      yield* Deferred.await(compacting)
      const refused = yield* Effect.flip(session.generate({ prompt: "hello" }))
      yield* Deferred.succeed(compacted, undefined)
      yield* Fiber.join(compaction)
      const result = yield* session.generate({ prompt: "again" })

      expect(refused.reason._tag).toBe("TurnInProgressError")
      expect(fake.turns.map((turn) => turn.prompt.content)).toMatchObject([[{ type: "text", text: "again" }]])
      expect(result.text).toBe("codex answers again")
    })
  )

  it.effect("keeps the conversation as it was when the agent fails to compact", () =>
    Effect.gen(function* () {
      const unsupported = new HarnessError({ agent: "codex", reason: new UnsupportedError({}) })
      const { session } = yield* createSession(answers, {
        beforeCompacting: Effect.fail(unsupported)
      })

      yield* session.generate({ prompt: "hello" })
      const failed = yield* Effect.flip(session.compact())
      yield* session.generate({ prompt: "again" })
      const state = yield* session.detach

      expect(failed.reason._tag).toBe("UnsupportedError")
      expect(state.history.content.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"])
    })
  )
})
