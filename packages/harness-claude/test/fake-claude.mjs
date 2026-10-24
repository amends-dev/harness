// A tiny stand-in for Claude's stream-json subprocess protocol, exercised through the real SDK.
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n")
let input = ""
for await (const chunk of process.stdin) {
  input += chunk.toString()
  for (;;) {
    const newline = input.indexOf("\n")
    if (newline < 0) break
    const line = input.slice(0, newline)
    input = input.slice(newline + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.type === "control_request") {
      write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: request.request_id,
          response: { commands: [], output_style: "default", available_output_styles: ["default"], models: [] }
        }
      })
    }
    if (request.type === "user") {
      const session_id = process.argv[process.argv.indexOf("--session-id") + 1] ?? "session"
      const usage = { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      write({
        type: "system",
        subtype: "init",
        session_id,
        tools: [],
        mcp_servers: [],
        model: "claude-test",
        permissionMode: "default",
        slash_commands: [],
        apiKeySource: "user",
        uuid: "init"
      })
      write({
        type: "assistant",
        uuid: "assistant",
        session_id,
        parent_tool_use_id: null,
        message: {
          id: "answer",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "hello from the SDK subprocess" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage
        }
      })
      write({
        type: "result",
        subtype: "success",
        session_id,
        uuid: "result",
        is_error: false,
        result: "hello from the SDK subprocess",
        stop_reason: "end_turn",
        usage,
        num_turns: 1,
        duration_ms: 1,
        duration_api_ms: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: []
      })
    }
  }
}
