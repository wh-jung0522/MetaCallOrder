import { describe, expect, it } from "vitest";
import { matchScore, rankMenu, type MenuItem, SupabaseMerchantAdapter } from "./index";

const item = (name: string, aliases: string[] = []): MenuItem => ({
  id: name, store_id: "s", name, aliases, price: 1000, options: [], is_available: true,
});

describe("menu matching", () => {
  it("matches names, spoken aliases and spacing variants", () => {
    const menu = [item("짜장면", ["자장면"]), item("순대국밥", ["국밥"]), item("수육")];
    expect(rankMenu(menu, "자장면")[0]?.name).toBe("짜장면");
    expect(rankMenu(menu, "순대 국밥")[0]?.name).toBe("순대국밥");
    expect(rankMenu(menu, "국밥")[0]?.name).toBe("순대국밥");
  });

  it("drops unrelated items", () => {
    expect(rankMenu([item("수육")], "피자")).toEqual([]);
    expect(matchScore("", "수육")).toBe(0);
  });
});

describe("searchStores", () => {
  const rows: Record<string, unknown[]> = {
    stores: [
      { id: "s1", name: "바삭한 오후", name_en: "Crispy Afternoon", category: "치킨", lat: 37, lng: 127 },
      { id: "s2", name: "행복국밥", name_en: "Happy Soup House", category: "한식", lat: 37, lng: 127 },
    ],
    menu_items: [
      { store_id: "s1", name: "양념 치킨", name_en: "sweet chili chicken", aliases: [] },
      { store_id: "s2", name: "순대국밥", name_en: "sundae soup", aliases: ["국밥"] },
    ],
  };
  const query = (table: string) => {
    const result = { data: rows[table], error: null };
    return { select: () => ({ eq: async () => result }) };
  };
  const adapter = new SupabaseMerchantAdapter({ from: query } as never);
  const ids = async (text?: string) => (await adapter.searchStores({ lat: 37, lng: 127, query: text })).map((store) => store.id);

  it("finds a store by what it is or what it sells, not only by name", async () => {
    expect(await ids("치킨")).toEqual(["s1"]);
    expect(await ids("chicken")).toEqual(["s1"]);
    expect(await ids("국밥")).toEqual(["s2"]);
    expect(await ids("Crispy")).toEqual(["s1"]);
  });

  it("offers every nearby store when nothing matches", async () => {
    expect(await ids("초밥")).toEqual(["s1", "s2"]);
    expect(await ids()).toEqual(["s1", "s2"]);
  });
});
