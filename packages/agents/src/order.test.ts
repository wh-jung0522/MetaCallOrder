import type { Cart, Customer, CustomerRepository, MenuItem, MerchantAdapter, OrderResult, PlaceOrderContext, Store } from "@callorder/adapters";
import { describe, expect, it } from "vitest";
import { judgeConfirmation, runConversationTurn, type ChatClient } from "./agent";
import { buildRecap, OrderSession } from "./order-session";
import { isAffirmative, isBargeIn, isHandoffRequest, isNegative, isRepeatRequest, nextLanguage, sanitizeForTts, takeSentences, wonToKorean } from "./text";
import { executeOrderTool, type OrderToolContext } from "./tools";

const customer: Customer = {
  id: "c1", phone_e164: "+821000000001", name: "김순자", default_address: "행복동 12번지", lat: 37, lng: 127,
  dietary_notes: null, order_spend_limit: 50000, daily_spend_limit: 100000, preferred_speech_rate: 0.9, is_demo: true,
};
const gukbap: MenuItem = {
  id: "m1", store_id: "s1", name: "순대국밥", aliases: ["국밥"], price: 9000, is_available: true,
  options: [{ name: "맵기", choices: ["안 맵게", "보통"], required: true }],
};
const store = { id: "s1", name: "행복국밥", delivery_fee: 2000, min_order_amount: 8000, eta_minutes: 30 } as Store;

function fixture(overrides: { spent?: number; customer?: Customer | null } = {}) {
  const orders = new Map<string, OrderResult>();
  const adapter: MerchantAdapter = {
    searchStores: async () => [store],
    getMenu: async () => [gukbap],
    quote: async (cart: Cart) => {
      const subtotal = cart.items.reduce((sum, line) => sum + line.unit_price * line.quantity, 0);
      return { subtotal, delivery_fee: 2000, total: subtotal + 2000, min_order_amount: 8000, meets_minimum: subtotal >= 8000, eta_minutes: 30 };
    },
    placeOrder: async (cart: Cart, key: string, _context: PlaceOrderContext) => {
      const existing = orders.get(key);
      if (existing) return { ...existing, duplicate: true };
      const order: OrderResult = { order_id: `o${orders.size + 1}`, status: "pending", total: 20000, eta_minutes: 30, duplicate: false };
      orders.set(key, order);
      return order;
    },
    getOrderStatus: async () => "pending",
  };
  const notified: string[] = [];
  const ctx: OrderToolContext = {
    callSid: "call-1",
    callerE164: customer.phone_e164,
    customer: overrides.customer === undefined ? customer : overrides.customer,
    session: new OrderSession(),
    adapter,
    customers: { spentLastDay: async () => overrides.spent ?? 0, recentOrders: async () => [] } as unknown as CustomerRepository,
    pendingRecap: null,
    storeName: null,
    placedOrder: null,
    onOrderPlaced: async (order) => void notified.push(order.order_id),
  };
  return { ctx, orders, notified };
}

const addTwo = (ctx: OrderToolContext) =>
  executeOrderTool("cart_add", { store_id: "s1", menu_item_id: "m1", quantity: 2, options: { 맵기: "안 맵게" } }, ctx);

async function recap(ctx: OrderToolContext): Promise<string> {
  const { confirmation_token } = (await executeOrderTool("request_confirmation", {}, ctx)) as { confirmation_token: string };
  ctx.session.noteSpoken(ctx.pendingRecap!);
  return confirmation_token;
}

