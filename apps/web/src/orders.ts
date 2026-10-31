import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";

export interface OrderRow {
  id: string;
  status: "pending" | "accepted" | "rejected" | "cancelled";
  total: number;
  delivery_address: string;
  created_at: string;
  items: { name: string; quantity: number; options: Record<string, string> }[];
  stores: { name: string } | null;
  customers: { name: string } | null;
}

const REFRESH_MS = 30_000;
const SELECT = "id, status, total, delivery_address, created_at, items, stores(name), customers(name)";

// RLS scopes both the query and the Realtime feed to what this user may see, so no filter is needed.
export function useOrders() {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const [newestId, setNewestId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: failure } = await supabase.from("orders").select(SELECT).order("created_at", { ascending: false }).limit(50);
    setLoading(false);
    if (failure) setError(failure.message);
    else setOrders(data as unknown as OrderRow[]);
  }, []);

  useEffect(() => {
    void load();
    // Realtime drops events while it wakes up or reconnects, and a missed order is the one failure a shop cannot notice.
    const timer = setInterval(load, REFRESH_MS);
    const channel = supabase
      .channel("orders")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, (change) => {
        if (change.eventType === "INSERT") setNewestId((change.new as { id: string }).id);
        void load();
      })
      .subscribe((status) => setLive(status === "SUBSCRIBED"));
    return () => {
      clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, [load]);

  return { orders, error, loading, live, newestId, reload: load };
}

export const won = (amount: number) => `${amount.toLocaleString("ko-KR")}원`;

export function itemLabel(line: OrderRow["items"][number]): string {
  return [...Object.values(line.options ?? {}), line.name].join(" ");
}

export function timeAgo(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`;
  return `${Math.floor(minutes / 1440)}일 전`;
}

export function isToday(iso: string): boolean {
  return new Date(iso).toDateString() === new Date().toDateString();
}
