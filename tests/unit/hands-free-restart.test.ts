import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIO_START_FALLBACK_MS, RECONNECT_DELAY_MS, createHandsFreeSession } from "@/lib/voice/hands-free";
import type { RecognitionPort } from "@/lib/voice/dictation";

interface FakePort extends RecognitionPort {
  starts: number;
  aborts: number;
}

const sessions: ReturnType<typeof createHandsFreeSession>[] = [];
afterEach(() => {
  for (const session of sessions) session.disable();
  sessions.length = 0;
  vi.useRealTimers();
});

/** `audioStart`: whether the fake browser supports `onaudiostart` (the property exists on the object, like a real one). */
function fixture(audioStart: boolean) {
  vi.useFakeTimers();
  const ports: FakePort[] = [];
  const messages: string[] = [];
  const phases: string[] = [];
  const spoken: string[] = [];
  let done: () => void = () => {};
  const session = createHandsFreeSession({
    language: "en-US",
    greeting: "How can I help?",
    create: () => {
      const port: FakePort = {
        lang: "", continuous: false, interimResults: false, starts: 0, aborts: 0,
        onresult: null, onerror: null, onend: null, onstart: null,
        start() { this.starts++; },
        stop() {},
        abort() { this.aborts++; },
      };
      if (audioStart) port.onaudiostart = null;
      ports.push(port);
      return port;
    },
    speak: (text, end) => { spoken.push(text); done = end; return () => {}; },
    onMessage: (text) => messages.push(text),
    onState: (state) => phases.push(state),
  });
  sessions.push(session);
  const say = (text: string, port = ports.at(-1)!) => port.onresult!({ results: [{ isFinal: true, 0: { transcript: text } }] });
  return { session, ports, messages, phases, spoken, say, finishSpeech: () => done() };
}

