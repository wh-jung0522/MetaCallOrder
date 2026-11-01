import type { SupabaseClient } from "@supabase/supabase-js";

export interface Customer {
  id: string;
  phone_e164: string;
  name: string;
  default_address: string;
  lat: number | null;
  lng: number | null;
  dietary_notes: string | null;
  order_spend_limit: number;
  daily_spend_limit: number;
  preferred_speech_rate: number;
  is_demo: boolean;
}

export interface Guardian {
  id: string;
  customer_id: string;
  name: string;
  phone_e164: string;
  notify_on_order: boolean;
}

export interface Store {
  id: string;
  name: string;
  name_en?: string | null;
  category?: string | null;
  phone_e164: string;
  address: string;
  lat: number | null;
  lng: number | null;
  adapter_type: "dashboard" | "webhook";
  adapter_config: { url?: string };
  is_open: boolean;
  delivery_fee: number;
  min_order_amount: number;
  eta_minutes: number;
}

export interface MenuOption {
  name: string;
  choices: string[];
  choices_en?: string[];
  required: boolean;
}

export interface MenuItem {
  id: string;
  store_id: string;
  name: string;
  name_en?: string | null;
  aliases: string[];
  price: number;
  options: MenuOption[];
  is_available: boolean;
}

export interface CatalogStore {
  store: Store;
  menu: MenuItem[];
}

export interface CartItem {
  menu_item_id: string;
  name: string;
  label_en?: string;
  quantity: number;
  unit_price: number;
  options: Record<string, string>;
}

export interface Cart {
  store_id: string;
  items: CartItem[];
}

export interface Quote {
  subtotal: number;
  delivery_fee: number;
  total: number;
  min_order_amount: number;
  meets_minimum: boolean;
  eta_minutes: number;
}

export interface PlaceOrderContext {
  customerId: string;
  callSid: string;
  deliveryAddress: string;
}

export interface OrderResult {
  order_id: string;
  status: OrderStatus;
  total: number;
  eta_minutes: number;
  duplicate: boolean;
}

export type OrderStatus = "pending" | "accepted" | "rejected" | "cancelled";

export interface MerchantAdapter {
  searchStores(input: { lat: number; lng: number; query?: string }): Promise<Store[]>;
  getMenu(storeId: string): Promise<MenuItem[]>;
  quote(cart: Cart): Promise<Quote>;
  placeOrder(cart: Cart, idempotencyKey: string, context: PlaceOrderContext): Promise<OrderResult>;
  getOrderStatus(orderId: string): Promise<OrderStatus>;
}

const normalize = (text: string) => text.toLowerCase().replace(/[\s.,!?~]/g, "");

function bigrams(text: string): string[] {
  if (text.length < 2) return [text];
  return Array.from({ length: text.length - 1 }, (_, i) => text.slice(i, i + 2));
}

// 1 when one side contains the other, else bigram Dice similarity. Tolerates STT slips like 잠뽕/짬뽕.
export function matchScore(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (c.includes(q) || q.includes(c)) return 1;
  const right = bigrams(c);
  const hits = bigrams(q).filter((gram) => {
    const at = right.indexOf(gram);
    if (at < 0) return false;
    right.splice(at, 1);
    return true;
  }).length;
  return (2 * hits) / (bigrams(q).length + bigrams(c).length);
}

const MATCH_THRESHOLD = 0.3;

export function rankMenu(items: MenuItem[], query: string, threshold = MATCH_THRESHOLD): MenuItem[] {
  const score = (item: MenuItem) =>
    Math.max(matchScore(query, item.name), ...item.aliases.map((alias) => matchScore(query, alias)));
  return items
    .map((item) => ({ item, s: score(item) }))
    .filter(({ s }) => s >= threshold)
    .sort((a, b) => b.s - a.s)
    .map(({ item }) => item);
}

function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

const DELIVERY_RADIUS_KM = 5;
const WEBHOOK_TIMEOUT_MS = 5000;

// Prices always come from the database, never from the cart the LLM assembled.
export class SupabaseMerchantAdapter implements MerchantAdapter {
  constructor(private db: SupabaseClient) {}

