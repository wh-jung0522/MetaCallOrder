import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { ChevronLeft, Search } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useT, type T } from "../i18n";
import { won } from "../orders";
import { supabase } from "../supabase";

interface Store {
  id: string;
  name: string;
  name_en: string | null;
  phone_e164: string;
  address: string;
  address_en: string | null;
  lat: number;
  lng: number;
  is_open: boolean;
  delivery_fee: number;
  min_order_amount: number;
  eta_minutes: number;
  category: string | null;
  category_en: string | null;
  description: string | null;
  description_en: string | null;
  hours: string | null;
  hours_en: string | null;
}

interface MenuItem {
  id: string;
  store_id: string;
  name: string;
  name_en: string | null;
  aliases: string[];
  price: number;
  options: { name: string; choices: string[]; choices_en?: string[]; required: boolean }[];
  category: string | null;
  category_en: string | null;
  description: string | null;
  description_en: string | null;
}

// Column list, not *: adapter_config and owner_user_id are not granted to browsers, so * is refused.
const STORE_COLUMNS = "id, name, name_en, phone_e164, address, address_en, lat, lng, is_open, delivery_fee, min_order_amount, eta_minutes, category, category_en, description, description_en, hours, hours_en";
const MENU_COLUMNS = "id, store_id, name, name_en, aliases, price, options, category, category_en, description, description_en";

// ponytail: option names stay Korean in the JSON because the voice agent keys carts on them. Add a word here when a new option name appears.
const OPTION_EN: Record<string, string> = { 맵기: "Spiciness", 크기: "Size", 부위: "Cut", 도우: "Crust", 와사비: "Wasabi", 온도: "Temperature", 간: "Seasoning" };

const CENTER: L.LatLngTuple = [37.5665, 126.978];
const FOCUS_ZOOM = 16;

const squash = (text: string) => text.toLowerCase().replace(/\s/g, "");
const seoulPhone = (e164: string) => e164.replace(/^\+82(\d)(\d{3})(\d{4})$/, "0$1-$2-$3");

function StoreMap({ stores, selectedId, onSelect, localName, t }: { stores: Store[]; selectedId: string | null; onSelect: (id: string) => void; localName: (store: Store) => string; t: T }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map>(null);
  const pins = useRef(new Map<string, L.Marker>());

  useEffect(() => {
    const created = L.map(box.current!).setView(CENTER, 14);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(created);
    map.current = created;
    return () => void created.remove();
  }, []);

  useEffect(() => {
    const current = map.current!;
    pins.current.forEach((pin) => pin.remove());
    pins.current.clear();
    for (const store of stores) {
      // Built with textContent so a store name can never become markup.
      const label = document.createElement("span");
      label.className = "store-pin-label";
      label.textContent = localName(store);
      const pin = L.marker([store.lat, store.lng], {
        icon: L.divIcon({ className: `store-pin${store.is_open ? "" : " is-closed"}`, html: label, iconSize: [32, 32], iconAnchor: [16, 16] }),
        title: localName(store),
        riseOnHover: true,
      }).on("click", () => onSelect(store.id)).on("keypress", (event) => {
        // Leaflet makes pins focusable but only reports the key. The mouse click path does not fire for it.
        const { key } = (event as L.LeafletKeyboardEvent).originalEvent;
        if (key !== "Enter" && key !== " ") return;
        (event as L.LeafletKeyboardEvent).originalEvent.preventDefault();
        onSelect(store.id);
      }).addTo(current);
      pin.getElement()?.setAttribute("aria-label", `${localName(store)}, ${store.is_open ? t("영업 중", "Open") : t("쉬는 중", "Closed")}`);
      pins.current.set(store.id, pin);
    }
    // t is rebuilt on every render; localName already changes with the language.
  }, [stores, localName, onSelect]);

  // Refit only when the set of stores changes, so switching language does not move the map.
  const storeKey = stores.map((store) => store.id).join();
  useEffect(() => {
    if (stores.length && !selectedId) map.current!.fitBounds(stores.map((store) => [store.lat, store.lng] as L.LatLngTuple), { padding: [36, 36], maxZoom: FOCUS_ZOOM });
  }, [storeKey]);

  useEffect(() => {
    pins.current.forEach((pin, id) => {
      const selected = id === selectedId;
      pin.setZIndexOffset(selected ? 1000 : 0);
      pin.getElement()?.classList.toggle("is-selected", selected);
    });
    const pin = selectedId ? pins.current.get(selectedId) : undefined;
    if (pin) map.current!.flyTo(pin.getLatLng(), Math.max(map.current!.getZoom(), FOCUS_ZOOM), { duration: 0.5 });
  }, [selectedId, stores, localName]);

  return <div ref={box} className="h-full w-full bg-muted" role="region" aria-label={t("가게 지도", "Store map")} />;
}

