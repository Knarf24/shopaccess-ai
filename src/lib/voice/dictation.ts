export type VoiceState = "idle" | "listening" | "finishing" | "review" | "denied" | "unavailable" | "unsupported" | "too_long" | "no_speech";
export interface RecognitionResult { readonly resultIndex?: number; readonly results: ArrayLike<{ readonly isFinal: boolean; readonly 0: { readonly transcript: string } }> }
export interface RecognitionPort {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart?: (() => void) | null;
  onresult: ((event: RecognitionResult) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

/** One explicit utterance. No network, form submission, storage or purchase capabilities. */
export function createDictationSession(options: {
  readonly create: () => RecognitionPort | null;
  readonly language: string;
  readonly onText: (text: string) => void;
  readonly onState: (state: VoiceState) => void;
}) {
  let current: RecognitionPort | null = null;
  let generation = 0;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  function release() {
    if (finishTimer !== null) clearTimeout(finishTimer);
    finishTimer = null;
    generation++;
    const previous = current;
    current = null;
    try { previous?.abort(); } catch { /* Already ended. */ }
  }
  return {
    stop() { release(); options.onState("idle"); },
    finish() {
      if (!current) return;
      const turn = generation;
      options.onState("finishing");
      try {
        current.stop();
        if (turn === generation) finishTimer = setTimeout(() => {
          if (turn !== generation) return;
          release(); options.onState("unavailable");
        }, 10000);
      } catch { release(); options.onState("unavailable"); }
    },
    start(existing: string) {
      release();
      const turn = generation;
      try {
        const recognition = options.create();
        if (!recognition) { options.onState("unsupported"); return; }
        current = recognition;
        recognition.lang = options.language;
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.onresult = event => {
          if (turn !== generation) return;
          const parts = Array.from(event.results).filter(result => result.isFinal).map(result => result[0].transcript.trim()).filter(Boolean);
          if (!parts.length) return;
          const text = [existing.trim(), parts.join(" ")].filter(Boolean).join(" ");
          release();
          if (text.length > 2000) { options.onState("too_long"); return; }
          options.onText(text);
          options.onState("review");
        };
        recognition.onerror = event => {
          if (turn !== generation) return;
          release();
          options.onState(event.error === "not-allowed" || event.error === "service-not-allowed" ? "denied" : event.error === "no-speech" ? "no_speech" : "unavailable");
        };
        recognition.onend = () => {
          if (turn !== generation) return;
          release();
          options.onState("no_speech");
        };
        options.onState("listening");
        recognition.start();
      } catch { release(); options.onState("unavailable"); }
    },
  };
}
