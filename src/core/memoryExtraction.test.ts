import {beforeEach,describe,expect,it} from "vitest";
import {confirmBatch,createExtractionBatch,isDuplicateMemory,memoryExtractionSettingsOf,pendingCount,transcript,validMemoryExtractionSettings,validateMemoryCandidates} from "./memoryExtraction";
import {db} from "./db";
import {defaultProvider,type Character,type Memory,type MemoryExtractionBatch,type Message} from "./types";

const character={id:"c",name:"月白",memoryExtractionSettings:{mode:"auto",chatThreshold:20,feedThreshold:30}} as Character;

describe("memory extraction",()=>{
 it("validates, trims and caps candidates",()=>{
  const got=validateMemoryCandidates({candidates:[{kind:"fact",content:" 喜欢雨天 ",importance:9},{kind:"plot",content:" ",importance:1}]});
  expect(got).toHaveLength(1);
  expect(got[0]).toMatchObject({content:"喜欢雨天",importance:9,selected:true});
 });
 it("renders speaker names",()=>{
  const messages=[{senderType:"user",content:"你好",status:"complete"},{senderType:"character",senderId:"c",content:"晚上好",status:"complete"}] as Message[];
  expect(transcript(messages,[{id:"c",name:"月白"} as Character])).toContain("月白：晚上好");const textImage=[{senderType:"character",senderId:"c",content:"",status:"complete",createdAt:2,attachments:[{type:"text-image",description:"雨夜的街道",intent:"scenery",characterId:"c",generationEventId:"e",createdAt:2}]}] as Message[];expect(transcript(textImage,[{id:"c",name:"月白"} as Character])).toContain("文字图片：雨夜的街道");
 });
 it("detects exact normalized duplicates",()=>{
  const memories=[{characterId:"c",conversationId:"v",kind:"fact",content:"喜欢雨天"} as Memory];
  expect(isDuplicateMemory({kind:"fact",content:" 喜欢雨天 "},memories,"c","v")).toBe(true);
 });
 it("validates automatic mode with only the chat threshold",()=>{
  expect(validMemoryExtractionSettings({mode:"auto",chatThreshold:10})).toBe(true);
  expect(validMemoryExtractionSettings({mode:"auto",chatThreshold:9,feedThreshold:100})).toBe(false);expect(validMemoryExtractionSettings({mode:"auto",chatThreshold:30,maxMemoriesPerBatch:13})).toBe(false);
  expect(memoryExtractionSettingsOf(character)).toEqual({enabled:true,mode:"auto",chatThreshold:20,maxMemoriesPerBatch:8,includeSummary:true,autoSaveHighConfidence:true,meetMemoryEnabled:true});
 });
});

describe("feed exclusion from memory extraction",()=>{
 beforeEach(async()=>{await db.delete();await db.open()});
 it("reports no pending feed content and rejects feed batches before calling a model",async()=>{
  await db.feedPosts.add({id:"post",authorId:"c",content:"不应进入记忆",comments:[],createdAt:1,updatedAt:1} as any);
  expect(await pendingCount(character,"feed")).toBe(0);
  await expect(createExtractionBatch({...defaultProvider, networkMode: "direct" as const,apiKey:"unused"},character,"feed")).rejects.toThrow("动态内容不参与记忆整理");
  expect(await db.memoryExtractionBatches.count()).toBe(0);
 });
 it("does not confirm a legacy pending feed batch",async()=>{
  const legacy={id:"feed-batch",characterId:"c",source:"feed",sourceIds:["post"],cursorKey:"c:feed:all",status:"pending",candidates:[{id:"candidate",kind:"fact",content:"旧动态候选",importance:3,selected:true,locked:false}],createdAt:1,updatedAt:1} as MemoryExtractionBatch;
  await db.memoryExtractionBatches.add(legacy);
  await confirmBatch(legacy.id,legacy.candidates);
  expect(await db.memories.count()).toBe(0);
  expect((await db.memoryExtractionBatches.get(legacy.id))?.status).toBe("pending");
  expect(await db.memoryExtractionCursors.get("c:feed:all")).toBeUndefined();
 });
});