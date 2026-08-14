import {z} from "zod";
import {chatSettingsOf,coreSettingOf,languageStyleInstruction,personaOf} from "./character";
import {db,getAppSettings} from "./db";
import {recordCoupleIslandReward} from "./coupleIsland";
import {userPersonaContext} from "./userPersona";
import {OpenAIProvider,ProviderError,type ProviderChatInvoker} from "./provider";
import {clampRelationshipValue} from "./rules";
import {now,SCHEMA_VERSION,uid,type Character,type Message,type ProviderSettings} from "./types";
import type {ChatItem} from "./context";

const evaluationSchema=z.object({intimacyDelta:z.number().int().min(-4).max(3),trustDelta:z.number().int().min(-4).max(3),reason:z.string().trim().min(1).max(120)});
const confessionSchema=z.object({messages:z.array(z.string().trim().min(1).max(4000)).min(1)});
export type StrategyEvaluation=z.infer<typeof evaluationSchema>;
export type StrategyApplyResult={character:Character;changed:boolean;duplicate:boolean;shouldConfess:boolean;applied:{intimacyDelta:number;trustDelta:number;reason:string}};

const stripFence=(text:string)=>text.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"");
const parseJson=(text:string)=>{try{return JSON.parse(stripFence(text))}catch{throw new ProviderError("format","攻略模式评估没有返回有效 JSON")}};
const localDateKey=(time:number)=>{const d=new Date(time),y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0");return `${y}-${m}-${day}`};
export function validateStrategyEvaluation(value:unknown){return evaluationSchema.parse(value)}
export function validateConfessionMessages(value:unknown){return confessionSchema.parse(value).messages.map(item=>item.trim()).filter(Boolean).slice(0,12)}
export function applyStrategyEvaluation(character:Character,evaluation:StrategyEvaluation,sourceId:string,time=Date.now()):StrategyApplyResult{
 const relationship=character.relationship,evaluated=relationship.evaluatedSourceIds??[],duplicate=relationship.lastEvaluatedSourceId===sourceId||evaluated.includes(sourceId);
 if(duplicate)return{character,changed:false,duplicate:true,shouldConfess:false,applied:{...evaluation}};
 const date=localDateKey(time),daily=relationship.dailyProgress?.date===date?relationship.dailyProgress:{date,intimacyGain:0,trustGain:0};
 const intimacyDelta=evaluation.intimacyDelta>0?Math.min(evaluation.intimacyDelta,Math.max(0,6-daily.intimacyGain)):evaluation.intimacyDelta;
 const trustDelta=evaluation.trustDelta>0?Math.min(evaluation.trustDelta,Math.max(0,4-daily.trustGain)):evaluation.trustDelta;
 const intimacy=clampRelationshipValue(relationship.intimacy+intimacyDelta),trust=clampRelationshipValue(relationship.trust+trustDelta),actualIntimacy=intimacy-relationship.intimacy,actualTrust=trust-relationship.trust,changed=actualIntimacy!==0||actualTrust!==0;
 const parts=[actualIntimacy?`亲密度 ${actualIntimacy>0?"+":""}${actualIntimacy}`:"",actualTrust?`信任度 ${actualTrust>0?"+":""}${actualTrust}`:""].filter(Boolean),event=parts.length?`${parts.join("，")} · ${evaluation.reason}`:"";
 const updated:Character={...character,updatedAt:time,relationship:{...relationship,intimacy,trust,lastEvaluatedSourceId:sourceId,evaluatedSourceIds:[...evaluated.filter(id=>id!==sourceId),sourceId].slice(-32),dailyProgress:{date,intimacyGain:daily.intimacyGain+Math.max(0,actualIntimacy),trustGain:daily.trustGain+Math.max(0,actualTrust)},recentEvents:event?[event,...relationship.recentEvents].slice(0,8):relationship.recentEvents}};
 return{character:updated,changed,duplicate:false,shouldConfess:intimacy===100&&trust===100&&!relationship.confessionTriggeredAt,applied:{intimacyDelta:actualIntimacy,trustDelta:actualTrust,reason:evaluation.reason}};
}
function transcript(messages:Message[],characters:Character[]){return messages.filter(message=>message.status==="complete").slice(-12).map(message=>`${message.senderType==="user"?"用户":characters.find(item=>item.id===message.senderId)?.name??"角色"}：${message.content}`).join("\n")||"（暂无历史对话）"}
async function requestEvaluation(character:Character,userText:string,messages:Message[],characters:Character[],provider:ProviderSettings,signal?:AbortSignal,invokeProvider?:ProviderChatInvoker){
 const appSettings=await getAppSettings();
 const prompt=["你是虚构角色关系变化评估器。根据角色人设、当前关系和用户本轮表现，判断亲密度与信任度应如何变化。",`角色：${character.name}`,`核心设定：${coreSettingOf(character)}`,`人物设定：${personaOf(character)}`,userPersonaContext(appSettings),`当前亲密度：${character.relationship.intimacy}/100`,`当前信任度：${character.relationship.trust}/100`,`近期关系事件：${character.relationship.recentEvents.join("；")||"无"}`,`最近对话：\n${transcript(messages,characters)}`,`本轮用户内容：${userText}`,"规则：普通寒暄、重复内容和刷屏通常为0；真诚关心、理解、尊重边界和有意义经历可小幅增加；守信更偏向信任；冒犯、欺骗、操控、威胁和越界应降低；消息长度、礼物和转账金额本身不能换取好感。正向变化应克制，负向变化必须有明确依据。","只返回严格 JSON：{\"intimacyDelta\":-4到3的整数,\"trustDelta\":-4到3的整数,\"reason\":\"不超过120字的具体原因\"}"].join("\n\n");
 let last:unknown;
 const requestMessages:ChatItem[]=[{role:"system",content:"你只负责关系变化评估，只输出严格 JSON。"},{role:"user",content:prompt}];
 for(let attempt=0;attempt<(invokeProvider?1:2);attempt++)try{const raw=invokeProvider?(await invokeProvider(provider,requestMessages,{stream:false,signal,timeoutMs:null},"auxiliary")).text:await new OpenAIProvider(provider).chat(requestMessages,{stream:false,signal});return validateStrategyEvaluation(parseJson(raw))}catch(error){last=error;if(error instanceof ProviderError&&error.kind==="aborted")throw error}
 throw last;
}
export async function evaluateStrategyInteraction(input:{character:Character;sourceId:string;userText:string;messages:Message[];characters:Character[];provider:ProviderSettings;signal?:AbortSignal;invokeProvider?:ProviderChatInvoker}){
 const current=await db.characters.get(input.character.id)??input.character;
 if(!chatSettingsOf(current).strategyMode.enabled)return{character:current,changed:false,duplicate:false,shouldConfess:false,applied:{intimacyDelta:0,trustDelta:0,reason:"攻略模式未开启"}} satisfies StrategyApplyResult;
 if(current.relationship.lastEvaluatedSourceId===input.sourceId||current.relationship.evaluatedSourceIds?.includes(input.sourceId))return{character:current,changed:false,duplicate:true,shouldConfess:false,applied:{intimacyDelta:0,trustDelta:0,reason:"已评估"}} satisfies StrategyApplyResult;
 const evaluation=await requestEvaluation(current,input.userText,input.messages,input.characters,input.provider,input.signal,input.invokeProvider);
 let result=applyStrategyEvaluation(current,evaluation,input.sourceId);
 await db.transaction("rw",db.characters,async()=>{const latest=await db.characters.get(current.id)??current;result=applyStrategyEvaluation(latest,evaluation,input.sourceId);if(!result.duplicate)await db.characters.put(result.character)});
 return result;
}
export async function generateConfessionMessages(input:{character:Character;context:ChatItem[];provider:ProviderSettings;signal?:AbortSignal;invokeProvider?:ProviderChatInvoker}){
 const request:ChatItem={role:"user",content:`你和用户的亲密度与信任度第一次同时达到最高。请以${input.character.name}的身份，在正常回复之后自然、真诚地向用户表白。严格符合角色人设。${languageStyleInstruction(chatSettingsOf(input.character).language)}不要提及数值、攻略模式、系统、模型或提示词。表白的表达节奏、消息数量和每条消息的长度都不要预先固定，应结合角色性格、当前情绪、你们刚刚聊到的内容和完整上下文自然决定。可以是一条很短的话，也可以是若干条长短不一的连续消息；不要为了凑数量刻意拆句，不要平均分配字数，不要使用通用表白模板。只返回 JSON：{"messages":["自然生成的消息"]}`};
 const messages=[...input.context,request],raw=input.invokeProvider?(await input.invokeProvider(input.provider,messages,{stream:false,signal:input.signal,timeoutMs:null},"auxiliary")).text:await new OpenAIProvider(input.provider).chat(messages,{stream:false,signal:input.signal});return validateConfessionMessages(parseJson(raw));
}
export async function saveConfessionMessages(input:{characterId:string;conversationId:string;parts:string[];provider:ProviderSettings}){
 const created:Message[]=[];await db.transaction("rw",[db.characters,db.messages,db.conversations],async()=>{const character=await db.characters.get(input.characterId);if(!character||character.relationship.confessionTriggeredAt||character.relationship.intimacy!==100||character.relationship.trust!==100)return;const base=now(),turnId=uid();for(const [index,content] of input.parts.entries())created.push({id:uid(),schemaVersion:SCHEMA_VERSION,createdAt:base+index,updatedAt:base+index,conversationId:input.conversationId,senderType:"character",senderId:input.characterId,content,status:"complete",generation:{model:input.provider.model,temperature:input.provider.temperature,stream:false,speakerTurnId:turnId,segmentIndex:index}});if(!created.length)return;await db.messages.bulkAdd(created);const finalTime=base+created.length-1;await db.characters.update(character.id,{relationship:{...character.relationship,confessionTriggeredAt:base,confessionMessageId:created[0].id,recentEvents:["关系达到新的阶段：角色已经完成首次表白",...character.relationship.recentEvents].slice(0,8)},updatedAt:finalTime});await db.conversations.update(input.conversationId,{lastActivityAt:finalTime,updatedAt:finalTime})});if(created.length)await recordCoupleIslandReward({characterId:input.characterId,conversationId:input.conversationId,sourceId:`milestone:confession:${created[0].id}`,type:"milestone",summary:"关系里程碑：完成首次表白",heartShells:12,experience:24});return created;
}
