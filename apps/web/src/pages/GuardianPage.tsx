import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { RequireLogin } from "../auth";
import { useT, type Pair } from "../i18n";
import { itemLabel, timeAgo, useOrders, won, type OrderRow } from "../orders";
import { supabase } from "../supabase";

const STATUS: Record<OrderRow["status"], { label: Pair; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: ["가게 확인 중", "Store is checking"], variant: "default" },
  accepted: { label: ["가게에서 수락", "Store accepted"], variant: "secondary" },
  rejected: { label: ["가게에서 거절", "Store declined"], variant: "destructive" },
  cancelled: { label: ["취소됨", "Cancelled"], variant: "outline" },
};

const CANCEL_WINDOW_MS = 3 * 3_600_000;

function OrderItem({ order, onChanged }: { order: OrderRow; onChanged: () => void }) {
  const { t } = useT();
  const [error, setError] = useState(false);
  const summary = order.items.map((line) => t(`${itemLabel(line, t)} ${line.quantity}개`, `${itemLabel(line, t)} × ${line.quantity}`)).join(", ");
  const cancel = async () => {
    const { error: failure } = await supabase.from("orders").update({ status: "cancelled" }).eq("id", order.id);
    setError(Boolean(failure));
    onChanged();
  };

  return (
    <li className="flex flex-col gap-2 py-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">{order.stores?.name}</h2>
          <p className="text-sm text-muted-foreground">{timeAgo(order.created_at, t)}</p>
        </div>
        <Badge variant={STATUS[order.status].variant}>{t(...STATUS[order.status].label)}</Badge>
      </div>
      <p className="text-lg">{summary}</p>
      <p className="text-muted-foreground">{order.delivery_address}, <b className="text-foreground tabular-nums">{won(order.total, t)}</b></p>
      {error && <Alert variant="destructive"><AlertDescription>{t("취소하지 못했습니다. 가게에 직접 전화해 주세요.", "Could not cancel the order. Please call the store directly.")}</AlertDescription></Alert>}
      {(order.status === "pending" || order.status === "accepted") && Date.now() - new Date(order.created_at).getTime() < CANCEL_WINDOW_MS && (
        <AlertDialog>
          <AlertDialogTrigger asChild><Button variant="outline" size="sm" className="self-start">{t("주문 취소", "Cancel order")}</Button></AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("이 주문을 취소할까요?", "Cancel this order?")}</AlertDialogTitle>
              <AlertDialogDescription>{order.stores?.name}, {summary}, {won(order.total, t)}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("그대로 두기", "Keep order")}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={cancel}>{t("주문 취소", "Cancel order")}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </li>
  );
}

function Orders() {
  const { t } = useT();
  const { orders, error, loading, reload } = useOrders();
  if (error) return <Alert variant="destructive"><AlertDescription>{t("주문을 불러오지 못했습니다. 새로고침해 주세요.", "Could not load orders. Please refresh the page.")}</AlertDescription></Alert>;
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (!orders.length) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t("아직 주문이 없습니다", "No orders yet")}</EmptyTitle>
          <EmptyDescription>{t("부모님이 전화로 주문하면 여기에 바로 표시됩니다.", "When your parent orders by phone, it will show up here right away.")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="max-w-2xl">
      <p className="text-muted-foreground">{t(`${orders[0]?.customers?.name ?? ""}님의 최근 주문입니다. 잘못된 주문은 여기서 취소할 수 있습니다.`, `Recent orders for ${orders[0]?.customers?.name ?? ""}. You can cancel a wrong order here.`)}</p>
      <Separator className="mt-4" />
      <ol className="flex flex-col divide-y">{orders.map((order) => <OrderItem key={order.id} order={order} onChanged={reload} />)}</ol>
    </div>
  );
}

export function GuardianPage() {
  const { t } = useT();
  return (
    <RequireLogin title={t("부모님 주문", "Your parent's orders")} description={t("부모님이 전화로 주문한 내용을 확인하려면 로그인하세요.", "Log in to see what your parent ordered by phone.")}>
      {() => <Orders />}
    </RequireLogin>
  );
}
