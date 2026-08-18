import {db} from "./db";
import {now,type Memory,type MemoryState} from "./types";

export interface MemorySelectionOptions {
  maxItems?: number;
  maxTokens?: number;
  query?: string;
  mode?: "chat" | "group" | "meet";
}

export function memoryContentHash(value:string){let h=2166136261;for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,16777619)}return(h>>>0).toString(16)}
const clamp=(value:number,min=0,max=1)=>Math.max(min,Math.min(max,value));
const normalizeText=(value:string)=>value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu,"");
const tokens=(value:string)=>{const normalized=value.toLowerCase(),words=normalized.match(/[\p{L}\p{N}]{2,}/gu)??[],compact=normalizeText(value),grams=Array.from({length:Math.max(0,compact.length-1)},(_,index)=>compact.slice(index,index+2));return new Set([...words,...grams])};
export function lexicalMemorySimilarity(a:string,b:string){const A=tokens(a),B=tokens(b);if(!A.size||!B.size)return 0;let common=0;for(const item of A)if(B.has(item))common++;return common/(A.size+B.size-common||1)}
export function estimateMemoryEmotion(text:string){const positive=["喜欢","开心","爱","谢谢","幸福","期待","信任","温柔","支持","高兴","赞","好耶"],negative=["讨厌","难过","生气","害怕","失望","痛苦","焦虑","对不起","哭","烦","恨"],intense=["非常","特别","真的","永远","绝对","太","！","!","？","?","崩溃","激动"];let valence=.5;for(const word of positive)if(text.includes(word))valence+=.08;for(const word of negative)if(text.includes(word))valence-=.1;let arousal=.15;for(const word of intense)if(text.includes(word))arousal+=.1;arousal+=Math.min(.25,(text.match(/[!?！？]/g)?.length??0)*.04);return{valence:clamp(valence),arousal:clamp(arousal)}}
export function normalizedMemory(memory:Memory):Memory{return{...memory,sourceType:memory.sourceType??(memory.source==="用户手动记录"?"manual":"chat"),sourceIds:memory.sourceIds??[],sourceSnapshot:memory.sourceSnapshot??memory.content,occurredAt:memory.occurredAt??memory.createdAt,topics:memory.topics??[],entities:memory.entities??[],importance:memory.importance<=5?memory.importance*2:clamp(memory.importance,1,10),confidence:memory.confidence??.8,valence:memory.valence??.5,arousal:memory.arousal??.2,activationCount:memory.activationCount??0,reinforcementCount:memory.reinforcementCount??0,state:memory.state??"active",digested:memory.digested??memory.kind==="summary",contentHash:memory.contentHash??memoryContentHash(memory.content)}}
export function memoryStrength(input:Memory,at=now()){const memory=normalizedMemory(input);if(memory.locked)return 1;const ageHours=Math.max(0,at-(memory.occurredAt??memory.createdAt))/3_600_000,timeWeight=1+Math.exp(-ageHours/36),emotionWeight=1+(memory.arousal??.2)*.8,combined=ageHours<=72?.7*timeWeight+.3*emotionWeight:.3*timeWeight+.7*emotionWeight,importance=(memory.importance/10)*.32,activation=Math.min(.24,Math.log1p((memory.activationCount??0)+(memory.reinforcementCount??0)*2)*.06),base=combined/2*.44+importance+activation,penalty=(memory.resolved?.82:1)*(memory.digested?.9:1);return clamp(base*penalty)}
export function memoryStateAt(memory:Memory,at=now()):MemoryState{if(memory.locked)return"active";const score=memoryStrength(memory,at);if(score>=.55)return"active";if(score>=.3)return"faded";const since=memory.archivedCandidateAt??memory.updatedAt;return at-since>=7*24*60*60*1000?"archived":"faded"}
export function memoryTimeBand(memory:Memory,at=now()){const days=Math.max(0,at-(memory.occurredAt??memory.createdAt))/86_400_000;return days<=3?"3 天内":days<=14?"4–14 天":days<=90?"15–90 天":"90 天以上"}
export function memoryEmotionBand(memory:Memory){const positive=(memory.valence??.5)>=.5,intense=(memory.arousal??.2)>=.5;return`${positive?"积极":"消极"}${intense?"强烈":"平静"}`}
export function estimateMemoryTokens(memory:Memory){
  const text=[memory.title,memory.content,memory.meaning].filter(Boolean).join("\n");
  let count=0,asciiRun=0;
  const flush=()=>{if(asciiRun){count+=Math.ceil(asciiRun/3.5);asciiRun=0}};
  for(const char of text){if(/^[\x00-\x7F]$/.test(char))asciiRun+=1;else{flush();if(!/\s/.test(char))count+=1}}
  flush();
  return Math.max(1,count+6);
}

