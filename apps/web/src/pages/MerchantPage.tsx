import { RequireLogin } from "../auth";
import { describeItems, STATUS_LABEL, useOrders, type OrderRow } from "../orders";
import { supabase } from "../supabase";

function Orders() {
  const { orders, error, newestId } = useOrders();
  const decide = async (order: OrderRow, status: "accepted" | "rejected") => {
    const { error: failure } = await supabase.from("orders").update({ status }).eq("id", order.id);
    if (failure) alert(failure.message);
  };

  if (error) return <p role="alert" className="error">{error}</p>;
  return (
    <div className="stack">
      {orders.length === 0 && <p className="muted">들어온 주문이 없습니다.</p>}
      {orders.map((order) => (
        <article key={order.id} className={`card ${order.id === newestId ? "new" : ""}`}>
          <header><strong>{order.customers?.name}</strong> · {order.stores?.name}<span className={`badge ${order.status}`}>{STATUS_LABEL[order.status]}</span></header>
          <p>{describeItems(order.items)}</p>
          <p>{order.delivery_address} · {order.total.toLocaleString("ko-KR")}원 · {new Date(order.created_at).toLocaleTimeString("ko-KR")}</p>
          {order.status === "pending" && (
            <div className="row">
              <button onClick={() => decide(order, "accepted")}>수락</button>
              <button className="secondary" onClick={() => decide(order, "rejected")}>거절</button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

export function MerchantPage() {
  return (
    <>
      <h1>가맹점 주문</h1>
      <RequireLogin>{() => <Orders />}</RequireLogin>
    </>
  );
}
