if (process.argv.includes("--list-models")) {
  console.log("MODEL\nAuto\nNext Generation\n");
  process.exit(0);
}
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("--help")) {
  console.log("1.0.0-test");
  process.exit(0);
}
let input = "";
const index = args.indexOf("-p");
if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("-"))
  run(args[index + 1]);
else {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => run(input));
}
function run(prompt: string) {
  if (prompt.includes("HANG_TIMEOUT") || prompt.includes("CANCEL_REQUEST")) {
    process.on("SIGTERM", () => {
      if (prompt.includes("CANCEL_REQUEST"))
        require("node:fs").appendFileSync(
          process.env.QODER_TRACE_FILE!,
          "CANCELLED\n",
        );
      process.exit(0);
    });
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes("DELAY_REQUEST")) {
    setTimeout(() => emit(prompt), 250);
    return;
  }
  emit(prompt);
}
function emit(prompt: string) {
  if (prompt.includes("FAIL_EXIT")) {
    process.stderr.write("upstream unavailable");
    process.exit(7);
  }
  if (prompt.includes("EMPTY_OUTPUT")) process.exit(0);
  if (prompt.includes("RESULT_ERROR")) {
    console.log(
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "quota exhausted",
      }),
    );
    return;
  }
  if (prompt.includes("DIAGNOSTICS")) {
    console.log(
      JSON.stringify({ type: "system", message: "STARTUP_DIAGNOSTIC" }),
    );
    console.log("warning: this is not model output");
  }
  let workflow = "";
  if (prompt.includes("WORKFLOW_REQUEST")) {
    const marker =
      "Conversation (JSON; roles, tool calls and results are authoritative):\n";
    const history = JSON.parse(
      prompt.slice(prompt.indexOf(marker) + marker.length),
    );
    const last = history.at(-1);
    if (last.role === "tool") {
      const previous = history.at(-2)?.tool_calls?.[0];
      workflow =
        previous?.id === last.tool_call_id &&
        JSON.parse(previous.function.arguments).command === "pwd" &&
        last.content === "working dir: /project"
          ? "WORKFLOW_DONE"
          : "BROKEN_HISTORY";
    } else
      workflow =
        '{"tool_call":{"name":"terminal","arguments":{"command":"pwd"}}}';
  }
  const text =
    (prompt.includes("REPORT_EFFORT") ? (args.includes("--thinking") ? "THINKING="+args[args.indexOf("--thinking")+1] : "EFFORT="+args[args.indexOf("--reasoning-effort")+1]) : "") ||
    (prompt.includes("REPORT_MODEL")
      ? "CLI_MODEL=" + args[args.indexOf("--model") + 1]
      : "") ||
    workflow ||
    (prompt.includes("RETURN_TOOL")
      ? '{"tool_call":{"name":"terminal","arguments":{"command":"pwd"}}}'
      : prompt.includes("UNICODE")
        ? "🙂"
        : "FINAL_ANSWER");
  const bytes = Buffer.from(
    JSON.stringify({
      type: "assistant",
      subtype: "message",
      message: { content: [{ type: "text", text }], stop_reason: "end_turn" },
    }) + "\n",
  );
  if (text === "🙂") {
    const at = bytes.indexOf(Buffer.from("🙂")) + 2;
    process.stdout.write(bytes.subarray(0, at));
    setTimeout(() => process.stdout.write(bytes.subarray(at)), 40);
  } else process.stdout.write(bytes);
}
