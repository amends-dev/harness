/**
 * The bridge program of the opencode agent, which a host launches in its sandbox, over opencode 1's
 * session API, as `BunBridge.runProgram` runs it.
 */

import * as BunBridge from "../bunBridge.ts"
import { makeCreateSession } from "./session.ts"

BunBridge.runProgram("opencode", import.meta.dirname, makeCreateSession)
