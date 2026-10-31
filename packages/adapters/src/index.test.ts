import { describe, expect, it } from "vitest";
import { matchScore, rankMenu, type MenuItem } from "./index";

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
