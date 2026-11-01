import type { CatalogStore, CustomerRepository, Customer, MerchantAdapter, OrderResult } from "@callorder/adapters";
import { rankMenu } from "@callorder/adapters";
import type OpenAI from "openai";
import { buildRecap, OrderSession } from "./order-session";

export interface OrderToolContext {
  callSid: string;
  callerE164: string;
  customer: Customer | null;
  session: OrderSession;
  adapter: MerchantAdapter;
  catalog?: CatalogStore[];
  customers: CustomerRepository;
  pendingRecap: string | null;
  storeName: string | null;
  placedOrder: OrderResult | null;
  onOrderPlaced(order: OrderResult, storeName: string): Promise<void>;
}

const tool = (name: string, description: string, properties: object = {}, required: string[] = []): OpenAI.ChatCompletionTool => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

const string = { type: "string" };
const integer = { type: "integer" };

// identify_customer and get_recent_orders take no id: the caller is fixed by the call, so a
// manipulated model cannot read somebody else's address or orders.
export const ORDER_TOOLS: OpenAI.ChatCompletionTool[] = [
  tool("identify_customer", "발신번호로 등록된 고객과 기본 주소를 조회합니다."),
  tool("get_recent_orders", "이 고객의 최근 주문을 조회합니다.", { limit: integer }),
  tool("find_menu", "모든 가게에서 메뉴를 찾아 가게별로 돌려줍니다. 가게가 정해지지 않았을 때 먼저 씁니다.", { query: string }, ["query"]),
  tool("search_stores", "고객 주소 근처에서 영업 중인 가게를 찾습니다.", { query: string }),
  tool("search_menu", "가게 메뉴를 구어 표현까지 포함해 찾습니다.", { store_id: string, query: string }, ["store_id", "query"]),
  tool("cart_add", "장바구니에 메뉴를 담습니다. options는 옵션명과 선택값의 객체입니다.",
    { store_id: string, menu_item_id: string, quantity: integer, options: { type: "object", additionalProperties: string } },
    ["store_id", "menu_item_id", "quantity"]),
  tool("cart_remove", "장바구니에서 메뉴를 뺍니다.", { menu_item_id: string }, ["menu_item_id"]),
  tool("cart_get", "현재 장바구니를 봅니다."),
  tool("get_quote", "합계, 배달비, 최소 주문 금액, 예상 시간을 계산합니다."),
  tool("request_confirmation", "복창 문구를 만들어 고객에게 읽어 주고 확인 토큰을 발급합니다."),
  tool("place_order", "고객이 음성으로 확인한 주문을 실행합니다.", { confirmation_token: string }, ["confirmation_token"]),
];

function requireCustomer(ctx: OrderToolContext): Customer {
  if (!ctx.customer) throw new Error("발신번호를 알 수 없어 주문할 수 없습니다");
  return ctx.customer;
}

export async function executeOrderTool(name: string, args: Record<string, any>, ctx: OrderToolContext): Promise<unknown> {
  switch (name) {
    case "identify_customer":
      if (!ctx.customer) return { registered: false };
      return {
        registered: true,
        customer_id: ctx.customer.id,
        name: ctx.customer.name,
        default_address: ctx.customer.default_address,
        dietary_notes: ctx.customer.dietary_notes,
      };
    case "get_recent_orders":
      return ctx.customers.recentOrders(requireCustomer(ctx).id, Math.min(args.limit ?? 3, 10));
    case "find_menu": {
      const catalog = ctx.catalog ?? [];
      return catalog.flatMap(({ store, menu }) =>
        rankMenu(menu, args.query).slice(0, 3).map(({ id, name, name_en, price, options }) => ({
          store_id: store.id, store_name: store.name, store_name_en: store.name_en, menu_item_id: id, name, name_en, price, options,
        })),
      );
    }
    case "search_stores": {
      const customer = requireCustomer(ctx);
      if (customer.lat == null || customer.lng == null) throw new Error("고객 주소의 좌표가 없습니다");
      const stores = await ctx.adapter.searchStores({ lat: customer.lat, lng: customer.lng, query: args.query });
      return stores.map(({ id, name, name_en, category, min_order_amount, delivery_fee, eta_minutes }) => ({ id, name, name_en, category, min_order_amount, delivery_fee, eta_minutes }));
    }
    case "search_menu": {
      const menu = rankMenu(await ctx.adapter.getMenu(args.store_id), args.query);
      return menu.slice(0, 5).map(({ id, name, name_en, price, options }) => ({ id, name, name_en, price, options }));
    }
    case "cart_add": {
      const menu = await ctx.adapter.getMenu(args.store_id);
      const item = menu.find((candidate) => candidate.id === args.menu_item_id);
      if (!item) throw new Error("이 가게에서 주문할 수 없는 메뉴입니다");
      ctx.session.addItem(item, args.quantity, args.options ?? {});
      return ctx.session.cart;
    }
    case "cart_remove":
      ctx.session.removeItem(args.menu_item_id);
      return ctx.session.cart;
    case "cart_get":
      return ctx.session.cart;
    case "get_quote": {
      if (!ctx.session.cart?.items.length) throw new Error("장바구니가 비어 있습니다");
      return ctx.adapter.quote(ctx.session.cart);
    }
    case "request_confirmation": {
      const customer = requireCustomer(ctx);
      const cart = ctx.session.cart;
      if (!cart?.items.length) throw new Error("장바구니가 비어 있습니다");
      const quote = await ctx.adapter.quote(cart);
      if (!quote.meets_minimum) throw new Error(`최소 주문 금액 ${quote.min_order_amount}원에 못 미칩니다`);
      assertWithinOrderLimit(customer, quote.total);
      const store = (await ctx.adapter.searchStores({ lat: customer.lat ?? 0, lng: customer.lng ?? 0 })).find((candidate) => candidate.id === cart.store_id);
      if (!store) throw new Error("가게가 지금 주문을 받지 않습니다");
      const language = ctx.session.language;
      const recap = buildRecap(language === "en" ? (store.name_en ?? store.name) : store.name, cart, quote.total, customer.default_address, language);
      const token = await ctx.session.issueConfirmation(recap);
      ctx.pendingRecap = recap;
      ctx.storeName = store.name;
      return { confirmation_token: token, spoken_by_system: true };
    }
    case "place_order": {
      const customer = requireCustomer(ctx);
      const hash = await ctx.session.assertConfirmed(args.confirmation_token);
      const cart = ctx.session.cart!;
      const quote = await ctx.adapter.quote(cart);
      assertWithinOrderLimit(customer, quote.total);
      const key = `${ctx.callSid}:${hash}`;
      // ponytail: read-then-insert limit check can be raced by two simultaneous calls, enforce in a DB function if real money moves
      const spent = await ctx.customers.spentLastDay(customer.id);
      if (spent + quote.total > customer.daily_spend_limit) {
        throw new Error("하루 주문 한도를 넘었습니다. 보호자 확인이 필요하니 handoff를 안내하세요");
      }
      const order = await ctx.adapter.placeOrder(cart, key, {
        customerId: customer.id,
        callSid: ctx.callSid,
        deliveryAddress: customer.default_address,
      });
      ctx.placedOrder = order;
      if (!order.duplicate) await ctx.onOrderPlaced(order, ctx.storeName ?? "");
      return order;
    }
    default:
      throw new Error(`알 수 없는 도구: ${name}`);
  }
}

function assertWithinOrderLimit(customer: Customer, total: number): void {
  if (total > customer.order_spend_limit) {
    throw new Error("1회 주문 한도를 넘었습니다. 보호자 확인이 필요하니 handoff를 안내하세요");
  }
}
