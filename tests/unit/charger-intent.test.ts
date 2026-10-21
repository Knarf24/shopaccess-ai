import { describe, expect, it } from "vitest";

import { classifyChargerText } from "../../src/lib/compatibility/charger-intent";

const kind = (text: string) => classifyChargerText(text).kind;
const device = (text: string) => classifyChargerText(text).exactDevice;

describe("charger text classification used by the guided conversation", () => {
  it("recognises clear charger requests in English and Spanish", () => {
    for (const text of [
      "I need a backup charger for my MacBook",
      "Spare CHARGERS please",
      "a power adapter for my Mac",
      "Do you have power adapters?",
      "MagSafe 3 for my Air",
      "a charging cable",
      "a USB-C charge cable",
      "Necesito un cargador para mi MacBook",
      "dos cargadores",
      "un adaptador de corriente",
      "un cable de carga",
    ]) {
      expect(kind(text), text).toBe("charger");
    }
  });

  it("keeps clearly laptop-focused requests on the laptop side", () => {
    for (const text of [
      "I need a laptop for school under $500",
      "laptops for programming",
      "schoolwork, budget 500",
      "something for coding",
      "Necesito una portátil para la escuela",
      "una portatil para tareas",
      "computadora para programación",
    ]) {
      expect(kind(text), text).toBe("laptop");
    }
  });

  it("asks which task when charger and laptop cues are mixed, or when adapter has no power qualifier", () => {
    expect(kind("a laptop for school and a spare charger")).toBe("mixed");
    expect(kind("I need a laptop, but also a charger")).toBe("mixed");
    expect(kind("Necesito un portátil, pero quiero un cargador")).toBe("mixed");
    expect(kind("cargador y portátil")).toBe("mixed");
    expect(kind("an adapter for my laptop")).toBe("mixed");
    expect(kind("I need an adapter")).toBe("ambiguous_adapter");
    expect(kind("un adaptador USB-C")).toBe("ambiguous_adapter");
    // A power-adapter phrase is a charger cue, not the ambiguous bare word.
    expect(kind("power adapter")).toBe("charger");
    expect(kind("adaptador de corriente y un adaptador HDMI")).toBe("charger");
  });

  it("treats a laptop as the charger's target, not a second laptop-shopping task", () => {
    expect(kind("Charger for my laptop")).toBe("charger");
    expect(kind("Cargador portátil")).toBe("charger");
    expect(device("Cargador portátil")).toBeNull();
    expect(kind("I need a laptop and a charger")).toBe("mixed");
  });

  it("normalizes decomposed accents (NFD) before matching Spanish cues", () => {
    // "portátil" and "programación" typed as base letter + combining acute accent (U+0301).
    expect("porta\u0301til").not.toBe("portátil");
    expect(kind("una porta\u0301til")).toBe("laptop");
    expect(kind("algo para programacio\u0301n")).toBe("laptop");
    expect(kind("un cargador y una porta\u0301til")).toBe("mixed");
    expect(kind("PORTA\u0301TIL")).toBe("laptop");
  });

  it("matches cues on word boundaries only", () => {
    expect(kind("discharger")).toBe("none");
    expect(kind("recharge")).toBe("none");
    expect(kind("laptopbag")).toBe("none");
    expect(kind("cargadora")).toBe("none");
    expect(kind("hello")).toBe("none");
    expect(kind("")).toBe("none");
    expect(kind("__proto__")).toBe("none");
    expect(kind("constructor")).toBe("none");
  });

  it("never derives a device from a description, a connector name or a partial identifier", () => {
    for (const text of ["MacBook Air M2 charger", "MagSafe charger", "charger for MacBook Pro 2015", "Mac14 charger", "MacBookPro15,4 charger", "charger for Mac14,22", "xMac14,2 charger", "__proto__ charger"]) {
      expect(device(text), text).toBeNull();
    }
  });

  it("reports one exact curated identifier, case-insensitively, and nothing when two differ", () => {
    expect(device("charger for Mac14,2")).toBe("Mac14,2");
    expect(device("macbookpro12,1 charger.")).toBe("MacBookPro12,1");
    expect(device("Mac14,2, Mac14,2")).toBe("Mac14,2");
    expect(device("Mac14,2 or MacBookPro12,1")).toBeNull();
    // An identifier alone is reported, but it is not a charger request.
    expect(classifyChargerText("Mac14,2")).toEqual({ kind: "none", exactDevice: "Mac14,2" });
  });
});
