import type {AppSettings,Character,ChatScene,ContextSectionDiagnostics,Conversation,GroupNpc,LoreBook,MediaAsset,Memory,Message,ProviderSettings,RegenerationReason} from "./types";
import {messageInteractionContext} from "./messageInteractions";
import {localTimeContext} from "./localTime";
import {selectMemories} from "./memory";
import {chatSettingsOf,coreSettingOf,languageStyleInstruction,personaOf,relationshipContextOf} from "./character";
import {userPersonaContext} from "./userPersona";
import {compiledLoreContext,performanceProfileContext,strongRoleplayInstruction} from "./personaEngine";
import {evaluateLore,groupLoreByInsertion,isLoreBookMounted,loreEntriesBlock,matchLore,scopeMatches} from "./lore";
import {chatPresenceInstruction,type ChatPresenceContext} from "./chatPresence";
import {CHAT_GROUP_LORE_BUDGET_CHARS,CHAT_PRIVATE_LORE_BUDGET_CHARS,INTERNAL_CONTEXT_WINDOW_TOKENS,estimateChatTokens,estimateTextTokens} from "./tokenBudget";
export {matchLore,scopeMatches} from "./lore";

export type ChatItem={role:"system"|"user"|"assistant";content:string;imageUrl?:string;imageUrls?:string[]};
export function chooseSpeaker(conversation:Conversation,messages:Message[]){const ids=messages.filter(message=>message.conversationId===conversation.id&&message.senderType==="character").map(message=>message.senderId),last=ids.at(-1);return conversation.memberIds.find(id=>id!==last)??conversation.memberIds[0]}
export function conversationLoreBooks(character:Character,conversation:Conversation,books:LoreBook[]){return books.filter(book=>isLoreBookMounted(book,character.id,conversation.id,character,conversation))}
function messageCommerceContext(message:Message){const textImage=message.attachments?.find(item=>item.type==="text-image"),sticker=message.attachments?.find(item=>item.type==="sticker"),attachment=message.attachments?.find(item=>["commerce","transfer","red-packet","poll","music-invitation","music-event","music-search-candidates","music-control-proposal","music-session-summary","couple-island-invitation"].includes(item.type));let content=sticker?.type==="sticker"?`[${message.senderType==="user"?"用户":"角色"}发送了表情包；含义：${sticker.description||sticker.name}]`:message.content;if(textImage?.type==="text-image")content+=`${content?"\n":""}[文字图片：${textImage.description}]`;if(attachment?.type==="transfer")content+=`\n转账方向：${attachment.direction==="character-to-user"?"角色转给用户":"用户转给角色"}；金额 ¥${(attachment.amountCents/100).toFixed(2)}；状态 ${attachment.state}`;else if(attachment?.type==="commerce")content+=`\n订单：${attachment.itemNames.join("、")}；接收人：${attachment.recipientName}；金额 ¥${(attachment.amountCents/100).toFixed(2)}；状态 ${attachment.status}`;else if(attachment?.type==="red-packet")content+=`\n红包总额 ¥${(attachment.totalAmountCents/100).toFixed(2)}；${attachment.claims.map(claim=>`${claim.participantName??claim.characterName??"成员"}领取¥${(claim.amountCents/100).toFixed(2)}`).join("；")}`;else if(attachment?.type==="poll")content+=`\n投票：${attachment.question}；选项 ${attachment.options.map(option=>option.text).join("、")}；已有投票 ${attachment.votes.map(vote=>`${vote.voterName}=${vote.optionIds.map((id:string)=>attachment.options.find(option=>option.id===id)?.text).filter(Boolean).join("、")}`).join("；")}`;else if(attachment?.type==="music-invitation")content+=`\n一起听邀请状态：${attachment.state}${attachment.trackId?`；歌曲ID ${attachment.trackId}`:""}`;else if(attachment?.type==="music-event")content+=`\n一起听事件：${attachment.eventType}${attachment.trackId?`；歌曲ID ${attachment.trackId}`:""}`;else if(attachment?.type==="music-search-candidates")content+=`\n角色DJ搜索候选：${attachment.query}；状态 ${attachment.state}；候选ID ${attachment.trackIds.join("、")}`;else if(attachment?.type==="music-control-proposal")content+=`\n角色DJ控制建议：${attachment.control}；状态 ${attachment.state}；原因：${attachment.reason}`;else if(attachment?.type==="music-session-summary")content+=`\n一起听小结：${attachment.trackIds.length} 首；约 ${Math.max(1,Math.round(attachment.listenedMs/60000))} 分钟${attachment.closingNote?`；结束语：${attachment.closingNote}`:""}`;else if(attachment?.type==="couple-island-invitation")content+=`\n茶侣岛${attachment.cardRole==="response"||message.senderType==="character"?"角色回应":"邀请"}状态：${attachment.state}${attachment.reason?`；原因：${attachment.reason}`:""}`;return messageInteractionContext(message,content)}
const reasonLabels:Record<RegenerationReason,string>={ooc:"角色 OOC","context-conflict":"与上下文不符","memory-conflict":"角色失忆","lore-conflict":"世界书理解错误","speech-style":"说话方式不符合人设","model-leak":"暴露模型或系统信息",other:"其他"};
export interface BuiltChatContext {
  items:ChatItem[];
  diagnostics:ContextSectionDiagnostics;
}

