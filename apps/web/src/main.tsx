import { createRoot } from "react-dom/client";
import { AdminPage } from "./pages/AdminPage";
import { GuardianPage } from "./pages/GuardianPage";
import { MerchantPage } from "./pages/MerchantPage";
import { SimulatorPage } from "./pages/SimulatorPage";
import "./style.css";

const PAGES: Record<string, { label: string; page: () => React.JSX.Element }> = {
  "/sim": { label: "전화 시뮬레이터", page: SimulatorPage },
  "/merchant": { label: "가맹점", page: MerchantPage },
  "/guardian": { label: "보호자", page: GuardianPage },
  "/admin": { label: "관리자", page: AdminPage },
};

const Page = (PAGES[location.pathname] ?? PAGES["/sim"]!).page;

createRoot(document.getElementById("root")!).render(
  <>
    <nav>
      <strong>콜오더</strong>
      {Object.entries(PAGES).map(([path, { label }]) => (
        <a key={path} href={path} aria-current={location.pathname === path ? "page" : undefined}>{label}</a>
      ))}
    </nav>
    <main><Page /></main>
  </>,
);