describe("place_order confirmation gate", () => {
  it("rejects when no recap was issued", async () => {
    const { ctx, orders } = fixture();
    await addTwo(ctx);
    await expect(executeOrderTool("place_order", { confirmation_token: "made-up" }, ctx)).rejects.toThrow("토큰");
    expect(orders.size).toBe(0);
  });

  it("rejects a real token until the caller says yes", async () => {
    const { ctx, orders } = fixture();
    await addTwo(ctx);
    const token = await recap(ctx);
    await expect(executeOrderTool("place_order", { confirmation_token: token }, ctx)).rejects.toThrow("승낙하지");
    expect(orders.size).toBe(0);
  });

  it("places the order after 네 and tells the guardian once", async () => {
    const { ctx, orders, notified } = fixture();
    await addTwo(ctx);
    const token = await recap(ctx);
    expect(ctx.session.noteCallerUtterance("네")).toBe("confirmed");
    await executeOrderTool("place_order", { confirmation_token: token }, ctx);
    expect(orders.size).toBe(1);
    expect(notified).toEqual(["o1"]);
  });

  it("does not double-order on a repeated call", async () => {
    const { ctx, orders, notified } = fixture();
    await addTwo(ctx);
    const token = await recap(ctx);
    ctx.session.noteCallerUtterance("네");
    await executeOrderTool("place_order", { confirmation_token: token }, ctx);
    const second = (await executeOrderTool("place_order", { confirmation_token: token }, ctx)) as OrderResult;
    expect(second.duplicate).toBe(true);
    expect(orders.size).toBe(1);
    expect(notified).toHaveLength(1);
  });

  it("revokes the token when the cart changes after the recap", async () => {
    const { ctx } = fixture();
    await addTwo(ctx);
    const token = await recap(ctx);
    ctx.session.noteCallerUtterance("네");
    await addTwo(ctx);
    await expect(executeOrderTool("place_order", { confirmation_token: token }, ctx)).rejects.toThrow("토큰");
  });

  it("does not count 네 when the last thing said was not the recap", async () => {
    const { ctx } = fixture();
    await addTwo(ctx);
    await recap(ctx);
    ctx.session.noteSpoken("다른 말씀 있으세요?");
    expect(ctx.session.noteCallerUtterance("네")).toBe("none");
  });

  it("does not count 네 after the recap was cut off", async () => {
    const { ctx } = fixture();
    await addTwo(ctx);
    await recap(ctx);
    ctx.session.noteInterrupted();
    expect(ctx.session.noteCallerUtterance("네")).toBe("none");
  });

  it("drops the token on 아니요", async () => {
    const { ctx } = fixture();
    await addTwo(ctx);
    const token = await recap(ctx);
    expect(ctx.session.noteCallerUtterance("아니요 하나만요")).toBe("judge");
    expect(ctx.session.answer("no")).toBe("rejected");
    await expect(executeOrderTool("place_order", { confirmation_token: token }, ctx)).rejects.toThrow("토큰");
  });

  it("stops amounts over the per-order limit before the recap", async () => {
    const { ctx } = fixture({ customer: { ...customer, order_spend_limit: 10000 } });
    await addTwo(ctx);
    await expect(executeOrderTool("request_confirmation", {}, ctx)).rejects.toThrow("1회");
  });

  it("stops amounts over the daily limit at placement", async () => {
    const { ctx, orders } = fixture({ spent: 90000 });
    await addTwo(ctx);
    const token = await recap(ctx);
    ctx.session.noteCallerUtterance("네");
    await expect(executeOrderTool("place_order", { confirmation_token: token }, ctx)).rejects.toThrow("하루");
    expect(orders.size).toBe(0);
  });

  it("refuses unregistered callers", async () => {
    const { ctx } = fixture({ customer: null });
    await addTwo(ctx);
    await expect(executeOrderTool("request_confirmation", {}, ctx)).rejects.toThrow("발신번호");
  });

  it("requires mandatory options", async () => {
    const { ctx } = fixture();
    await expect(executeOrderTool("cart_add", { store_id: "s1", menu_item_id: "m1", quantity: 1 }, ctx)).rejects.toThrow("맵기");
  });
});

describe("speech rules", () => {
  it.each(["네", "네네", "예.", "응", "맞아요", "네 맞아요", "그렇게 해주세요", "응 해줘", "넵", "어, 그래", "좋아요", "그걸로 해 주세요", "네 주문해 주세요", "주문할게요", "그대로요", "응응 보내줘", "알겠습니다", "네, 부탁드려요", "그럼요"])("%s confirms", (text) => {
    expect(isAffirmative(text)).toBe(true);
  });
  it.each(["네 근데 하나 더요", "아니요", "네 아니요", "어", "음", "잠깐만요", "네 취소요", "그래서요", "해물 짬뽕으로 해줘", "응 그거 빼줘", "좋아요 근데 하나 더", "그렇게 말고요"])("%s does not confirm", (text) => {
    expect(isAffirmative(text)).toBe(false);
  });
  it("detects negatives and repeat requests", () => {
    expect(isNegative("아니 그게 아니고")).toBe(true);
    expect(isRepeatRequest("뭐라고요?")).toBe(true);
    expect(isRepeatRequest("다시 말해 주세요")).toBe(true);
    expect(isRepeatRequest("짜장면 주세요")).toBe(false);
  });
  it("ignores backchannel for barge-in", () => {
    expect(isBargeIn("음")).toBe(false);
    expect(isBargeIn("어어")).toBe(false);
    expect(isBargeIn("네")).toBe(false);
    expect(isBargeIn("아니요")).toBe(true);
  });
  it("reads won amounts aloud", () => {
    expect(wonToKorean(18000)).toBe("만 팔천 원");
    expect(wonToKorean(12000)).toBe("만 이천 원");
    expect(wonToKorean(32500)).toBe("삼만 이천 오백 원");
    expect(wonToKorean(0)).toBe("영 원");
  });
  it("splits streamed sentences and keeps decimals whole", () => {
    expect(takeSentences("네, 알겠습니다. 어떤")).toEqual({ sentences: ["네, 알겠습니다."], rest: " 어떤" });
    expect(takeSentences("3.5킬로").sentences).toEqual([]);
  });
  it("strips what TTS must not read", () => {
    expect(sanitizeForTts("**네** (확인) 😀 알겠습니다")).toBe("네 알겠습니다");
  });
});

