import { useEffect, useState } from "react";
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

export const STATUS_LABEL: Record<OrderRow["status"], string> = {
  pending: "접수 대기",
  accepted: "수락됨",
  rejected: "거절됨",
  cancelled: "취소됨",
};

const SELECT = "id, status, total, delivery_address, created_at, items, stores(name), customers(name)";

// RLS scopes both the query and the Realtime feed to what this user may see, so no filter is needed.
export function useOrders(): { orders: OrderRow[]; error: string; newestId: string | null } {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [error, setError] = useState("");
  const [newestId, setNewestId] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const { data, error: failure } = await supabase.from("orders").select(SELECT).order("created_at", { ascending: false }).limit(50);
      if (failure) setError(failure.message);
      else setOrders(data as unknown as OrderRow[]);
    };
    void load();
    const channel = supabase
      .channel("orders")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, (change) => {
        if (change.eventType === "INSERT") setNewestId((change.new as { id: string }).id);
        void load();
      })
      .subscribe();
    return () => void supabase.removeChannel(channel);
  }, []);

  return { orders, error, newestId };
}

export function describeItems(items: OrderRow["items"]): string {
  return items.map((line) => `${[...Object.values(line.options), line.name].join(" ")} ${line.quantity}개`).join(", ");
}