function normalizedMemorySelectionOptions(limit:number,query:string,options?:MemorySelectionOptions){
  return{
    maxItems:Math.max(1,Math.trunc(options?.maxItems??limit)),
    maxTokens:options?.maxTokens===undefined?undefined:Math.max(1,Math.trunc(options.maxTokens)),
    query:options?.query??query,
    mode:options?.mode??"chat",
  };
}

export function selectMemories(items:Memory[],characterId:string,conversationId:string,limit=12,query="",enabled=true,options?:MemorySelectionOptions){
  if(!enabled)return[];
  const selection=normalizedMemorySelectionOptions(limit,query,options),search=selection.query.trim();
  const eligible=items.filter(item=>item.characterId===characterId&&(!item.conversationId||item.conversationId===conversationId)&&!item.dontSurface).map(normalizedMemory);
  const seenHashes=new Set<string>(),deduped=eligible.filter(memory=>{
    const hash=memory.contentHash??memoryContentHash(memory.content);
    if(seenHashes.has(hash))return false;
    seenHashes.add(hash);
    return true;
  });
  const emotion=estimateMemoryEmotion(search);
  const scored=deduped.map(memory=>{
    const state=memoryStateAt(memory),text=[memory.title,memory.content,memory.meaning,...(memory.topics??[]),...(memory.entities??[])].filter(Boolean).join(" "),semantic=search?lexicalMemorySimilarity(search,text):0,emotionScore=1-Math.hypot((memory.valence??.5)-emotion.valence,(memory.arousal??.2)-emotion.arousal)/Math.SQRT2,timeScore=Math.exp(-Math.max(0,now()-(memory.occurredAt??memory.createdAt))/86_400_000/30),importance=memory.importance/10,strength=memoryStrength(memory),relationshipBoost=memory.kind==="relationship"?.25:0,unresolvedBoost=memory.resolved?0:.3,score=Number(memory.locked)*3+semantic*4+emotionScore*2+timeScore*1.5+importance+strength*2+(memory.reinforcementCount??0)*.05+relationshipBoost+unresolvedBoost-(state==="archived"&&search&&semantic<.35?4:0);
    return{memory:{...memory,state},score,semantic};
  }).sort((a,b)=>b.score-a.score||b.memory.updatedAt-a.memory.updatedAt);
  const chosen:Memory[]=[],topicCount=new Map<string,number>(),sourceIds=new Set<string>();
  let usedTokens=0;
  for(const row of scored){
    if(chosen.length>=selection.maxItems)break;
    if(row.memory.state==="archived"&&search&&row.semantic<.35&&!row.memory.locked)continue;
    const topic=row.memory.topics?.[0]??row.memory.kind,topicHits=topicCount.get(topic)??0;
    if(search&&topicHits>=2&&!row.memory.locked)continue;
    const sourceOverlap=(row.memory.sourceIds??[]).some(id=>sourceIds.has(id));
    if(sourceOverlap&&!row.memory.locked)continue;
    const cost=estimateMemoryTokens(row.memory);
    if(selection.maxTokens!==undefined&&usedTokens>0&&usedTokens+cost>selection.maxTokens)continue;
    topicCount.set(topic,topicHits+1);
    for(const id of row.memory.sourceIds??[])sourceIds.add(id);
    usedTokens+=cost;
    chosen.push(row.memory);
  }
  return chosen;
}
export async function recordMemoryAccess(ids:string[],eventId:string){const unique=[...new Set(ids)];for(const id of unique){const memory=await db.memories.get(id);if(!memory||memory.lastActivationEventId===eventId)continue;await db.memories.update(id,{activationCount:(memory.activationCount??0)+1,lastAccessedAt:now(),lastActivationEventId:eventId,state:"active",updatedAt:now()})}}
export async function refreshMemoryStates(characterId?:string){const rows=characterId?await db.memories.where("characterId").equals(characterId).toArray():await db.memories.toArray();for(const row of rows){const state=memoryStateAt(row),strength=memoryStrength(row);if(state===row.state)continue;await db.memories.update(row.id,{state,archivedCandidateAt:strength<.3?(row.archivedCandidateAt??now()):undefined,updatedAt:now()})}}
