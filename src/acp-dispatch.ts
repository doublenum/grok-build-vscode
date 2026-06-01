/**
 * Pure dispatch helpers for the ACP wire protocol.
 *
 * Kept separate from `AcpClient` (which spawns + I/Os) so we can unit-test
 * the line-parsing, response correlation, and update routing without faking
 * a child process.
 */

export type DispatchEvent =
  | { kind: "response"; id: number | string; result?: any; error?: any }
  | { kind: "session-update"; update: any }
  | { kind: "server-request"; id?: number | string; method: string; params: any }
  | { kind: "non-json"; line: string };

export function parseAcpLine(line: string): DispatchEvent | null {
  if (!line.trim()) return null;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return { kind: "non-json", line };
  }
  if (msg.id != null && msg.method == null) {
    return { kind: "response", id: msg.id, result: msg.result, error: msg.error };
  }
  if (msg.method === "session/update") {
    return { kind: "session-update", update: msg.params?.update };
  }
  if (msg.method) {
    return { kind: "server-request", id: msg.id, method: msg.method, params: msg.params };
  }
  return null;
}

export type UpdateRoute =
  | { event: "messageChunk"; text: string }
  | { event: "userMessageChunk"; text: string }
  | { event: "thoughtChunk"; text: string }
  | { event: "toolCall"; payload: any }
  | { event: "toolCallUpdate"; payload: any }
  | { event: "plan"; payload: any }
  | { event: "modeChanged"; modeId: string }
  | { event: "commandsUpdate"; commands: any[] }
  | { event: "update"; payload: any };

export function routeSessionUpdate(u: any): UpdateRoute | null {
  if (!u) return null;
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      return { event: "messageChunk", text: u.content?.text ?? "" };
    case "user_message_chunk":
      return { event: "userMessageChunk", text: u.content?.text ?? "" };
    case "agent_thought_chunk":
      return { event: "thoughtChunk", text: u.content?.text ?? "" };
    case "tool_call":
      return { event: "toolCall", payload: u };
    case "tool_call_update":
      return { event: "toolCallUpdate", payload: u };
    case "plan":
      return { event: "plan", payload: u };
    case "current_mode_update":
      return { event: "modeChanged", modeId: u.currentModeId };
    case "available_commands_update":
      return { event: "commandsUpdate", commands: u.availableCommands ?? [] };
    default:
      return { event: "update", payload: u };
  }
}

export interface PromptResultMeta {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  reasoningTokens?: number;
  modelId?: string;
}

export function extractPromptMeta(result: any): PromptResultMeta {
  const m = result?._meta ?? {};
  return {
    totalTokens: m.totalTokens,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cachedReadTokens: m.cachedReadTokens,
    reasoningTokens: m.reasoningTokens,
    modelId: m.modelId,
  };
}

export function makePermissionResponse(id: number | string, optionId: string) {
  return {
    jsonrpc: "2.0",
    id,
    result: { outcome: { outcome: "selected", optionId } },
  };
}

export function makeExitPlanResponse(
  id: number | string,
  verdict: "approved" | "abandoned" | "rejected",
) {
  if (verdict === "approved") {
    return { jsonrpc: "2.0", id, result: { outcome: "approved" } };
  }
  // Reject and Abandon must be sent as JSON-RPC errors — the CLI treats any
  // successful result as approval regardless of the outcome value.
  const message = verdict === "rejected" ? "User rejected the plan" : "User abandoned the plan";
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

export function makeAckResponse(id: number | string, result: any = {}) {
  return { jsonrpc: "2.0", id, result };
}

// grok 0.2.x drives plan mode through `EnterPlanMode` / `ExitPlanMode` *tools*
// (rawInput.variant === "EnterPlanMode") rather than the older
// `current_mode_update` session event. Detect those tool calls so the host can
// raise/lower the plan gate. We key on the tool's own identity (variant / tool /
// name) — never the title — so a grep whose *pattern* contains "EnterPlanMode"
// (variant "Grep") can't masquerade as a real plan-mode tool.
export function planModeToolSignal(call: any): "enter" | "exit" | null {
  if (!call || typeof call !== "object") return null;
  const raw = call.rawInput || call.input || {};
  const id = String(
    (typeof raw.variant === "string" && raw.variant) || call.tool || call.name || "",
  )
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (id === "enterplanmode") return "enter";
  if (id === "exitplanmode") return "exit";
  return null;
}

// grok's ask_user_question elicitation. The method name varies by CLI build, so
// we recognize the request by shape: params carry a `questions` array (each with
// a `question` string + `options[]`). Returns the normalized question(s) or null.
export function extractUserQuestion(params: any): {
  question: string;
  options: { label: string; description?: string; optionId?: string }[];
  multiSelect?: boolean;
  header?: string;
  questions?: any[];
} | null {
  if (!params || typeof params !== "object") return null;
  const list = Array.isArray(params.questions)
    ? params.questions
    : Array.isArray(params.input?.questions)
      ? params.input.questions
      : null;
  const first = list?.[0];
  if (!first || typeof first.question !== "string" || !Array.isArray(first.options)) return null;
  const norm = (o: any, i: number) => ({
    label: typeof o === "string" ? o : String(o?.label ?? o?.name ?? o?.optionId ?? `Option ${i + 1}`),
    description: typeof o === "object" ? o?.description : undefined,
    optionId: typeof o === "object" ? (o?.optionId ?? o?.id) : undefined,
  });
  return {
    question: first.question,
    options: first.options.map(norm),
    multiSelect: !!first.multiSelect,
    header: first.header,
    questions: list,
  };
}

// Reply grok's deserializer accepts for ask_user_question: a top-level `outcome`
// of "selected" plus the chosen answers (the missing `outcome` field was the
// cause of "Client returned an invalid response … missing field `outcome`").
export function makeUserQuestionResponse(
  id: number | string,
  selections: { label: string; optionId?: string }[],
) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      outcome: "selected",
      // include several shapes so whichever field the CLI reads is satisfied
      answers: selections.map((s) => s.label),
      selectedOptions: selections.map((s) => ({ optionId: s.optionId, label: s.label })),
      options: selections.map((s) => s.label),
    },
  };
}

export function makeRequest(id: number, method: string, params: any) {
  return { jsonrpc: "2.0", id, method, params };
}
