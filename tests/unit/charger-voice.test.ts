import { describe, expect, it } from "vitest";
import { chargerVoiceAction, chargerVoiceGuidance, isJourneyPost } from "@/lib/voice/journey";
const track={state:"confirmed" as const,deviceId:"Mac14,2",deviceName:"MacBook Air (M2, 2022)",budgetEnabled:true,proposedCents:null,confirmedCents:null,purchasable:false,permitted:false};
describe("charger voice continuation",()=>{
 it("accepts exact model names without guessing vague MacBooks",()=>{
  expect(chargerVoiceAction("My model is MacBook Air M2 2022","awaiting_model")).toEqual({action:"choose_model",value:"Mac14,2"});
  for(const text of ["MacBook Air","MacBook Pro 2019","not MacBook Air M2 2022","MacBook Air M2 2022 and buy it"])expect(chargerVoiceAction(text,"awaiting_model")).toBeNull();
 });
 it("requires separate exact model and budget confirmations in the right state",()=>{
  expect(chargerVoiceAction("confirm my device","candidate")).toEqual({action:"confirm"});
  expect(chargerVoiceAction("confirm my device","awaiting_model")).toBeNull();
  expect(chargerVoiceAction("my charger budget is 60 dollars","confirmed")).toEqual({action:"propose_budget",value:"60"});
  expect(chargerVoiceAction("mi presupuesto es 59 dólares","confirmed")).toEqual({action:"propose_budget",value:"59"});
  expect(chargerVoiceAction("confirm my charger budget","confirmed")).toEqual({action:"confirm_budget"});
  for(const text of ["buy it","save purchase permission","confirm my choices","my budget is -60","my budget is 60 and buy it"])expect(chargerVoiceAction(text,"confirmed")).toBeNull();
 });
 it("gives one next action from saved charger state and retains the cable requirement",()=>{
  expect(chargerVoiceGuidance({...track,state:"awaiting_model"},"en")).toContain("exact");
  expect(chargerVoiceGuidance({...track,state:"candidate"},"en")).toContain("confirm my device");
  expect(chargerVoiceGuidance(track,"en")).toContain("charger budget");
  expect(chargerVoiceGuidance({...track,proposedCents:6000},"en")).toContain("60.00");
  expect(chargerVoiceGuidance({...track,confirmedCents:5000},"en")).toContain("No recommended adapter");
  expect(chargerVoiceGuidance({...track,deviceId:"MacBookPro12,1",confirmedCents:6000},"en")).toContain("unknown");
  const ready=chargerVoiceGuidance({...track,purchasable:true,confirmedCents:6000},"en");
  expect(ready).toContain("59.00");expect(ready).toContain("Cable sold separately");expect(ready).toContain("choose option one");
  expect(chargerVoiceGuidance({...track,budgetEnabled:false},"en")).toContain("information only");
 });
 it("allows only the existing protected charger control endpoint",()=>{
  expect(isJourneyPost("/shop/needs/charger-control")).toBe(true);
  expect(isJourneyPost("/shop/needs/charger-control/admin")).toBe(false);
 });
});
