import {db,getAppSettings,getSpeechSettings} from "./db";
import {saveVoiceMedia} from "./mediaAssets";
import {OpenAIProvider,type ProviderChatInvoker} from "./provider";
import {chatSettingsOf,coreSettingOf,personaOf} from "./character";
import {userPersonaContext} from "./userPersona";
import {defaultSpeechSettings,now,type Character,type CharacterSpeechSettings,type Message,type ProviderSettings,type SpeechProviderKind,type SpeechSettings,type SpeechTendency,type SpeechVendorSettings} from "./types";

export type SpeechErrorKind="auth"|"rate"|"voice"|"timeout"|"network"|"cors"|"format"|"aborted";
export interface SpeechVoiceOption{id:string;name:string;category?:string;previewUrl?:string}
export interface SpeechModelOption{id:string;name:string}
export interface VoiceAttachmentResult{status:"voice"|"text"|"failed"|"disabled";messageId?:string;error?:string}
export class SpeechError extends Error{constructor(public kind:SpeechErrorKind,message:string){super(message)}}

const trimBase=(value:string)=>value.trim().replace(/\/$/,"");
const clamp=(value:number|undefined,min:number,max:number,fallback:number)=>Math.max(min,Math.min(max,Number.isFinite(value)?Number(value):fallback));
const hexToBlob=(hex:string,mime="audio/mpeg")=>{if(!/^[0-9a-f]+$/i.test(hex)||hex.length%2)throw new SpeechError("format","语音服务返回了无法识别的音频");const bytes=new Uint8Array(hex.length/2);for(let i=0;i<bytes.length;i++)bytes[i]=parseInt(hex.slice(i*2,i*2+2),16);return new Blob([bytes],{type:mime})};
const mapStatus=(status:number)=>{if(status===401||status===403)return new SpeechError("auth","语音 API Key 无效或无权限");if(status===404)return new SpeechError("voice","音色、模型或接口不存在");if(status===429)return new SpeechError("rate","语音服务额度或频率已达上限");return new SpeechError("network","语音服务请求失败 ("+status+")")};
const json=async(response:Response)=>{if(!response.ok)throw mapStatus(response.status);try{return await response.json()}catch{throw new SpeechError("format","语音服务返回了无效 JSON")}};

function normalizeVendor(kind:SpeechProviderKind,value?:Partial<SpeechVendorSettings>):SpeechVendorSettings{
 const base=defaultSpeechSettings[kind],next={...base,...(value??{})};
 return{...next,enabled:Boolean(next.enabled),apiKey:String(next.apiKey??""),baseUrl:String(next.baseUrl||base.baseUrl),model:String(next.model||base.model),defaultVoiceId:String(next.defaultVoiceId??""),speed:clamp(next.speed,.5,2,1),volume:clamp(next.volume,.1,10,1),pitch:clamp(next.pitch,-12,12,0),languageBoost:String(next.languageBoost||"auto"),stability:clamp(next.stability,0,1,.5),similarityBoost:clamp(next.similarityBoost,0,1,.75),style:clamp(next.style,0,1,0),useSpeakerBoost:next.useSpeakerBoost!==false};
}
export function normalizeSpeechSettings(value?:Partial<SpeechSettings>|null):SpeechSettings{
 const input=value??{},presets=(input.presets??[]).filter(item=>item&&item.id&&item.name).map(item=>({id:String(item.id),name:String(item.name).trim().slice(0,40)||"语音预设",provider:item.provider==="elevenlabs"?"elevenlabs" as const:"minimax" as const,settings:normalizeVendor(item.provider==="elevenlabs"?"elevenlabs":"minimax",item.settings),createdAt:Number(item.createdAt)||Date.now(),updatedAt:Number(item.updatedAt)||Date.now()}));
 return{defaultProvider:input.defaultProvider==="elevenlabs"?"elevenlabs":"minimax",minimax:normalizeVendor("minimax",input.minimax),elevenlabs:normalizeVendor("elevenlabs",input.elevenlabs),presets};
}

