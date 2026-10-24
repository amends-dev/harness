/**
 * The bridge program of the opencode 2 agent, which a host launches in its sandbox, over opencode
 * 2's session API, as `BunBridge.runProgram` runs it.
 */

import * as BunBridge from "../bunBridge.ts"
import { makeCreateSession } from "./session.ts"

BunBridge.runProgram("opencode2", import.meta.dirname, makeCreateSession)