function fakeClient(script: Array<Array<object> | object>): ChatClient {
  let i = 0;
  return {
    create: (async () => {
      const step = script[i++];
      if (!Array.isArray(step)) return step;
      return (async function* () { yield* step; })();
    }) as unknown as ChatClient["create"],
  };
}

const toolDelta = (name: string, args: object) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name, arguments: JSON.stringify(args) } }] } }] });

describe("conversation turn", () => {
  const hooks = (spoken: string[]) => ({ speak: (text: string) => void spoken.push(text), onToolCall() {}, onFirstToken() {}, onUsage() {} });

  it("speaks the whole reply in one go", async () => {
    const { ctx } = fixture();
    const spoken: string[] = [];
    const client = fakeClient([[{ choices: [{ delta: { content: "안녕하세요. 무엇을" } }] }, { choices: [{ delta: { content: " 드릴까요?" } }] }]]);
    await runConversationTurn([], ctx, { client, model: "m" }, hooks(spoken), new AbortController().signal);
    expect(spoken).toEqual(["안녕하세요. 무엇을 드릴까요?"]);
  });

  it("delegates, says the filler first, reads the recap verbatim and stops", async () => {
    const { ctx } = fixture();
    await addTwo(ctx);
    const spoken: string[] = [];
    const client = fakeClient([
      [toolDelta("order_agent", { instruction: "복창" })],
      { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "request_confirmation", arguments: "{}" } }] } }] },
      { choices: [{ message: { role: "assistant", content: JSON.stringify({ status: "ok", summary: "복창함" }) } }] },
    ]);
    const messages: any[] = [];
    await runConversationTurn(messages, ctx, { client, model: "m" }, hooks(spoken), new AbortController().signal);
    expect(spoken[0]).toBe("네, 확인해 볼게요.");
    expect(spoken[1]).toBe("행복국밥에서 안 맵게 순대국밥 두 개, 배달비 포함 이만 원, 행복동 12번지로 보내드릴까요?");
    expect(messages.at(-1)).toEqual({ role: "assistant", content: spoken[1] });
  });

  it("ends the call after the order even if the model forgets end_call", async () => {
    const { ctx } = fixture();
    ctx.placedOrder = { order_id: "o1", total: 20000, eta_minutes: 30 } as OrderResult;
    const client = fakeClient([[{ choices: [{ delta: { content: "주문됐습니다." } }] }]]);
    const action = await runConversationTurn([], ctx, { client, model: "m" }, hooks([]), new AbortController().signal);
    expect(action).toEqual({ type: "end_call" });
  });

  it("returns handoff as an action", async () => {
    const { ctx } = fixture();
    const client = fakeClient([[toolDelta("handoff", { reason: "요청" })]]);
    const action = await runConversationTurn([], ctx, { client, model: "m" }, hooks([]), new AbortController().signal);
    expect(action).toEqual({ type: "handoff", reason: "요청" });
  });
});

