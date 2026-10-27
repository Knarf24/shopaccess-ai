import { afterEach, describe, expect, it, vi } from "vitest";
import * as voiceCommands from "@/lib/voice/hands-free";
import { createHandsFreeSession } from "@/lib/voice/hands-free";
import type { RecognitionPort } from "@/lib/voice/dictation";
import { createMockAdvisoryAi } from "@/lib/providers/ai";

const sessions: ReturnType<typeof createHandsFreeSession>[]=[];
afterEach(()=>{for(const session of sessions)session.disable();sessions.length=0;vi.useRealTimers();});
function fixture(autoStart = true) {
  const ports: RecognitionPort[]=[]; const messages:string[]=[]; const states:string[]=[]; const spoken:string[]=[];
  let done:()=>void=()=>{};
  const session=createHandsFreeSession({ language:"en-US", greeting:"How can I help?",
    create:()=>{ const p:RecognitionPort={lang:"",continuous:false,interimResults:false,onresult:null,onerror:null,onend:null,onstart:null,start(){if(autoStart)this.onstart?.();},stop(){},abort(){}};ports.push(p);return p; },
    speak:(text,end)=>{spoken.push(text);done=end;return ()=>{};},onMessage:text=>messages.push(text),onState:state=>states.push(state),
  });
  sessions.push(session);
  const say=(text:string)=>ports.at(-1)?.onresult?.({results:[{isFinal:true,0:{transcript:text}}]});
  return {session,ports,messages,states,spoken,say,done:()=>done()};
}
describe("foreground hands-free conversation",()=>{
 it("keeps a progressing reply alive beyond two minutes, then resumes listening",()=>{
  vi.useFakeTimers();let progress:(part:string)=>void=()=>{};let done=()=>{};
  const session=createHandsFreeSession({language:"en-US",greeting:"Hello",create:()=>({lang:"",continuous:false,interimResults:false,onresult:null,onerror:null,onend:null,start(){},stop(){},abort(){}}),
   speak:(_text,end,_failed,onProgress)=>{progress=onProgress ?? (()=>{});done=end;progress("a".repeat(600));return ()=>{};},onMessage:()=>{},onState:()=>{}});
  sessions.push(session);session.enable();session.respond("a".repeat(2000));
  for(let i=0;i<3;i++){vi.advanceTimersByTime(50000);progress("a".repeat(600));}
  expect(session.phase()).toBe("speaking");done();expect(session.isActive()).toBe(true);expect(session.phase()).toBe("starting");
 });
 it("accepts Hey Assistant ShopAccess, then a selection after the reply ends",()=>{
  const f=fixture();f.session.enable();f.say("Hey Assistant, Shop Access, laptop");
  expect(f.messages).toEqual(["laptop"]);f.session.respond("Option one. Option two. Option three.");
  f.done();expect(f.session.phase()).toBe("listening");f.say("choose option one");
  expect(f.messages).toEqual(["laptop","choose option one"]);
 });
  it("does not claim active voice after denial or failure",()=>{
    const f=fixture();expect(f.session.isActive()).toBe(false);
    f.session.enable();expect(f.session.isActive()).toBe(true);f.session.fail();expect(f.session.isActive()).toBe(false);
    expect(f.session.waitForReply()).toBe(false);f.session.enable();f.ports.at(-1)!.onerror!({error:"not-allowed"});
    expect(f.session.isActive()).toBe(false);expect(f.session.waitForReply()).toBe(false);
  });
  it("waits for actual microphone readiness and ignores a late start after stopping",()=>{
    const f=fixture(false);f.session.enable();
    expect(f.session.phase()).toBe("starting");
    const started=f.ports.at(-1)!.onstart!;
    started();expect(f.session.phase()).toBe("listening");
    f.say("Hey ShopAccess");f.done();expect(f.session.phase()).toBe("starting");
    const late=f.ports.at(-1)!.onstart!;
    f.session.disable();late();expect(f.session.phase()).toBe("off");expect(f.messages).toEqual([]);
  });
  it("recognizes only an explicit needs-confirmation phrase",()=>{
    expect(voiceCommands.isNeedsConfirmation).toBeTypeOf("function");
    expect(voiceCommands.isNeedsConfirmation("Confirm my choices.", "en")).toBe(true);
    expect(voiceCommands.isNeedsConfirmation("Confirmo mis opciones", "es")).toBe(true);
    for(const text of ["do not confirm my choices", "buy it", "confirmed", "confirm my choices and buy it"])
      expect(voiceCommands.isNeedsConfirmation(text,"en")).toBe(false);
  });
  it("reconnects once after an empty microphone end, then pauses instead of looping",()=>{
    vi.useFakeTimers();const f=fixture();f.session.enable();
    const first=f.ports.at(-1)!;first.onerror!({error:"no-speech"});first.onend!();
    expect(f.session.phase()).toBe("reconnecting");vi.advanceTimersByTime(500);
    const second=f.ports.at(-1)!;expect(second).not.toBe(first);
    second.onerror!({error:"no-speech"});second.onend!();
    expect(f.session.phase()).toBe("no_speech");expect(f.session.isActive()).toBe(false);
    vi.advanceTimersByTime(60000);expect(f.ports).toHaveLength(2);expect(f.messages).toEqual([]);
  });
  it("previews a voice without enabling a microphone or sending a message",()=>{
    const f=fixture();expect(f.session.preview("A voice sample")).toBe(true);
    expect(f.session.phase()).toBe("previewing");expect(f.ports).toHaveLength(0);
    f.done();expect(f.session.phase()).toBe("off");expect(f.messages).toEqual([]);
  });
  it("pauses recognition for a preview, resumes afterwards and refuses previews during a pending message",()=>{
    const f=fixture();f.session.enable();const old=f.ports.at(-1)!.onresult!;
    f.session.preview("Sample");old({results:[{isFinal:true,0:{transcript:"Hey ShopAccess, buy"}}]});
    expect(f.messages).toEqual([]);f.done();expect(f.session.phase()).toBe("listening");
    f.say("Hey ShopAccess, laptop");expect(f.session.preview("Interrupt")).toBe(false);
    expect(f.session.phase()).toBe("waiting");
  });
  it("pauses for an explicit website confirmation and reads its result without enabling again",()=>{
    const f=fixture();expect(f.session.waitForReply()).toBe(false);
    f.session.enable();f.say("Hey ShopAccess");f.done();
    const old=f.ports.at(-1)!.onresult!;
    expect(f.session.waitForReply()).toBe(true);expect(f.session.phase()).toBe("waiting");
    old({results:[{isFinal:true,0:{transcript:"change budget"}}]});expect(f.messages).toEqual([]);
    f.session.respond("A laptop is recommended");expect(f.spoken.at(-1)).toBe("A laptop is recommended");
    f.done();expect(f.session.phase()).toBe("listening");
  });
  it("stops a stalled microphone or speech service instead of staying active forever",()=>{
    vi.useFakeTimers();const f=fixture();f.session.enable();vi.advanceTimersByTime(60000);expect(f.session.phase()).toBe("error");
    f.session.enable();f.say("Hey ShopAccess");vi.advanceTimersByTime(120000);expect(f.session.phase()).toBe("error");
  });
  it("understands the Spanish study request in the local preview",async()=>{
    await expect(createMockAdvisoryAi().interpretNeeds({instructions:"",untrustedData:{shopperMessage:"Para estudiar. Mi presupuesto es de 600 dólares.",products:[]}})).resolves.toMatchObject({understoodUse:"schoolwork"});
  });
  it("supports a Spanish wake phrase and refuses an overlong spoken request",()=>{
    const f=fixture();f.session.enable();f.say("Hola Shop Access, para estudiar");expect(f.messages).toEqual(["para estudiar"]);
    f.session.disable();f.session.enable();f.say("Hey ShopAccess, "+"a".repeat(2001));expect(f.session.phase()).toBe("too_long");expect(f.messages).toHaveLength(1);
  });
  it("accepts normal speech after explicit enable without requiring a second wake phrase",()=>{
    const f=fixture();expect(f.ports).toHaveLength(0);f.session.enable();f.say("I need a laptop");
    expect(f.messages).toEqual(["I need a laptop"]);expect(f.session.phase()).toBe("waiting");
    f.session.disable();f.session.enable();f.say("Hey Shop Access AI, I need a laptop for school");
    expect(f.messages.at(-1)).toBe("I need a laptop for school");
  });
  it("speaks a greeting after wake-only input, then accepts the next utterance",()=>{
    const f=fixture();f.session.enable();f.say("Hey ShopAccess");expect(f.spoken).toEqual(["How can I help?"]);f.done();f.say("My budget is $600");expect(f.messages).toEqual(["My budget is $600"]);
  });
  it("ignores old microphone results while speaking and resumes only after speech ends",()=>{
    const f=fixture();f.session.enable();f.say("Hey ShopAccess, a laptop");const old=f.ports.at(-1)!.onresult!;
    f.session.respond("Check your choices");old({results:[{isFinal:true,0:{transcript:"buy it"}}]});expect(f.messages).toEqual(["a laptop"]);expect(f.session.phase()).toBe("speaking");f.done();expect(f.session.phase()).toBe("listening");
  });
  it("stop ignores late callbacks and does not submit a stop command",()=>{
    const f=fixture();f.session.enable();const old=f.ports.at(-1)!.onresult!;f.say("stop listening");expect(f.session.phase()).toBe("off");old({results:[{isFinal:true,0:{transcript:"Hey ShopAccess, buy now"}}]});expect(f.messages).toEqual([]);
  });
});