export class SpeechProvider{
 constructor(private kind:SpeechProviderKind,private settings:SpeechVendorSettings){}
 private base(){return trimBase(this.settings.baseUrl)}
 private ensure(requireVoice=true){if(!this.settings.enabled||!this.settings.apiKey.trim())throw new SpeechError("auth","尚未配置语音服务");if(requireVoice&&!this.settings.defaultVoiceId.trim())throw new SpeechError("voice","请先选择或填写 Voice ID")}
 async listVoices(signal?:AbortSignal):Promise<SpeechVoiceOption[]>{
  this.ensure(false);
  if(this.kind==="elevenlabs"){
   const data=await json(await fetch(this.base()+"/voices",{headers:{"xi-api-key":this.settings.apiKey},signal}));
   return (Array.isArray(data?.voices)?data.voices:[]).map((voice:any)=>({id:String(voice.voice_id??voice.id??""),name:String(voice.name??voice.voice_id??"未命名音色"),category:voice.category?String(voice.category):undefined,previewUrl:voice.preview_url?String(voice.preview_url):undefined})).filter((voice:SpeechVoiceOption)=>voice.id);
  }
  const data=await json(await fetch(this.base()+"/get_voice",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+this.settings.apiKey},body:JSON.stringify({voice_type:"all"}),signal}));
  const groups:[[string,string]]|Array<[string,string]>=[["system_voice","系统"],["voice_cloning","克隆"],["voice_generation","生成"]],result:SpeechVoiceOption[]=[];
  for(const [key,category] of groups){const values=data?.data?.[key]??data?.[key]??[];for(const item of Array.isArray(values)?values:[]){const id=typeof item==="string"?item:String(item?.voice_id??item?.id??"");if(id)result.push({id,name:String(item?.voice_name??item?.name??id),category})}}
  return result.filter((voice,index,all)=>all.findIndex(item=>item.id===voice.id)===index);
 }
 async listModels(signal?:AbortSignal):Promise<SpeechModelOption[]>{
  this.ensure(false);
  if(this.kind==="minimax")return ["speech-02-hd","speech-02-turbo","speech-2.6-hd","speech-2.6-turbo"].map(id=>({id,name:id}));
  const data=await json(await fetch(this.base()+"/models",{headers:{"xi-api-key":this.settings.apiKey},signal}));
  return (Array.isArray(data)?data:Array.isArray(data?.models)?data.models:[]).filter((model:any)=>model.can_do_text_to_speech!==false).map((model:any)=>({id:String(model.model_id??model.id??""),name:String(model.name??model.model_id??model.id??"")})).filter((model:SpeechModelOption)=>model.id);
 }
 async synthesize(text:string,signal?:AbortSignal){
  this.ensure();const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort("timeout"),60000),abort=()=>ctl.abort("user");signal?.addEventListener("abort",abort,{once:true});
  try{
   if(this.kind==="elevenlabs"){
    const r=await fetch(this.base()+"/text-to-speech/"+encodeURIComponent(this.settings.defaultVoiceId)+"?output_format=mp3_44100_128",{method:"POST",headers:{"Content-Type":"application/json",Accept:"audio/mpeg","xi-api-key":this.settings.apiKey},body:JSON.stringify({text,model_id:this.settings.model,voice_settings:{speed:clamp(this.settings.speed,.5,2,1),stability:clamp(this.settings.stability,0,1,.5),similarity_boost:clamp(this.settings.similarityBoost,0,1,.75),style:clamp(this.settings.style,0,1,0),use_speaker_boost:this.settings.useSpeakerBoost!==false}}),signal:ctl.signal});
    if(!r.ok)throw mapStatus(r.status);const blob=await r.blob();if(!blob.size)throw new SpeechError("format","语音服务没有返回音频");return blob;
   }
   const r=await fetch(this.base()+"/t2a_v2",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+this.settings.apiKey},body:JSON.stringify({model:this.settings.model,text,stream:false,language_boost:this.settings.languageBoost||"auto",voice_setting:{voice_id:this.settings.defaultVoiceId,speed:clamp(this.settings.speed,.5,2,1),vol:clamp(this.settings.volume,.1,10,1),pitch:clamp(this.settings.pitch,-12,12,0)},audio_setting:{sample_rate:32000,bitrate:128000,format:"mp3",channel:1}}),signal:ctl.signal});
   if(!r.ok)throw mapStatus(r.status);const data=await r.json(),audio=data?.data?.audio;if(typeof audio!=="string")throw new SpeechError("format",data?.base_resp?.status_msg||"语音服务返回格式异常");return hexToBlob(audio);
  }catch(e){if(e instanceof SpeechError)throw e;if(ctl.signal.aborted)throw new SpeechError(ctl.signal.reason==="timeout"?"timeout":"aborted",ctl.signal.reason==="timeout"?"语音生成超时":"语音生成已停止");if(e instanceof TypeError)throw new SpeechError("cors","网络或跨域请求失败，请确认语音 API 支持浏览器访问");throw new SpeechError("network",e instanceof Error?e.message:"语音生成失败")}finally{clearTimeout(timer);signal?.removeEventListener("abort",abort)}
 }
}