export type BuildContextInput={character:Character;conversation:Conversation;messages:Message[];loreBooks:LoreBook[];memories:Memory[];userText:string;settings:Partial<Pick<AppSettings,"sensitiveContent"|"userName"|"userBio"|"userPersona">>;provider:ProviderSettings;characters?:Character[];groupNpcs?:GroupNpc[];mediaAssets?:MediaAsset[];forumContext?:string;scene?:ChatScene;regenerationReasons?:RegenerationReason[];regenerationInstruction?:string;forceAllLore?:boolean;presence?:ChatPresenceContext;crossModeContinuity?:string;timeAt?:Date};

const CHAT_HISTORY_TOKEN_BUDGET={private:8_000,group:10_000} as const;
const CHAT_MEMORY_TOKEN_BUDGET={private:3_000,group:2_500} as const;
const CHAT_LORE_CHAR_BUDGET={private:CHAT_PRIVATE_LORE_BUDGET_CHARS,group:CHAT_GROUP_LORE_BUDGET_CHARS} as const;

function configuredLoreBudget(books:LoreBook[],fallback:number){
  const configured=books.map(book=>book.triggerSettings?.maxContextChars).filter((value):value is number=>Number.isFinite(value)&&Number(value)>0);
  return configured.length?Math.min(fallback,Math.max(...configured)):fallback;
}

function recentMessagesWithinBudget(messages:Message[],conversationId:string,maxItems:number,maxTokens:number){
  const candidates=messages.filter(message=>message.conversationId===conversationId&&message.status==="complete").slice(-maxItems),kept:Message[]=[];
  let used=0;
  for(let index=candidates.length-1;index>=0;index-=1){
    const message=candidates[index]!,cost=estimateTextTokens(messageCommerceContext(message))+6;
    if(kept.length&&used+cost>maxTokens)continue;
    kept.unshift(message);used+=cost;
  }
  return kept;
}

function memoryLine(item:Memory){
  const content=item.content.trim(),meaning=item.meaning?.trim();
  const usefulMeaning=meaning&&normalizeComparableText(meaning)!==normalizeComparableText(content)&&!normalizeComparableText(content).includes(normalizeComparableText(meaning));
  return `- ${item.title?`${item.title}\uff1a`:""}${content}${usefulMeaning?`\uff08\u610f\u4e49\uff1a${meaning}\uff09`:""}`;
}

function normalizeComparableText(value:string){return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu,"")}

