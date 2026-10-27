import {describe,it,expect} from "vitest";
import {selectVoiceOption,voiceOptionsSummary,isJourneyDestination,isJourneyPost,isPermissionsRequest,voicePageReply} from "@/lib/voice/journey";
import {checkoutVoiceGuidance} from "@/lib/voice/checkout-guidance";
const options=[{productId:"one",variantId:"v1",title:"Acer Aspire Go 15",priceCents:57999,description:"8 GB RAM",recommended:false},{productId:"two",variantId:"v2",title:"Acer Aspire 14 AI",priceCents:87999,description:"16 GB RAM",recommended:true}];
describe("voice shopping continuation",()=>{
 it("opens permissions for singular, combined and transcribed navigation phrases only",()=>{
  for(const text of ["open permissions","open manage purchase permissions","manage purchase permissions","open pictures permission","open pages permissions"])expect(isPermissionsRequest(text)).toBe(true);
  for(const text of ["do not open permissions","save permission","buy it","I need permission for my budget"])expect(isPermissionsRequest(text)).toBe(false);
 });
 it("never replaces a refusal with the retained selection reminder",()=>{
  expect(voicePageReply("Permission required", "options", "options", options[0],options,true,"en")).toBe("Permission required");
  expect(voicePageReply("Permission required", "options", "permissions", options[0],options,true,"en")).toBe("Permission required");
  expect(voicePageReply("Read options", "options", "options", options[0],options,false,"en")).toBe("Read options");
  expect(voicePageReply("Read options", "options", "permissions", options[0],options,false,"en")).toContain("Say review my selection");
 });
 it("selects only an unambiguous current option",()=>{
  expect(selectVoiceOption("choose option two",options)?.variantId).toBe("v2");
  expect(selectVoiceOption("elijo la opción uno",options)?.variantId).toBe("v1");
  expect(selectVoiceOption("choose Acer Aspire 14 AI",options)?.variantId).toBe("v2");
  for(const t of ["choose Acer","choose option nine","do not choose option two","choose option two and buy it"])expect(selectVoiceOption(t,options)).toBeNull();
 });
 it("reads every option's actual price and specs",()=>{
  const t=voiceOptionsSummary(options,"en");for(const part of ["579.99","879.99","8 GB RAM","16 GB RAM","Option two"])expect(t).toContain(part);
  expect(voiceOptionsSummary(options,"es")).toContain("Opción dos");
  expect(t).toContain("Which option would you like?");expect(t).not.toContain("Then say review");
 });
 it("rejects external, traversal and unrelated destinations and actions",()=>{
  expect(isJourneyDestination("/en/shop/permissions")).toBe(true);expect(isJourneyDestination("/es/checkout/ci_00000000000000000000000000000001")).toBe(true);
  for(const p of ["//evil.example/","https://evil.example/","/api/extension/v1/conversation","/en/shop/needs/../admin","/en/checkout/abc/confirm","/en/checkout/abc-123","/en/checkout/ci_123"])expect(isJourneyDestination(p)).toBe(false);
  expect(isJourneyPost("/checkout/start")).toBe(true);expect(isJourneyPost("/checkout/ci_00000000000000000000000000000001/simulate")).toBe(true);
  for(const p of ["/checkout/abc/approve","https://elsewhere/checkout/start","/checkout/abc/refund"])expect(isJourneyPost(p)).toBe(false);
 });
 it("announces success only from verified capture, retaining pending and declined distinctions",()=>{
  expect(checkoutVoiceGuidance("CAPTURED_VERIFIED","en",false,"Laptop",87999,false,null)).toContain("No money was charged");
  expect(checkoutVoiceGuidance("CAPTURED_VERIFIED","es",true,"Laptop",87999,false,null)).toContain("PayPal Sandbox");
  for(const s of ["CAPTURE_UNKNOWN","ORDER_CREATE_UNKNOWN","MANUAL_REVIEW","CAPTURE_PENDING_PROVIDER","CAPTURE_IN_FLIGHT","APPROVAL_CHECK_PENDING"])expect(checkoutVoiceGuidance(s,"en",false,"Laptop",87999,true,null)).toContain("do not pay again");
  expect(checkoutVoiceGuidance("DECLINED_RETRYABLE","en",false,"Laptop",87999,false,null)).toContain("not complete");
  expect(checkoutVoiceGuidance("CANCELED_LOCAL","en",false,"Laptop",87999,false,null)).toContain("canceled");
 });
 it("retains deliberate page approval and explains the external Sandbox handoff",()=>{
  expect(checkoutVoiceGuidance("QUOTED","en",false,"Laptop",87999,false,null)).toContain("Tick the acknowledgement");
  expect(checkoutVoiceGuidance("QUOTED","es",false,"Laptop",87999,true,null)).toContain("permiso");
  expect(checkoutVoiceGuidance("USER_CONFIRMED","en",true,"Laptop",87999,false,null)).toContain("enable voice again");
 });
});
