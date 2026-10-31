import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Message, MessageContent } from "@/components/ui/message";

const EXAMPLE: { who: "caller" | "agent"; text: string }[] = [
  { who: "caller", text: "거기 저번에 시킨 국밥 두 그릇 갖다 줘요" },
  { who: "agent", text: "네, 행복국밥 순대국밥 말씀이시죠? 맵기는 어떻게 해 드릴까요?" },
  { who: "caller", text: "안 맵게 해 줘요" },
  { who: "agent", text: "행복국밥에서 안 맵게 순대국밥 두 개, 배달비 포함 이만 원, 행복동 12번지로 보내드릴까요?" },
  { who: "caller", text: "네" },
];

const STEPS = [
  { title: "늘 쓰던 전화로 겁니다", body: "앱을 깔거나 가입하지 않아도 됩니다. 등록된 번호면 누구신지 먼저 알아봅니다." },
  { title: "평소 말투로 주문합니다", body: "\"저번에 시킨 국밥\"이라고 해도 지난 주문과 메뉴에서 찾아 되묻습니다." },
  { title: "\"네\"라고 해야 주문됩니다", body: "가게, 메뉴, 금액, 주소를 천천히 읽어 드리고, 직접 확인한 뒤에만 주문이 들어갑니다." },
];

export function HomePage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-14 px-4 py-12 md:px-6 md:py-20">
      <section className="grid items-center gap-12 md:grid-cols-2">
        <div className="flex flex-col items-start gap-6">
          <h1 className="text-5xl font-extrabold leading-tight tracking-tight md:text-6xl">전화 한 통이면<br />주문이 끝납니다</h1>
          <p className="max-w-md text-lg text-muted-foreground">화면을 보기 어려워도 괜찮습니다. 늘 하던 대로 전화로 말씀하시면 단골 가게의 음식과 생필품을 대신 주문해 드립니다.</p>
          <Button asChild size="lg" className="h-12 px-6 text-base"><a href="/sim">통화 시연해 보기</a></Button>
        </div>
        <div className="flex flex-col gap-3" aria-label="통화 예시">
          {EXAMPLE.map((line, index) => (
            <Message key={index} align={line.who === "caller" ? "end" : "start"}>
              <MessageContent>
                <Bubble variant={line.who === "caller" ? "default" : "muted"} align={line.who === "caller" ? "end" : "start"}>
                  <BubbleContent>{line.text}</BubbleContent>
                </Bubble>
              </MessageContent>
            </Message>
          ))}
        </div>
      </section>
      <ol className="grid gap-8 border-t pt-10 md:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex flex-col gap-2">
            <h2 className="text-lg font-bold">{index + 1}. {step.title}</h2>
            <p className="text-muted-foreground">{step.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
