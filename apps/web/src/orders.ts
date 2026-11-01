import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import type { T } from "./i18n";
import { supabase } from "./supabase";

export interface OrderRow {
  id: string;
  customer_id: string;
  status: "pending" | "accepted" | "rejected" | "cancelled";
  total: number;
  delivery_address: string;
  created_at: string;
  items: { name: string; label_en?: string; quantity: number; options: Record<string, string> }[];
  stores: { name: string } | null;
  customers: { name: string; phone_last4: string | null } | null;
}

const REFRESH_MS = 30_000;
const SELECT = "id, customer_id, status, total, delivery_address, created_at, items, stores(name), customers(name, phone_last4)";

// RLS scopes both the query and the Realtime feed to what this client may see.
export function useOrders(db: SupabaseClient = supabase, customerIds?: string[]) {
  const scope = customerIds?.join();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const [newestId, setNewestId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const query = db.from("orders").select(SELECT);
    const { data, error: failure } = await (scope === undefined ? query : query.in("customer_id", scope.split(","))).order("created_at", { ascending: false }).limit(50);
    setLoading(false);
    if (failure) setError(failure.message);
    else setOrders(data as unknown as OrderRow[]);
  }, [db, scope]);

  useEffect(() => {
    void load();
    // Realtime drops events while it wakes up or reconnects, and a missed order is the one failure a shop cannot notice.
    const timer = setInterval(load, REFRESH_MS);
    const channel = db
      .channel("orders")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, (change) => {
        if (change.eventType === "INSERT") setNewestId((change.new as { id: string }).id);
        void load();
      })
      .subscribe((status) => setLive(status === "SUBSCRIBED"));
    return () => {
      clearInterval(timer);
      void db.removeChannel(channel);
    };
  }, [db, load]);

  return { orders, error, loading, live, newestId, reload: load };
}

// Which customers or stores this login is tied to. Null while it is still being checked.
export function useLinkedIds(session: Session | null | undefined, table: "guardians" | "stores", idColumn: string, userColumn: string): string[] | null {
  const [ids, setIds] = useState<string[] | null>(null);
  const userId = session?.user.id;
  useEffect(() => {
    if (session === undefined) return;
    if (!userId) return setIds([]);
    setIds(null);
    supabase.from(table).select(idColumn).eq(userColumn, userId).then(({ data }) => setIds(((data ?? []) as unknown as Record<string, string>[]).map((row) => row[idColumn]!)));
  }, [session === undefined, userId, table, idColumn, userColumn]);
  return ids;
}

export function won(amount: number, t: T): string {
  const digits = amount.toLocaleString("ko-KR");
  return t(`${digits}원`, `${digits} won`);
}

// label_en already includes the options. Orders placed before it existed only have the Korean name.
export function itemLabel(line: OrderRow["items"][number], t: T): string {
  const korean = [...Object.values(line.options ?? {}), line.name].join(" ");
  return t(korean, line.label_en || korean);
}

export function timeAgo(iso: string, t: T, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60000);
  const ago = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  if (minutes < 1) return t("방금 전", "Just now");
  if (minutes < 60) return t(`${minutes}분 전`, ago(minutes, "minute"));
  const hours = Math.floor(minutes / 60);
  if (minutes < 1440) return t(`${hours}시간 전`, ago(hours, "hour"));
  const days = Math.floor(minutes / 1440);
  return t(`${days}일 전`, ago(days, "day"));
}

export function isToday(iso: string): boolean {
  return new Date(iso).toDateString() === new Date().toDateString();
}

// Phone callers have no name, so the last four digits of their number tell them apart.
export function customerLabel(customer: OrderRow["customers"], t: T): string {
  if (!customer) return "";
  return customer.name === "고객" && customer.phone_last4 ? t(`고객 ${customer.phone_last4}`, `Caller ${customer.phone_last4}`) : customer.name;
}
