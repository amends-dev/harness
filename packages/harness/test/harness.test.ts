import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { Prompt } from "effect/ai"
import { SessionId } from "../src/Agent.ts"
import * as Harness from "../src/Harness.ts"
import * as Session from "../src/Session.ts"
import type { StreamPart } from "../src/StreamPart.ts"
import { makeFakeAgent, makeFakeSandbox, readUntil, reply, type Script } from "./fakes.ts"

const id = SessionId.make("session-one")

/** A step that reads the notes with the agent's own tool. */
const readingStep: ReadonlyArray<StreamPart> = [
  { type: "text-start", id: "plan" },
  { type: "text-delta", id: "plan", delta: "Reading the notes." },
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
      { type: "text", text: "Reading the notes." },
      { type: "tool-call", id: "call-read", name: "read", params: { path: "notes.md" } }
    ]
  },
  { role: "tool", content: [{ type: "tool-result", id: "call-read", result: "2 and 3" }] }
]

/**
 * Answers each prompt in one step, except `slow`, which first reads the notes in a step of its own.
 * The first `slow` turn stops partway through its answer until it is suspended; run again once
 * `running` is done, it finishes.
 */
const answersAs =
  (agent: string, running?: Deferred.Deferred<void>): Script =>
  (prompt) => {
    const answer = Stream.fromIterable(reply(`${agent} answers ${prompt}`))
    if (prompt !== "slow" || running === undefined) return answer
    const answerUntilSuspended = Stream.concat(
      Stream.fromIterable<StreamPart>([
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: `${agent} answ` }
      ]),
      Stream.never
    )
    return Stream.concat(
      Stream.fromIterable(readingStep),
      Stream.unwrap(Effect.map(Deferred.isDone(running), (ranBefore) => (ranBefore ? answer : answerUntilSuspended)))
    )
  }

/**
 * Suspends a turn running on `harness` once the caller has read part of its answer, marking
 * `running` done, and returns the session as a caller would store it: as JSON.
 */
const suspendSlowTurn = (harness: Harness.Harness["Service"], running: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const { sandbox } = yield* makeFakeSandbox
    const session = yield* harness.createSession({ sandbox, id })
    const slow = yield* readUntil(
      session.stream({ prompt: "slow" }),
      (part) => part.type === "text-delta" && part.id === "answer"
    )
    yield* Deferred.succeed(running, undefined)
    const state = yield* session.suspendTurn
    yield* Fiber.join(slow)
    const json = Schema.fromJsonString(Schema.toCodecJson(Session.SessionState))
    return yield* Schema.decodeEffect(json)(yield* Schema.encodeEffect(json)(state))
  })

/** What a turn that adds answers with. */
const Sum = Schema.Struct({ sum: Schema.Finite })

const textsOf = (history: Prompt.Prompt) =>
  history.content.map((message) =>
    typeof message.content === "string"
      ? message.content
      : message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
  )