export function normalizeCharacterSpeech(value?:CharacterSpeechSettings):CharacterSpeechSettings{return{enabled:value?.enabled??true,provider:value?.provider??"inherit",presetId:value?.presetId,voiceId:value?.voiceId,model:value?.model,autoMessages:{enabled:value?.autoMessages?.enabled??false,tendency:value?.autoMessages?.tendency??"medium",dailyProgress:value?.autoMessages?.dailyProgress,lastVoiceAt:value?.autoMessages?.lastVoiceAt}}}
export function resolveCharacterSpeech(character:Character,globalValue:SpeechSettings){const global=normalizeSpeechSettings(globalValue),speech=normalizeCharacterSpeech(character.chatSettings?.speech);if(!speech.enabled)return null;const preset=speech.presetId?global.presets.find(item=>item.id===speech.presetId):undefined,kind=preset?.provider??(speech.provider!=="inherit"?speech.provider:global.defaultProvider),settings={...(preset?.settings??global[kind])};if(speech.voiceId?.trim())settings.defaultVoiceId=speech.voiceId.trim();if(speech.model?.trim())settings.model=speech.model.trim();return settings.enabled&&settings.apiKey.trim()&&settings.defaultVoiceId.trim()?{kind,settings,provider:new SpeechProvider(kind,settings),preset}:null}
export async function speechForCharacter(character:Character){return resolveCharacterSpeech(character,normalizeSpeechSettings(await getSpeechSettings()))?.provider??null}
export function sanitizeSpeechSettings(settings:SpeechSettings):SpeechSettings{const normalized=normalizeSpeechSettings(settings);return{...normalized,minimax:{...normalized.minimax,apiKey:""},elevenlabs:{...normalized.elevenlabs,apiKey:""},presets:normalized.presets.map(preset=>({...preset,settings:{...preset.settings,apiKey:""}}))}}

