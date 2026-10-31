import { useEffect, useState } from "react";
import { RequireLogin } from "../auth";
import { supabase } from "../supabase";

interface CallRow {
  call_sid: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  cost_usd: number | null;
  handoff_reason: string | null;
  transcript: { role: "caller" | "agent"; text: string }[] | null;
  latency_metrics: { tts_first_chunk_ms?: number }[] | null;
  customers: { name: string } | null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

function Calls() {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase
      .from("calls")
      .select("call_sid, started_at, ended_at, outcome, cost_usd, handoff_reason, transcript, latency_metrics, customers(name)")
      .order("started_at", { ascending: false })
      .limit(50)
      .then(({ data, error: failure }) => {
        if (failure) setError(failure.message);
        else setCalls(data as unknown as CallRow[]);
      });
  }, []);

  if (error) return <p role="alert" className="error">{error}</p>;
  return (
    <div className="stack">
      {calls.length === 0 && <p className="muted">통화 기록이 없거나 관리자 권한이 없습니다.</p>}
      {calls.map((call) => {
        const firstVoice = median((call.latency_metrics ?? []).flatMap((turn) => turn.tts_first_chunk_ms ?? []));
        return (
          <details key={call.call_sid} className="card">
            <summary>
              {new Date(call.started_at).toLocaleString("ko-KR")} · {call.customers?.name ?? "미등록"} · {call.outcome ?? "진행 중"}
              {firstVoice !== null && ` · 첫 음성 ${firstVoice}ms`}
              {call.cost_usd !== null && ` · $${Number(call.cost_usd).toFixed(4)}`}
            </summary>
            {call.handoff_reason && <p className="muted">연결 사유: {call.handoff_reason}</p>}
            {(call.transcript ?? []).map((line, index) => (
              <p key={index}><strong>{line.role === "caller" ? "고객" : "상담원"}</strong> {line.text}</p>
            ))}
          </details>
        );
      })}
    </div>
  );
}

export function AdminPage() {
  return (
    <>
      <h1>통화 기록</h1>
      <RequireLogin>{() => <Calls />}</RequireLogin>
    </>
  );
}
