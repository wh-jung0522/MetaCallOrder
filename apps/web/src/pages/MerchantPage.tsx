import type { SupabaseClient } from "@supabase/supabase-js";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Account, LoginForm, useSession } from "../auth";
import { useT, type Pair } from "../i18n";
import { customerLabel, isToday, itemLabel, timeAgo, useLinkedIds, useOrders, won, type OrderRow } from "../orders";
import { publicDb, supabase } from "../supabase";

const COLUMNS: { title: Pair; statuses: OrderRow["status"][]; empty: Pair }[] = [
  { title: ["새 주문", "New orders"], statuses: ["pending"], empty: ["새 주문이 오면 여기에 바로 표시됩니다.", "New orders will show up here right away."] },
  { title: ["수락한 주문", "Accepted orders"], statuses: ["accepted"], empty: ["수락한 주문이 없습니다.", "No accepted orders."] },
  { title: ["거절·취소", "Declined or cancelled"], statuses: ["rejected", "cancelled"], empty: ["거절하거나 취소된 주문이 없습니다.", "No declined or cancelled orders."] },
];

function OrderCard({ order, db, isNew, onError, onChanged }: { order: OrderRow; db: SupabaseClient; isNew: boolean; onError: (failed: boolean) => void; onChanged: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const decide = async (status: "accepted" | "rejected") => {
    setBusy(true);
    const { error } = await db.from("orders").update({ status }).eq("id", order.id);
    setBusy(false);
    onError(Boolean(error));
    onChanged();
  };

  return (
    <Card data-new={isNew && order.status === "pending"} className="data-[new=true]:ring-2 data-[new=true]:ring-primary">
      <CardHeader>
        <CardTitle>{order.stores?.name}</CardTitle>
        <CardDescription>{order.customers && `${customerLabel(order.customers, t)}, `}{timeAgo(order.created_at, t)}{order.status === "cancelled" && t(", 보호자가 취소", ", cancelled by the guardian")}{order.status === "rejected" && t(", 가게에서 거절", ", declined by the store")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1 text-lg font-semibold">
          {order.items.map((line, index) => (
            <li key={index} className="flex justify-between gap-4"><span>{itemLabel(line, t)}</span><span className="whitespace-nowrap">{t(`${line.quantity}개`, `× ${line.quantity}`)}</span></li>
          ))}
        </ul>
        <Separator />
        <div className="flex justify-between gap-4 text-sm"><span className="text-muted-foreground">{t("배달지", "Deliver to")}</span><span className="text-right">{order.delivery_address}</span></div>
        <div className="flex justify-between gap-4"><span className="text-sm text-muted-foreground">{t("합계", "Total")}</span><span className="font-bold tabular-nums">{won(order.total, t)}</span></div>
      </CardContent>
      {order.status === "pending" && (
        <CardFooter className="grid grid-cols-[repeat(3,1fr)] gap-2">
          <Button variant="outline" disabled={busy} onClick={() => decide("rejected")}>{t("거절", "Decline")}</Button>
          <Button className="col-span-2" disabled={busy} onClick={() => decide("accepted")}>{t("주문 수락", "Accept order")}</Button>
        </CardFooter>
      )}
    </Card>
  );
}

function Board({ db }: { db: SupabaseClient }) {
  const { t } = useT();
  const { orders, error, loading, live, newestId, reload } = useOrders(db);
  const [actionError, setActionError] = useState(false);

  if (error) return <Alert variant="destructive"><AlertDescription>{t("주문을 불러오지 못했습니다. 새로고침해 주세요.", "Could not load orders. Please refresh the page.")}</AlertDescription></Alert>;
  if (loading) return <Skeleton className="h-64 w-full" />;

  const today = orders.filter((order) => isToday(order.created_at));
  const sales = today.filter((order) => order.status === "accepted").reduce((sum, order) => sum + order.total, 0);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground">{t(`오늘 주문 ${today.length}건, 수락 금액 `, `Orders today: ${today.length}, accepted total: `)}<b className="text-foreground tabular-nums">{won(sales, t)}</b></p>
        <Badge variant={live ? "secondary" : "outline"}>{live ? t("새 주문 받는 중", "Receiving new orders") : t("연결 중", "Connecting")}</Badge>
      </div>
      {actionError && <Alert variant="destructive"><AlertDescription>{t("주문 상태를 바꾸지 못했습니다. 다시 눌러 주세요.", "Could not update the order. Please press the button again.")}</AlertDescription></Alert>}
      <div className="grid items-start gap-6 md:grid-cols-3">
        {COLUMNS.map((column) => {
          const rows = orders.filter((order) => column.statuses.includes(order.status));
          return (
            <section key={column.statuses[0]} aria-label={t(...column.title)} className="flex flex-col gap-3">
              <h2 className="flex items-center gap-2 font-bold">{t(...column.title)}<Badge variant={column.statuses[0] === "pending" && rows.length ? "default" : "secondary"}>{rows.length}</Badge></h2>
              {rows.length === 0 && <p className="py-1 text-sm text-muted-foreground">{t(...column.empty)}</p>}
              {rows.map((order) => <OrderCard key={order.id} order={order} db={db} isNew={order.id === newestId} onError={setActionError} onChanged={reload} />)}
            </section>
          );
        })}
      </div>
    </>
  );
}

export function MerchantPage() {
  const { t } = useT();
  const session = useSession();
  const stores = useLinkedIds(session, "stores", "id", "owner_user_id");
  const [wantsLogin, setWantsLogin] = useState(false);
  const owner = Boolean(stores?.length);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{t("주문 받기", "Receive orders")}</h1>
        {session ? <Account session={session} /> : session === null && <Button variant="outline" size="sm" onClick={() => setWantsLogin((open) => !open)}>{t("가게 로그인", "Store login")}</Button>}
      </div>
      {!session && wantsLogin && <LoginForm title={t("가게 로그인", "Store login")} description={t("실제 전화로 들어온 주문까지 보려면 로그인하세요.", "Log in to also see orders from real phone calls.")} />}
      {stores === null ? <Skeleton className="h-64 w-full" /> : (
        <>
          {!owner && <p className="text-muted-foreground">{t("시연용 주문과 전화로 들어온 주문이 함께 보입니다. 누구나 수락하거나 거절해 볼 수 있습니다.", "Demo orders and orders from phone calls both appear here. Anyone can accept or decline them.")}</p>}
          <Board db={owner ? supabase : publicDb} />
        </>
      )}
    </div>
  );
}
