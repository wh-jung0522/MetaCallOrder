import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { AdminPage } from "./pages/AdminPage";
import { GuardianPage } from "./pages/GuardianPage";
import { HomePage } from "./pages/HomePage";
import { MerchantPage } from "./pages/MerchantPage";
import { SimulatorPage } from "./pages/SimulatorPage";
import "./index.css";

const LINKS = [
  { path: "/sim", label: "전화 걸기" },
  { path: "/merchant", label: "가맹점" },
  { path: "/guardian", label: "보호자" },
  { path: "/admin", label: "관리자" },
];

const PAGES: Record<string, () => React.JSX.Element> = {
  "/sim": SimulatorPage,
  "/merchant": MerchantPage,
  "/guardian": GuardianPage,
  "/admin": AdminPage,
};

const Page = PAGES[location.pathname] ?? HomePage;

createRoot(document.getElementById("root")!).render(
  <div className="flex min-h-svh flex-col">
    <header className="flex h-14 items-center gap-6 border-b px-4 md:px-6">
      <a href="/" className="text-lg font-extrabold tracking-tight text-primary">콜오더</a>
      <nav aria-label="주요 화면" className="flex gap-1 overflow-x-auto">
        {LINKS.map(({ path, label }) => (
          <Button key={path} asChild size="sm" variant={location.pathname === path ? "secondary" : "ghost"}>
            <a href={path} aria-current={location.pathname === path ? "page" : undefined}>{label}</a>
          </Button>
        ))}
      </nav>
    </header>
    <main className="flex flex-1 flex-col"><Page /></main>
  </div>,
);
