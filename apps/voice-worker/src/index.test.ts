import { describe, expect, it, vi } from "vitest";

vi.mock("./call-session", () => ({ CallSession: class {} }));
vi.mock("./env", () => ({ createDb: () => ({}) }));

const { default: worker, isAllowedOrigin, signStream, toE164 } = await import("./index");
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

describe("phone routes", () => {
  const env = { PHONE_WEBHOOK_TOKEN: "secret", CALL_SESSION: { getByName: () => ({ fetch: async () => new Response("ok") }) } } as never;

  it("normalizes Korean caller ids", () => {
    expect(toE164("010-2718-0000")).toBe("+821027180000");
    expect(toE164("+14155550101")).toBe("+14155550101");
  });

  it("rejects a webhook without the shared token", async () => {
    const response = await worker.fetch(new Request("https://w.test/phone/voice", { method: "POST" }), env);
    expect(response.status).toBe(403);
  });

  it("rejects a stream whose caller id was not signed", async () => {
    const sig = await signStream("call-1", "+821000000001", "secret");
    const upgrade = { headers: { upgrade: "websocket" } };
    const forged = await worker.fetch(new Request(`https://w.test/phone/stream?callId=call-1&caller=%2B821000000002&sig=${sig}`, upgrade), env);
    expect(forged.status).toBe(403);
    const signed = await worker.fetch(new Request(`https://w.test/phone/stream?callId=call-1&caller=%2B821000000001&sig=${sig}`, upgrade), env);
    expect(signed.status).toBe(200);
  });
});
