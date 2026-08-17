import {create} from "zustand";
import {db,getAppSettings,getProvider,getAppearance} from "./db";
import {migrateMeetSessionNarrative} from "./meet";
import {
 MESSAGE_PAGE_SIZE,
 MESSAGE_WINDOW_LIMIT,
 compareMessages,
 mergeMessageItems,
 readConversationMessagePage,
 readConversationSummaries,
 type ConversationMessageSummary,
 type ConversationMessageWindow,
} from "./messageStore";
import type {AppSettings,Character,Conversation,FeedPost,LoreBook,Memory,Message,Preset,ProviderSettings,MemoryExtractionBatch,AppearanceSettings,ImageAsset,MeetSession} from "./types";

type State={
 ready:boolean;
 characters:Character[];
 conversations:Conversation[];
 messageWindows:Record<string,ConversationMessageWindow>;
 conversationSummaries:Record<string,ConversationMessageSummary>;
 messageWindowOrder:string[];
 feedPosts:FeedPost[];
 loreBooks:LoreBook[];
 memories:Memory[];
 presets:Preset[];
 memoryExtractionBatches:MemoryExtractionBatch[];
 appearance:AppearanceSettings|null;
 imageAssets:ImageAsset[];
 meetSessions:MeetSession[];
 provider:ProviderSettings|null;
 settings:AppSettings|null;
 reload:()=>Promise<void>;
 reloadConversation:(conversationId:string)=>Promise<void>;
 loadConversationWindow:(conversationId:string)=>Promise<void>;
 loadOlderConversationMessages:(conversationId:string)=>Promise<void>;
 refreshConversationWindow:(conversationId:string)=>Promise<void>;
 clearConversationWindow:(conversationId:string)=>void;
 refreshConversationSummaries:()=>Promise<void>;
 mergeMessage:(message:Message)=>void;
 setGenerating:(id:string|null)=>void;
 generating:string|null;
};

const emptyWindow=():ConversationMessageWindow=>({items:[],hasMore:true,loading:false,initialized:false});
const conversationWindowLoads=new Map<string,Promise<void>>();
function touchedOrder(order:string[],conversationId:string){return [...order.filter(id=>id!==conversationId),conversationId]}
function evictWindows(windows:Record<string,ConversationMessageWindow>,order:string[]){
 const next={...windows},kept=order.slice(-MESSAGE_WINDOW_LIMIT);
 for(const id of Object.keys(next))if(!kept.includes(id))delete next[id];
 return {windows:next,order:kept};
}