function DeliveryFacts({ store, t }: { store: Store; t: T }) {
  return (
    <p className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
      <span>{t(`배달 약 ${store.eta_minutes}분`, `About ${store.eta_minutes} min`)}</span>
      <span>{t("배달비", "Delivery fee")} {won(store.delivery_fee, t)}</span>
      <span>{t("최소 주문", "Minimum")} {won(store.min_order_amount, t)}</span>
    </p>
  );
}

function StoreDetail({ store, menu, onBack, t, pick }: { store: Store; menu: MenuItem[]; onBack: () => void; t: T; pick: (ko: string | null, en: string | null) => string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [store.id]);

  const sections = new Map<string, MenuItem[]>();
  for (const item of menu) {
    const title = pick(item.category, item.category_en) || t("메뉴", "Menu");
    sections.set(title, [...(sections.get(title) ?? []), item]);
  }

  return (
    <article className="flex flex-col gap-5 p-4 md:p-5">
      <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={onBack}><ChevronLeft />{t("가게 목록", "All stores")}</Button>
      <header className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <h2 ref={heading} tabIndex={-1} className="scroll-mt-[40svh] text-2xl font-extrabold tracking-tight outline-none md:scroll-mt-4">{pick(store.name, store.name_en)}</h2>
          <Badge variant={store.is_open ? "secondary" : "outline"} className="mt-1.5 shrink-0">{store.is_open ? t("영업 중", "Open") : t("쉬는 중", "Closed")}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{pick(store.category, store.category_en)}</p>
        {store.description && <p>{pick(store.description, store.description_en)}</p>}
      </header>

      {!store.is_open && <Alert><AlertDescription>{t("지금은 주문을 받지 않습니다. 메뉴는 미리 보실 수 있습니다.", "This store is not taking orders right now. You can still look at the menu.")}</AlertDescription></Alert>}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">{t("배달 시간", "Delivery time")}</dt><dd>{t(`약 ${store.eta_minutes}분`, `About ${store.eta_minutes} min`)}</dd>
        <dt className="text-muted-foreground">{t("배달비", "Delivery fee")}</dt><dd>{won(store.delivery_fee, t)}</dd>
        <dt className="text-muted-foreground">{t("최소 주문", "Minimum order")}</dt><dd>{won(store.min_order_amount, t)}</dd>
        {store.hours && <><dt className="text-muted-foreground">{t("영업 시간", "Hours")}</dt><dd>{pick(store.hours, store.hours_en)}</dd></>}
        <dt className="text-muted-foreground">{t("주소", "Address")}</dt><dd>{pick(store.address, store.address_en)}</dd>
        <dt className="text-muted-foreground">{t("전화", "Phone")}</dt><dd className="tabular-nums">{seoulPhone(store.phone_e164)}</dd>
      </dl>

      <Separator />

      {menu.length === 0 && <p className="text-muted-foreground">{t("지금 주문할 수 있는 메뉴가 없습니다.", "There is nothing on the menu right now.")}</p>}
      {[...sections].map(([title, items]) => (
        <section key={title} className="flex flex-col gap-1">
          <h3 className="text-lg font-bold">{title}</h3>
          <ul className="flex flex-col divide-y">
            {items.map((item) => (
              <li key={item.id} className="flex flex-col gap-1 py-3">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-semibold">{pick(item.name, item.name_en)}</span>
                  <span className="whitespace-nowrap font-semibold tabular-nums">{won(item.price, t)}</span>
                </div>
                {item.description && <p className="text-sm text-muted-foreground">{pick(item.description, item.description_en)}</p>}
                {item.options.map((option) => (
                  <p key={option.name} className="text-sm">
                    <span className="font-medium">{pick(option.name, OPTION_EN[option.name] ?? null)}{option.required ? t(" (꼭 골라 주세요)", " (required)") : t(" (선택)", " (optional)")}: </span>
                    {t(option.choices.join(", "), (option.choices_en ?? option.choices).join(", "))}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}

export function StoresPage() {
  const { t, lang } = useT();
  const [stores, setStores] = useState<Store[] | null>(null);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // In the URL so the phone's back gesture closes a store instead of leaving the page.
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(location.search).get("store"));

  const load = useCallback(async () => {
    setFailed(false);
    setStores(null);
    // Sorted by id so menu sections keep the order they were written in.
    const [storeResult, menuResult] = await Promise.all([
      supabase.from("stores").select(STORE_COLUMNS).order("is_open", { ascending: false }).order("eta_minutes"),
      supabase.from("menu_items").select(MENU_COLUMNS).eq("is_available", true).order("id"),
    ]);
    if (storeResult.error || menuResult.error) return setFailed(true);
    setStores(storeResult.data as unknown as Store[]);
    setMenu(menuResult.data as unknown as MenuItem[]);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onPop = () => setSelectedId(new URLSearchParams(location.search).get("store"));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const select = useCallback((id: string) => {
    if (new URLSearchParams(location.search).get("store") === id) return;
    history.pushState(null, "", `/stores?store=${id}`);
    setSelectedId(id);
  }, []);
  const back = () => {
    const previous = selectedId;
    history.pushState(null, "", "/stores");
    setSelectedId(null);
    // The list was hidden, so its row can only take focus on the next frame.
    requestAnimationFrame(() => {
      const row = document.getElementById(`store-${previous}`);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: "nearest" });
    });
  };

  const pick = useCallback((ko: string | null, en: string | null) => (lang === "en" ? en || ko : ko) ?? "", [lang]);
  const localName = useCallback((store: Store) => pick(store.name, store.name_en), [pick]);

  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const store of stores ?? []) if (store.category) seen.set(store.category, store.category_en ?? store.category);
    return [...seen];
  }, [stores]);

  const needle = squash(query);
  const menuHit = useCallback((store: Store) => {
    if (!needle) return null;
    return menu.find((item) => item.store_id === store.id && [item.name, item.name_en ?? "", ...item.aliases].some((word) => squash(word).includes(needle))) ?? null;
  }, [menu, needle]);

  const visible = useMemo(() => (stores ?? []).filter((store) => {
    if (category && store.category !== category) return false;
    if (!needle) return true;
    return [store.name, store.name_en ?? "", store.category ?? "", store.category_en ?? ""].some((word) => squash(word).includes(needle)) || menuHit(store) !== null;
  }), [stores, category, needle, menuHit]);

  const selected = stores?.find((store) => store.id === selectedId) ?? null;
  // A store opened from a link or a pin stays on the map even when the filter would hide it.
  const onMap = useMemo(() => (selected && !visible.includes(selected) ? [...visible, selected] : visible), [visible, selected]);

  const clearFilters = () => { setQuery(""); setCategory(null); };

  return (
    <div className="flex flex-1 flex-col md:h-[calc(100svh-3.5rem)] md:flex-none md:flex-row">
      <div className="min-w-0 md:w-[26rem] md:shrink-0 md:overflow-y-auto md:border-r lg:w-[30rem]">
        {selected && <StoreDetail store={selected} menu={menu.filter((item) => item.store_id === selected.id)} onBack={back} t={t} pick={pick} />}

        <div hidden={Boolean(selected)}>
          <div className="flex flex-col gap-3 p-4 md:p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4">
              <h1 className="text-2xl font-extrabold tracking-tight">{t("우리 동네 가게", "Stores near you")}</h1>
              <a href="/merchant" className="rounded-sm text-sm text-primary underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">{t("사장님 주문 받기", "Store owner orders")}</a>
            </div>
            <div className="relative">
              <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-8" aria-label={t("가게나 메뉴 검색", "Search stores or menus")} placeholder={t("가게나 메뉴 이름으로 찾기", "Search by store or menu")} />
            </div>
            <div role="group" aria-label={t("가게 종류", "Store type")} className="flex flex-wrap gap-1.5 py-1">
              <Button size="sm" className="rounded-full" variant={category === null ? "default" : "outline"} aria-pressed={category === null} onClick={() => setCategory(null)}>{t("전체", "All")}</Button>
              {categories.map(([ko, en]) => (
                <Button key={ko} size="sm" className="rounded-full" variant={category === ko ? "default" : "outline"} aria-pressed={category === ko} onClick={() => setCategory(category === ko ? null : ko)}>{t(ko, en)}</Button>
              ))}
            </div>
          </div>

          {stores && <p role="status" className="sr-only">{t(`가게 ${visible.length}곳`, `${visible.length} stores`)}</p>}

          {failed && (
            <div className="flex flex-col items-start gap-3 px-4 pb-6 md:px-5">
              <Alert variant="destructive"><AlertDescription>{t("가게 정보를 불러오지 못했습니다.", "Could not load the stores.")}</AlertDescription></Alert>
              <Button variant="outline" onClick={() => void load()}>{t("다시 불러오기", "Try again")}</Button>
            </div>
          )}

          {!failed && !stores && (
            <div className="flex flex-col gap-5 px-4 pb-6 md:px-5" role="status" aria-label={t("가게를 불러오는 중", "Loading stores")}>
              {[0, 1, 2, 3].map((index) => <div key={index} className="flex flex-col gap-2"><Skeleton className="h-5 w-40" /><Skeleton className="h-4 w-full" /></div>)}
            </div>
          )}

          {stores && visible.length === 0 && (
            <div className="flex flex-col items-start gap-3 px-4 pb-6 md:px-5">
              <p className="text-muted-foreground">{query ? t(`"${query}"에 맞는 가게가 없습니다.`, `No stores match "${query}".`) : t("이 종류의 가게가 없습니다.", "There are no stores of this type.")}</p>
              <Button variant="outline" onClick={clearFilters}>{t("전체 가게 보기", "Show all stores")}</Button>
            </div>
          )}

          {stores && visible.length > 0 && (
            <ul className="flex flex-col divide-y border-t">
              {visible.map((store) => {
                const hit = menuHit(store);
                const sample = menu.filter((item) => item.store_id === store.id).slice(0, 3).map((item) => pick(item.name, item.name_en)).join(", ");
                return (
                  <li key={store.id}>
                    <button id={`store-${store.id}`} type="button" onClick={() => select(store.id)} className="flex w-full scroll-mt-[40svh] flex-col gap-1 px-4 py-3.5 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset md:scroll-mt-0 md:px-5">
                      <span className="flex items-center justify-between gap-3">
                        <span className={`font-bold ${store.is_open ? "" : "text-muted-foreground"}`}>{pick(store.name, store.name_en)}<span className="ml-2 text-sm font-normal text-muted-foreground">{pick(store.category, store.category_en)}</span></span>
                        <Badge variant={store.is_open ? "secondary" : "outline"} className="shrink-0">{store.is_open ? t("영업 중", "Open") : t("쉬는 중", "Closed")}</Badge>
                      </span>
                      <DeliveryFacts store={store} t={t} />
                      <span className="truncate text-sm text-muted-foreground">{hit ? t(`찾은 메뉴: ${hit.name}`, `Found on the menu: ${hit.name_en || hit.name}`) : sample}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="px-4 py-5 text-xs text-muted-foreground md:px-5">{t("시연용으로 만든 가상의 가게입니다. 주소와 전화번호는 실제와 관계없습니다.", "These stores are made up for this demo. Their addresses and phone numbers are not real.")}</p>
        </div>
      </div>

      <div className="sticky top-0 isolate z-10 h-[38svh] min-w-0 max-md:order-first md:h-auto md:flex-1">
        <StoreMap stores={onMap} selectedId={selectedId} onSelect={select} localName={localName} t={t} />
      </div>
    </div>
  );
}