export function buildContextWithDiagnostics(input:BuildContextInput):BuiltChatContext{
  const {character,conversation,userText}=input,chat=chatSettingsOf(character),mode=conversation.type==="group"?"group":"private",recent=recentMessagesWithinBudget(input.messages,conversation.id,chat.contextLimit,CHAT_HISTORY_TOKEN_BUDGET[mode]),texts=[...recent.map(message=>messageCommerceContext(message)),userText,input.regenerationInstruction??""],seed=`${recent.at(-1)?.id??""}:${userText}:${input.regenerationInstruction??""}`,books=conversationLoreBooks(character,conversation,input.loreBooks),forceAllLore=input.forceAllLore||input.regenerationReasons?.includes("lore-conflict"),loreBudget=configuredLoreBudget(books,CHAT_LORE_CHAR_BUDGET[mode]),lore=evaluateLore({books,texts,characterId:character.id,conversationId:conversation.id,character,conversation,seed,forceAll:forceAllLore,budget:loreBudget}).filter(entry=>entry.injected),loreGroups=groupLoreByInsertion(lore),memoryLimit=input.regenerationReasons?.includes("memory-conflict")?(mode==="group"?8:20):(mode==="group"?4:10),memory=selectMemories(input.memories,character.id,conversation.id,memoryLimit,userText,character.memoryExtractionSettings?.enabled??true,{maxItems:memoryLimit,maxTokens:input.regenerationReasons?.includes("memory-conflict")?Math.round(CHAT_MEMORY_TOKEN_BUDGET[mode]*1.5):CHAT_MEMORY_TOKEN_BUDGET[mode],query:userText,mode:mode==="group"?"group":"chat"}),time=localTimeContext({enabled:character.proactive.timeAware,at:input.timeAt}),scene=input.scene??(conversation.type==="group"?"group-chat":"private-chat"),isNpc=input.groupNpcs?.some(npc=>npc.id===character.id)??false,rawLoreBookIds=new Set(lore.map(entry=>entry.bookId)),compiledLoreBudget=Math.min(12_000,Math.max(0,loreBudget-Math.min(loreBudget,lore.reduce((sum,item)=>sum+item.content.length,0)))),compiledLore=compiledLoreContext(books.filter(book=>!rawLoreBookIds.has(book.id))).slice(0,compiledLoreBudget),regeneration=[input.regenerationReasons?.length?`\u672c\u6b21\u91cd\u65b0\u56de\u590d\u9700\u8981\u4fee\u590d\uff1a${input.regenerationReasons.map(reason=>reasonLabels[reason]).join("\u3001")}\u3002`:"",input.regenerationInstruction?.trim()?`\u672c\u6b21\u4e00\u6b21\u6027\u5bfc\u6f14\u8981\u6c42\uff1a${input.regenerationInstruction.trim()}\u3002\u5b83\u53ea\u5f71\u54cd\u672c\u6b21\u56de\u590d\uff0c\u4f4e\u4e8e\u89d2\u8272\u6838\u5fc3\u8bbe\u5b9a\u3001\u5b8c\u6574\u4eba\u8bbe\u548c\u4e16\u754c\u4e66\u786c\u89c4\u5219\uff0c\u4e0d\u5f97\u4fdd\u5b58\u4e3a\u89d2\u8272\u4e8b\u5b9e\u3002`:""].filter(Boolean).join("\n"),personaBlock=`\u5f53\u524d\u6f14\u7ece\u89d2\u8272\uff1a${character.name}\n\u6838\u5fc3\u8bbe\u5b9a\uff1a${coreSettingOf(character)}\n\u4eba\u7269\u8bbe\u5b9a\uff1a${personaOf(character)}\n${languageStyleInstruction(chat.language)}`,performanceBlock=performanceProfileContext(character),relationshipBlock=isNpc?"":relationshipContextOf(character),memoryBlock=memory.length?`\u6d77\u9a6c\u4f53\u8bb0\u5fc6\uff08\u81ea\u7136\u4f7f\u7528\uff0c\u4e0d\u5f97\u63d0\u53ca\u8bb0\u5fc6\u7cfb\u7edf\u6216\u8bc4\u5206\uff09\uff1a\n${memory.map(memoryLine).join("\n")}`:"",continuityBlock=input.crossModeContinuity??"",protocolBlock=strongRoleplayInstruction(scene,isNpc),system=[
    protocolBlock,
    chatPresenceInstruction(input.presence??{mode:"remote",evidence:"default"}),
    continuityBlock,
    loreEntriesBlock(loreGroups["base-rules"]),
    personaBlock,
    performanceBlock,
    loreEntriesBlock(loreGroups["after-character"]),
    conversation.type==="group"?`\u4f60\u6b63\u5728\u7fa4\u804a\u201c${conversation.title}\u201d\u4e2d\u53d1\u8a00\u3002\u53ea\u626e\u6f14${character.name}\uff0c\u4e0d\u8981\u4ee3\u66ff\u5176\u4ed6\u6210\u5458\u53d1\u8a00\u3002${conversation.chatSettings?.userInGroup===false?"\u7528\u6237\u4e0d\u5c5e\u4e8e\u7fa4\u6210\u5458\uff1b\u6807\u8bb0\u4e3a\u5e55\u540e\u6307\u5bfc\u7684\u5185\u5bb9\u53ea\u662f\u5bfc\u6f14\u6307\u4ee4\uff0c\u4e0d\u8981\u5728\u7fa4\u5185\u63d0\u53ca\u7528\u6237\u6216\u6307\u4ee4\u6765\u6e90\u3002":"\u7528\u6237\u662f\u7fa4\u804a\u6210\u5458\u3002"}`:"",
    conversation.type!=="group"||conversation.chatSettings?.userInGroup!==false?userPersonaContext(input.settings):"",
    time,
    compiledLore,
    relationshipBlock,
    memoryBlock,
    loreEntriesBlock(loreGroups["after-memory"]),
    input.forumContext?`\u8bba\u575b\u4e92\u901a\u5185\u5bb9\uff1a\n${input.forumContext}`:"",
    regeneration,
  ].filter(Boolean).join("\n\n"),history=recent.map<ChatItem>(message=>{if(message.kind==="director")return{role:"system",content:`[\u4ec5\u7528\u6237\u53ef\u89c1\u7684\u5e55\u540e\u6307\u5bfc] ${message.content}`};if(message.senderType==="system")return{role:"system",content:messageCommerceContext(message)};const media=message.attachments?.find(attachment=>attachment.type==="image"||attachment.type==="sticker"),assetId=media&&"assetId" in media?media.assetId:undefined,asset=assetId?input.mediaAssets?.find(item=>item.id===assetId):undefined,imageUrl=media?.type==="image"&&media.visionMode==="description"?undefined:(asset?.data||(media&&"url" in media?media.url:undefined)),name=message.senderType==="user"?(input.settings.userName?.trim()||"\u6211"):input.characters?.find(item=>item.id===message.senderId)?.name??input.groupNpcs?.find(item=>item.id===message.senderId)?.name??"\u6210\u5458",content=conversation.type==="group"?`${name}\uff1a${messageCommerceContext(message)}`:messageCommerceContext(message);return{role:message.senderType==="user"?"user":"assistant",content,imageUrl}}),items=[{role:"system" as const,content:system},...(loreGroups["before-history"].length?[{role:"system" as const,content:loreEntriesBlock(loreGroups["before-history"])}]:[]),...history,...(loreGroups["before-user"].length?[{role:"system" as const,content:loreEntriesBlock(loreGroups["before-user"])}]:[]),{role:"user" as const,content:userText}],loreText=[...lore.map(item=>item.content),compiledLore].filter(Boolean).join("\n"),historyText=history.map(item=>item.content).join("\n");
  return{items,diagnostics:{personaTokens:estimateTextTokens([personaBlock,performanceBlock,userPersonaContext(input.settings)].filter(Boolean).join("\n")),relationshipTokens:estimateTextTokens(relationshipBlock),historyTokens:estimateTextTokens(historyText),memoryTokens:estimateTextTokens(memoryBlock),loreTokens:estimateTextTokens(loreText),continuityTokens:estimateTextTokens(continuityBlock),protocolTokens:estimateTextTokens(protocolBlock),totalInputTokens:estimateChatTokens(items),providerWindow:INTERNAL_CONTEXT_WINDOW_TOKENS,memoryCount:memory.length,loreCount:lore.length}};
}

export function buildContext(input:BuildContextInput):ChatItem[]{return buildContextWithDiagnostics(input).items}
