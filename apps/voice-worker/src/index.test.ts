import { describe, expect, it, vi } from "vitest";

vi.mock("./call-session", () => ({ CallSession: class {} }));
vi.mock("./env", () => ({ createDb: () => ({}) }));

const { isAllowedOrigin } = await import("./index");
const allowed = "https://callorder-web.pages.dev,https://*.callorder-web.pages.dev";

describe("isAllowedOrigin", () => {
  it("accepts production and preview hosts", () => {
    expect(isAllowedOrigin("https://callorder-web.pages.dev", allowed)).toBe(true);
    expect(isAllowedOrigin("https://abc123.callorder-web.pages.dev", allowed)).toBe(true);
  });
  it("rejects look-alikes and missing origins", () => {
    expect(isAllowedOrigin("https://evil.com", allowed)).toBe(false);
    expect(isAllowedOrigin("https://callorder-web.pages.dev.evil.com", allowed)).toBe(false);
    expect(isAllowedOrigin("https://a.b.callorder-web.pages.dev", allowed)).toBe(false);
    expect(isAllowedOrigin(null, allowed)).toBe(false);
  });
});
