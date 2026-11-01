import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { LangProvider, useT, type Pair } from "./i18n";
import { AdminPage } from "./pages/AdminPage";
import { GuardianPage } from "./pages/GuardianPage";
import { HomePage } from "./pages/HomePage";
import { MerchantPage } from "./pages/MerchantPage";
import { SimulatorPage } from "./pages/SimulatorPage";
import "./index.css";

const LINKS: { path: string; label: Pair }[] = [
  { path: "/sim", label: ["전화 걸기", "Make a call"] },
  { path: "/merchant", label: ["가맹점", "Store"] },
  { path: "/guardian", label: ["보호자", "Guardian"] },
  { path: "/admin", label: ["관리자", "Admin"] },
];

const PAGES: Record<string, () => React.JSX.Element> = {
  "/sim": SimulatorPage,
  "/merchant": MerchantPage,
  "/guardian": GuardianPage,
  "/admin": AdminPage,
};

const Page = PAGES[location.pathname] ?? HomePage;

function App() {
  const { t, lang, setLang } = useT();
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex flex-wrap items-center gap-x-6 border-b px-4 md:h-14 md:px-6">
        <a href="/" className="flex items-center text-lg max-md:h-14 font-extrabold tracking-tight text-primary">{t("콜오더", "CallOrder")}</a>
        <nav aria-label={t("주요 화면", "Main screens")} className="flex gap-1 overflow-x-auto max-md:order-last max-md:w-full max-md:pb-2">
          {LINKS.map(({ path, label }) => (
            <Button key={path} asChild size="sm" variant={location.pathname === path ? "secondary" : "ghost"}>
              <a href={path} aria-current={location.pathname === path ? "page" : undefined}>{t(...label)}</a>
            </Button>
          ))}
        </nav>
        <div role="group" aria-label={t("언어", "Language")} className="ml-auto flex items-center gap-1 text-sm text-muted-foreground">
          <Button size="sm" lang="ko" variant={lang === "ko" ? "secondary" : "ghost"} aria-pressed={lang === "ko"} onClick={() => setLang("ko")}>한국어</Button>
          <span aria-hidden="true">/</span>
          <Button size="sm" lang="en" variant={lang === "en" ? "secondary" : "ghost"} aria-pressed={lang === "en"} onClick={() => setLang("en")}>English</Button>
        </div>
      </header>
      <main className="flex flex-1 flex-col"><Page /></main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<LangProvider><App /></LangProvider>);
