import {useEffect} from "react";
import {backgroundExecutionAllowed} from "../core/notificationSettings";
import {wakeChatReplyPump} from "../core/chatReplyRunner";
import {recoverInvitationResponseTasks} from "../core/invitationResponseTasks";
import {useStore} from "../core/store";

export default function ChatReplyCoordinator(){
 const {ready,provider,settings,reloadConversation,setGenerating}=useStore();
 useEffect(()=>{
  if(!ready||!provider)return;let disposed=false;
  const canClaim=()=>document.visibilityState==="visible"||backgroundExecutionAllowed(settings,document.visibilityState);
  const pump=()=>{
   if(disposed||!canClaim())return Promise.resolve();
   return recoverInvitationResponseTasks().catch(()=>undefined).then(()=>wakeChatReplyPump({
    source:"background",
    canRun:()=>!disposed&&canClaim(),
    onTaskStart:task=>{setGenerating(task.conversationId??null)},
    onTaskComplete:async(task)=>{if(task.conversationId)await reloadConversation(task.conversationId)},
    onTaskError:async(task)=>{if(task.conversationId)await reloadConversation(task.conversationId)},
    onIdle:()=>{setGenerating(null)},
   }));
  };
  const wake=()=>void pump(),syncAndWake=()=>{wake()},onMessage=(event:MessageEvent)=>{if(event.data?.type==="CHACHA_BACKGROUND_WAKE"||event.data?.type==="CHACHA_CHAT_REPLY_WAKE")syncAndWake()};
  void pump();const interval=setInterval(wake,5000);window.addEventListener("mira:chat-reply-change",syncAndWake);window.addEventListener("mira:chat-translation-change",syncAndWake);window.addEventListener("online",wake);document.addEventListener("visibilitychange",wake);navigator.serviceWorker?.addEventListener("message",onMessage);
  return()=>{disposed=true;clearInterval(interval);window.removeEventListener("mira:chat-reply-change",syncAndWake);window.removeEventListener("mira:chat-translation-change",syncAndWake);window.removeEventListener("online",wake);document.removeEventListener("visibilitychange",wake);navigator.serviceWorker?.removeEventListener("message",onMessage)};
 },[ready,provider,settings,reloadConversation,setGenerating]);
 return null;
}