describe("Harness", () => {
  it.effect("creates a session in a directory named by its id, in the sandbox's working directory", () =>
    Effect.gen(function* () {
      const codex = yield* makeFakeAgent("codex", answersAs("codex"))
      const { sandbox, directories } = yield* makeFakeSandbox

      yield* Harness.make(codex.agent).createSession({ sandbox, id })

      expect(directories).toEqual(["/work/session-one"])
      expect(codex.createdWith[0]?.id).toBe(id)
      expect(codex.createdWith[0]?.workspace).toEqual({
        sandbox,
        directory: "/work/session-one"
      })
      expect(codex.createdWith[0]?.history.content).toEqual([])
      expect(codex.createdWith[0]?.agentState).toBeUndefined()
      expect(codex.createdWith[0]?.unfinishedTurn).toBeUndefined()
    })
  )

  it.effect("resumes a session on the agent that last ran it from that agent's own state", () =>
    Effect.gen(function* () {
      const codex = yield* makeFakeAgent("codex", answersAs("codex"))
      const harness = Harness.make(codex.agent)
      const { sandbox } = yield* makeFakeSandbox
      const session = yield* harness.createSession({ sandbox, id })
      yield* session.generate({ prompt: "hello" })
      const state = yield* session.detach

      yield* harness.createSession({ sandbox, resumeFrom: state })

      expect(codex.createdWith[1]?.agentState).toEqual({ agent: "codex" })
      expect(textsOf(codex.createdWith[1]?.history ?? state.history)).toEqual(["hello", "codex answers hello"])
    })
  )

  it.effect("gives another agent the conversation, but not the last agent's own state", () =>
    Effect.gen(function* () {
      const codex = yield* makeFakeAgent("codex", answersAs("codex"))
      const opencode = yield* makeFakeAgent("opencode", answersAs("opencode"))
      const { sandbox } = yield* makeFakeSandbox
      const onCodex = yield* Harness.make(codex.agent).createSession({ sandbox, id })
      yield* onCodex.generate({ prompt: "hello" })

      const onOpencode = yield* Harness.make(opencode.agent).createSession({
        sandbox,
        resumeFrom: yield* onCodex.detach
      })
      yield* onOpencode.generate({ prompt: "again" })
      const state = yield* onOpencode.detach

      expect(opencode.createdWith[0]?.agentState).toBeUndefined()
      expect(textsOf(opencode.createdWith[0]?.history ?? state.history)).toEqual(["hello", "codex answers hello"])
      expect(state.agent).toBe("opencode")
      expect(textsOf(state.history)).toEqual(["hello", "codex answers hello", "again", "opencode answers again"])
    })
  )

  it.effect("starts a new session with the conversation the agent joins", () =>
    Effect.gen(function* () {
      const codex = yield* makeFakeAgent("codex", answersAs("codex"))
      const { sandbox } = yield* makeFakeSandbox
      const history = Prompt.make([
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "opencode answers hello" }] }
      ])

      const session = yield* Harness.make(codex.agent).createSession({ sandbox, id, history })
      yield* session.generate({ prompt: "again" })
      const state = yield* session.detach

      expect(codex.createdWith[0]?.history).toEqual(history)
      expect(codex.createdWith[0]?.agentState).toBeUndefined()
      expect(textsOf(state.history)).toEqual(["hello", "opencode answers hello", "again", "codex answers again"])
    })
  )

  it.effect("continues an unfinished turn on the agent that suspended it, after the steps it finished", () =>
    Effect.gen(function* () {
      const running = yield* Deferred.make<void>()
      const codex = yield* makeFakeAgent("codex", answersAs("codex", running))
      const harness = Harness.make(codex.agent)
      const state = yield* suspendSlowTurn(harness, running)
      const { sandbox } = yield* makeFakeSandbox

      const session = yield* harness.createSession({ sandbox, resumeFrom: state })
      const refused = yield* Effect.flip(session.generate({ prompt: "hello" }))
      const result = yield* Stream.runCollect(session.continueStream({}))

      expect(state.unfinishedTurn?.steps).toMatchObject([
        {
          parts: [
            { type: "text", text: "Reading the notes." },
            { type: "tool-call", id: "call-read" },
            { type: "tool-result", id: "call-read" }
          ],
          finish: { type: "finish-step" }
        }
      ])
      expect(codex.createdWith[1]?.agentState).toBeUndefined()
      expect(codex.createdWith[1]?.unfinishedTurn).toEqual({ agent: "codex", turn: true })
      expect(session.hasUnfinishedTurn).toBe(true)
      expect(refused).toMatchObject({ _tag: "HarnessError", reason: { _tag: "TurnInProgressError" } })
      expect(codex.continued).toEqual([1])
      expect(result).toEqual(reply("codex answers slow"))
      expect((yield* session.detach).history.content).toMatchObject([
        { role: "user", content: [{ type: "text", text: "slow" }] },
        ...readingMessages,
        { role: "assistant", content: [{ type: "text", text: "codex answers slow" }] }
      ])
    })
  )

  it.effect("runs an unfinished turn again from its prompt on another agent", () =>
    Effect.gen(function* () {
      const running = yield* Deferred.make<void>()
      const codex = yield* makeFakeAgent("codex", answersAs("codex", running))
      const opencode = yield* makeFakeAgent("opencode", answersAs("opencode"))
      const state = yield* suspendSlowTurn(Harness.make(codex.agent), running)
      const { sandbox } = yield* makeFakeSandbox

      const session = yield* Harness.make(opencode.agent).createSession({
        sandbox,
        resumeFrom: state
      })
      const result = yield* Stream.runCollect(session.continueStream({}))

      expect(opencode.createdWith[0]?.unfinishedTurn).toBeUndefined()
      expect(result).toEqual(reply("opencode answers slow"))
      expect(textsOf((yield* session.detach).history)).toEqual(["slow", "opencode answers slow"])
    })
  )

  it.effect(
    "runs an unfinished turn again from its prompt, without the steps it finished, on an agent that lost it",
    () =>
      Effect.gen(function* () {
        const running = yield* Deferred.make<void>()
        const codex = yield* makeFakeAgent("codex", answersAs("codex", running), {
          losesUnfinishedTurns: true
        })
        const harness = Harness.make(codex.agent)
        const state = yield* suspendSlowTurn(harness, running)
        const { sandbox } = yield* makeFakeSandbox

        const session = yield* harness.createSession({ sandbox, resumeFrom: state })
        const result = yield* Stream.runCollect(session.continueStream({}))

        expect(session.hasUnfinishedTurn).toBe(false)
        expect(codex.continued).toEqual([])
        expect(codex.turns).toHaveLength(2)
        expect(result).toEqual([...readingStep, ...reply("codex answers slow")])
        expect((yield* session.detach).history.content).toMatchObject([
          { role: "user", content: [{ type: "text", text: "slow" }] },
          ...readingMessages,
          { role: "assistant", content: [{ type: "text", text: "codex answers slow" }] }
        ])
      })
  )

  it.effect("finishes an unfinished turn whole with continueGenerate", () =>
    Effect.gen(function* () {
      const running = yield* Deferred.make<void>()
      const codex = yield* makeFakeAgent("codex", answersAs("codex", running))
      const harness = Harness.make(codex.agent)
      const state = yield* suspendSlowTurn(harness, running)
      const { sandbox } = yield* makeFakeSandbox

      const session = yield* harness.createSession({ sandbox, resumeFrom: state })
      const result = yield* session.continueGenerate({})

      expect(state.unfinishedTurn?.responseFormat).toEqual({ type: "text" })
      expect(codex.continued).toEqual([1])
      expect(result.text).toBe("codex answers slow")
      expect((yield* session.detach).history.content).toMatchObject([
        { role: "user", content: [{ type: "text", text: "slow" }] },
        ...readingMessages,
        { role: "assistant", content: [{ type: "text", text: "codex answers slow" }] }
      ])
    })
  )

  it.effect("records that a suspended turn answers in JSON, which continueStream does not finish", () =>
    Effect.gen(function* () {
      const answering = yield* Deferred.make<void>()
      const codex = yield* makeFakeAgent("codex", () =>
        Stream.concat(
          Stream.fromIterable(readingStep),
          Stream.concat(Stream.fromEffect(Deferred.succeed(answering, undefined)), Stream.never)
        ).pipe(Stream.filter((part) => typeof part !== "boolean"))
      )
      const harness = Harness.make(codex.agent)
      const { sandbox } = yield* makeFakeSandbox
      const session = yield* harness.createSession({ sandbox, id })
      const turn = yield* Effect.forkChild(session.generateObject({ prompt: "add", schema: Sum, objectName: "Sum" }))
      yield* Deferred.await(answering)
      const state = yield* session.suspendTurn
      yield* Fiber.await(turn)

      const resumed = yield* harness.createSession({ sandbox, resumeFrom: state })
      const refused = yield* Effect.flip(Stream.runCollect(resumed.continueStream({})))

      expect(state.unfinishedTurn?.responseFormat).toEqual({ type: "json", objectName: "Sum" })
      expect(refused).toMatchObject({ _tag: "HarnessError", reason: { _tag: "NoTurnError" } })
    })
  )

  it.effect(
    "finishes an unfinished turn that answers in JSON with continueGenerateObject, given the schema again",
    () =>
      Effect.gen(function* () {
        const codex = yield* makeFakeAgent("codex", () => Stream.fromIterable(reply('{"sum":5}')))
        const { sandbox } = yield* makeFakeSandbox
        const session = yield* Harness.make(codex.agent).createSession({
          sandbox,
          resumeFrom: {
            id,
            agent: "codex",
            history: Prompt.empty,
            unfinishedTurn: {
              prompt: Prompt.makeMessage("user", {
                content: [Prompt.makePart("text", { text: "add" })]
              }),
              responseFormat: { type: "json", objectName: "Sum" },
              steps: [],
              agentState: { agent: "codex", turn: true }
            }
          }
        })
        const refused = yield* Effect.flip(session.continueGenerate({}))
        const result = yield* session.continueGenerateObject({ schema: Sum })
        const format = codex.turns[0]?.responseFormat

        expect(refused).toMatchObject({ _tag: "HarnessError", reason: { _tag: "NoTurnError" } })
        expect(format?.type === "json" && format.objectName).toBe("Sum")
        expect(format?.type === "json" && format.schema).toBe(Sum)
        expect(result.value).toEqual({ sum: 5 })
      })
  )

  it.effect("creates a session without a sandbox for an agent that does not require one", () =>
    Effect.gen(function* () {
      const amends = yield* makeFakeAgent("amends", answersAs("amends"), {
        requiresSandbox: false
      })

      const session = yield* Harness.make(amends.agent).createSession({ id })
      const result = yield* session.generate({ prompt: "how are you doing" })

      expect(amends.createdWith[0]?.workspace).toBeUndefined()
      expect(result.text).toBe("amends answers how are you doing")
    })
  )

  it.effect("needs a sandbox for an agent that requires one, also to take over a session", () =>
    Effect.gen(function* () {
      const amends = yield* makeFakeAgent("amends", answersAs("amends"), {
        requiresSandbox: false
      })
      const codex = yield* makeFakeAgent("codex", answersAs("codex"))
      const onAmends = yield* Harness.make(amends.agent).createSession({ id })
      yield* onAmends.generate({ prompt: "hello" })
      const state = yield* onAmends.detach
      const harness = Harness.make(codex.agent)

      const refusedStart = yield* Effect.flip(harness.createSession({ id }))
      const refusedResume = yield* Effect.flip(harness.createSession({ resumeFrom: state }))
      const { sandbox } = yield* makeFakeSandbox
      const onCodex = yield* harness.createSession({ sandbox, resumeFrom: state })
      const result = yield* onCodex.generate({ prompt: "again" })

      expect(refusedStart.reason._tag).toBe("UnsupportedError")
      expect(refusedResume.reason._tag).toBe("UnsupportedError")
      expect(textsOf(codex.createdWith[0]?.history ?? state.history)).toEqual(["hello", "amends answers hello"])
      expect(result.text).toBe("codex answers again")
    })
  )

  it.effect("tells how long a name the agent takes for a host tool, when it limits it", () =>
    Effect.gen(function* () {
      const limited = yield* makeFakeAgent("opencode", answersAs("opencode"), {
        maxToolNameLength: 59
      })
      const unlimited = yield* makeFakeAgent("codex", answersAs("codex"))

      expect(Harness.make(limited.agent).agent.maxToolNameLength).toBe(59)
      expect(Harness.make(unlimited.agent).agent.maxToolNameLength).toBeUndefined()
    })
  )

  it.effect("provides the harness through its layer", () =>
    Effect.gen(function* () {
      const codex = yield* makeFakeAgent("codex", answersAs("codex"))

      const harness = yield* Effect.provide(Harness.Harness, Harness.layer(codex.agent))

      expect(harness.agent.id).toBe("codex")
    })
  )
})
