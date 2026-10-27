"use client";

import "./voice-journey.css";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isNeedsConfirmation, createHandsFreeSession, type HandsFreePhase } from "@/lib/voice/hands-free";
import { isJourneyDestination, isJourneyPost, isPermissionsRequest, voicePageReply, chargerVoiceAction, type VoiceChargerContext, selectVoiceOption, voiceOptionsSummary, type VoiceJourneyOption } from "@/lib/voice/journey";
import { speakInSequence } from "@/lib/voice/speech-sequence";
import { clearAcknowledgedVoiceDraft } from "@/lib/voice/draft";
import type { RecognitionPort } from "@/lib/voice/dictation";
import type { JourneyLanguage } from "@/lib/i18n/language";

type BrowserVoice = Window & { SpeechRecognition?: new () => RecognitionPort; webkitSpeechRecognition?: new () => RecognitionPort };
const subscribe = () => () => {};
const client = () => true;
const server = () => false;
const COPY = {
  en: {
    enable: "Chat by voice", stop: "Stop voice chat", greeting: "I'm listening. What do you need?",
    disclosure: "Click Chat by voice, wait for Listening, then speak normally. Hey ShopAccess is optional. Messages are sent and replies spoken automatically. Your browser may process audio while voice chat is on, while waiting for you to speak. To see recommendations, say confirm my choices or use the page button.",
    previewing: "Playing a voice sample. The microphone is paused.",
    reconnecting: "The microphone stopped. Reconnecting once…", no_speech: "No speech was received. Voice chat paused. Click Chat by voice to try again, or type your message.",
    off: "Voice chat is off.", starting: "Getting the microphone ready… Wait for the listening message before speaking.", wake: "Waiting for Hey ShopAccess…", listening: "Listening to your shopping request… Say stop listening to turn voice chat off.", waiting: "Message sent. Waiting for the reply…", speaking: "Reading the reply. The microphone is paused.",
    denied: "Microphone access was refused. Allow it in browser settings or type your message.", error: "Voice chat stopped. A message already sent may still finish. Check the page before trying again.", too_long: "That message is too long. Voice chat stopped; your typed draft was kept.", unsupported: "Voice chat is unavailable in this browser. Typing and individual voice controls remain available.", draft: "Send or clear your typed draft before starting voice chat.",
  },
  es: {
    enable: "Conversar por voz", stop: "Detener conversación por voz", greeting: "Le escucho. ¿Qué necesita?",
    disclosure: "Pulse Conversar por voz, espere el mensaje de escucha y hable normalmente. Hey ShopAccess es opcional. Los mensajes se envían y las respuestas se leen automáticamente. Su navegador puede procesar audio mientras la voz está activa, mientras espera a que hable. Para ver recomendaciones, diga confirmo mis opciones o use el botón de la página.",
    previewing: "Reproduciendo una muestra de voz. El micrófono está en pausa.",
    reconnecting: "El micrófono se detuvo. Reconectando una vez…", no_speech: "No se recibió voz. La conversación está en pausa. Pulse Conversar por voz para reintentar o escriba su mensaje.",
    off: "Manos libres está desactivado. Un mensaje ya enviado podría terminar.", starting: "Preparando el micrófono… Espere el mensaje de escucha antes de hablar.", wake: "Esperando Hey ShopAccess…", listening: "Escuchando su solicitud… Diga deja de escuchar para desactivar manos libres.", waiting: "Mensaje enviado. Esperando respuesta…", speaking: "Leyendo la respuesta. El micrófono está en pausa.",
    denied: "Se denegó el acceso al micrófono. Puede permitirlo en los ajustes del navegador o escribir.", error: "Manos libres se detuvo. Un mensaje ya enviado podría terminar. Revise la página antes de volver a intentarlo.", too_long: "El mensaje es demasiado largo. Manos libres se detuvo; su borrador se conservó.", unsupported: "Manos libres no está disponible en este navegador. Puede escribir o usar los controles de voz individuales.", draft: "Envíe o borre su borrador antes de activar manos libres.",
  },
} as const;

