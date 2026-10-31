import { RequireLogin } from "../auth";
import { describeItems, STATUS_LABEL, useOrders, type OrderRow } from "../orders";
import { supabase } from "../supabase";

function Orders() {
  const { orders, error } = useOrders();
  const cancel = async (order: OrderRow) => {
    if (!confirm("이 주문을 취소할까요?")) return;
    const { error: failure } = await supabase.from("orders").update({ status: "cancelled" }).eq("id", order.id);
    if (failure) alert(failure.message);
  };

  if (error) return <p role="alert" className="error">{error}</p>;
  return (
    <div className="stack">
      {orders.length === 0 && <p className="muted">주문 내역이 없습니다.</p>}
      {orders.map((order) => (
        <article key={order.id} className="card">
          <header><strong>{order.customers?.name}</strong> · {order.stores?.name}<span className={`badge ${order.status}`}>{STATUS_LABEL[order.status]}</span></header>
          <p>{describeItems(order.items)}</p>
          <p>{order.delivery_address} · {order.total.toLocaleString("ko-KR")}원 · {new Date(order.created_at).toLocaleString("ko-KR")}</p>
          {(order.status === "pending" || order.status === "accepted") && (
            <button className="secondary" onClick={() => cancel(order)}>주문 취소</button>
          )}
        </article>
      ))}
    </div>
  );
}

export function GuardianPage() {
  return (
    <>
      <h1>보호자 주문 확인</h1>
      <RequireLogin>{() => <Orders />}</RequireLogin>
    </>
  );
}
