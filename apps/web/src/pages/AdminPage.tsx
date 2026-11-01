import type { SupabaseClient } from "@supabase/supabase-js";
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
import { Switch } from "@/components/ui/switch";
import { Account, isAdmin, LoginForm, useSession } from "../auth";
import { useT, type Pair, type T } from "../i18n";
import { publicDb, supabase } from "../supabase";
import { CallLogs } from "./CallLogs";

interface CallRow {
  call_sid: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  cost_usd: number | null;
  // Not readable without a login: it can quote raw provider errors.
  handoff_reason?: string | null;
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

const PUBLIC_COLUMNS = "call_sid, started_at, ended_at, outcome, cost_usd, transcript, latency_metrics, customers(name)";

function Calls({ db, developer }: { db: SupabaseClient; developer: boolean }) {
  const { t } = useT();
  const [calls, setCalls] = useState<CallRow[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    db
      .from("calls")
      .select(developer ? `${PUBLIC_COLUMNS}, handoff_reason` : PUBLIC_COLUMNS)
      .order("started_at", { ascending: false })
      .limit(50)
      .then(({ data, error: failure }) => {
        if (failure) setError(failure.message);
        else setCalls(data as unknown as CallRow[]);
      });
  }, [db, developer]);

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
            <TableHead className="text-right max-sm:hidden">{t("통화 길이", "Call length")}</TableHead>
            <TableHead className="text-right max-md:hidden">{t("첫 응답까지", "First reply")}</TableHead>
            <TableHead className="text-right max-md:hidden">{t("비용", "Cost")}</TableHead>
            <TableHead><span className="sr-only">{t("통화 내용", "Transcript")}</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {calls.map((call) => {
            const outcome = OUTCOMES[call.outcome ?? ""];
            const voice = firstVoice(call);
            return (
              <TableRow key={call.call_sid}>
                <TableCell className="max-sm:whitespace-normal">{startedAt(call, t)}</TableCell>
                <TableCell className="max-sm:whitespace-normal">{call.customers?.name ?? t("미등록 번호", "Unregistered number")}</TableCell>
                <TableCell><Badge variant={outcome?.variant ?? "outline"} className="max-sm:h-auto max-sm:whitespace-normal">{t(...(outcome?.label ?? IN_PROGRESS))}</Badge></TableCell>
                <TableCell className="text-right tabular-nums max-sm:hidden">{duration(call, t)}</TableCell>
                <TableCell className="text-right tabular-nums max-md:hidden">{voice === null ? t("없음", "None") : t(`${(voice / 1000).toFixed(1)}초`, `${(voice / 1000).toFixed(1)} sec`)}</TableCell>
                <TableCell className="text-right tabular-nums max-md:hidden">{call.cost_usd === null ? t("없음", "None") : `$${Number(call.cost_usd).toFixed(4)}`}</TableCell>
                <TableCell className="text-right max-sm:flex max-sm:flex-col max-sm:items-end">
                  <Sheet>
                    <SheetTrigger asChild><Button variant="ghost" size="sm" className="max-sm:px-1">{t("통화 내용", "Transcript")}</Button></SheetTrigger>
                    <CallDetail call={call} />
                  </Sheet>
                  {developer && (
                    <Sheet>
                      <SheetTrigger asChild><Button variant="ghost" size="sm" className="max-sm:px-1">{t("로그", "Logs")}</Button></SheetTrigger>
                      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
                        <SheetHeader>
                          <SheetTitle>{t("통화 로그", "Call logs")}</SheetTitle>
                          <SheetDescription>{startedAt(call, t)}, {duration(call, t)}, {t(...(outcome?.label ?? IN_PROGRESS))}</SheetDescription>
                        </SheetHeader>
                        <CallLogs callSid={call.call_sid} />
                      </SheetContent>
                    </Sheet>
                  )}
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
  const session = useSession();
  const [wantsDeveloper, setWantsDeveloper] = useState(false);
  const admin = isAdmin(session);
  const developer = wantsDeveloper && admin;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{t("통화 기록", "Call history")}</h1>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            <Switch id="developer-view" checked={wantsDeveloper} onCheckedChange={setWantsDeveloper} />
            <label htmlFor="developer-view" className="text-sm font-medium">{t("개발자 보기", "Developer view")}</label>
          </div>
          {session && <Account session={session} />}
        </div>
      </div>
      {wantsDeveloper && session === null && <LoginForm title={t("관리자 로그인", "Admin login")} description={t("녹음과 통화 로그를 보려면 관리자 계정으로 로그인하세요.", "Log in with an admin account to see recordings and call logs.")} />}
      {wantsDeveloper && session && !admin && <Alert variant="destructive"><AlertDescription>{t("이 계정은 관리자가 아닙니다. 개발자 보기는 관리자 계정으로만 열 수 있습니다. 로그아웃한 뒤 관리자 계정으로 로그인해 주세요.", "This account is not an admin. Developer view only opens with an admin account. Log out, then log in with an admin account.")}</AlertDescription></Alert>}
      {!developer && <p className="text-muted-foreground">{t("시연 통화만 공개됩니다. 실제 고객의 통화는 여기에 나오지 않습니다.", "Only demo calls are public. Real customers' calls never appear here.")}</p>}
      <Calls key={developer ? "developer" : "public"} db={developer ? supabase : publicDb} developer={developer} />
    </div>
  );
}
