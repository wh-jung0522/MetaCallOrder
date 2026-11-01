import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Account, LoginForm, useSession } from "../auth";
import { useT, type Pair } from "../i18n";
import { customerLabel, itemLabel, timeAgo, useLinkedIds, useOrders, won, type OrderRow } from "../orders";
import { publicDb, supabase } from "../supabase";

const STATUS: Record<OrderRow["status"], { label: Pair; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: ["가게 확인 중", "Store is checking"], variant: "default" },
  accepted: { label: ["가게에서 수락", "Store accepted"], variant: "secondary" },
  rejected: { label: ["가게에서 거절", "Store declined"], variant: "destructive" },
  cancelled: { label: ["취소됨", "Cancelled"], variant: "outline" },
};

const CANCEL_WINDOW_MS = 3 * 3_600_000;

function OrderItem({ order, db, showCustomer, onChanged }: { order: OrderRow; db: SupabaseClient; showCustomer: boolean; onChanged: () => void }) {
  const { t } = useT();
  const [error, setError] = useState(false);
  const summary = order.items.map((line) => t(`${itemLabel(line, t)} ${line.quantity}개`, `${itemLabel(line, t)} × ${line.quantity}`)).join(", ");
  const cancel = async () => {
    const { error: failure } = await db.from("orders").update({ status: "cancelled" }).eq("id", order.id);
    setError(Boolean(failure));
    onChanged();
  };

  return (
    <li className="flex flex-col gap-2 py-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">{order.stores?.name}</h2>
          <p className="text-sm text-muted-foreground">{showCustomer && order.customers && `${customerLabel(order.customers, t)}, `}{timeAgo(order.created_at, t)}</p>
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

function Orders({ db, customerIds }: { db: SupabaseClient; customerIds?: string[] }) {
  const { t } = useT();
  const { orders, error, loading, reload } = useOrders(db, customerIds);
  if (error) return <Alert variant="destructive"><AlertDescription>{t("주문을 불러오지 못했습니다. 새로고침해 주세요.", "Could not load orders. Please refresh the page.")}</AlertDescription></Alert>;
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (!orders.length) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t("아직 주문이 없습니다", "No orders yet")}</EmptyTitle>
          <EmptyDescription>{t("전화로 주문하면 여기에 바로 표시됩니다.", "When someone orders by phone, it will show up here right away.")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div>
      {customerIds && <p className="text-muted-foreground">{t(`${orders[0]?.customers?.name ?? ""}님의 최근 주문입니다. 잘못된 주문은 여기서 취소할 수 있습니다.`, `Recent orders for ${orders[0]?.customers?.name ?? ""}. You can cancel a wrong order here.`)}</p>}
      <Separator className="mt-4" />
      <ol className="flex flex-col divide-y">{orders.map((order) => <OrderItem key={order.id} order={order} db={db} showCustomer={!customerIds} onChanged={reload} />)}</ol>
    </div>
  );
}

export function GuardianPage() {
  const { t } = useT();
  const session = useSession();
  const parents = useLinkedIds(session, "guardians", "customer_id", "user_id");
  const [wantsLogin, setWantsLogin] = useState(false);
  const linked = Boolean(parents?.length);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{t("부모님 주문", "Your parent's orders")}</h1>
        {session ? <Account session={session} /> : session === null && <Button variant="outline" size="sm" onClick={() => setWantsLogin((open) => !open)}>{t("보호자 로그인", "Guardian login")}</Button>}
      </div>
      {!session && wantsLogin && <LoginForm title={t("보호자 로그인", "Guardian login")} description={t("실제 부모님 주문을 보려면 로그인하세요.", "Log in to see your own parent's orders.")} />}
      {parents === null ? <Skeleton className="h-40 w-full" /> : (
        <>
          {!linked && <p className="max-w-2xl text-muted-foreground">{session ? t("이 계정에 연결된 부모님이 없어 시연용 주문을 보여 드립니다. 누구나 확인하고 취소해 볼 수 있습니다.", "This account has no parent linked to it, so these are demo orders. Anyone can view and cancel them.") : t("시연용 주문입니다. 누구나 확인하고 취소해 볼 수 있습니다. 실제 고객의 주문은 여기에 나오지 않습니다.", "These are demo orders. Anyone can view and cancel them. Real customers' orders never appear here.")}</p>}
          {linked ? <Orders db={supabase} customerIds={parents!} /> : <Orders db={publicDb} />}
        </>
      )}
    </div>
  );
}
