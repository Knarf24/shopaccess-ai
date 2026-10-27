import {describe,it,expect} from "vitest";
import {clearAcknowledgedVoiceDraft} from "@/lib/voice/draft";
describe("acknowledged voice draft",()=>{
 it("clears only the exact voice transcript while it is still protected from editing",()=>{
  const field={value:"I need a laptop",readOnly:true};clearAcknowledgedVoiceDraft(field,"I need a laptop");expect(field.value).toBe("");
 });
 it("preserves a different or editable typed draft, and fields without a sent transcript",()=>{
  for(const [value,readOnly,sent] of [["My typed correction",true,"I need a laptop"],["I need a laptop",false,"I need a laptop"],["1000",true,null]] as const){
   const field={value,readOnly};clearAcknowledgedVoiceDraft(field,sent);expect(field.value).toBe(value);
  }
 });
});
