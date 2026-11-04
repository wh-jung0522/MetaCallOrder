import { mulawEncode } from "@callorder/audio";
import { describe, expect, it, vi } from "vitest";
import { PhoneTransport } from "./transport";

vi.stubGlobal("WebSocket", { OPEN: 1 });

function fakeSocket() {
  const listeners: Record<string, ((event: { data?: unknown }) => void)[]> = {};
  const sent: { event: string; media?: { payload: string } }[] = [];
  return {
    readyState: 1,
    sent,
    addEventListener: (type: string, cb: (event: { data?: unknown }) => void) => void (listeners[type] ??= []).push(cb),
    send: (data: string) => void sent.push(JSON.parse(data)),
    close: vi.fn(),
    emit: (type: string, data?: unknown) => listeners[type]?.forEach((cb) => cb({ data })),
  };
}

describe("PhoneTransport", () => {
  it("turns phone audio into 16 kHz PCM", () => {
    const socket = fakeSocket();
    const transport = new PhoneTransport(socket as unknown as WebSocket, "+821000000001");
    const got: Int16Array[] = [];
    transport.onAudio((pcm) => void got.push(pcm));
    const mulaw = mulawEncode(new Int16Array(160).fill(8000));
    socket.emit("message", JSON.stringify({ event: "media", media: { payload: btoa(String.fromCharCode(...mulaw)) } }));
    expect(got[0]).toHaveLength(320);
    expect(Math.abs(got[0]![100]! - 8000)).toBeLessThan(400);
  });

  it("sends speech only as whole 20 ms frames, at speaking pace, padding the tail", () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const transport = new PhoneTransport(socket as unknown as WebSocket, "+821000000001");
    transport.playAudio(new Int16Array(12000).fill(1000)); // 500 ms
    transport.playAudio(new Int16Array(100).fill(1000));
    vi.advanceTimersByTime(40);
    expect(socket.sent.length).toBeLessThanOrEqual(13); // only 200 ms ahead of real time
    vi.advanceTimersByTime(2000);
    const bytes = socket.sent.map((message) => atob(message.media!.payload).length);
    expect(new Set(bytes)).toEqual(new Set([160]));
    expect(bytes.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(4033);
    vi.useRealTimers();
  });

  it("drops queued speech when the caller interrupts", () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const transport = new PhoneTransport(socket as unknown as WebSocket, "+821000000001");
    transport.playAudio(new Int16Array(24000).fill(1000));
    vi.advanceTimersByTime(40);
    transport.clearPlayback();
    const count = socket.sent.length;
    vi.advanceTimersByTime(1000);
    expect(socket.sent.at(-1)!.event).toBe("clear");
    expect(socket.sent.length).toBe(count);
    vi.useRealTimers();
  });

  it("reports the caller hanging up and passes key presses", () => {
    const socket = fakeSocket();
    const transport = new PhoneTransport(socket as unknown as WebSocket, "+821000000001");
    const hangup = vi.fn();
    const digits: string[] = [];
    transport.onHangup(hangup);
    transport.onDtmf((digit) => void digits.push(digit));
    socket.emit("message", JSON.stringify({ event: "dtmf", dtmf: { digit: "1" } }));
    socket.emit("message", JSON.stringify({ event: "stop" }));
    expect(digits).toEqual(["1"]);
    expect(hangup).toHaveBeenCalled();
  });

  it("hands screen events to the watcher, not the phone line, and tells it when the call ends", () => {
    const socket = fakeSocket();
    const watched: Record<string, unknown>[] = [];
    const transport = new PhoneTransport(socket as unknown as WebSocket, "+821000000001", undefined, (event) => void watched.push(event));
    transport.sendEvent({ type: "assistant_text", text: "무엇을 주문해 드릴까요?" });
    socket.emit("close");
    expect(watched).toEqual([{ type: "assistant_text", text: "무엇을 주문해 드릴까요?" }, { type: "hangup" }]);
    expect(socket.sent).toEqual([]);
  });
});
