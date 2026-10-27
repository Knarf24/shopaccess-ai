import { EVIDENCE, type DeviceId } from "./evidence";
import { selectDevice } from "./rules";

/**
 * Local reading of one shopper message for charger clarification (F03 conversation, slice 1). No provider is involved.
 * The kind only says which task the words point to; it never identifies a device. A device is identified only by an
 * exact curated model identifier, checked by the existing `selectDevice`. A description, a year, a connector name such as
 * MagSafe or a partial identifier identifies nothing.
 *
 * The guided website and existing extension text handlers use this local reading; no provider call is involved.
 */

export type ChargerTextKind = "charger" | "laptop" | "mixed" | "ambiguous_adapter" | "none";

export interface ChargerTextReading {
  readonly kind: ChargerTextKind;
  /** A description of an owned Mac, not a request to shop for another laptop. It identifies no model. */
  readonly modelDescription?: true;
  /** The one exact curated identifier in the text, or null (none, several different ones, or not curated). */
  readonly exactDevice: DeviceId | null;
}

/** Clear charger wording. "Power adapter" is here; the bare word "adapter" is not. */
const CHARGER_CUES = [
  "charger",
  "chargers",
  "power adapter",
  "power adapters",
  "magsafe",
  "charging cable",
  "charging cables",
  "charge cable",
  "charge cables",
  "cargador",
  "cargadores",
  "adaptador de corriente",
  "adaptadores de corriente",
  "cable de carga",
  "cables de carga",
];

/** "Adapter" with no power or charging qualifier: a hub, a video adapter or a charger. Ambiguous. */
const ADAPTER_CUES = ["adapter", "adapters", "adaptador", "adaptadores"];

/** Laptop shopping, including the use words the laptop flow already recognises. */
const LAPTOP_CUES = [
  "laptop",
  "laptops",
  "portátil",
  "portátiles",
  "portatil",
  "portatiles",
  "computadora",
  "computadoras",
  "school",
  "schoolwork",
  "homework",
  "escuela",
  "clases",
  "tareas",
  "programming",
  "program",
  "coding",
  "programación",
  "programacion",
];

const WORD = /[a-z0-9áéíóúñü]/;

/** NFC first, so an accent typed as a separate combining mark ("a" + U+0301) matches the composed cue ("á"). */
function normalize(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, " ");
}

/** Start offsets of each whole-word occurrence of `phrase`. */
function occurrences(text: string, phrase: string): number[] {
  const found: number[] = [];
  let from = 0;
  while (from <= text.length - phrase.length) {
    const index = text.indexOf(phrase, from);
    if (index === -1) break;
    const before = index === 0 ? "" : text[index - 1];
    const after = text[index + phrase.length] ?? "";
    if (!WORD.test(before) && !WORD.test(after)) found.push(index);
    from = index + 1;
  }
  return found;
}

function hasCue(text: string, cues: readonly string[]): boolean {
  return cues.some((cue) => occurrences(text, cue).length > 0);
}

/** A conjunction only means two shopping tasks when it appears between a laptop and charger cue. */
function asksForBothProducts(text: string): boolean {
  const links = ["and", "but also", "but additionally", "plus", "as well as", "y", "pero", "además", "también", "tambien"];
  for (const laptopCue of LAPTOP_CUES) {
    for (const laptopAt of occurrences(text, laptopCue)) {
      for (const chargerCue of CHARGER_CUES) {
        for (const chargerAt of occurrences(text, chargerCue)) {
          const start = Math.min(laptopAt + laptopCue.length, chargerAt + chargerCue.length);
          const end = Math.max(laptopAt, chargerAt);
          if (end < start || end - start > 100) continue;
          const between = text.slice(start, end);
          if (links.some((link) => occurrences(between, link).length > 0)) return true;
        }
      }
    }
  }
  return false;
}

/** The text with every charger phrase blanked, so the "adapter" inside "power adapter" does not count as bare. */
function withoutChargerPhrases(text: string): string {
  let rest = text;
  for (const cue of CHARGER_CUES) {
    for (const index of occurrences(rest, cue)) rest = rest.slice(0, index) + " ".repeat(cue.length) + rest.slice(index + cue.length);
  }
  return rest;
}

/** Identifier-shaped tokens such as Mac14,2, not glued to other letters, digits or commas. */
const IDENTIFIER = /(?<![A-Za-z0-9,])[A-Za-z]+[0-9]+,[0-9]+(?![A-Za-z0-9]|,[0-9])/g;

function exactDeviceIn(text: string): DeviceId | null {
  const found = new Set<DeviceId>();
  for (const match of text.matchAll(IDENTIFIER)) {
    const selection = selectDevice(EVIDENCE, { identifier: match[0] });
    if (selection.kind === "identified") found.add(selection.device);
  }
  return found.size === 1 ? [...found][0] : null;
}

export function isChargerModelDescription(text: string): boolean {
 const value=normalize(text).trim();
 return /^(?:my (?:laptop|computer|macbook) is|mi (?:portátil|portatil|computadora|macbook) es|i have|tengo) (?:a |un |una )?macbook(?: pro| air)?\b/.test(value)
  && !/\b(?:buy|purchase|shopping|want|need|comprar|quiero|necesito)\b/.test(value);
}

export function classifyChargerText(text: string): ChargerTextReading {
  const normalized = normalize(text);
  const charger = hasCue(normalized, CHARGER_CUES);
  const laptop = hasCue(normalized, LAPTOP_CUES);
  const bothProducts = charger && laptop && asksForBothProducts(normalized);
  const adapter = hasCue(withoutChargerPhrases(normalized), ADAPTER_CUES);
  const kind: ChargerTextKind = bothProducts
    ? "mixed"
    : charger
      ? "charger"
      : laptop
        ? adapter
          ? "mixed"
          : "laptop"
        : adapter
          ? "ambiguous_adapter"
          : "none";
  return { kind, exactDevice: exactDeviceIn(text), ...(isChargerModelDescription(text) ? {modelDescription:true as const} : {}) };
}
