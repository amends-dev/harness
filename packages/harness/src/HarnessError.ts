/**
 * Errors a harness reports when it cannot do what it was asked: start or resume a session, run or
 * continue a turn, or change the session's lifecycle. A failure the agent reports during a turn,
 * such as its model rejecting a key, arrives in the turn's stream as an `error` part, and the turn
 * finishes with the reason `error`. Only `generate` and `generateObject`, which return a whole
 * turn, fail on it, with `TurnFailedError`. An answer that does not match the schema
 * `generateObject` asked for fails as Effect AI's `generateObject` fails: with an `AiError` whose
 * reason is its `StructuredOutputError`.
 *
 * `HarnessError` says which agent failed and holds the reason, so callers can recover from one
 * reason with `Effect.catchReason("HarnessError", "NotFoundError", ...)`. The operation that failed
 * is the one the caller ran, which its span names. Each reason has a `description`, what happened
 * in the words of whoever reports it, and says with `isRetryable` whether trying again may succeed,
 * as the reasons of `AiError` do.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * The agent cannot do what it was asked, such as answer in JSON, compact on request, or work
 * without a sandbox.
 *
 * @category errors
 * @since 0.1.0
 */
export class UnsupportedError extends Schema.TaggedError<UnsupportedError>(
  "@amends-dev/harness/HarnessError/UnsupportedError"
)("UnsupportedError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The harness does not support this operation"
  }
}

/**
 * Something the agent was asked about does not exist, such as a session it lost.
 *
 * @category errors
 * @since 0.1.0
 */
export class NotFoundError extends Schema.TaggedError<NotFoundError>("@amends-dev/harness/HarnessError/NotFoundError")(
  "NotFoundError",
  { description: Schema.optional(Schema.String) }
) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The agent has no such session"
  }
}

/**
 * The session was released: `Harness.createSession` picks it up again from what that returned, as
 * `resumeFrom`.
 *
 * @category errors
 * @since 0.1.0
 */
export class SessionReleasedError extends Schema.TaggedError<SessionReleasedError>(
  "@amends-dev/harness/HarnessError/SessionReleasedError"
)("SessionReleasedError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The session was suspended, detached, stopped, or destroyed"
  }
}

/**
 * The session runs a turn, or holds one `suspendTurn` cut short, so it cannot start another,
 * detach, or compact until the turn ends.
 *
 * @category errors
 * @since 0.1.0
 */
export class TurnInProgressError extends Schema.TaggedError<TurnInProgressError>(
  "@amends-dev/harness/HarnessError/TurnInProgressError"
)("TurnInProgressError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The session is already running a turn"
  }
}

/**
 * The session has no turn for the operation: none running to suspend, or none to continue.
 *
 * @category errors
 * @since 0.1.0
 */
export class NoTurnError extends Schema.TaggedError<NoTurnError>("@amends-dev/harness/HarnessError/NoTurnError")(
  "NoTurnError",
  { description: Schema.optional(Schema.String) }
) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The session has no turn for this"
  }
}

/**
 * The agent reported that the turn failed, with the error of its `error` part.
 *
 * @category errors
 * @since 0.1.0
 */
export class TurnFailedError extends Schema.TaggedError<TurnFailedError>(
  "@amends-dev/harness/HarnessError/TurnFailedError"
)("TurnFailedError", { description: Schema.optional(Schema.String), error: Schema.Unknown }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The agent reported that the turn failed"
  }
}

/**
 * The agent sent the harness something it cannot read: an event it cannot translate, a call of a
 * tool the host does not have, or a saved state it cannot decode.
 *
 * @category errors
 * @since 0.1.0
 */
export class AgentContractError extends Schema.TaggedError<AgentContractError>(
  "@amends-dev/harness/HarnessError/AgentContractError"
)("AgentContractError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The agent sent the harness something it cannot read"
  }
}

/**
 * The agent cannot be reached right now, as when its bridge does not answer or its sandbox is
 * gone. Trying again may succeed.
 *
 * @category errors
 * @since 0.1.0
 */
export class UnavailableError extends Schema.TaggedError<UnavailableError>(
  "@amends-dev/harness/HarnessError/UnavailableError"
)("UnavailableError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return true
  }

  override get message(): string {
    return this.description ?? "The agent cannot be reached right now"
  }
}

/**
 * The harness failed for a reason none of the others names, such as a sandbox it could not make
 * a directory in.
 *
 * @category errors
 * @since 0.1.0
 */
export class UnknownError extends Schema.TaggedError<UnknownError>("@amends-dev/harness/HarnessError/UnknownError")(
  "UnknownError",
  { description: Schema.optional(Schema.String) }
) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The harness failed"
  }
}

/**
 * Why a harness failed: one of the errors above, which `HarnessError.reason` holds.
 *
 * @category errors
 * @since 0.1.0
 */
export const HarnessErrorReason = Schema.Union([
  UnsupportedError,
  NotFoundError,
  SessionReleasedError,
  TurnInProgressError,
  NoTurnError,
  TurnFailedError,
  AgentContractError,
  UnavailableError,
  UnknownError
]).pipe(Schema.toTaggedUnion("_tag"))

/**
 * @category errors
 * @since 0.1.0
 */
export type HarnessErrorReason = typeof HarnessErrorReason.Type

/**
 * The error every harness operation fails with: which agent failed, and why.
 *
 * **Example** (Recovering from one reason)
 *
 * ```ts
 * import { Session } from "@amends-dev/harness"
 * import { Effect } from "effect"
 *
 * declare const session: Session.Session
 *
 * const answer = session.generate({ prompt: "Hello" }).pipe(
 *   Effect.map((result) => result.text),
 *   Effect.catchReason("HarnessError", "UnavailableError", (error) =>
 *     Effect.succeed(`The agent is away: ${error.message}`)
 *   )
 * )
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class HarnessError extends Schema.TaggedError<HarnessError>("@amends-dev/harness/HarnessError")("HarnessError", {
  /** The agent that failed, as `Agent.id` names it. */
  agent: Schema.String,
  reason: HarnessErrorReason,
  cause: Schema.optional(Schema.Defect())
}) {
  get isRetryable(): boolean {
    return this.reason.isRetryable
  }

  override get message(): string {
    return `${this.agent}: ${this.reason.message}`
  }
}
