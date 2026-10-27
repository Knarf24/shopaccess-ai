/** Presentation-only eligible options; server forms remain the authority. */
export interface VoiceJourneyOption {
 readonly productId: string; readonly variantId: string; readonly title: string;
 readonly priceCents: number; readonly description: string; readonly recommended: boolean;
}
const EN = ["one","two","three","four","five","six","seven","eight","nine"];
const ES = ["uno","dos","tres","cuatro","cinco","seis","siete","ocho","nueve"];
const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[.!?]+$/, "").trim();
export function selectVoiceOption(text: string, options: readonly VoiceJourneyOption[]): VoiceJourneyOption | null {
 const m = normalize(text).match(/^(?:choose|select|i choose|i want|elijo|selecciono|quiero)\s+(?:the\s+|la\s+|el\s+)?(.+)$/);
 if (!m) return null;
 const n = m[1].match(/^(?:option|opcion)\s+([1-9]|one|two|three|four|five|six|seven|eight|nine|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)$/);
 if (n) return options[/^[1-9]$/.test(n[1]) ? Number(n[1])-1 : Math.max(EN.indexOf(n[1]),ES.indexOf(n[1]))] ?? null;
 const matches=options.filter(o=>normalize(o.title)===m[1]);
 return matches.length===1 ? matches[0] : null;
}
export function voiceOptionsSummary(options: readonly VoiceJourneyOption[], language: string): string {
 const es=language==="es";
 if (!options.length) return es ? "No hay opciones adecuadas. Puede cambiar sus necesidades o su presupuesto." : "No suitable options are available. You can change your needs or budget.";
 return options.slice(0,9).map((o,i)=>es
  ? `Opción ${ES[i]}: ${o.title}, ${(o.priceCents/100).toFixed(2)} dólares. ${o.description}${o.recommended ? " Recomendada por el asistente." : ""}`
  : `Option ${EN[i]}: ${o.title}, ${(o.priceCents/100).toFixed(2)} dollars. ${o.description}${o.recommended ? " Recommended by the assistant." : ""}`
 ).join("\n\n") + (es ? "\n\n¿Qué opción prefiere? Diga, por ejemplo, elijo la opción uno." : "\n\nWhich option would you like? Say, for example, choose option one.");
}
export function isJourneyDestination(path: string): boolean {
 return /^\/(?:en|es)\/(?:shop\/(?:needs|permissions)|checkout\/ci_[0-9a-f]{32})$/.test(path);
}
/** Provider approval leaves through native navigation, never this transport. */
export function isJourneyPost(path: string): boolean {
 return path==="/shop/needs/charger-control" || path==="/shop/needs/submit" || path==="/shop/needs/confirm" || path==="/checkout/start" || path==="/shop/permissions/create" || /^\/checkout\/ci_[0-9a-f]{32}\/(?:review|confirm|simulate|capture|cancel)$/.test(path);
}

/** Navigation only: these phrases never create or save purchase authority. */
export function isPermissionsRequest(text: string): boolean {
 const command=normalize(text);
 return /^(?:open|manage|open manage)(?: (?:the|purchase|page|pages|pictures))* permissions?$/.test(command)
  || /^(?:set purchase limits|set limits|purchase limits|open purchase limits|configurar limites|limites de compra|abrir permisos)$/.test(command);
}
/** Server notices always take priority over a retained selection. */
export function voicePageReply(reply: string, stage: string, previousStage: string, selected: VoiceJourneyOption | null, options: readonly VoiceJourneyOption[], notice: boolean, language: string): string {
 if (notice || stage !== "options" || previousStage !== "permissions" || !selected || !options.some(option=>option.productId===selected.productId && option.variantId===selected.variantId && option.priceCents===selected.priceCents)) return reply;
 return language === "es" ? `Su selección sigue siendo ${selected.title}. Diga revisar mi selección.` : `Your selection is still ${selected.title}. Say review my selection.`;
}

