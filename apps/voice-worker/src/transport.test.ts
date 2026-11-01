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

  it("sends 24 kHz speech as 8 kHz mulaw frames with no sample lost between chunks", () => {
    const socket = fakeSocket();
    const transport = new PhoneTransport(socket as unknown as WebSocket, "+821000000001");
    transport.playAudio(new Int16Array(500).fill(1000), 24000);
    transport.playAudio(new Int16Array(460).fill(1000), 24000);
    const bytes = socket.sent.map((message) => atob(message.media!.payload).length);
    expect(bytes.reduce((a, b) => a + b, 0)).toBe(320);
    expect(Math.max(...bytes)).toBe(160);
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
});
