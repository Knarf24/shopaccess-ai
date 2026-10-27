"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createDictationSession, type RecognitionPort, type VoiceState } from "@/lib/voice/dictation";
import type { JourneyLanguage } from "@/lib/i18n/language";

type VoiceWindow = Window & {
  SpeechRecognition?: new () => RecognitionPort;
  webkitSpeechRecognition?: new () => RecognitionPort;
};

const COPY = {
  en: {
    microphone: "Dictate a message", stop: "Stop listening", read: "Listen to the last reply", stopReading: "Stop reading",
    privacy: "Optional voice input: your browser may send audio to its speech service. Review the words before selecting Send. Typing is always available.",
    idle: "", listening: "Listening… Select Stop listening to finish.", review: "Your words are in the message box. Edit them if needed, then select Send.",
    finishing: "Finishing your transcription… You can type to cancel it.",
    denied: "Microphone access was refused. You can allow it in browser settings or type your message.", unavailable: "Voice input could not connect. Try again or type your message.",
    unsupported: "Voice input is unavailable in this browser. You can type your message.", too_long: "That recording is too long. Your existing message was kept. Try a shorter recording.", no_speech: "No words were received. Try again or type your message.",
    speechError: "The reply could not be read aloud. The text remains available.", speaking: "Reading the reply aloud.", speechUnsupported: "Reading aloud is unavailable in this browser.",
  },
  es: {
    microphone: "Dictar un mensaje", stop: "Dejar de escuchar", read: "Leer respuesta en voz alta", stopReading: "Detener lectura",
    privacy: "Entrada de voz opcional: su navegador puede enviar el audio a su servicio de voz. Revise el texto antes de seleccionar Enviar. Siempre puede escribir.",
    idle: "", listening: "Escuchando… Seleccione Dejar de escuchar para terminar.", review: "Sus palabras están en el cuadro del mensaje. Puede corregirlas antes de seleccionar Enviar.",
    finishing: "Terminando la transcripción… Puede escribir para cancelarla.",
    denied: "Se denegó el acceso al micrófono. Puede permitirlo en los ajustes del navegador o escribir su mensaje.", unavailable: "No se pudo conectar la entrada de voz. Inténtelo de nuevo o escriba su mensaje.",
    unsupported: "La entrada de voz no está disponible en este navegador. Puede escribir su mensaje.", too_long: "La grabación es demasiado larga. Se conservó su mensaje anterior. Pruebe una grabación más corta.", no_speech: "No se recibieron palabras. Inténtelo de nuevo o escriba su mensaje.",
    speechError: "No se pudo leer la respuesta en voz alta. El texto sigue disponible.", speaking: "Leyendo la respuesta en voz alta.", speechUnsupported: "La lectura en voz alta no está disponible en este navegador.",
  },
} as const;

const subscribeToHydration = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

/** Client-only enhancement of the native form. Speech never sends or confirms a form. */
export function VoiceControls({ language, fieldId, reply }: { readonly language: JourneyLanguage; readonly fieldId: string; readonly reply: string }) {
  const copy = COPY[language];
  const ready = useSyncExternalStore(subscribeToHydration, clientReady, serverReady);
  const [state, setState] = useState<VoiceState>("idle");
  const [speech, setSpeech] = useState<"idle" | "speaking" | "error" | "unsupported">("idle");
  const session = useRef<ReturnType<typeof createDictationSession> | null>(null);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    const field = document.getElementById(fieldId);
    if (!(field instanceof HTMLTextAreaElement)) return;
    const voiceWindow = window as VoiceWindow;
    const dictation = createDictationSession({
      create: () => {
        const Recognition = voiceWindow.SpeechRecognition ?? voiceWindow.webkitSpeechRecognition;
        return Recognition ? new Recognition() : null;
      },
      language: language === "es" ? "es-ES" : "en-US",
      onText: text => { field.value = text; field.focus(); },
      onState: setState,
    });
    session.current = dictation;
    // Editing or leaving the form invalidates any pending recognition result.
    const cancelReading = () => {
      if (utterance.current && "speechSynthesis" in window) {
        utterance.current.onend = null; utterance.current.onerror = null;
        window.speechSynthesis.cancel(); utterance.current = null;
      }
      setSpeech("idle");
    };
    const stop = () => { dictation.stop(); cancelReading(); };
    field.addEventListener("input", stop);
    field.form?.addEventListener("submit", stop);
    const hidden = () => {
      if (!document.hidden) return;
      stop();
    };
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("shopaccess-voice-exclusive", stop);
    return () => {
      stop(); session.current = null;
      field.removeEventListener("input", stop);
      field.form?.removeEventListener("submit", stop);
      document.removeEventListener("visibilitychange", hidden);
      document.removeEventListener("shopaccess-voice-exclusive", stop);
    };
  }, [fieldId, language, reply]);

  function stopReading() {
    if (utterance.current) {
      utterance.current.onend = null; utterance.current.onerror = null;
      window.speechSynthesis.cancel(); utterance.current = null;
    }
    setSpeech("idle");
  }
  function dictate() {
    if (state === "listening") { session.current?.finish(); return; }
    document.dispatchEvent(new Event("shopaccess-voice-exclusive"));
    stopReading();
    const field = document.getElementById(fieldId);
    if (field instanceof HTMLTextAreaElement) session.current?.start(field.value);
  }
  function read() {
    if (speech === "speaking") { stopReading(); return; }
    document.dispatchEvent(new Event("shopaccess-voice-exclusive"));
    session.current?.stop();
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) { setSpeech("unsupported"); return; }
    stopReading();
    const text = new SpeechSynthesisUtterance(reply);
    text.lang = language === "es" ? "es-ES" : "en-US";
    const voice = window.speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith(language));
    if (voice) text.voice = voice;
    text.onend = () => { utterance.current = null; setSpeech("idle"); };
    text.onerror = () => { utterance.current = null; setSpeech("error"); };
    utterance.current = text;
    setSpeech("speaking");
    try { window.speechSynthesis.speak(text); } catch { utterance.current = null; setSpeech("error"); }
  }

  return <details className="flex flex-col gap-2">
    <summary className="cursor-pointer text-sm">{language === "es" ? "Más opciones de voz" : "More voice options"}</summary>
    <p id={`${fieldId}-voice-privacy`} className="text-sm">{copy.privacy}</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={!ready || state === "finishing"} onClick={dictate} aria-pressed={state === "listening" || state === "finishing"} aria-describedby={`${fieldId}-voice-privacy`} className="shopping-secondary-action rounded px-4 py-2">{state === "listening" || state === "finishing" ? copy.stop : copy.microphone}</button>
      <button type="button" disabled={!ready || !reply} onClick={read} aria-pressed={speech === "speaking"} className="shopping-secondary-action rounded px-4 py-2">{speech === "speaking" ? copy.stopReading : copy.read}</button>
    </div>
    <p role="status" aria-live="polite">{copy[state]}{speech === "speaking" ? ` ${copy.speaking}` : speech === "error" ? ` ${copy.speechError}` : speech === "unsupported" ? ` ${copy.speechUnsupported}` : ""}</p>
  </details>;
}
