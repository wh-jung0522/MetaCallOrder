import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller";
import { Skeleton } from "@/components/ui/skeleton";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceLine, TraceTitle } from "@/components/ui/trace";
import { useT, type T } from "../i18n";
import { supabase } from "../supabase";

interface LogRow {
  seq: number;
  ms: number;
  kind: string;
  payload: Record<string, any>;
}

const PAGE = 1000; // Supabase returns at most 1000 rows per request.
const SIGNED_URL_SECONDS = 3600;

async function loadLogs(callSid: string): Promise<LogRow[]> {
  const rows: LogRow[] = [];
  for (;;) {
    const { data, error } = await supabase.from("call_logs").select("seq, ms, kind, payload").eq("call_sid", callSid).order("seq").range(rows.length, rows.length + PAGE - 1);
    if (error) throw error;
    rows.push(...(data as LogRow[]));
    if (data.length < PAGE) return rows;
  }
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const pretty = (value: unknown) => {
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};

function Detail({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div className="mb-2 last:mb-0">
      <p className="text-xs font-medium">{label}</p>
      <pre className="font-mono text-xs break-words whitespace-pre-wrap">{pretty(value)}</pre>
    </div>
  );
}

function Expandable({ title, description, failed, children }: { title: string; description?: string; failed?: boolean; children: React.ReactNode }) {
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine status={failed ? "error" : undefined}>
            <TraceTitle>{title}</TraceTitle>
            {description && <TraceDescription>{description}</TraceDescription>}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>{children}</TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

function latencyText(payload: Record<string, number>, t: T): string {
  const part = (ms: number | undefined, ko: string, en: string) => (ms === undefined ? [] : [t(`${ko} ${ms}ms`, `${en} ${ms} ms`)]);
  return [
    ...part(payload.final_ms, "글자 변환", "transcript"),
    ...part(payload.llm_first_token_ms, "AI 첫 응답", "first AI reply"),
    ...part(payload.tts_first_chunk_ms, "첫 음성", "first voice"),
  ].join(", ");
}

const TOOL_FAILED = (result: unknown) => typeof result === "object" && result !== null && "error" in result;

function Entry({ log, request, seekTo, seek }: { log: LogRow; request?: LogRow; seekTo: number; seek: ((ms: number) => void) | null }) {
  const { t } = useT();
  const { kind, payload } = log;

  if (kind === "stt_final" || kind === "say") {
    const caller = kind === "stt_final";
    const align = caller ? "end" : "start";
    return (
      <Message align={align}>
        <MessageContent>
          <Bubble variant={caller ? "default" : "muted"} align={align}>
            {seek ? (
              <BubbleContent asChild>
                <button type="button" onClick={() => seek(seekTo)} aria-label={t(`${clock(seekTo)}부터 듣기: ${payload.text}`, `Listen from ${clock(seekTo)}: ${payload.text}`)}>{payload.text}</button>
              </BubbleContent>
            ) : <BubbleContent>{payload.text}</BubbleContent>}
          </Bubble>
          <MessageFooter>
            {clock(seekTo)}
            {caller && payload.partials > 0 && t(`, 중간 인식 ${payload.partials}번`, `, ${payload.partials} partial result${payload.partials === 1 ? "" : "s"}`)}
            {payload.ignored && t(", 안내 중에 한 말이라 넘겼습니다", ", spoken over the agent so it was skipped")}
          </MessageFooter>
        </MessageContent>
      </Message>
    );
  }
  if (kind === "llm_response") {
    const order = payload.agent === "order";
    return (
      <Expandable title={order ? t("주문 담당 AI 응답", "Order agent reply") : t("대화 담당 AI 응답", "Conversation agent reply")} description={t(`${payload.ms}ms`, `${payload.ms} ms`)}>
        <Detail label={t("보낸 메시지 수", "Messages sent")} value={request?.payload.messages} />
        <Detail label={t("마지막으로 보낸 내용", "Last message sent")} value={request?.payload.last} />
        <Detail label={t("응답", "Reply")} value={payload.text} />
        <Detail label={t("도구 요청", "Tools requested")} value={payload.tool_calls?.length ? payload.tool_calls : null} />
        <Detail label={t("토큰", "Tokens")} value={payload.usage} />
      </Expandable>
    );
  }
  if (kind === "tool_call") {
    return (
      <Expandable title={t(`도구 사용: ${payload.tool}`, `Tool used: ${payload.tool}`)} failed={TOOL_FAILED(payload.result)}>
        <Detail label={t("입력", "Input")} value={payload.args} />
        <Detail label={t("결과", "Result")} value={payload.result} />
      </Expandable>
    );
  }
  if (kind === "latency") {
    const text = latencyText(payload, t);
    return text ? <Trace><TraceLine><TraceTitle className="whitespace-normal">{t(`응답 속도: ${text}`, `Response time: ${text}`)}</TraceTitle></TraceLine></Trace> : null;
  }
  if (kind === "fail_safe") return <Trace><TraceLine status="error"><TraceTitle className="whitespace-normal">{t(`장애로 연결 전환: ${payload.reason}`, `Error, sent to operator: ${payload.reason}`)}</TraceTitle></TraceLine></Trace>;
  if (kind === "tts_off") return <Trace><TraceLine status="error"><TraceTitle className="whitespace-normal">{t(`음성을 끄고 글자로만 진행: ${payload.reason}`, `Voice turned off, text only: ${payload.reason}`)}</TraceTitle></TraceLine></Trace>;
  if (kind === "usage") {
    return (
      <Expandable title={t("사용량", "Usage")} description={payload.cost_usd === undefined ? undefined : `$${Number(payload.cost_usd).toFixed(4)}`}>
        <Detail label={t("입력 토큰", "Input tokens")} value={payload.input} />
        <Detail label={t("출력 토큰", "Output tokens")} value={payload.output} />
        <Detail label={t("음성 글자 수", "Characters spoken")} value={payload.ttsChars} />
        <Detail label={t("음성 길이(초)", "Voice seconds")} value={payload.ttsSeconds} />
      </Expandable>
    );
  }
  const note: Record<string, string> = {
    barge_in: t("고객이 끼어들어 재생을 멈췄습니다", "The caller interrupted, so playback stopped"),
    turn_cancelled: t("새 말씀이 들어와 이전 처리를 멈췄습니다", "A new utterance replaced the turn in progress"),
    confirmation: payload.outcome === "confirmed" ? t("고객이 주문을 확인했습니다", "The caller confirmed the order") : t("고객이 복창 내용을 거절했습니다", "The caller said no to the read-back"),
    dtmf: t(`키패드 ${payload.digit}번`, `Keypad ${payload.digit}`),
    call_end: t("통화 종료", "Call ended"),
  };
  return note[kind] ? <Marker variant={kind === "call_end" ? "separator" : "default"}><MarkerContent>{note[kind]}</MarkerContent></Marker> : null;
}

const SHOWN = new Set(["stt_final", "say", "llm_response", "tool_call", "latency", "fail_safe", "tts_off", "usage", "barge_in", "turn_cancelled", "confirmation", "dtmf", "call_end"]);

export function CallLogs({ callSid }: { callSid: string }) {
  const { t } = useT();
  const [logs, setLogs] = useState<LogRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [audio, setAudio] = useState<{ url?: string; missing?: boolean }>({});
  const player = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let current = true;
    loadLogs(callSid).then(
      async (rows) => {
        if (!current) return;
        setLogs(rows);
        const path = rows.find((row) => row.kind === "audio")?.payload.path;
        if (!path) return setAudio({ missing: true });
        const { data } = await supabase.storage.from("call-audio").createSignedUrl(path, SIGNED_URL_SECONDS);
        if (current) setAudio(data ? { url: data.signedUrl } : { missing: true });
      },
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [callSid]);

  // Each row's place in the audio: a caller's from when they started speaking, an agent's from when its voice started.
  const entries = useMemo(() => {
    const heard = new Map((logs ?? []).filter((row) => row.kind === "tts_start").map((row) => [row.payload.say as number, row.payload.audio_ms as number]));
    const requests = new Map<string, LogRow>();
    let speechStart: number | null = null;
    return (logs ?? []).flatMap((log) => {
      if (log.kind === "stt_speech_start") speechStart ??= log.ms;
      if (log.kind === "llm_request") requests.set(`${log.payload.agent}:${log.payload.step}`, log);
      if (!SHOWN.has(log.kind)) return [];
      let seekTo = log.ms;
      if (log.kind === "stt_final") {
        seekTo = speechStart ?? log.ms;
        speechStart = null;
      }
      if (log.kind === "say") seekTo = heard.get(log.seq) ?? log.ms;
      return [{ log, seekTo, request: log.kind === "llm_response" ? requests.get(`${log.payload.agent}:${log.payload.step}`) : undefined }];
    });
  }, [logs]);

  const seek = (ms: number) => {
    const element = player.current!;
    element.currentTime = ms / 1000;
    void element.play();
  };

  if (failed) return <Alert variant="destructive" className="mx-4 w-auto"><AlertDescription>{t("통화 로그를 불러오지 못했습니다. 다시 열어 주세요.", "Could not load the call logs. Please open them again.")}</AlertDescription></Alert>;
  if (!logs) return <div className="flex flex-col gap-3 px-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-64 w-full" /></div>;
  if (!logs.length) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t("통화 로그가 없습니다", "No call logs")}</EmptyTitle>
          <EmptyDescription>{t("로그를 남기기 전의 통화이거나, 보관 기간 30일이 지났습니다.", "This call came before logging began, or its logs were deleted after 30 days.")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-col gap-1 px-4">
        {audio.url && (
          <>
            <audio ref={player} controls preload="metadata" src={audio.url} className="w-full" />
            <p className="text-xs text-muted-foreground">{t("왼쪽은 고객, 오른쪽은 상담 AI입니다. 말풍선을 누르면 그 부분부터 들립니다.", "The caller is on the left and the AI agent on the right. Press a bubble to hear that moment.")}</p>
          </>
        )}
        {audio.missing && <p className="text-sm text-muted-foreground">{t("이 통화의 녹음이 없습니다. 저장에 실패했거나 보관 기간 30일이 지났습니다.", "There is no recording of this call. Saving it failed, or it was deleted after 30 days.")}</p>}
        {!audio.url && !audio.missing && <Skeleton className="h-10 w-full" />}
      </div>
      <MessageScrollerProvider defaultScrollPosition="start">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-3 px-4 pb-6">
              {entries.map(({ log, seekTo, request }) => (
                <MessageScrollerItem key={log.seq} messageId={String(log.seq)} className="overflow-visible px-px">
                  <Entry log={log} request={request} seekTo={seekTo} seek={audio.url ? seek : null} />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}