describe("english calls", () => {
  it("counts only a plain yes as confirmation", () => {
    for (const yes of ["Yes.", "yes please", "That's right", "Okay", "go ahead"]) expect(isAffirmative(yes)).toBe(true);
    for (const other of ["yes but add one more", "no", "not yet", "wait", "I know"]) expect(isAffirmative(other)).toBe(false);
    expect(isNegative("I know")).toBe(false);
    expect(isNegative("No, cancel it")).toBe(true);
  });

  it("recognizes barge-in, repeat and agent requests", () => {
    expect(isBargeIn("um")).toBe(false);
    expect(isBargeIn("yeah")).toBe(false);
    expect(isBargeIn("actually make it two")).toBe(true);
    expect(isRepeatRequest("Can you repeat that?")).toBe(true);
    expect(isHandoffRequest("I want a real person")).toBe(true);
  });

  it("follows the caller's language without flipping on one stray word", () => {
    expect(nextLanguage("okay", "ko")).toBe("ko");
    expect(nextLanguage("two soups please", "ko")).toBe("en");
    expect(nextLanguage("hello", "ko")).toBe("en");
    expect(nextLanguage("yes", "ko")).toBe("ko");
    expect(nextLanguage("네", "en")).toBe("ko");
    expect(nextLanguage("yes", "en")).toBe("en");
  });

  it("reads the recap in English using English names and option labels", () => {
    const session = new OrderSession();
    session.addItem({ ...gukbap, name_en: "sundae soup", options: [{ name: "맵기", choices: ["안 맵게", "보통"], choices_en: ["not spicy", "regular"], required: true }] }, 2, { 맵기: "안 맵게" });
    const recap = buildRecap("Happy Soup House", session.cart!, 20000, "12 Haengbok-dong, Seoul", "en");
    expect(recap).toBe("From Happy Soup House, 2 not spicy sundae soup, 20,000 won including delivery, to 12 Haengbok-dong, Seoul. Shall I place this order?");
    expect(recap).not.toMatch(/[가-힣]/);
  });
});

describe("catalog", () => {
  const store = (id: string, name: string, category: string) => ({ id, name, category }) as Store;
  const menuItem = (id: string, storeId: string, name: string): MenuItem => ({ id, store_id: storeId, name, aliases: [], price: 8000, options: [], is_available: true });
  const catalog = [
    { store: store("s1", "만리장성", "중식"), menu: [menuItem("m1", "s1", "짬뽕")] },
    { store: store("s2", "붉은대문 반점", "중식"), menu: [menuItem("m2", "s2", "굴짬뽕")] },
    { store: store("s3", "구름다방", "카페"), menu: [menuItem("m3", "s3", "아메리카노")] },
  ];

  it("finds a dish across every store so the caller can be asked where", async () => {
    const { ctx } = fixture();
    ctx.catalog = catalog;
    const found = (await executeOrderTool("find_menu", { query: "짬뽕" }, ctx)) as { store_id: string }[];
    expect(found.map((row) => row.store_id)).toEqual(["s1", "s2"]);
    expect(await executeOrderTool("find_menu", { query: "초밥" }, ctx)).toEqual([]);
  });

  it("gives the conversation agent the list so it can answer directly", async () => {
    const { ctx } = fixture();
    ctx.catalog = catalog;
    const requests: { messages: { content: string }[] }[] = [];
    const client = { create: async (request: never) => {
      requests.push(request);
      return (async function* () { yield { choices: [{ delta: { content: "중식과 카페가 있습니다." } }] }; })();
    } } as unknown as ChatClient;
    await runConversationTurn([], ctx, { client, model: "m" }, { speak() {}, onToolCall() {}, onFirstToken() {}, onUsage() {} }, new AbortController().signal);
    expect(requests[0]!.messages[1]!.content).toContain("구름다방 (카페): 아메리카노");
  });
});

describe("judging the answer to the recap", () => {
  const reply = (content: string) => fakeClient([{ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]);
  const judge = (content: string) => judgeConfirmation("만리장성에서 짜장면 두 개, 보내드릴까요?", "아니 그대로 해 주세요", { client: reply(content), model: "m" }, () => {});

  it("takes the model's yes or no, and anything else as unclear", async () => {
    expect(await judge('{"verdict":"yes"}')).toBe("yes");
    expect(await judge('{"verdict":"no"}')).toBe("no");
    expect(await judge('{"verdict":"maybe"}')).toBe("unclear");
    expect(await judge("not json")).toBe("unclear");
  });

  it("confirms on a judged yes only after the whole recap was heard", async () => {
    const { ctx } = fixture();
    await addTwo(ctx);
    await recap(ctx);
    expect(ctx.session.noteCallerUtterance("sure, go for it")).toBe("judge");
    expect(ctx.session.answer("unclear")).toBe("none");
    expect(ctx.session.answer("yes")).toBe("confirmed");
    ctx.session.noteInterrupted();
    expect(ctx.session.answer("yes")).toBe("none");
  });
});
