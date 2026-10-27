import type { RecognitionPort } from "./dictation";

export type HandsFreePhase = "off" | "reconnecting" | "no_speech" | "starting" | "wake" | "listening" | "waiting" | "speaking" | "previewing" | "denied" | "error" | "too_long" | "unsupported";
const WAKE = /^(?:hey|hola|oye)\s+(?:assistant[,\s]+)?shop\s*access(?:\s+a\s*i)?(?:[\s,.:!?]+|$)/i;
/** A needs confirmation is never a purchase or permission command. */
export function isNeedsConfirmation(text: string, language: string): boolean {
  return (language.startsWith("es")
    ? /^(?:por favor[ ,]+)?(?:confirmo mis opciones|confirmar mis opciones|confirmar mis necesidades)[.!?]*$/i
    : /^(?:please[ ,]+)?(?:confirm my choices|confirm these choices|confirm my needs)[.!?]*$/i).test(text.trim());
}
const STOP = /^(?:stop(?: listening| shop\s*access)?|deja de escuchar|dejar de escuchar|detener escucha)[.!?]*$/i;

/** Browser transcription wake gate. No form, storage, payment or network capabilities. */
export function createHandsFreeSession(options: {
  readonly create: () => RecognitionPort | null;
  readonly language: string;
  readonly greeting: string | (() => string);
  readonly speak: (text: string, done: () => void, failed: () => void, progress: (part: string) => void) => () => void;
  readonly onMessage: (text: string) => void;
  readonly onState: (state: HandsFreePhase) => void;
}) {
  let active = false;
  let awake = false;
  let phase: HandsFreePhase = "off";
  let generation = 0;
  let recognition: RecognitionPort | null = null;
  let cancelSpeech: (() => void) | null = null;
  let restart: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let emptyRestarts = 0;
  let idleDeadline = 0;
  const state = (next: HandsFreePhase) => { phase = next; options.onState(next); };
  function stopMicrophone() {
    generation++;
    if (restart) clearTimeout(restart);
    if (watchdog) clearTimeout(watchdog);
    restart = null;
    watchdog = null;
    const previous = recognition; recognition = null;
    try { previous?.abort(); } catch { /* Already ended. */ }
  }
  function disable(next: HandsFreePhase = "off") {
    active = false; awake = false; stopMicrophone();
    const cancel = cancelSpeech; cancelSpeech = null; cancel?.();
    state(next);
  }
  function speak(text: string, preview = false) {
    stopMicrophone();
    const turn = generation;
    state(preview ? "previewing" : "speaking");
    const progress = (part: string) => {
      if (turn !== generation) return;
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => { if (turn === generation) disable("error"); }, Math.min(120000, Math.max(30000, part.length * 150)));
    };
    progress(text);
    try {
      cancelSpeech = options.speak(text, () => {
        if (turn !== generation) return;
        cancelSpeech = null;
        if (active) { idleDeadline = Date.now() + 60000; listen(); } else if (preview) { stopMicrophone(); state("off"); }
      }, () => { if ((active || preview) && turn === generation) disable("error"); }, progress);
    } catch { disable("error"); }
  }
  function listen() {
    if (!active) return;
    stopMicrophone();
    const turn = generation;
    try {
      const port = options.create();
      if (!port) { disable("unsupported"); return; }
      recognition = port; port.lang = options.language; port.continuous = true; port.interimResults = false;
      let noSpeech = false;
      let ended = false;
      const resetWatchdog = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => { if (turn === generation) disable("error"); }, Math.max(0, idleDeadline - Date.now()));
      };
      port.onstart = () => {
        if (active && turn === generation) state(awake ? "listening" : "wake");
      };
      port.onresult = event => {
        if (!active || turn !== generation || ended) return;
        const results = Array.from(event.results);
        const text = results.slice(event.resultIndex ?? Math.max(0, results.length - 1)).filter(result => result.isFinal).map(result => result[0].transcript.trim()).filter(Boolean).join(" ");
        if (!text) return;
        idleDeadline = Date.now() + 60000;
        resetWatchdog();
        emptyRestarts = 0;
        if (STOP.test(text)) { disable(); return; }
        let message = text;
        const match = text.match(WAKE);
        if (match) {
          awake = true;
          message = text.slice(match[0].length).trim();
          if (!message) { speak(typeof options.greeting === "function" ? options.greeting() : options.greeting); return; }
        }
        if (STOP.test(message)) { disable(); return; }
        if (message.length > 2000) { disable("too_long"); return; }
        stopMicrophone(); state("waiting");
        try { options.onMessage(message); } catch { disable("error"); }
      };
      port.onerror = event => {
        if (!active || turn !== generation) return;
        if (event.error === "no-speech") { noSpeech = true; return; }
        disable(event.error === "not-allowed" || event.error === "service-not-allowed" ? "denied" : "error");
      };
      port.onend = () => {
        if (!active || turn !== generation || ended) return;
        ended = true;
        if (++emptyRestarts > 1) { disable(noSpeech ? "no_speech" : "error"); return; }
        state("reconnecting");
        restart = setTimeout(() => { if (active && turn === generation) listen(); }, 500);
      };
      state("starting"); resetWatchdog(); port.start();
    } catch { disable("error"); }
  }
  return {
    phase: () => phase,
    isActive: () => active,
    enable() { disable(); active = true; awake = true; emptyRestarts = 0; idleDeadline = Date.now() + 60000; listen(); },
    disable: () => disable(),
    fail: () => disable("error"),
    waitForReply() { if (!active) return false; stopMicrophone(); const cancel = cancelSpeech; cancelSpeech = null; cancel?.(); state("waiting"); return true; },
    preview(text: string) {
      if (phase === "waiting" || !text.trim()) return false;
      const cancel = cancelSpeech; cancelSpeech = null; cancel?.();
      speak(text, true); return true;
    },
    respond(text: string) { if (active && text.trim()) speak(text); },
  };
}
