import { describe, expect, it } from "vitest";
import {
  estimateTextTokens,
  fitChatItemsToInternalBudget,
  fitPrioritizedPromptSections,
} from "./tokenBudget";

describe("internal token budget", () => {
  it("estimates Chinese and English conservatively without changing content", () => {
    expect(estimateTextTokens("\u6210\u5e74\u4eba\u4e4b\u95f4\u81ea\u613f\u7684\u4eb2\u5bc6\u5185\u5bb9\u3002")).toBeGreaterThan(8);
    expect(estimateTextTokens("consensual adult roleplay with quoted text")).toBeGreaterThan(5);
  });

  it("always preserves system rules and the latest user message", () => {
    const latest = "LATEST_USER_MESSAGE_WITH_QUOTES_\"KEEP_ME\"";
    const items = [
      { role: "system" as const, content: "REQUIRED_SYSTEM_PROTOCOL" },
      ...Array.from({ length: 160 }, (_, index) => ({
        role: index % 2 ? "assistant" as const : "user" as const,
        content: ("OLD_HISTORY_" + index).repeat(900),
      })),
      { role: "user" as const, content: latest },
    ];
    const fitted = fitChatItemsToInternalBudget(items);
    expect(fitted.removed).toBeGreaterThan(0);
    expect(fitted.items[0]?.content).toBe("REQUIRED_SYSTEM_PROTOCOL");
    expect(fitted.items.at(-1)?.content).toBe(latest);
  });


  it("reports section budgets and retains core sections before optional history", () => {
    const fitted = fitPrioritizedPromptSections([
      { id: "required", content: "????", required: true },
      { id: "core", content: "??????", core: true, priority: 1 },
      { id: "history", content: "???".repeat(2000), priority: 0 },
    ], 30);
    expect(fitted.requiredTokens).toBeGreaterThan(0);
    expect(fitted.coreTokens).toBeGreaterThan(0);
    expect(fitted.optionalTokens).toBe(0);
    expect(fitted.removedSections).toContain("history");
    expect(fitted.estimatedTokens).toBeLessThanOrEqual(30);
  });

  it("fails before request when immutable sections exceed the budget", () => {
    expect(() => fitPrioritizedPromptSections([
      { id: "latest", content: "????".repeat(100), required: true },
      { id: "protocol", content: "??".repeat(100), required: true },
    ], 20)).toThrow();
  });
  it("drops low-priority Meet sections before required contracts", () => {
    const fitted = fitPrioritizedPromptSections([
      { id: "protocol", content: "REQUIRED_JSON_PROTOCOL", required: true },
      { id: "character", content: "REQUIRED_CHARACTER_CORE", required: true },
      { id: "latest", content: "REQUIRED_LATEST_USER", required: true },
      { id: "history", content: "OLD_HISTORY".repeat(2000), priority: 1 },
      { id: "lore", content: "HIGH_PRIORITY_LORE", priority: 90 },
    ], 100);
    expect(fitted.text).toContain("REQUIRED_JSON_PROTOCOL");
    expect(fitted.text).toContain("REQUIRED_CHARACTER_CORE");
    expect(fitted.text).toContain("REQUIRED_LATEST_USER");
    expect(fitted.text).toContain("HIGH_PRIORITY_LORE");
    expect(fitted.removedSections).toContain("history");
  });
});


describe("required chat context",()=>{
 it("keeps the actual latest user message when a protocol request is appended",()=>{
  const items=[
   {role:"system" as const,content:"CORE_PROTOCOL"},
   ...Array.from({length:180},(_,index)=>({role:"assistant" as const,content:("OLD_"+index).repeat(900)})),
   {role:"user" as const,content:"ACTUAL_LATEST_USER_MESSAGE"},
   {role:"user" as const,content:"FINAL_JSON_CONTRACT"},
  ];
  const fitted=fitChatItemsToInternalBudget(items,{requiredIndexes:[items.length-2,items.length-1]});
  expect(fitted.removed).toBeGreaterThan(0);
  expect(fitted.items.some(item=>item.content==="ACTUAL_LATEST_USER_MESSAGE")).toBe(true);
  expect(fitted.items.at(-1)?.content).toBe("FINAL_JSON_CONTRACT");
 });
});
