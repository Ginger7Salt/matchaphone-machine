import {describe,expect,it} from "vitest";
import {changeLoreImportMode,evaluateLore,groupLoreByInsertion,loreInsertionPositionOf,parseLoreImport,uniqueLoreName} from "./lore";

describe("lore import",()=>{
  it("imports a multi-paragraph TXT document as one entry by default",()=>{const preview=parseLoreImport("月港\n关键词：月亮, 海风\n这里是月港。\n\n第二段仍属于同一文档。","城市.txt");expect(preview.format).toBe("txt");expect(preview.mode).toBe("single");expect(preview.books[0].name).toBe("城市");expect(preview.books[0].entries).toHaveLength(1);expect(preview.books[0].entries[0].keywords).toEqual(["月亮","海风"]);expect(preview.books[0].entries[0].content).toContain("第二段")});
  it("only splits explicit headings when selected",()=>{const base=parseLoreImport("# 月港\n这里是月港。\n\n普通段落继续。\n# 山城\n这里是山城。","城市.txt");const preview=changeLoreImportMode(base,"headings");expect(preview.books[0].entries).toHaveLength(2);expect(preview.books[0].entries.map(entry=>entry.title)).toEqual(["月港","山城"]);expect(preview.books[0].entries[0].content).toContain("普通段落继续")});
  it("falls back to one entry when no explicit headings exist",()=>{const preview=changeLoreImportMode(parseLoreImport("第一句。\n\n第二句。","普通.txt"),"headings");expect(preview.books[0].entries).toHaveLength(1);expect(preview.warnings.join(" ")).toContain("没有识别到明确标题")});
  it("rejects JSON world books",()=>{expect(()=>parseLoreImport(JSON.stringify({name:"雾港",entries:{}}),"雾港.json")).toThrow("不支持 JSON 世界书")});
  it("parses extracted DOCX text as one entry",()=>{const preview=parseLoreImport("天气\n关键词：雾\n夜间有雾","雾港.docx");expect(preview.format).toBe("docx");expect(preview.books[0].description).toBe("从 DOCX 导入");expect(preview.books[0].entries).toHaveLength(1);expect(preview.books[0].entries[0].keywords).toEqual(["雾"])});
  it("keeps names unique",()=>expect(uniqueLoreName("雾港",["雾港","雾港 (2)"])).toBe("雾港 (3)"));
});

describe("lore insertion",()=>{
 const entry=(position?:any)=>({id:"e",title:"x",keywords:[],constant:true,secondaryKeywords:[],secondaryLogic:"and" as const,probability:100,content:"content",priority:50,enabled:true,scope:{type:"global" as const},insertionPosition:position,createdAt:1,updatedAt:1});
 it("keeps old entries at after-character",()=>expect(loreInsertionPositionOf(entry())).toBe("after-character"));
 it("groups decisions by insertion",()=>{const decision={...entry("before-user"),bookId:"b",bookName:"B",matched:true,injected:true,estimatedChars:7,usedBudget:7,remainingBudget:10};expect(groupLoreByInsertion([decision])["before-user"]).toHaveLength(1)});
});


describe("global lore budget", () => {
  const makeBook = (id: string, priority: number, content: string) => ({
    id,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    name: id,
    description: "",
    enabled: true,
    entries: [{
      id: id + "-entry",
      title: id,
      keywords: [],
      constant: true,
      content,
      priority,
      enabled: true,
      scope: { type: "global" as const },
    }],
  });

  it("shares one budget across multiple books and keeps higher priority content", () => {
    const high = makeBook("high", 100, "H".repeat(7));
    const low = makeBook("low", 1, "L".repeat(7));
    const result = evaluateLore({
      books: [low, high],
      texts: ["anything"],
      characterId: "char",
      conversationId: "conversation",
      budget: 10,
    });
    expect(result.find((item) => item.bookId === "high")?.injected).toBe(true);
    expect(result.find((item) => item.bookId === "low")?.reason).toBe("\u6ce8\u5165\u9884\u7b97\u4e0d\u8db3");
    expect(low.entries[0].content).toBe("L".repeat(7));
  });
});


describe("unlimited lore source storage",()=>{
 it("keeps a very long TXT entry intact",()=>{const body="start-"+"x".repeat(120000)+"-end",preview=parseLoreImport("Long lore\n"+body,"long.txt"),content=preview.books[0].entries[0].content;expect(content).toContain("start-");expect(content.endsWith("-end")).toBe(true);expect(content.length).toBeGreaterThanOrEqual(body.length)});
 it("never mutates oversized source content when runtime budget skips it",()=>{const source="z".repeat(10000),book=makeBookForLongSource(source),result=evaluateLore({books:[book],texts:["anything"],characterId:"char",conversationId:"conversation",budget:100});expect(result[0].injected).toBe(false);expect(result[0].reason).toBe("\u6ce8\u5165\u9884\u7b97\u4e0d\u8db3");expect(book.entries[0].content).toBe(source)});
});
function makeBookForLongSource(content:string){return{id:"long",schemaVersion:1,createdAt:1,updatedAt:1,name:"long",description:"",enabled:true,entries:[{id:"long-entry",title:"long",keywords:[],constant:true,content,priority:100,enabled:true,scope:{type:"global" as const}}]}}
