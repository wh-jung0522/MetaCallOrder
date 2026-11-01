import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Message, MessageContent } from "@/components/ui/message";
import { useT, type Pair } from "../i18n";

const EXAMPLE: { who: "caller" | "agent"; text: Pair }[] = [
  { who: "caller", text: ["거기 저번에 시킨 국밥 두 그릇 갖다 줘요", "Please bring me two bowls of the gukbap I got last time"] },
  { who: "agent", text: ["네, 행복국밥 순대국밥 말씀이시죠? 맵기는 어떻게 해 드릴까요?", "Sure, you mean the soondae gukbap from Haengbok Gukbap? How spicy would you like it?"] },
  { who: "caller", text: ["안 맵게 해 줘요", "Not spicy, please"] },
  { who: "agent", text: ["행복국밥에서 안 맵게 순대국밥 두 개, 배달비 포함 이만 원, 행복동 12번지로 보내드릴까요?", "Two mild soondae gukbap from Haengbok Gukbap, 20,000 won with delivery, to 12 Haengbok-dong. Shall I send it?"] },
  { who: "caller", text: ["네", "Yes"] },
];

const STEPS: { title: Pair; body: Pair }[] = [
  { title: ["늘 쓰던 전화로 겁니다", "Call from your usual phone"], body: ["앱을 깔거나 가입하지 않아도 됩니다. 등록된 번호면 누구신지 먼저 알아봅니다.", "There is no app to install and no sign-up. If your number is registered, we know who you are right away."] },
  { title: ["평소 말투로 주문합니다", "Order the way you normally talk"], body: ["\"저번에 시킨 국밥\"이라고 해도 지난 주문과 메뉴에서 찾아 되묻습니다.", "Even if you say \"the gukbap I got last time\", we look through your past orders and the menu, then check with you."] },
  { title: ["\"네\"라고 해야 주문됩니다", "Nothing is ordered until you say \"yes\""], body: ["가게, 메뉴, 금액, 주소를 천천히 읽어 드리고, 직접 확인한 뒤에만 주문이 들어갑니다.", "We slowly read back the store, items, price, and address. The order goes in only after you confirm."] },
];

export function HomePage() {
  const { t } = useT();
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-14 px-4 py-12 md:px-6 md:py-20">
      <section className="grid items-center gap-12 md:grid-cols-2">
        <div className="flex flex-col items-start gap-6">
          <h1 className="text-5xl font-extrabold leading-tight tracking-tight md:text-6xl">{t("전화 한 통이면", "One phone call")}<br />{t("주문이 끝납니다", "and it's ordered")}</h1>
          <p className="max-w-md text-lg text-muted-foreground">{t("화면을 보기 어려워도 괜찮습니다. 늘 하던 대로 전화로 말씀하시면 단골 가게의 음식과 생필품을 대신 주문해 드립니다.", "It is fine if screens are hard to read. Just talk on the phone as you always do, and we will order food and everyday items from your regular stores for you.")}</p>
          <Button asChild size="lg" className="h-12 px-6 text-base"><a href="/sim">{t("통화 시연해 보기", "Try a demo call")}</a></Button>
        </div>
        <div className="flex flex-col gap-3" aria-label={t("통화 예시", "Example call")}>
          {EXAMPLE.map((line, index) => (
            <Message key={index} align={line.who === "caller" ? "end" : "start"}>
              <MessageContent>
                <Bubble variant={line.who === "caller" ? "default" : "muted"} align={line.who === "caller" ? "end" : "start"}>
                  <BubbleContent>{t(...line.text)}</BubbleContent>
                </Bubble>
              </MessageContent>
            </Message>
          ))}
        </div>
      </section>
      <ol className="grid gap-8 border-t pt-10 md:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={index} className="flex flex-col gap-2">
            <h2 className="text-lg font-bold">{index + 1}. {t(...step.title)}</h2>
            <p className="text-muted-foreground">{t(...step.body)}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
