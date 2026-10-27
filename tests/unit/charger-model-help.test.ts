import {expect,it} from "vitest";
import {chargerModelHelp} from "@/lib/i18n/charger-copy";
import {assistantText} from "@/components/mock-journey/NeedsConversation";
import {journeyCopy} from "@/lib/i18n/demo-copy";
import {chargerVoiceGuidance} from "@/lib/voice/journey";
it("explains how to find an unknown model without guessing compatibility",()=>{
 const text="I don't know the model and can you suggest anything for me";
 const help=chargerModelHelp(text,"en")!;
 expect(help).toContain("About This Mac");expect(help).toContain("Do not share the serial number");
 expect(assistantText("charger_model",journeyCopy("en"),"en",text)).toBe(help);
 expect(chargerVoiceGuidance({state:"awaiting_model",deviceId:null,deviceName:null,budgetEnabled:true,proposedCents:null,confirmedCents:null,purchasable:false,permitted:false,modelHelp:help},"en")).toBe(help);
 expect(chargerModelHelp("No sé el modelo","es")).toContain("Acerca de esta Mac");
});
it("explains an unmatched model description and preserves the ordinary model question",()=>{
 expect(chargerModelHelp("My laptop is a MacBook Pro, 16-inch, 2019.","en")).toContain("96W");
 expect(assistantText("charger_model",journeyCopy("en"),"en","I need a charger")).toContain("Which exact Mac model");
 expect(chargerModelHelp("I need a charger for my MacBook Pro, 16-inch, 2019.","en")).toContain("96W");
 expect(chargerModelHelp("My laptop is a MacBook Pro, 13-inch, 2019.","en")).toContain("could not match");
 expect(chargerModelHelp("I want to buy a laptop","en")).toBeNull();
});
