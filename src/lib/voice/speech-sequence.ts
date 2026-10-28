/** Bounded speech segments. Paragraphs retain a longer pause; completion waits for the final end event. */
function speechParts(text: string): { text: string; pauseAfter: number }[] {
  const parts: { text: string; pauseAfter: number }[] = [];
  for (const paragraph of text.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean)) {
    // A decimal point is followed by a digit, not whitespace, so prices stay together.
    for (const sentence of paragraph.split(/(?<=[.!?。！？])\s+/)) {
      let remaining = sentence.trim();
      while (remaining.length > 240) {
        const space = remaining.lastIndexOf(" ", 240);
        const cut = space > 0 ? space : 240;
        parts.push({ text: remaining.slice(0, cut), pauseAfter: 180 });
        remaining = remaining.slice(cut).trimStart();
      }
      if (remaining) parts.push({ text: remaining, pauseAfter: 180 });
    }
    if (parts.length) parts[parts.length - 1].pauseAfter = 500;
  }
  return parts;
}
export function speakInSequence(options: {
  readonly text: string;
  readonly speak: (text: string, done: () => void, failed: () => void) => () => void;
  readonly progress?: (part: string) => void;
  readonly done: () => void;
  readonly failed: () => void;
}) {
  const parts = speechParts(options.text);
  let stopped = false;
  let index = 0;
  let cancel: (() => void) | null = null;
  let pause: ReturnType<typeof setTimeout> | null = null;
  function next() {
    if (stopped) return;
    if (index === parts.length) { stopped = true; options.done(); return; }
    let ended = false;
    try {
      const part = parts[index++];
      options.progress?.(part.text);
      cancel = options.speak(part.text, () => {
        if (stopped || ended) return;
        ended = true;
        cancel = null;
        if (index === parts.length) next();
        else pause = setTimeout(next, part.pauseAfter);
      }, () => {
        if (stopped || ended) return;
        ended = true; stopped = true; options.failed();
      });
    } catch { if (!stopped) { stopped = true; options.failed(); } }
  }
  next();
  return () => {
    stopped = true;
    if (pause !== null) clearTimeout(pause);
    cancel?.();
    cancel = null;
  };
}