  async searchStores({ lat, lng, query }: { lat: number; lng: number; query?: string }): Promise<Store[]> {
    const { data, error } = await this.db.from("stores").select("*").eq("is_open", true);
    if (error) throw error;
    // ponytail: filters every store in memory, use PostGIS once there are thousands of stores
    const nearby = (data as Store[])
      .map((store) => ({ store, km: distanceKm(lat, lng, store.lat ?? lat, store.lng ?? lng) }))
      .filter(({ km }) => km <= DELIVERY_RADIUS_KM)
      .sort((a, b) => a.km - b.km)
      .map(({ store }) => store);
    if (!query) return nearby;
    // "치킨" names a kind of food or a dish as often as a store, so a store matches on any of them.
    const { data: menu, error: menuError } = await this.db.from("menu_items").select("store_id, name, name_en, aliases").eq("is_available", true);
    if (menuError) throw menuError;
    const close = (text?: string | null) => matchScore(query, text ?? "") >= MATCH_THRESHOLD;
    const selling = new Set((menu as Pick<MenuItem, "store_id" | "name" | "name_en" | "aliases">[])
      .filter((item) => close(item.name) || close(item.name_en) || item.aliases.some(close))
      .map((item) => item.store_id));
    const matched = nearby.filter((store) => close(store.name) || close(store.name_en) || close(store.category) || selling.has(store.id));
    // Nothing matched is not the same as nothing nearby: the agent can still offer what is open.
    return matched.length ? matched : nearby;
  }

  // Everything orderable near the caller, read once per call so questions about it need no further lookups.
  async catalog(input: { lat: number; lng: number }): Promise<CatalogStore[]> {
    const [stores, { data, error }] = await Promise.all([
      this.searchStores(input),
      this.db.from("menu_items").select("*").eq("is_available", true),
    ]);
    if (error) throw error;
    return stores.map((store) => ({ store, menu: (data as MenuItem[]).filter((item) => item.store_id === store.id) }));
  }

  async getMenu(storeId: string): Promise<MenuItem[]> {
    const { data, error } = await this.db
      .from("menu_items")
      .select("*")
      .eq("store_id", storeId)
      .eq("is_available", true);
    if (error) throw error;
    return data as MenuItem[];
  }

  async quote(cart: Cart): Promise<Quote> {
    const store = await this.getStore(cart.store_id);
    const menu = await this.getMenu(cart.store_id);
    const subtotal = cart.items.reduce((sum, line) => {
      const item = menu.find((candidate) => candidate.id === line.menu_item_id);
      if (!item) throw new Error(`메뉴를 주문할 수 없습니다: ${line.name}`);
      return sum + item.price * line.quantity;
    }, 0);
    return {
      subtotal,
      delivery_fee: store.delivery_fee,
      total: subtotal + store.delivery_fee,
      min_order_amount: store.min_order_amount,
      meets_minimum: subtotal >= store.min_order_amount,
      eta_minutes: store.eta_minutes,
    };
  }

  async placeOrder(cart: Cart, idempotencyKey: string, context: PlaceOrderContext): Promise<OrderResult> {
    const store = await this.getStore(cart.store_id);
    const quote = await this.quote(cart);
    const { data, error } = await this.db
      .from("orders")
      .upsert(
        {
          customer_id: context.customerId,
          store_id: cart.store_id,
          call_sid: context.callSid,
          total: quote.total,
          items: cart.items,
          delivery_address: context.deliveryAddress,
          idempotency_key: idempotencyKey,
        },
        { onConflict: "idempotency_key", ignoreDuplicates: true },
      )
      .select("id, status, total");
    if (error) throw error;

    const inserted = data?.[0];
    if (!inserted) {
      const { data: existing, error: lookupError } = await this.db
        .from("orders")
        .select("id, status, total")
        .eq("idempotency_key", idempotencyKey)
        .single();
      if (lookupError) throw lookupError;
      return {
        order_id: existing.id,
        status: existing.status,
        total: existing.total,
        eta_minutes: store.eta_minutes,
        duplicate: true,
      };
    }

    const status = store.adapter_type === "webhook" ? await this.sendWebhook(store, inserted.id, cart, quote, context) : inserted.status;
    return { order_id: inserted.id, status, total: inserted.total, eta_minutes: store.eta_minutes, duplicate: false };
  }

  async getOrderStatus(orderId: string): Promise<OrderStatus> {
    const { data, error } = await this.db.from("orders").select("status").eq("id", orderId).single();
    if (error) throw error;
    return data.status;
  }

  private async getStore(storeId: string): Promise<Store> {
    const { data, error } = await this.db.from("stores").select("*").eq("id", storeId).single();
    if (error) throw error;
    return data as Store;
  }

