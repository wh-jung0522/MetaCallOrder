import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { RequireLogin } from "../auth";
import { isToday, itemLabel, timeAgo, useOrders, won, type OrderRow } from "../orders";
import { supabase } from "../supabase";

const COLUMNS: { title: string; statuses: OrderRow["status"][]; empty: string }[] = [
  { title: "새 주문", statuses: ["pending"], empty: "새 주문이 오면 여기에 바로 표시됩니다." },
  { title: "수락한 주문", statuses: ["accepted"], empty: "수락한 주문이 없습니다." },
  { title: "거절·취소", statuses: ["rejected", "cancelled"], empty: "거절하거나 취소된 주문이 없습니다." },
];

function OrderCard({ order, isNew, onError, onChanged }: { order: OrderRow; isNew: boolean; onError: (message: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const decide = async (status: "accepted" | "rejected") => {
    setBusy(true);
    const { error } = await supabase.from("orders").update({ status }).eq("id", order.id);
    setBusy(false);
    onError(error ? "주문 상태를 바꾸지 못했습니다. 다시 눌러 주세요." : "");
    onChanged();
  };

  return (
    <Card data-new={isNew && order.status === "pending"} className="data-[new=true]:ring-2 data-[new=true]:ring-primary">
      <CardHeader>
        <CardTitle>{order.stores?.name}</CardTitle>
        <CardDescription>{timeAgo(order.created_at)}{order.status === "cancelled" && ", 보호자가 취소"}{order.status === "rejected" && ", 가게에서 거절"}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1 text-lg font-semibold">
          {order.items.map((line, index) => (
            <li key={index} className="flex justify-between gap-4"><span>{itemLabel(line)}</span><span>{line.quantity}개</span></li>
          ))}
        </ul>
        <Separator />
        <div className="flex justify-between gap-4 text-sm"><span className="text-muted-foreground">배달지</span><span className="text-right">{order.delivery_address}</span></div>
        <div className="flex justify-between gap-4"><span className="text-sm text-muted-foreground">합계</span><span className="font-bold tabular-nums">{won(order.total)}</span></div>
      </CardContent>
      {order.status === "pending" && (
        <CardFooter className="grid grid-cols-3 gap-2">
          <Button variant="outline" disabled={busy} onClick={() => decide("rejected")}>거절</Button>
          <Button className="col-span-2" disabled={busy} onClick={() => decide("accepted")}>주문 수락</Button>
        </CardFooter>
      )}
    </Card>
  );
}

function Board() {
  const { orders, error, loading, live, newestId, reload } = useOrders();
  const [actionError, setActionError] = useState("");

  if (error) return <Alert variant="destructive"><AlertDescription>주문을 불러오지 못했습니다. 새로고침해 주세요.</AlertDescription></Alert>;
  if (loading) return <Skeleton className="h-64 w-full" />;

  const today = orders.filter((order) => isToday(order.created_at));
  const sales = today.filter((order) => order.status === "accepted").reduce((sum, order) => sum + order.total, 0);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground">오늘 주문 {today.length}건, 수락 금액 <b className="text-foreground tabular-nums">{won(sales)}</b></p>
        <Badge variant={live ? "secondary" : "outline"}>{live ? "새 주문 받는 중" : "연결 중"}</Badge>
      </div>
      {actionError && <Alert variant="destructive"><AlertDescription>{actionError}</AlertDescription></Alert>}
      <div className="grid items-start gap-6 md:grid-cols-3">
        {COLUMNS.map((column) => {
          const rows = orders.filter((order) => column.statuses.includes(order.status));
          return (
            <section key={column.title} aria-label={column.title} className="flex flex-col gap-3">
              <h2 className="flex items-center gap-2 font-bold">{column.title}<Badge variant={column.statuses[0] === "pending" && rows.length ? "default" : "secondary"}>{rows.length}</Badge></h2>
              {rows.length === 0 && <p className="py-6 text-sm text-muted-foreground">{column.empty}</p>}
              {rows.map((order) => <OrderCard key={order.id} order={order} isNew={order.id === newestId} onError={setActionError} onChanged={reload} />)}
            </section>
          );
        })}
      </div>
    </>
  );
}

export function MerchantPage() {
  return (
    <RequireLogin title="주문 받기" description="어르신이 전화로 넣은 주문을 받으려면 로그인하세요.">
      {() => <Board />}
    </RequireLogin>
  );
}
