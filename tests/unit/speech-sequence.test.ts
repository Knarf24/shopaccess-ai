import { afterEach, describe, expect, it, vi } from "vitest";
import { speakInSequence } from "@/lib/voice/speech-sequence";
afterEach(()=>vi.useRealTimers());
describe("spoken option pauses",()=>{
 it("reads every paragraph in order, pauses between them and completes only after the last one",()=>{
  vi.useFakeTimers();const spoken:string[]=[];const ended:(()=>void)[]=[];const done=vi.fn();const progress=vi.fn();
  speakInSequence({progress,text:"Option one: Laptop A.\n\nOption two: Laptop B.\n\nOption three: Laptop C.",speak:(text,end)=>{spoken.push(text);ended.push(end);return ()=>{};},done,failed:vi.fn()});
  expect(spoken).toEqual(["Option one: Laptop A."]);ended[0]();vi.advanceTimersByTime(499);expect(spoken).toHaveLength(1);
  vi.advanceTimersByTime(1);expect(spoken[1]).toContain("Option two");ended[1]();vi.advanceTimersByTime(500);expect(spoken[2]).toContain("Option three");
  expect(progress.mock.calls.map(call=>call[0])).toEqual(spoken);
  expect(done).not.toHaveBeenCalled();ended[2]();expect(done).toHaveBeenCalledTimes(1);
 });
 it("stops queued paragraphs and ignores late end callbacks after cancellation",()=>{
  vi.useFakeTimers();let end=()=>{};const spoken:string[]=[];const done=vi.fn();const cancel=vi.fn();
  const stop=speakInSequence({text:"First.\n\nSecond.",speak:(text,ended)=>{spoken.push(text);end=ended;return cancel;},done,failed:vi.fn()});
  end();stop();vi.advanceTimersByTime(1000);end();expect(spoken).toEqual(["First."]);expect(done).not.toHaveBeenCalled();
 });
});
