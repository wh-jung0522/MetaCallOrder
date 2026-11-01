import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Message, MessageContent } from "@/components/ui/message";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RequireLogin } from "../auth";
import { useT, type Pair, type T } from "../i18n";
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

const OUTCOMES: Record<string, { label: Pair; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  ordered: { label: ["주문 완료", "Order placed"], variant: "default" },
  completed: { label: ["통화 완료", "Call finished"], variant: "secondary" },
  handoff: { label: ["상담원 연결", "Sent to operator"], variant: "secondary" },
  fail_safe: { label: ["장애로 연결 전환", "Error, sent to operator"], variant: "destructive" },
  silence: { label: ["응답 없음", "No answer"], variant: "outline" },
  max_duration: { label: ["시간 초과", "Time limit reached"], variant: "destructive" },
  abandoned: { label: ["중간에 끊음", "Hung up early"], variant: "outline" },
};

const IN_PROGRESS: Pair = ["진행 중", "In progress"];

function median(values: number[]): number | null {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

const firstVoice = (call: CallRow) => median((call.latency_metrics ?? []).flatMap((turn) => turn.tts_first_chunk_ms ?? []));

function duration(call: CallRow, t: T): string {
  if (!call.ended_at) return t(...IN_PROGRESS);
  const seconds = Math.round((new Date(call.ended_at).getTime() - new Date(call.started_at).getTime()) / 1000);
  return t(`${Math.floor(seconds / 60)}분 ${seconds % 60}초`, `${Math.floor(seconds / 60)} min ${seconds % 60} sec`);
}

const startedAt = (call: CallRow, t: T) => new Date(call.started_at).toLocaleString(t("ko-KR", "en-US"), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function CallDetail({ call }: { call: CallRow }) {
  const { t } = useT();
  const outcome = OUTCOMES[call.outcome ?? ""];
  return (
    <SheetContent className="sm:max-w-lg">
      <SheetHeader>
        <SheetTitle>{t(`${call.customers?.name ?? "미등록 번호"} 통화`, call.customers ? `Call with ${call.customers.name}` : "Call from an unregistered number")}</SheetTitle>
        <SheetDescription>{startedAt(call, t)}, {duration(call, t)}, {t(...(outcome?.label ?? IN_PROGRESS))}</SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-6">
        {call.handoff_reason && <Alert><AlertDescription>{t("연결 사유: ", "Reason for transfer: ")}{call.handoff_reason}</AlertDescription></Alert>}
        {!call.transcript?.length && <p className="text-sm text-muted-foreground">{t("통화 내용이 없거나 보관 기간 30일이 지났습니다.", "There is no transcript, or it was deleted after 30 days.")}</p>}
        {(call.transcript ?? []).map((line, index) => (
          <Message key={index} align={line.role === "caller" ? "end" : "start"}>
            <MessageContent>
              <Bubble variant={line.role === "caller" ? "default" : "muted"} align={line.role === "caller" ? "end" : "start"}>
                <BubbleContent>{line.text}</BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>
        ))}
      </div>
    </SheetContent>
  );
}

function Calls() {
  const { t } = useT();
  const [calls, setCalls] = useState<CallRow[] | null>(null);
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

  if (error) return <Alert variant="destructive"><AlertDescription>{t("통화 기록을 불러오지 못했습니다. 새로고침해 주세요.", "Could not load call history. Please refresh the page.")}</AlertDescription></Alert>;
  if (!calls) return <Skeleton className="h-64 w-full" />;
  if (!calls.length) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t("통화 기록이 없습니다", "No call history yet")}</EmptyTitle>
          <EmptyDescription>{t("전화를 한 통 걸면 통화 내용과 비용이 여기에 쌓입니다.", "Make a call and its transcript and cost will appear here.")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent><Button asChild><a href="/sim">{t("전화 걸기", "Make a call")}</a></Button></EmptyContent>
      </Empty>
    );
  }

  const ordered = calls.filter((call) => call.outcome === "ordered").length;
  const costs = calls.flatMap((call) => (call.cost_usd === null ? [] : Number(call.cost_usd)));
  const averageCost = costs.length ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length : null;

  return (
    <>
      <p className="text-muted-foreground">{t(`최근 ${calls.length}통 중 ${ordered}통이 주문으로 끝났습니다.`, `${ordered} of the last ${calls.length} calls ended with an order.`)}{averageCost !== null && t(` 통화당 평균 비용은 $${averageCost.toFixed(4)}입니다.`, ` The average cost per call is $${averageCost.toFixed(4)}.`)}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("시작", "Started")}</TableHead>
            <TableHead>{t("고객", "Customer")}</TableHead>
            <TableHead>{t("결과", "Result")}</TableHead>
            <TableHead className="text-right">{t("통화 길이", "Call length")}</TableHead>
            <TableHead className="text-right">{t("첫 응답까지", "First reply")}</TableHead>
            <TableHead className="text-right">{t("비용", "Cost")}</TableHead>
            <TableHead><span className="sr-only">{t("통화 내용", "Transcript")}</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {calls.map((call) => {
            const outcome = OUTCOMES[call.outcome ?? ""];
            const voice = firstVoice(call);
            return (
              <TableRow key={call.call_sid}>
                <TableCell>{startedAt(call, t)}</TableCell>
                <TableCell>{call.customers?.name ?? t("미등록 번호", "Unregistered number")}</TableCell>
                <TableCell><Badge variant={outcome?.variant ?? "outline"}>{t(...(outcome?.label ?? IN_PROGRESS))}</Badge></TableCell>
                <TableCell className="text-right tabular-nums">{duration(call, t)}</TableCell>
                <TableCell className="text-right tabular-nums">{voice === null ? t("없음", "None") : t(`${(voice / 1000).toFixed(1)}초`, `${(voice / 1000).toFixed(1)} sec`)}</TableCell>
                <TableCell className="text-right tabular-nums">{call.cost_usd === null ? t("없음", "None") : `$${Number(call.cost_usd).toFixed(4)}`}</TableCell>
                <TableCell className="text-right">
                  <Sheet>
                    <SheetTrigger asChild><Button variant="ghost" size="sm">{t("통화 내용", "Transcript")}</Button></SheetTrigger>
                    <CallDetail call={call} />
                  </Sheet>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}

export function AdminPage() {
  const { t } = useT();
  return (
    <RequireLogin title={t("통화 기록", "Call history")} description={t("통화 내용과 비용을 보려면 관리자 계정으로 로그인하세요.", "Log in with an admin account to see call transcripts and costs.")}>
      {() => <Calls />}
    </RequireLogin>
  );
}
