/** Sequential speech, with a real pause between paragraphs. No microphone, storage or request capabilities. */
export function speakInSequence(options: {
  readonly text: string;
  readonly speak: (text: string, done: () => void, failed: () => void) => () => void;
  readonly progress?: (part: string) => void;
  readonly done: () => void;
  readonly failed: () => void;
}) {
  const parts = options.text.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
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
      options.progress?.(part);
      cancel = options.speak(part, () => {
        if (stopped || ended) return;
        ended = true;
        cancel = null;
        if (index === parts.length) next();
        else pause = setTimeout(next, 500);
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