const dailyLimit=(tendency:SpeechTendency)=>tendency==="low"?1:tendency==="high"?6:3;
const dayKey=()=>new Date().toLocaleDateString("en-CA");
function withDecision(message:Message,value:"voice"|"text"|"failed"){return{...message.generation,model:message.generation?.model??"speech-decision",temperature:message.generation?.temperature??0,voiceDecision:value}}
async function markMessages(messages:Message[],value:"text"|"failed"){await Promise.all(messages.map(message=>db.messages.update(message.id,{generation:withDecision(message,value),updatedAt:now()})))}
async function audioDuration(blob:Blob,text:string){if(typeof Audio==="undefined"||typeof URL==="undefined")return Math.min(60000,Math.max(1000,text.length*180));const url=URL.createObjectURL(blob);try{return await new Promise<number>(resolve=>{const audio=new Audio(url),done=(value:number)=>resolve(Math.max(1000,value));const timer=setTimeout(()=>done(text.length*180),5000);audio.onloadedmetadata=()=>{clearTimeout(timer);done(Number.isFinite(audio.duration)?audio.duration*1000:text.length*180)};audio.onerror=()=>{clearTimeout(timer);done(text.length*180)}})}finally{URL.revokeObjectURL(url)}}
function parseDecision(raw:string,candidates:Message[]){try{const start=raw.indexOf("{"),end=raw.lastIndexOf("}"),value=JSON.parse(raw.slice(start,end+1));const message=candidates.find(item=>item.id===String(value.messageId??""));return{sendVoice:value.sendVoice===true&&Boolean(message),message}}catch{return{sendVoice:false,message:undefined}}}
export async function maybeAttachCharacterVoice(input:{character:Character;messageIds:string[];provider:ProviderSettings;signal?:AbortSignal;invokeProvider?:ProviderChatInvoker}):Promise<VoiceAttachmentResult>{
 const character=await db.characters.get(input.character.id)??input.character,speech=normalizeCharacterSpeech(character.chatSettings?.speech),auto=speech.autoMessages??{enabled:false,tendency:"medium" as const};if(!auto.enabled)return{status:"disabled"};
 const rows=(await db.messages.bulkGet(input.messageIds)).filter((message):message is Message=>Boolean(message&&message.senderType==="character"&&message.senderId===character.id&&message.status==="complete"&&!message.generation?.voiceDecision));if(!rows.length)return{status:"disabled"};
 const progress=auto.dailyProgress?.date===dayKey()?auto.dailyProgress:{date:dayKey(),count:0};if(progress.count>=dailyLimit(auto.tendency)){await markMessages(rows,"text");return{status:"text"}}
 const resolved=resolveCharacterSpeech(character,normalizeSpeechSettings(await getSpeechSettings()));if(!resolved){await markMessages(rows,"failed");return{status:"failed",error:"角色语音配置不完整"}}
 try{
  const appSettings=await getAppSettings(),prompt=["判断角色本轮是否会自然地使用语音消息。只返回严格 JSON。",`角色：${character.name}`,`核心设定：${coreSettingOf(character)}`,`人物设定：${personaOf(character)}`,userPersonaContext(appSettings),`语音倾向：${auto.tendency==="low"?"很少":auto.tendency==="high"?"经常":"偶尔"}`,"只有情绪表达、安慰、撒娇、重要回应或明显适合说出口的话才选择语音；普通说明、系统性内容或过长内容保持文字。不得为了消耗额度而选择语音。","候选消息：",...rows.map(message=>`${message.id}：${message.content}`),`只返回：{"sendVoice":true或false,"messageId":"候选消息ID；不发送时为空","reason":"简短原因"}`].filter(Boolean).join("\n\n"),providerMessages=[{role:"system" as const,content:"你只负责判断虚构角色是否自然发送语音消息，只输出严格 JSON。"},{role:"user" as const,content:prompt}],raw=input.invokeProvider?(await input.invokeProvider(input.provider,providerMessages,{stream:false,signal:input.signal,timeoutMs:null},"auxiliary")).text:await new OpenAIProvider(input.provider).chat(providerMessages,{stream:false,signal:input.signal}),decision=parseDecision(raw,rows);
  if(!decision.sendVoice||!decision.message){await markMessages(rows,"text");return{status:"text"}}
  const blob=await resolved.provider.synthesize(decision.message.content,input.signal),durationMs=await audioDuration(blob,decision.message.content),asset=await saveVoiceMedia(blob,durationMs),current=await db.messages.get(decision.message.id);if(!current||current.content!==decision.message.content){await db.mediaAssets.delete(asset.id);await markMessages(rows,"failed");return{status:"failed",error:"消息内容已经变化"}}
  const attachment={type:"voice" as const,assetId:asset.id,durationMs,transcript:current.content},updatedAuto={...auto,dailyProgress:{date:dayKey(),count:progress.count+1},lastVoiceAt:now()};
  await db.transaction("rw",[db.messages,db.characters],async()=>{await db.messages.update(current.id,{kind:"voice",attachments:[...(current.attachments??[]).filter(item=>item.type!=="voice"),attachment],generation:withDecision(current,"voice"),updatedAt:now()});for(const row of rows)if(row.id!==current.id)await db.messages.update(row.id,{generation:withDecision(row,"text"),updatedAt:now()});const latest=await db.characters.get(character.id)??character,chat=chatSettingsOf(latest);await db.characters.update(character.id,{chatSettings:{...chat,speech:{...normalizeCharacterSpeech(chat.speech),autoMessages:updatedAuto}},updatedAt:now()})});
  return{status:"voice",messageId:current.id};
 }catch(error){await markMessages(rows,"failed");return{status:"failed",error:error instanceof Error?error.message:"语音生成失败"}}
}