describe("hands-free microphone restart", () => {
  it("restarts once per spoken reply and keeps the microphone paused while speaking", () => {
    const f = fixture(false);
    f.session.enable();
    f.ports[0].onstart!();
    f.say("I need a laptop");
    expect(f.ports[0].aborts).toBe(1);
    expect(f.session.phase()).toBe("waiting");
    f.session.respond("Check your choices");
    expect(f.session.phase()).toBe("speaking");
    expect(f.ports).toHaveLength(1);
    f.finishSpeech();
    expect(f.ports).toHaveLength(2);
    expect(f.ports[1].starts).toBe(1);
    expect(f.ports[0].aborts).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(f.ports).toHaveLength(2);
  });

  it("ignores stale callbacks from an aborted recognition", () => {
    const f = fixture(false);
    f.session.enable();
    const old = f.ports[0];
    old.onstart!();
    f.say("I need a laptop");
    old.onend!();
    old.onerror!({ error: "aborted" });
    old.onresult!({ results: [{ isFinal: true, 0: { transcript: "buy it" } }] });
    vi.advanceTimersByTime(5000);
    expect(f.ports).toHaveLength(1);
    expect(f.messages).toEqual(["I need a laptop"]);
    expect(f.session.phase()).toBe("waiting");
  });

  it("aborts the live microphone when a reply interrupts listening", () => {
    const f = fixture(false);
    f.session.enable();
    f.ports[0].onstart!();
    expect(f.session.phase()).toBe("listening");
    f.session.respond("Page changed");
    expect(f.ports[0].aborts).toBe(1);
    expect(f.session.phase()).toBe("speaking");
    expect(f.ports).toHaveLength(1);
  });

  it("reconnects once after the short delay, then reports silence as no_speech", () => {
    const f = fixture(false);
    f.session.enable();
    f.ports[0].onstart!();
    f.ports[0].onend!();
    expect(f.session.phase()).toBe("reconnecting");
    vi.advanceTimersByTime(RECONNECT_DELAY_MS - 1);
    expect(f.ports).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(f.ports).toHaveLength(2);
    expect(RECONNECT_DELAY_MS).toBe(200);
    f.ports[1].onend!();
    expect(f.session.phase()).toBe("no_speech");
    expect(f.session.isActive()).toBe(false);
    vi.advanceTimersByTime(60000);
    expect(f.ports).toHaveLength(2);
  });

  it("still reports genuine recognition errors", () => {
    const network = fixture(false);
    network.session.enable();
    network.ports[0].onerror!({ error: "network" });
    expect(network.session.phase()).toBe("error");
    network.session.disable();
    const denied = fixture(false);
    denied.session.enable();
    denied.ports[0].onerror!({ error: "not-allowed" });
    expect(denied.session.phase()).toBe("denied");
  });

  it("treats no-speech events and silent ends alike as no_speech", () => {
    const f = fixture(false);
    f.session.enable();
    f.ports[0].onerror!({ error: "no-speech" });
    f.ports[0].onend!();
    vi.advanceTimersByTime(RECONNECT_DELAY_MS);
    f.ports[1].onerror!({ error: "no-speech" });
    f.ports[1].onend!();
    expect(f.session.phase()).toBe("no_speech");
  });

  it("waits for onaudiostart where the browser supports it", () => {
    const f = fixture(true);
    f.session.enable();
    expect(f.session.phase()).toBe("starting");
    f.ports[0].onstart!();
    expect(f.session.phase()).toBe("starting");
    f.ports[0].onaudiostart!();
    expect(f.session.phase()).toBe("listening");
  });

  it("does not stay at starting when onaudiostart is supported but never fires", () => {
    const f = fixture(true);
    f.session.enable();
    f.ports[0].onstart!();
    expect(AUDIO_START_FALLBACK_MS).toBe(1500);
    vi.advanceTimersByTime(AUDIO_START_FALLBACK_MS - 1);
    expect(f.session.phase()).toBe("starting");
    vi.advanceTimersByTime(1);
    expect(f.session.phase()).toBe("listening");
  });

  it("becomes ready on onstart alone where onaudiostart does not exist", () => {
    const f = fixture(false);
    f.session.enable();
    expect(f.session.phase()).toBe("starting");
    f.ports[0].onstart!();
    expect(f.session.phase()).toBe("listening");
  });

  it("ignores a late readiness signal from an aborted recognition", () => {
    const f = fixture(true);
    f.session.enable();
    const old = f.ports[0];
    old.onstart!();
    f.say("I need a laptop");
    old.onaudiostart!();
    vi.advanceTimersByTime(AUDIO_START_FALLBACK_MS * 2);
    expect(f.session.phase()).toBe("waiting");
  });

  it("is ready again, with its own readiness signal, after each reply", () => {
    const f = fixture(true);
    f.session.enable();
    f.ports[0].onstart!();
    f.ports[0].onaudiostart!();
    f.say("I need a laptop");
    f.session.respond("Check your choices");
    f.finishSpeech();
    expect(f.session.phase()).toBe("starting");
    f.ports[1].onstart!();
    expect(f.session.phase()).toBe("starting");
    f.ports[1].onaudiostart!();
    expect(f.session.phase()).toBe("listening");
  });

  it("gives every listening window after a recognised result its own silence reconnect", () => {
    const f = fixture(false);
    f.session.enable();
    f.ports[0].onstart!();
    f.ports[0].onend!();
    vi.advanceTimersByTime(RECONNECT_DELAY_MS);
    expect(f.ports).toHaveLength(2);
    // A recognised result resets the silence budget used by the first window.
    f.ports[1].onstart!();
    f.say("I need a laptop");
    f.session.respond("Check your choices");
    f.finishSpeech();
    expect(f.ports).toHaveLength(3);
    f.ports[2].onstart!();
    f.ports[2].onend!();
    expect(f.session.phase()).toBe("reconnecting");
    vi.advanceTimersByTime(RECONNECT_DELAY_MS);
    expect(f.ports).toHaveLength(4);
    f.ports[3].onend!();
    expect(f.session.phase()).toBe("no_speech");
    expect(f.session.isActive()).toBe(false);
  });

  it("leaves no timer running after hands-free is disabled with the readiness fallback pending", () => {
    const f = fixture(true);
    f.session.enable();
    f.ports[0].onstart!();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    f.session.disable();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.session.phase()).toBe("off");
  });

  it("leaves no timer running after a message is sent while the readiness fallback is pending", () => {
    const f = fixture(true);
    f.session.enable();
    f.ports[0].onstart!();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    f.say("I need a laptop");
    expect(f.session.phase()).toBe("waiting");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a late onaudiostart during the reconnect gap", () => {
    const f = fixture(true);
    f.session.enable();
    f.ports[0].onstart!();
    f.ports[0].onend!();
    expect(f.session.phase()).toBe("reconnecting");
    f.ports[0].onaudiostart!();
    expect(f.session.phase()).toBe("reconnecting");
    vi.advanceTimersByTime(RECONNECT_DELAY_MS);
    expect(f.ports).toHaveLength(2);
    expect(f.session.phase()).toBe("starting");
  });
});
