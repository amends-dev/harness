// A stand-in for `opencode serve`, which tests install as the command that runs opencode. It
// starts as opencode does, with `serve --hostname=… --port=…`, the server's password in its
// environment, and its configuration in the directory its environment names, listens on the port
// it is given, and announces it on its output as opencode does. Behind the password, it answers
// opencode's health check and creates sessions, over either session API. It adds a line to
// `starts.jsonl` beside itself for each start. Given `FAKE_OPENCODE_EXIT`, it exits with that code
// before it listens, as a server that fails does, and given `FAKE_OPENCODE_EXIT_AFTER`, it exits
// that many milliseconds after it listens.
import { appendFileSync, readFileSync } from "node:fs"

const argument = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(`--${name}=`.length)

if (process.env.FAKE_OPENCODE_EXIT !== undefined) {
  process.exit(Number(process.env.FAKE_OPENCODE_EXIT))
}

appendFileSync(
  `${import.meta.dir}/starts.jsonl`,
  `${JSON.stringify({
    args: process.argv.slice(2),
    configDirectory: process.env.OPENCODE_CONFIG_DIR,
    config: JSON.parse(readFileSync(`${process.env.OPENCODE_CONFIG_DIR}/opencode.json`, "utf8")),
    greeting: process.env.GREETING,
    pid: process.pid
  })}\n`
)

const authorization = `Basic ${btoa(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`)}`

const server = Bun.serve({
  hostname: argument("hostname"),
  port: Number(argument("port")),
  fetch: (request) => {
    if (request.headers.get("authorization") !== authorization) {
      return new Response(null, { status: 401 })
    }
    const { pathname } = new URL(request.url)
    if (pathname === "/api/health") return Response.json({ healthy: true })
    // opencode 2's session API, and opencode 1's.
    if (request.method === "POST" && pathname === "/api/session") {
      return Response.json({ data: { id: "ses_standin" } })
    }
    if (request.method === "POST" && pathname === "/session") {
      return Response.json({ id: "ses_standin" })
    }
    return Response.json({ message: "Not found" }, { status: 404 })
  }
})

console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

if (process.env.FAKE_OPENCODE_EXIT_AFTER !== undefined) {
  setTimeout(() => process.exit(1), Number(process.env.FAKE_OPENCODE_EXIT_AFTER))
}
