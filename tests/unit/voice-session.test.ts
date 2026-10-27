import { describe, expect, it } from "vitest";
import { createDictationSession, type RecognitionPort, type RecognitionResult } from "@/lib/voice/dictation";

function fixture() {
  const messages: string[] = [];
  const states: string[] = [];
  let starts = 0;
  let aborts = 0;
  const recognition: RecognitionPort = { lang: "", continuous: true, interimResults: true,
    onresult: null, onerror: null, onend: null,
    start() { starts++; }, stop() {}, abort() { aborts++; } };
  const session = createDictationSession({ create: () => recognition, language: "es-ES", onText: text => messages.push(text), onState: state => states.push(state) });
  const result = (text: string): RecognitionResult => ({ results: [{ isFinal: true, 0: { transcript: text } }] });
  return { session, recognition, messages, states, result, starts: () => starts, aborts: () => aborts };
}

describe("explicit dictation session", () => {
  it("finishes listening without discarding the browser's pending final words", () => {
    const f = fixture(); f.session.start("I need");
    f.session.finish();
    expect(f.states.at(-1)).toBe("finishing");
    f.recognition.onresult?.(f.result("a laptop"));
    expect(f.messages).toEqual(["I need a laptop"]);
    expect(f.states.at(-1)).toBe("review");
  });
  it("does not listen until started and appends one final transcription without submitting", () => {
    const f = fixture();
    expect(f.starts()).toBe(0);
    f.session.start("I need");
    expect(f.recognition.lang).toBe("es-ES");
    expect(f.recognition.continuous).toBe(false);
    expect(f.recognition.interimResults).toBe(false);
    f.recognition.onresult?.(f.result("a laptop"));
    expect(f.messages).toEqual(["I need a laptop"]);
    expect(f.states).toContain("listening");
  });

  it("stop ignores late results and releases recognition", () => {
    const f = fixture(); f.session.start("");
    const late = f.recognition.onresult!;
    f.session.stop(); late(f.result("buy now"));
    expect(f.messages).toEqual([]);
    expect(f.aborts()).toBe(1);
    expect(f.states.at(-1)).toBe("idle");
  });

  it("keeps the draft on permission denial and allows a deliberate retry", () => {
    const f = fixture(); f.session.start("existing");
    f.recognition.onerror?.({ error: "not-allowed" });
    expect(f.messages).toEqual([]);
    expect(f.states.at(-1)).toBe("denied");
    f.session.start("existing");
    expect(f.starts()).toBe(2);
  });

  it("refuses an oversized transcription without truncating the draft", () => {
    const f = fixture(); f.session.start("existing");
    f.recognition.onresult?.(f.result("a".repeat(2000)));
    expect(f.messages).toEqual([]);
    expect(f.states.at(-1)).toBe("too_long");
  });

  it("reports unavailable recognition without losing typed input", () => {
    const states: string[] = [];
    const session = createDictationSession({ create: () => null, language: "en-US", onText: () => { throw Error("unexpected text"); }, onState: state => states.push(state) });
    session.start("typed");
    expect(states).toEqual(["unsupported"]);
  });
});
