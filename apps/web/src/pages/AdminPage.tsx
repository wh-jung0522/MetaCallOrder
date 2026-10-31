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

const OUTCOMES: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  ordered: { label: "주문 완료", variant: "default" },
  completed: { label: "통화 완료", variant: "secondary" },
  handoff: { label: "상담원 연결", variant: "secondary" },
  fail_safe: { label: "장애로 연결 전환", variant: "destructive" },
  silence: { label: "응답 없음", variant: "outline" },
  max_duration: { label: "시간 초과", variant: "destructive" },
  abandoned: { label: "중간에 끊음", variant: "outline" },
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

const firstVoice = (call: CallRow) => median((call.latency_metrics ?? []).flatMap((turn) => turn.tts_first_chunk_ms ?? []));

function duration(call: CallRow): string {
  if (!call.ended_at) return "진행 중";
  const seconds = Math.round((new Date(call.ended_at).getTime() - new Date(call.started_at).getTime()) / 1000);
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

const startedAt = (call: CallRow) => new Date(call.started_at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function CallDetail({ call }: { call: CallRow }) {
  const outcome = OUTCOMES[call.outcome ?? ""];
  return (
    <SheetContent className="sm:max-w-lg">
      <SheetHeader>
        <SheetTitle>{call.customers?.name ?? "미등록 번호"} 통화</SheetTitle>
        <SheetDescription>{startedAt(call)}, {duration(call)}, {outcome?.label ?? "진행 중"}</SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-6">
        {call.handoff_reason && <Alert><AlertDescription>연결 사유: {call.handoff_reason}</AlertDescription></Alert>}
        {!call.transcript?.length && <p className="text-sm text-muted-foreground">통화 내용이 없거나 보관 기간 30일이 지났습니다.</p>}
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

  if (error) return <Alert variant="destructive"><AlertDescription>통화 기록을 불러오지 못했습니다. 새로고침해 주세요.</AlertDescription></Alert>;
  if (!calls) return <Skeleton className="h-64 w-full" />;
  if (!calls.length) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>통화 기록이 없습니다</EmptyTitle>
          <EmptyDescription>전화를 한 통 걸면 통화 내용과 비용이 여기에 쌓입니다.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent><Button asChild><a href="/sim">전화 걸기</a></Button></EmptyContent>
      </Empty>
    );
  }

  const ordered = calls.filter((call) => call.outcome === "ordered").length;
  const costs = calls.flatMap((call) => (call.cost_usd === null ? [] : Number(call.cost_usd)));
  const averageCost = costs.length ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length : null;

  return (
    <>
      <p className="text-muted-foreground">최근 {calls.length}통 중 {ordered}통이 주문으로 끝났습니다.{averageCost !== null && ` 통화당 평균 비용은 $${averageCost.toFixed(4)}입니다.`}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>시작</TableHead>
            <TableHead>고객</TableHead>
            <TableHead>결과</TableHead>
            <TableHead className="text-right">통화 길이</TableHead>
            <TableHead className="text-right">첫 응답까지</TableHead>
            <TableHead className="text-right">비용</TableHead>
            <TableHead><span className="sr-only">통화 내용</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {calls.map((call) => {
            const outcome = OUTCOMES[call.outcome ?? ""];
            const voice = firstVoice(call);
            return (
              <TableRow key={call.call_sid}>
                <TableCell>{startedAt(call)}</TableCell>
                <TableCell>{call.customers?.name ?? "미등록 번호"}</TableCell>
                <TableCell><Badge variant={outcome?.variant ?? "outline"}>{outcome?.label ?? "진행 중"}</Badge></TableCell>
                <TableCell className="text-right tabular-nums">{duration(call)}</TableCell>
                <TableCell className="text-right tabular-nums">{voice === null ? "없음" : `${(voice / 1000).toFixed(1)}초`}</TableCell>
                <TableCell className="text-right tabular-nums">{call.cost_usd === null ? "없음" : `$${Number(call.cost_usd).toFixed(4)}`}</TableCell>
                <TableCell className="text-right">
                  <Sheet>
                    <SheetTrigger asChild><Button variant="ghost" size="sm">통화 내용</Button></SheetTrigger>
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
  return (
    <RequireLogin title="통화 기록" description="통화 내용과 비용을 보려면 관리자 계정으로 로그인하세요.">
      {() => <Calls />}
    </RequireLogin>
  );
}