export const useStore=create<State>((set,get)=>({
 ready:false,characters:[],conversations:[],messageWindows:{},conversationSummaries:{},messageWindowOrder:[],feedPosts:[],loreBooks:[],memories:[],presets:[],memoryExtractionBatches:[],appearance:null,imageAssets:[],meetSessions:[],provider:null,settings:null,generating:null,
 setGenerating:(id)=>set({generating:id}),
 mergeMessage:(message)=>set((state)=>{
  const current=state.messageWindows[message.conversationId];
  const messageWindows=current?.initialized?{...state.messageWindows,[message.conversationId]:{...current,items:mergeMessageItems(current.items,message)}}:state.messageWindows;
  const previous=state.conversationSummaries[message.conversationId];
  const isLatest=!previous?.latestMessage||compareMessages(previous.latestMessage,message)<=0;
  const unreadDelta=message.origin==="proactive"&&!message.readAt&&previous?.latestMessage?.id!==message.id?1:0;
  return {messageWindows,conversationSummaries:{...state.conversationSummaries,[message.conversationId]:{conversationId:message.conversationId,latestMessage:isLatest?message:previous?.latestMessage,proactiveUnreadCount:(previous?.proactiveUnreadCount??0)+unreadDelta}}};
 }),
 loadConversationWindow:async(conversationId)=>{
  const existing=get().messageWindows[conversationId];
  if(existing?.initialized){set(state=>{const evicted=evictWindows(state.messageWindows,touchedOrder(state.messageWindowOrder,conversationId));return{messageWindows:evicted.windows,messageWindowOrder:evicted.order}});return}
  const pending=conversationWindowLoads.get(conversationId);
  if(pending)return pending;
  const task=(async()=>{
   set(state=>({messageWindows:{...state.messageWindows,[conversationId]:{...(state.messageWindows[conversationId]??emptyWindow()),loading:true,error:undefined}}}));
   try{
    const page=await readConversationMessagePage(conversationId);
    set(state=>{const order=touchedOrder(state.messageWindowOrder,conversationId),messageWindows={...state.messageWindows,[conversationId]:{items:page.items,oldest:page.oldest,hasMore:page.hasMore,loading:false,initialized:true,error:undefined}},evicted=evictWindows(messageWindows,order);return{messageWindows:evicted.windows,messageWindowOrder:evicted.order}});
   }catch(error){set(state=>({messageWindows:{...state.messageWindows,[conversationId]:{...(state.messageWindows[conversationId]??emptyWindow()),loading:false,initialized:false,error:"initial"}}}));throw error}
   finally{conversationWindowLoads.delete(conversationId)}
  })();
  conversationWindowLoads.set(conversationId,task);
  return task;
 },
 loadOlderConversationMessages:async(conversationId)=>{
  const existing=get().messageWindows[conversationId];
  if(!existing?.initialized||existing.loading||!existing.hasMore||!existing.oldest)return;
  set(state=>({messageWindows:{...state.messageWindows,[conversationId]:{...existing,loading:true,error:undefined}}}));
  try{
   const page=await readConversationMessagePage(conversationId,existing.oldest);
   set(state=>{
    const current=state.messageWindows[conversationId]??existing,items=[...page.items,...current.items].filter((message,index,all)=>all.findIndex(row=>row.id===message.id)===index).sort(compareMessages),order=touchedOrder(state.messageWindowOrder,conversationId),messageWindows={...state.messageWindows,[conversationId]:{items,oldest:items[0]?{createdAt:items[0].createdAt,id:items[0].id}:undefined,hasMore:page.hasMore,loading:false,initialized:true,error:undefined}},evicted=evictWindows(messageWindows,order);return{messageWindows:evicted.windows,messageWindowOrder:evicted.order};
   });
  }catch(error){set(state=>({messageWindows:{...state.messageWindows,[conversationId]:{...(state.messageWindows[conversationId]??existing),loading:false,error:"older"}}}));throw error}
 },
 refreshConversationWindow:async(conversationId)=>{
  const pending=conversationWindowLoads.get(conversationId);
  if(pending)await pending.catch(()=>undefined);
  const existing=get().messageWindows[conversationId];
  if(!existing?.initialized)return;
  const page=await readConversationMessagePage(conversationId,undefined,Math.max(MESSAGE_PAGE_SIZE,existing.items.length));
  set(state=>{const current=state.messageWindows[conversationId];if(!current?.initialized)return{};const order=touchedOrder(state.messageWindowOrder,conversationId),messageWindows={...state.messageWindows,[conversationId]:{items:page.items,oldest:page.oldest,hasMore:page.hasMore,loading:false,initialized:true,error:undefined}},evicted=evictWindows(messageWindows,order);return{messageWindows:evicted.windows,messageWindowOrder:evicted.order}});
 },
 clearConversationWindow:(conversationId)=>set(state=>{const messageWindows={...state.messageWindows};delete messageWindows[conversationId];return{messageWindows,messageWindowOrder:state.messageWindowOrder.filter(id=>id!==conversationId)}}),
 refreshConversationSummaries:async()=>{const summaries=await readConversationSummaries(get().conversations);set({conversationSummaries:summaries})},
 reloadConversation:async(conversationId)=>{
  const conversation=await db.conversations.get(conversationId);
  if(conversation)set(state=>({conversations:[...state.conversations.filter(row=>row.id!==conversationId),conversation]}));
  await Promise.all([get().refreshConversationWindow(conversationId),get().refreshConversationSummaries()]);
 },
 reload:async()=>{
  const activeWindowIds=Object.entries(get().messageWindows).filter(([,window])=>window.initialized).map(([id])=>id);
  const [characters,conversations,feedPosts,loreBooks,memories,presets,memoryExtractionBatches,appearance,imageAssets,meetSessions,provider,settings]=await Promise.all([db.characters.toArray(),db.conversations.toArray(),db.feedPosts.toArray(),db.loreBooks.toArray(),db.memories.toArray(),db.presets.toArray(),db.memoryExtractionBatches.toArray().then(rows=>rows.filter(batch=>batch.source==="chat")),getAppearance(),db.imageAssets.toArray(),db.meetSessions.toArray().then(async rows=>{const meetSessions=rows.map(migrateMeetSessionNarrative),migrated=meetSessions.filter((row,index)=>row!==rows[index]);if(migrated.length)await db.meetSessions.bulkPut(migrated);return meetSessions}),getProvider(),getAppSettings()]);
  const conversationSummaries=await readConversationSummaries(conversations);
  set({ready:true,characters,conversations,conversationSummaries,feedPosts,loreBooks,memories,presets,memoryExtractionBatches,appearance,imageAssets,meetSessions,provider,settings});
  await Promise.all(activeWindowIds.map(id=>get().refreshConversationWindow(id)));
 }
}));