type JourneyStage = "charger" | "needs" | "options" | "permissions" | "checkout" | "loading";
interface VoicePage { readonly language: JourneyLanguage; readonly reply: string; readonly replyKey: string; readonly charger?: VoiceChargerContext; readonly notice?: boolean; readonly stage?: JourneyStage; readonly options?: readonly VoiceJourneyOption[]; }
const NO_OPTIONS: readonly VoiceJourneyOption[] = [];
const VoicePageContext=createContext<((page: VoicePage)=>()=>void)|null>(null);
/** One foreground controller, retained across first-party client navigation. */
export function VoiceJourneyProvider({children}:{readonly children:ReactNode}) {
 const [registration,setRegistration]=useState<{page:VoicePage;token:object;current:boolean}|null>(null);
 const register=useCallback((page:VoicePage)=>{
  const token={};setRegistration({page,token,current:true});
  return ()=>setRegistration(current=>current?.token===token ? {...current,current:false} : current);
 },[]);
 const page=registration?.page;
 return <VoicePageContext.Provider value={register}>
  {page ? <div className="guided-presentation ui-refresh" data-voice-journey data-voice-stage={page.stage}><div className="voice-journey-column">
   <HandsFreeSession {...page} stage={registration.current ? page.stage : "loading"} options={registration.current ? page.options : NO_OPTIONS} reply={registration.current ? page.reply : page.language==="es" ? "Espere el siguiente paso o use la navegación de la página." : "Wait for the next step or use the page navigation."} replyKey={registration.current ? page.replyKey : "page-unavailable"}/>
  </div></div> : null}
  {children}
 </VoicePageContext.Provider>;
}
export function HandsFreeControls(props:VoicePage) {
 const register=useContext(VoicePageContext);
 const pathname=usePathname();
 const {language,reply,replyKey,stage,options,notice,charger}=props;
 useEffect(()=>register?.({language,reply,replyKey,stage,options,notice,charger}),[register,language,reply,replyKey,stage,options,notice,charger,pathname]);
 return register ? null : <HandsFreeSession {...props}/>;
}
function HandsFreeSession({language,reply,replyKey,stage="needs",options=NO_OPTIONS,notice=false,charger}:VoicePage) {
 const pageRef=useRef({stage,options,reply,charger});
 useEffect(()=>{pageRef.current={stage,options,reply,charger};},[stage,options,reply,charger]);
 const selection=useRef<VoiceJourneyOption|null>(null);
 const previousStage=useRef(stage);
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => { routerRef.current = router; }, [router]);
  const ready = useSyncExternalStore(subscribe, client, server);
  const [phase, setPhase] = useState<HandsFreePhase>("off");
  const [draftWarning, setDraftWarning] = useState(false);
  const copy = COPY[language];
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceChoice, setVoiceChoice] = useState("");
  const preferredVoice = useRef("");
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    const update = () => setVoices(synth.getVoices().filter(v => v.lang.toLowerCase().startsWith(language)));
    update();
    synth.addEventListener?.("voiceschanged", update);
    return () => synth.removeEventListener?.("voiceschanged", update);
  }, [language]);
  const controller = useRef<ReturnType<typeof createHandsFreeSession> | null>(null);
  const lastKey = useRef(replyKey);
  const requestGeneration = useRef(0);
  const cancelPending = useRef<() => void>(() => {});
  const pending = useRef<{ field: HTMLTextAreaElement | HTMLInputElement; wasReadOnly: boolean; sentText: string | null; timer: ReturnType<typeof setTimeout>; abort: AbortController } | null>(null);

  useEffect(() => {
    const voiceWindow = window as BrowserVoice;
    let mounted = true;
    const finishPending = (abortRequest = false) => {
      requestGeneration.current++;
      if (!pending.current) return;
      if (abortRequest) pending.current.abort.abort();
      clearTimeout(pending.current.timer);
      pending.current.field.readOnly = pending.current.wasReadOnly;
      pending.current = null;
    };
    cancelPending.current = () => finishPending(true);
    const session = createHandsFreeSession({
      language: language === "es" ? "es-ES" : "en-US", greeting: () => pageRef.current.stage === "needs" ? COPY[language].greeting : pageRef.current.reply,
      create: () => {
        if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return null;
        const Recognition = voiceWindow.SpeechRecognition ?? voiceWindow.webkitSpeechRecognition;
        return Recognition ? new Recognition() : null;
      },
      speak: (text, done, failed, progress) => speakInSequence({ text, done, failed, progress, speak: (part, partDone, partFailed) => {
        const utterance = new SpeechSynthesisUtterance(part);
        utterance.lang = language === "es" ? "es-ES" : "en-US";
        utterance.rate = 0.92;
        const available = window.speechSynthesis.getVoices().filter(v => v.lang.toLowerCase().startsWith(language));
        const voice = available.find(v => v.voiceURI === preferredVoice.current) ?? available.find(v => v.default) ?? available[0];
        if (voice) utterance.voice = voice;
        utterance.onend = partDone; utterance.onerror = partFailed;
        window.speechSynthesis.speak(utterance);
        return () => { utterance.onend = null; utterance.onerror = null; window.speechSynthesis.cancel(); };
      } }),
      onState: state => {
        if (["off", "no_speech", "error", "denied", "unsupported", "too_long"].includes(state)) finishPending(true);
        if (mounted) setPhase(state);
      },
      onMessage: text => {
        const page=pageRef.current;
        const command=text.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
        const navigate=(path:string)=>{
          if(pending.current || page.stage==="loading") return;
          session.waitForReply();const target=new URL(path,window.location.origin);
          target.searchParams.set("voiceTurn",crypto.randomUUID());routerRef.current.push(target.pathname+target.search);
        };
        if(page.stage==="loading") { session.respond(language==="es" ? "Espere el siguiente paso." : "Please wait for the next step.");return; }
        if(/^(?:help|what next|what happens next|ayuda|que sigue)$/.test(command)) {session.respond(page.reply);return;}
        if(/^(?:compare options|read my options|list options|comparar opciones|leer opciones)$/.test(command) && page.stage==="options") {session.respond(voiceOptionsSummary(page.options,language));return;}
        if(page.charger && (page.stage==="charger" || page.stage==="options")) {
          const control=chargerVoiceAction(text,page.charger.state);
          if(control) {
            const form=Array.from(document.querySelectorAll('form[action="/shop/needs/charger-control"]')).find(f=>f instanceof HTMLFormElement && new FormData(f).get("action")===control.action);
            const field=form?.querySelector('input[name="csrfToken"]');
            if(form instanceof HTMLFormElement && field instanceof HTMLInputElement && !pending.current) {
              const body=formBody(form);
              if(control.action==="choose_model")body.set("device",control.value!);
              if(control.action==="propose_budget")body.set("dollars",control.value!);
              if(session.waitForReply())send(body,field,"/shop/needs/charger-control");
            } else session.respond(page.reply);
            return;
          }
          if(isNeedsConfirmation(text,language)) {session.respond(page.reply);return;}
        }
        if(page.stage==="options") {
          const chosen=selectVoiceOption(text,page.options);
          if(chosen) {selection.current=chosen;session.respond(language==="es" ? `Seleccionó ${chosen.title}, a ${(chosen.priceCents/100).toFixed(2)} dólares. Diga revisar mi selección. No se ha autorizado el pago.` : `You selected ${chosen.title}, at ${(chosen.priceCents/100).toFixed(2)} dollars. Say review my selection. No payment has been authorized.`);return;}
          if(/^(?:choose|select|i choose|i want|elijo|selecciono|quiero)\b/.test(command)) {session.respond(language==="es" ? "Indique una opción por número o el nombre completo del producto." : "Please choose an option by number or the full product name.");return;}
          if(/^(?:review my selections?|review my purchase|revisar mi seleccion|revisar mi compra)$/.test(command)) {
            const chosen=selection.current;
            const current=chosen && page.options.find(o=>o.productId===chosen.productId && o.variantId===chosen.variantId && o.priceCents===chosen.priceCents);
            const form=current && Array.from(document.querySelectorAll('form[action="/checkout/start"]')).find(f=>f instanceof HTMLFormElement && new FormData(f).get("variantId")===current.variantId && new FormData(f).get("productId")===current.productId);
            const field=form?.querySelector('input[name="quantity"]');
            if(form instanceof HTMLFormElement && field instanceof HTMLInputElement && !pending.current && form.checkValidity()) send(formBody(form),field,"/checkout/start");
            else session.respond(current && page.charger ? language==="es" ? "Esta compra necesita un permiso. Diga abrir permisos." : "This purchase needs permission. Say open permissions." : language==="es" ? "Primero elija una opción actual de la página." : "First choose a current option from the page.");
            return;
          }
        }
        if(isPermissionsRequest(command)) {
          const chosen=selection.current;
          const query=chosen ? "?"+new URLSearchParams({item:`${chosen.productId}:${chosen.variantId}`,quantity:"1",total:(chosen.priceCents/100).toFixed(2)}) : "";
          navigate(`/${language}/shop/permissions${query}`);return;
        }
        if(/^(?:return to my selection|back to shopping|go back|go back to the main page|go back to main page|back to the main page|go back to shopping|return to shopping|volver a mi seleccion|volver a comprar|volver)$/.test(command)) {navigate(`/${language}/shop/needs`);return;}
        if (page.stage === "options" && /\b(?:limits?|permissions?)\b/.test(command) && !/\d/.test(command)) {
          session.respond(language === "es" ? "Si quiere revisar los permisos, diga abrir permisos o use el enlace Administrar permisos de compra." : "If you want purchase limits, say open permissions, or use the Manage purchase permissions link. I have not changed your needs or permissions.");return;
        }
        if(page.stage==="permissions" || page.stage==="checkout") {session.respond(page.reply);return;}
        if (isNeedsConfirmation(text, language)) {
          const review = document.querySelector('form[action="/shop/needs/confirm"]');
          const field = review?.querySelector('input[name="budget"]');
          if (review instanceof HTMLFormElement && field instanceof HTMLInputElement && !pending.current && review.checkValidity()) {
            const body = new URLSearchParams();
            for (const [name, value] of new FormData(review)) if (typeof value === "string") body.append(name, value);
            send(body, field, "/shop/needs/confirm");
          } else {
            session.respond(language === "es" ? "Primero indique para qué necesita el portátil y su presupuesto. Si ya confirmó sus opciones, revise las recomendaciones en la página." : "First tell me what you need the laptop for and your budget. If your choices are already confirmed, review the recommendations on the page.");
          }
          return;
        }
        const form = document.querySelector('.needs-conversation form[action="/shop/needs/submit"]');
        const field = form?.querySelector('textarea[name="shopperText"]');
        if (!(form instanceof HTMLFormElement) || !(field instanceof HTMLTextAreaElement) || pending.current) { session.fail(); return; }
        const body = new URLSearchParams();
        for (const [name, value] of new FormData(form)) if (typeof value === "string") body.append(name, value);
        body.set("shopperText", text); field.value = text;
        send(body, field, "/shop/needs/submit");
      },
    });
    function formBody(form:HTMLFormElement,submitter?:HTMLElement|null) {
      const body=new URLSearchParams();
      for(const [name,value] of new FormData(form)) if(typeof value==="string") body.append(name,value);
      if(submitter instanceof HTMLButtonElement && submitter.name) body.append(submitter.name,submitter.value);
      return body;
    }
    function send(body: URLSearchParams, field: HTMLTextAreaElement | HTMLInputElement, action: string) {
        if (!isJourneyPost(action) || pending.current) { session.fail(); return; }
        if (!body.get("csrfToken")) { session.fail(); return; }
        const wasReadOnly = field.readOnly; field.readOnly = true;
        const abort = new AbortController();
        const request = ++requestGeneration.current;
        const timer = setTimeout(() => { if (request !== requestGeneration.current) return; finishPending(true); session.fail(); }, 20000);
        pending.current = { field, wasReadOnly, sentText: action === "/shop/needs/submit" && field instanceof HTMLTextAreaElement ? body.get("shopperText") : null, timer, abort };
        void fetch(action, { method: "POST", body, credentials: "same-origin", mode: "same-origin", signal: abort.signal }).then(response => {
          if (!mounted || request !== requestGeneration.current) return;
          const target = new URL(response.url);
          if (!response.ok || target.origin !== window.location.origin || !isJourneyDestination(target.pathname)) throw Error("shopping reply unavailable");
          target.searchParams.set("voiceTurn", crypto.randomUUID());
          routerRef.current.replace(target.pathname + target.search, { scroll: false });
        }).catch(() => { if (mounted && request === requestGeneration.current) { finishPending(true); session.fail(); } });
    }
    controller.current = session;
    const stop = (event?: Event) => { if (event instanceof CustomEvent && event.detail === "handsfree-preview") return; session.disable(); };
    const hidden = () => { if (document.hidden) stop(); };
    const input = (event: Event) => { if (event.target instanceof Element && event.target.closest(".needs-conversation")) stop(); };
    const submit = (event: Event) => {
      if (pending.current?.field.form === event.target) { event.preventDefault(); return; }
      const form = event.target;
      if (form instanceof HTMLFormElement && form.getAttribute("action") === "/shop/needs/confirm" && session.isActive()) {
        if (pending.current) { event.preventDefault(); return; }
        const field = form.querySelector('input[name="budget"]');
        if (field instanceof HTMLInputElement && session.waitForReply()) {
          event.preventDefault();
          const body = new URLSearchParams();
          for (const [name, value] of new FormData(form)) if (typeof value === "string") body.append(name, value);
          send(body, field, "/shop/needs/confirm");
          return;
        }
      }
      if(form instanceof HTMLFormElement && session.isActive()) {
        const action=form.getAttribute("action") ?? "";
        if(form.method.toLowerCase()==="get" && action===`/${language}/shop/permissions`) {
          event.preventDefault();if(pending.current)return;session.waitForReply();
          const query=formBody(form);query.set("voiceTurn",crypto.randomUUID());routerRef.current.push(action+"?"+query);return;
        }
        if(form.method.toLowerCase()==="post" && isJourneyPost(action)) {
          event.preventDefault();if(pending.current)return;
          const field=form.querySelector('input[name="csrfToken"]');
          if(field instanceof HTMLInputElement && form.checkValidity() && session.waitForReply()) send(formBody(form,(event as SubmitEvent).submitter),field,action);
          return;
        }
      }
      if (event.target instanceof Element && event.target.closest(".needs-conversation")) stop();
    };
    const link=(event:MouseEvent)=>{
      if(!session.isActive() || event.defaultPrevented || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)return;
      const anchor=event.target instanceof Element ? event.target.closest("a") : null;
      if(!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.hasAttribute("download"))return;
      const target=new URL(anchor.href);
      if(target.origin!==window.location.origin || !isJourneyDestination(target.pathname))return;
      event.preventDefault();if(pending.current)return;
      session.waitForReply();target.searchParams.set("voiceTurn",crypto.randomUUID());routerRef.current.push(target.pathname+target.search);
    };
    document.addEventListener("click",link);
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("input", input);
    document.addEventListener("submit", submit);
    document.addEventListener("shopaccess-voice-exclusive", stop);
    return () => {
      mounted = false; session.disable(); controller.current = null;
      pending.current?.abort.abort(); finishPending();
      document.removeEventListener("click",link);
      document.removeEventListener("visibilitychange", hidden);
      document.removeEventListener("input", input);
      document.removeEventListener("submit", submit);
      document.removeEventListener("shopaccess-voice-exclusive", stop);
    };
  }, [language]);

  useEffect(()=>{
    if(stage!=="loading")return;
    controller.current?.waitForReply();
    const timer=setTimeout(()=>controller.current?.disable(),30000);
    return ()=>clearTimeout(timer);
  },[stage]);
  useEffect(() => {
    const fromStage = previousStage.current;
    if (stage !== "loading") previousStage.current = stage;
    if (stage === "loading" || lastKey.current === replyKey) return;
    lastKey.current = replyKey;
    if (pending.current) {
      requestGeneration.current++;
      clearTimeout(pending.current.timer);
      if (pending.current.field instanceof HTMLTextAreaElement) clearAcknowledgedVoiceDraft(pending.current.field, pending.current.sentText);
      pending.current.field.readOnly = pending.current.wasReadOnly;
      pending.current = null;
    }
    controller.current?.respond(voicePageReply(reply,stage,fromStage,selection.current,options,notice,language));
  }, [replyKey, reply, stage, language, options, notice]);

  const active = ["starting", "reconnecting", "wake", "listening", "waiting", "speaking", "previewing"].includes(phase);
  function previewVoice() {
    if (pending.current) return;
    document.dispatchEvent(new CustomEvent("shopaccess-voice-exclusive", { detail: "handsfree-preview" }));
    controller.current?.preview(language === "es" ? "Hola, soy su asistente de compras ShopAccess. Dígame qué necesita." : "Hi, I'm your ShopAccess shopping assistant. Tell me what you need.");
  }
  function toggle() {
    setDraftWarning(false);
    if (active) { cancelPending.current(); controller.current?.disable(); return; }
    const field = document.querySelector('.needs-conversation textarea[name="shopperText"]');
    if (field instanceof HTMLTextAreaElement && field.value.trim()) { setDraftWarning(true); return; }
    document.dispatchEvent(new Event("shopaccess-voice-exclusive"));
    controller.current?.enable();
  }
  return <section className="journey-panel rounded border p-3" data-hands-free-controls aria-label={language === "es" ? "Conversación por voz" : "Voice chat"}>
    <p className="text-sm" id="hands-free-disclosure">{copy.disclosure}</p>
    <button type="button" disabled={!ready} onClick={toggle} aria-pressed={active} aria-describedby="hands-free-disclosure" className="shopaccess-voice-start" data-voice-phase={phase}>
      <span className="shopaccess-voice-orb" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" focusable="false">
          <path d="M7 13v6M13 8v16M19 5v22M25 11v10" />
        </svg>
      </span>
      <span>{phase === "previewing" ? (language === "es" ? "Detener muestra" : "Stop preview") : active ? copy.stop : copy.enable}</span>
    </button>
    <p role="status" aria-live="polite">{stage === "loading" ? reply : draftWarning ? copy.draft : copy[phase]}</p>
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer">{language === "es" ? "Cambiar voz" : "Change voice"}</summary>
      <label className="block" htmlFor="shopaccess-voice-choice">
        {language === "es" ? "Voz para las respuestas" : "Voice for replies"}
      </label>
      <select id="shopaccess-voice-choice" value={voiceChoice} disabled={!ready || !voices.length || phase === "waiting"} onChange={event => { preferredVoice.current = event.target.value; setVoiceChoice(event.target.value); previewVoice(); }} className="rounded border border-zinc-400 p-2">
          <option value="">{language === "es" ? "Automática" : "Automatic"}</option>
          {voices.map(v => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}
      </select>
      <button type="button" disabled={!ready || !voices.length || phase === "waiting"} onClick={previewVoice} className="rounded border border-blue-800 px-4 py-2 text-blue-800">{language === "es" ? "Escuchar muestra" : "Preview voice"}</button>
      <p>{language === "es" ? "Se aplica a la próxima respuesta. Las voces disponibles dependen de su navegador y dispositivo." : "Applies to the next reply. Available voices depend on your browser and device."}</p>
    </details>
  </section>;
}
