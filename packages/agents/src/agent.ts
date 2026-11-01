import type OpenAI from "openai";
import { CONVERSATION_PROMPT, ORDER_PROMPT } from "./prompts";
import { sanitizeForTts, takeSentences } from "./text";
import { executeOrderTool, ORDER_TOOLS, type OrderToolContext } from "./tools";

export type ChatClient = Pick<OpenAI["chat"]["completions"], "create">;

const MAX_MAIN_STEPS = 4;
const MAX_SUB_STEPS = 8;
const LLM_TIMEOUT_MS = 15_000;
const FILLER = "네, 확인해 볼게요.";
const FILLER_EN = "One moment, please.";

const CONVERSATION_TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "order_agent",
      description: "가게·메뉴 조회, 장바구니, 금액, 복창, 주문 실행을 맡깁니다.",
      parameters: { type: "object", properties: { instruction: { type: "string" } }, required: ["instruction"] },
    },
  },
  {
    type: "function",
    function: {
      name: "handoff",
      description: "사람 상담원에게 연결합니다.",
      parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
    },
  },
  {
    type: "function",
    function: { name: "end_call", description: "인사를 마친 뒤 통화를 끝냅니다.", parameters: { type: "object", properties: {} } },
  },
];

const ORDER_RESULT_FORMAT: OpenAI.ResponseFormatJSONSchema = {
  type: "json_schema",
  json_schema: {
    name: "order_result",
    schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ok", "need_info", "error"] },
        summary: { type: "string" },
      },
      required: ["status", "summary"],
    },
  },
};

export interface AgentHooks {
  speak(text: string): void;
  onToolCall(name: string, args: unknown, result: unknown): void;
  onFirstToken(): void;
  onUsage(usage: { prompt_tokens: number; completion_tokens: number }): void;
}

export type TurnAction = { type: "handoff"; reason: string } | { type: "end_call" } | null;

export interface AgentConfig {
  client: ChatClient;
  model: string;
}

function stateNote(ctx: OrderToolContext): string {
  return `[시스템 상태] ${JSON.stringify({
    customer: ctx.customer && { name: ctx.customer.name, default_address: ctx.customer.default_address, dietary_notes: ctx.customer.dietary_notes },
    registered: Boolean(ctx.customer),
    language: ctx.session.language,
    cart: ctx.session.cart,
    confirmation: ctx.session.status,
    placed_order: ctx.placedOrder,
  })}`;
}

async function runOrderAgent(instruction: string, ctx: OrderToolContext, config: AgentConfig, hooks: AgentHooks, signal: AbortSignal): Promise<string> {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: ORDER_PROMPT },
    { role: "system", content: stateNote(ctx) },
    { role: "user", content: instruction },
  ];
  for (let step = 0; step < MAX_SUB_STEPS; step++) {
    const response = await config.client.create(
      {
        model: config.model,
        messages,
        tools: ORDER_TOOLS,
        reasoning_effort: "low",
        response_format: ORDER_RESULT_FORMAT,
      } as OpenAI.ChatCompletionCreateParamsNonStreaming,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(LLM_TIMEOUT_MS)]) },
    );
    if (response.usage) hooks.onUsage(response.usage);
    const message = response.choices[0]!.message;
    if (!message.tool_calls?.length) return message.content ?? JSON.stringify({ status: "error", summary: "응답 없음" });
    messages.push(message);
    for (const call of message.tool_calls) {
      if (call.type !== "function") continue;
      const content = await runTool(call.function.name, call.function.arguments, ctx, hooks);
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  return JSON.stringify({ status: "error", summary: "주문 처리 단계가 너무 많습니다" });
}

// A tool failure goes back to the model as data so it can explain or recover; it never ends the call.
async function runTool(name: string, rawArgs: string, ctx: OrderToolContext, hooks: AgentHooks): Promise<string> {
  let result: unknown;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}");
    result = (await executeOrderTool(name, args, ctx)) ?? null;
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  }
  hooks.onToolCall(name, args, result);
  return JSON.stringify(result);
}

export async function runConversationTurn(
  messages: OpenAI.ChatCompletionMessageParam[],
  ctx: OrderToolContext,
  config: AgentConfig,
  hooks: AgentHooks,
  signal: AbortSignal,
): Promise<TurnAction> {
  let spokeThisTurn = false;
  const say = (raw: string) => {
    const text = sanitizeForTts(raw);
    if (!text) return;
    spokeThisTurn = true;
    hooks.speak(text);
  };

  for (let step = 0; step < MAX_MAIN_STEPS; step++) {
    const stream = await config.client.create(
      {
        model: config.model,
        messages: [{ role: "system", content: CONVERSATION_PROMPT }, { role: "system", content: stateNote(ctx) }, ...messages],
        tools: CONVERSATION_TOOLS,
        reasoning_effort: "minimal",
        stream: true,
        stream_options: { include_usage: true },
      } as OpenAI.ChatCompletionCreateParamsStreaming,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(LLM_TIMEOUT_MS)]) },
    );

    let text = "";
    let first = true;
    const calls: { id: string; name: string; arguments: string }[] = [];
    for await (const chunk of stream) {
      if (chunk.usage) hooks.onUsage(chunk.usage);
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (first && (delta.content || delta.tool_calls)) {
        first = false;
        hooks.onFirstToken();
      }
      if (delta.content) {
        text += delta.content;
      }
      for (const call of delta.tool_calls ?? []) {
        const slot = (calls[call.index] ??= { id: "", name: "", arguments: "" });
        slot.id ||= call.id ?? "";
        slot.name ||= call.function?.name ?? "";
        slot.arguments += call.function?.arguments ?? "";
      }
    }

    if (!calls.length) {
      const { sentences, rest } = takeSentences(text);
      [...sentences, rest].forEach(say);
      messages.push({ role: "assistant", content: text });
      // The model sometimes gives the arrival time and forgets end_call, which would leave the caller on the line.
      return ctx.placedOrder ? { type: "end_call" } : null;
    }

    if (!spokeThisTurn) say(ctx.session.language === "en" ? FILLER_EN : FILLER);
    // Text ahead of a tool call is the model narrating its plan, so the caller hears the filler instead.
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
    });

    let action: TurnAction = null;
    for (const call of calls) {
      let content: string;
      if (call.name === "order_agent") {
        const { instruction } = JSON.parse(call.arguments || "{}") as { instruction?: string };
        content = await runOrderAgent(instruction ?? "", ctx, config, hooks, signal);
      } else if (call.name === "handoff") {
        const { reason } = JSON.parse(call.arguments || "{}") as { reason?: string };
        action = { type: "handoff", reason: reason ?? "unknown" };
        content = "연결을 시작합니다";
      } else if (call.name === "end_call") {
        action = { type: "end_call" };
        content = "통화를 종료합니다";
      } else {
        content = JSON.stringify({ error: `알 수 없는 도구: ${call.name}` });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }

    // The system reads the recap verbatim, so the caller's "네" answers exactly these words.
    if (ctx.pendingRecap) {
      const recap = ctx.pendingRecap;
      ctx.pendingRecap = null;
      messages.push({ role: "assistant", content: recap });
      hooks.speak(recap);
      return null;
    }
    if (action) return action;
    // The system has announced the order, so the call ends without another model turn.
    if (ctx.placedOrder) return { type: "end_call" };
  }
  throw new Error("대화 단계가 너무 많습니다");
}
