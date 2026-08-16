import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import {
  InnerVoiceCard,
  useInnerVoiceForumHandle,
} from "../components/InnerVoiceCard";
import { AppTopBar } from "../components/ui";
import { db } from "../core/db";
import { conversationInnerVoiceEnabled } from "../core/innerVoice";
import { selectInnerVoiceMessages } from "../core/innerVoiceView";
import { useStore } from "../core/store";
import type { Message } from "../core/types";

export default function InnerVoicePage() {
  const { conversationId, actorType, actorId } = useParams(),
    nav = useNavigate(),
    { conversations, characters } = useStore(),
    [conversationMessages, setConversationMessages] = useState<Message[]>([]),
    [npcAvatar, setNpcAvatar] = useState<string>(),
    [notice, setNotice] = useState("");
  const conversation = conversations.find((item) => item.id === conversationId),
    character = characters.find((item) => item.id === actorId),
    npc = conversation?.groupNpcs?.find((item) => item.id === actorId),
    name = character?.name ?? npc?.name ?? "角色",
    avatar = character?.avatar ?? npcAvatar,
    validActorType = actorType === "character" || actorType === "npc",
    actorHandle = useInnerVoiceForumHandle(
      validActorType ? actorType : "character",
      actorId ?? "",
      name,
    ),
    innerVoiceEnabled = conversation
      ? conversationInnerVoiceEnabled(conversation)
      : false;

  const loadConversationMessages = async () => {
    if (!conversationId || !actorId) return setConversationMessages([]);
    setConversationMessages(await db.messages.where("conversationId").equals(conversationId).filter(message => message.senderId === actorId && Boolean(message.innerVoice)).sortBy("createdAt"));
  };
  useEffect(() => { void loadConversationMessages(); }, [conversationId, actorId]);

  useEffect(() => {
    if (!npc?.avatarAssetId) {
      setNpcAvatar(undefined);
      return;
    }
    void db.mediaAssets
      .get(npc.avatarAssetId)
      .then((asset) => setNpcAvatar(asset?.data));
  }, [npc?.avatarAssetId]);

  const entries = useMemo(
      () =>
        validActorType && conversationId && actorId
          ? selectInnerVoiceMessages(
              conversationMessages,
              conversationId,
              actorType,
              actorId,
            )
          : [],
      [conversationMessages, conversationId, actorType, actorId, validActorType],
    );

  if (!conversation || !actorId || !validActorType)
    return <Navigate to="/messages/chats" replace />;

  const showNotice = (value: string) => {
    setNotice(value);
    window.setTimeout(
      () => setNotice((current) => (current === value ? "" : current)),
      1800,
    );
  };

  return (
    <div className="inner-voice-page">
      <AppTopBar title={`${name}的心声`} onBack={() => nav(-1)} />
      <main>
        {!innerVoiceEnabled && (
          <div className="inner-voice-disabled">
            当前群聊已关闭新心声生成，已有记录仍会保留。
          </div>
        )}
        {entries.length ? (
          <div className="inner-voice-timeline">
            {entries.map((message) => (
              <InnerVoiceCard
                key={message.innerVoice!.id}
                message={message}
                conversationMessages={conversationMessages}
                actorName={name}
                actorAvatar={avatar}
                actorHandle={actorHandle}
                onChanged={loadConversationMessages}
                onSource={(messageId) =>
                  nav(`/messages/${conversation.id}?message=${messageId}`)
                }
                onNotice={showNotice}
              />
            ))}
          </div>
        ) : (
          <div className="inner-voice-empty">
            <Sparkles />
            <h2>还没有心声</h2>
            <p>之后产生的新角色回复，会把没有说出口的话记录在这里。</p>
          </div>
        )}
      </main>
      {notice && <div className="inner-voice-page-toast">{notice}</div>}
    </div>
  );
}