  // The order row stays pending when the webhook is unreachable so the merchant can still see it.
  private async sendWebhook(store: Store, orderId: string, cart: Cart, quote: Quote, context: PlaceOrderContext): Promise<OrderStatus> {
    if (!store.adapter_config.url) return "pending";
    try {
      const response = await fetch(store.adapter_config.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order_id: orderId, items: cart.items, total: quote.total, delivery_address: context.deliveryAddress }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!response.ok) return "pending";
      const { status } = (await response.json()) as { status?: string };
      if (status !== "accepted" && status !== "rejected") return "pending";
      await this.db.from("orders").update({ status }).eq("id", orderId);
      return status;
    } catch {
      return "pending";
    }
  }
}

export const FIRST_TIME_CALLER_NAME = "고객";

export class CustomerRepository {
  constructor(private db: SupabaseClient) {}

  async findByPhone(phone: string): Promise<Customer | null> {
    const { data, error } = await this.db.from("customers").select("*").eq("phone_e164", phone).maybeSingle();
    if (error) throw error;
    return data as Customer | null;
  }

  // Keeps an existing row as it is, so a repeat caller's name and address are never reset.
  async ensureCaller(phone: string, isDemo = false): Promise<void> {
    const { error } = await this.db.from("customers").upsert(
      { phone_e164: phone, name: FIRST_TIME_CALLER_NAME, default_address: "행복동 12번지", lat: 37.5665, lng: 126.978, preferred_speech_rate: 0.95, is_demo: isDemo, auto_created: true },
      { onConflict: "phone_e164", ignoreDuplicates: true },
    );
    if (error) throw error;
  }

  async listDemo(): Promise<Pick<Customer, "name" | "phone_e164">[]> {
    const { data, error } = await this.db.from("customers").select("name, phone_e164").eq("is_demo", true).order("phone_e164");
    if (error) throw error;
    return data;
  }

  async guardians(customerId: string): Promise<Guardian[]> {
    const { data, error } = await this.db.from("guardians").select("*").eq("customer_id", customerId);
    if (error) throw error;
    return data as Guardian[];
  }

  async recentOrders(customerId: string, limit: number) {
    const { data, error } = await this.db
      .from("orders")
      .select("id, store_id, items, total, created_at, stores(name)")
      .eq("customer_id", customerId)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  }

  // Rolling 24 hours, which avoids any timezone question about what "today" means.
  async spentLastDay(customerId: string): Promise<number> {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { data, error } = await this.db
      .from("orders")
      .select("total")
      .eq("customer_id", customerId)
      .in("status", ["pending", "accepted"])
      .gte("created_at", since);
    if (error) throw error;
    return data.reduce((sum, row) => sum + row.total, 0);
  }

  // Menu and store names bias the STT toward what callers will actually say.
  async sttKeywords(limit: number): Promise<string[]> {
    const [stores, menu] = await Promise.all([
      this.db.from("stores").select("name"),
      this.db.from("menu_items").select("name, aliases, options"),
    ]);
    const words = [
      ...(stores.data ?? []).map((row) => row.name as string),
      ...(menu.data ?? []).flatMap((row) => [row.name as string, ...(row.aliases as string[]), ...(row.options as MenuOption[]).flatMap((option) => [...option.choices, ...(option.choices_en ?? [])])]),
    ];
    return [...new Set(words)].slice(0, limit);
  }
}

export class CallRepository {
  constructor(private db: SupabaseClient) {}

  async start(callSid: string, customerId: string | null, channel: "simulator" | "phone"): Promise<void> {
    // The simulator picks its own call id, so reusing one must never clear customer_id, which would make that call public.
    const { error } = await this.db.from("calls").upsert({ call_sid: callSid, customer_id: customerId, channel }, { onConflict: "call_sid", ignoreDuplicates: true });
    if (error) throw error;
    if (!customerId) return;
    const { error: consentError } = await this.db.from("consents").insert(
      (["recording", "ai_processing"] as const).map((type) => ({ customer_id: customerId, type, channel: "call_notice" })),
    );
    if (consentError) throw consentError;
  }

  async finish(callSid: string, fields: { outcome: string; transcript: unknown; latency_metrics: unknown; cost_usd: number; handoff_reason: string | null }): Promise<void> {
    const { error } = await this.db
      .from("calls")
      .update({ ...fields, ended_at: new Date().toISOString() })
      .eq("call_sid", callSid);
    if (error) throw error;
  }

  async saveLogs(rows: unknown[]): Promise<void> {
    const { error } = await this.db.from("call_logs").insert(rows);
    if (error) throw error;
  }
}