export interface VoiceChargerContext {
 readonly modelHelp?: string;
 readonly state: "task_choice" | "awaiting_model" | "candidate" | "confirmed" | "closed";
 readonly deviceId: string | null; readonly deviceName: string | null;
 readonly budgetEnabled: boolean; readonly proposedCents: number | null; readonly confirmedCents: number | null;
 readonly purchasable: boolean; readonly permitted: boolean;
}
/** Exact website clarification commands only. Never permission or payment approval. */
export function chargerVoiceAction(text: string, state: VoiceChargerContext["state"]): {action:string;value?:string} | null {
 const command=normalize(text).replace(/[,]/g," ").replace(/\s+/g," ");
 if(state==="awaiting_model") {
  const model=command.replace(/^(?:my model is|my laptop is|mi modelo es|mi portatil es) /,"");
  if(/^(?:mac14 ?2|macbook air (?:\(m2 2022\)|m2 2022|m2 de 2022))$/.test(model))return {action:"choose_model",value:"Mac14,2"};
  if(/^(?:macbookpro12 ?1|macbook pro retina 13(?:-inch| pulgadas) early 2015)$/.test(model))return {action:"choose_model",value:"MacBookPro12,1"};
 }
 if(state==="candidate" && /^(?:confirm my device|confirm my model|confirmo mi modelo|confirmar mi modelo)$/.test(command))return {action:"confirm"};
 if(state==="confirmed") {
  if(/^(?:confirm my charger budget|confirmo mi presupuesto del cargador)$/.test(command))return {action:"confirm_budget"};
  const budget=command.match(/^(?:(?:my (?:charger )?budget is|change (?:my )?(?:charger )?budget to|mi presupuesto(?: del cargador)? es|cambiar mi presupuesto a) )\$?([1-9][0-9]{1,4})(?: (?:dollars|dolares))?$/);
  if(budget)return {action:"propose_budget",value:budget[1]};
 }
 return null;
}
/** Facts come from current server state; unknown compatibility never becomes a recommendation. */
export function chargerVoiceGuidance(track: VoiceChargerContext, language: string): string {
 const es=language==="es";
 if(track.state==="task_choice")return es ? "¿Busca un portátil o un cargador?" : "Are you shopping for a laptop or a charger?";
 if(track.state==="awaiting_model" && track.modelHelp)return track.modelHelp;
 if(track.state==="awaiting_model")return es ? "Indique el modelo exacto de su MacBook, incluido el año. También puede elegirlo en la página." : "Tell me your exact MacBook model, including the year. You can also choose it on the page.";
 if(track.state==="candidate")return es ? `Identifiqué ${track.deviceName}. Si es correcto, diga confirmo mi modelo.` : `I identified ${track.deviceName}. If that is correct, say confirm my device.`;
 if(track.state!=="confirmed")return es ? "Dígame qué necesita." : "Tell me what you need.";
 if(track.deviceId!=="Mac14,2")return es ? "La compatibilidad de este modelo sigue siendo desconocida según nuestras fuentes. No puedo recomendar una compra." : "Compatibility for this model remains unknown in our sources. I cannot recommend a purchase.";
 if(!track.budgetEnabled)return es ? "Esta página ofrece solo información. La compra del adaptador no está habilitada en este entorno." : "This page provides information only. Adapter purchasing is not enabled in this environment.";
 if(track.proposedCents!==null && track.confirmedCents===null)return es ? `Su presupuesto propuesto es ${(track.proposedCents/100).toFixed(2)} dólares. Si es correcto, diga confirmo mi presupuesto del cargador.` : `Your proposed charger budget is ${(track.proposedCents/100).toFixed(2)} dollars. If that is correct, say confirm my charger budget.`;
 if(track.confirmedCents===null)return es ? "¿Cuál es su presupuesto para el cargador?" : "What is your charger budget?";
 if(track.confirmedCents<5900)return es ? "No hay un adaptador recomendado dentro de su presupuesto. El adaptador cuesta 59.00 dólares. Puede indicar otro presupuesto." : "No recommended adapter fits your budget. The adapter costs 59.00 dollars. You can tell me a different budget.";
 if(!track.purchasable)return es ? "No hay una compra de adaptador disponible en este estado. Revise el aviso de la página." : "An adapter purchase is not available in this state. Check the notice on the page.";
 return es ? "Apple 70W USB-C Power Adapter, modelo A2743, a 59.00 dólares. Apple incluye su MacBook Air M2 de 2022 en las combinaciones compatibles. El cable se vende por separado; el adaptador solo no completa el conjunto de carga.\n\nPara seleccionarlo, diga elijo la opción uno." : "Apple 70W USB-C Power Adapter, model A2743, at 59.00 dollars. Apple lists a pairing for your MacBook Air M2 from 2022. Cable sold separately; the adapter alone is not a complete charging setup.\n\nTo select it, say choose option one.";
}
