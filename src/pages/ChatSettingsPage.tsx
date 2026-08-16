import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  BrainCircuit,
  Camera,
  ChevronRight,
  Download,
  Heart,
  ImagePlus,
  Link2,
  MessageCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldBan,
  SlidersHorizontal,
  Star,
  Trash2,
  Upload,
  UserRound,
  Users,
  Volume2,
  X,
} from "lucide-react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Avatar, Modal } from "../components/ui";
import { chatSettingsOf } from "../core/character";
import {
  clearConversationMessages,
  chatArchiveToText,
  createChatArchive,
  importChatArchive,
  parseChatArchive,
  previewChatImport,
  stringifyChatArchive,
  type ChatArchive,
  type ChatImportMode,
  type ChatImportPreview,
} from "../core/chatArchive";
import {
  conversationChatSettingsOf,
  conversationDisplayName,
  isCharacterBlocked,
} from "../core/conversationSettings";
import { db, getSpeechSettings } from "../core/db";
import { deleteMediaIfUnused, saveImageMedia } from "../core/mediaAssets";
import {compressImage} from "../core/imageAssets";
import {appearanceSourceUrl,deleteImageAssetIfUnused} from "../core/imageAssetUsage";
import {
  createExtractionBatch,
  defaultMemoryExtractionSettings,
  memoryExtractionSettingsOf,
  pendingCount,
  validMemoryExtractionSettings,
} from "../core/memoryExtraction";
import { resolveSecondaryProvider } from "../core/modelServices";
import {
  emptyProactiveSettings,
  proactiveSettingsOf,
  validChannel,
} from "../core/proactiveRules";
import {
  normalizeCharacterSpeech,
  normalizeSpeechSettings,
} from "../core/speech";
import { useStore } from "../core/store";
import { shouldTranslateLanguage } from "../core/chatTranslation";
import {
  now,
  type Character,
  type ConversationChatSettings,
  type GroupNpc,
  type MemoryExtractionSettings,
  type ProactiveSettings,
  type SpeechSettings,
  type StickerPack,
} from "../core/types";

function SwitchRow({
  title,
  note,
  checked,
  onChange,
}: {
  title: string;
  note?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="chat-settings-switch">
      <span>
        <b>{title}</b>
        {note && <small>{note}</small>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i />
    </label>
  );
}
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="chat-settings-section">
      <h3>{title}</h3>
      <div className="chat-settings-group">{children}</div>
    </section>
  );
}
function LinkRow({
  icon,
  title,
  note,
  onClick,
  danger = false,
}: {
  icon: React.ReactNode;
  title: string;
  note?: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      className={`chat-settings-link ${danger ? "danger" : ""}`}
      onClick={onClick}
    >
      <span className="chat-settings-row-icon">{icon}</span>
      <span>
        <b>{title}</b>
        {note && <small>{note}</small>}
      </span>
      <ChevronRight />
    </button>
  );
}
function downloadFile(name: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}
const dateRange = (preview: ChatImportPreview) =>
  preview.firstAt
    ? `${new Date(preview.firstAt).toLocaleDateString("zh-CN")} – ${new Date(preview.lastAt ?? preview.firstAt).toLocaleDateString("zh-CN")}`
    : "无日期";
const normalizedProactive = (draft: ProactiveSettings): ProactiveSettings => ({
  ...draft,
  image: {
    frequency: draft.image?.frequency ?? "low",
    dailyLimit: Math.max(1, Math.min(10, draft.image?.dailyLimit ?? 1)),
    cooldownHours: Math.max(1, Math.min(720, draft.image?.cooldownHours ?? 24)),
    onlyWhenRelevant: draft.image?.onlyWhenRelevant ?? true,
    useCharacterReference: draft.image?.useCharacterReference ?? true,
    includeMessage: draft.image?.includeMessage ?? true,
    lastGeneratedAt: draft.image?.lastGeneratedAt,
  },
  message: draft.message.enabled
    ? {
        ...draft.message,
        intervalHours: draft.message.intervalHours ?? 12,
        catchupLimit: draft.message.catchupLimit ?? 1,
        dailyLimit: draft.message.dailyLimit ?? 3,
      }
    : draft.message,
  feed: draft.feed.enabled
    ? {
        ...draft.feed,
        intervalHours: draft.feed.intervalHours ?? 24,
        catchupLimit: draft.feed.catchupLimit ?? 1,
        dailyLimit: draft.feed.dailyLimit ?? 1,
      }
    : draft.feed,
});

export default function ChatSettingsPage() {
  const { id } = useParams(),
    nav = useNavigate(),
    {
      conversations,
      characters,
      loreBooks,
      messageWindows,
      loadConversationWindow,
      imageAssets,
      provider,
      settings,
      reload,
    } = useStore();
  const conversation = conversations.find((item) => item.id === id),
    members = characters.filter((character) =>
      conversation?.memberIds.includes(character.id),
    ),
    character = conversation?.type === "private" ? members[0] : undefined;
  const [conversationDraft, setConversationDraft] =
    useState<ConversationChatSettings>(() =>
      conversationChatSettingsOf(conversation, character),
    );
  const [characterDraft, setCharacterDraft] = useState(() =>
    chatSettingsOf(character ?? ({} as Character)),
  );
  const [proactiveDraft, setProactiveDraft] = useState<ProactiveSettings>(() =>
    character ? proactiveSettingsOf(character) : emptyProactiveSettings(),
  );
  const [memoryDraft, setMemoryDraft] = useState<MemoryExtractionSettings>(
    () =>
      character
        ? memoryExtractionSettingsOf(character)
        : defaultMemoryExtractionSettings(),
  );
  const [groupTitle, setGroupTitle] = useState(conversation?.title ?? "");
  const [groupMembers, setGroupMembers] = useState<Set<string>>(
    new Set(conversation?.memberIds ?? []),
  );
  const [groupNpcs, setGroupNpcs] = useState<GroupNpc[]>(
    conversation?.groupNpcs ?? [],
  );
  const [groupNpcAvatars, setGroupNpcAvatars] = useState<Map<string, string>>(
    new Map(),
  );
  const [groupBooks, setGroupBooks] = useState<Set<string>>(
    new Set(conversation?.loreBookIds ?? []),
  );
  const [groupAvatarId, setGroupAvatarId] = useState(
      conversation?.avatarAssetId ?? "",
    ),
    [groupAvatarUrl, setGroupAvatarUrl] = useState("");
  const [stickerPacks, setStickerPacks] = useState<StickerPack[]>([]),
    [speechSettings, setSpeechSettings] = useState<SpeechSettings | null>(null),
    [pendingMemoryCount, setPendingMemoryCount] = useState(0),
    [summarizing, setSummarizing] = useState(false),
    [messageText, setMessageText] = useState(""),
    [busyReply, setBusyReply] = useState(false),
    [saving, setSaving] = useState(false),
    [contextLimitDraft, setContextLimitDraft] = useState(
      character ? String(chatSettingsOf(character).contextLimit) : "",
    ),
    [minReplyDraft, setMinReplyDraft] = useState(
      character ? String(chatSettingsOf(character).minReplyMessages ?? "") : "",
    ),
    [maxReplyDraft, setMaxReplyDraft] = useState(
      character ? String(chatSettingsOf(character).maxReplyMessages ?? "") : "",
    ),
    [confirmAction, setConfirmAction] = useState<"clear" | "block" | null>(
      null,
    ),
    [confirmText, setConfirmText] = useState(""),
    [chatBackgroundUrlOpen,setChatBackgroundUrlOpen]=useState(false),
    [chatBackgroundUrl,setChatBackgroundUrl]=useState("");
  const [archive, setArchive] = useState<ChatArchive | null>(null),
    [archivePreview, setArchivePreview] = useState<ChatImportPreview | null>(
      null,
    ),
    [importMode, setImportMode] = useState<ChatImportMode>("merge"),
    fileRef = useRef<HTMLInputElement>(null),
    chatBackgroundRef = useRef<HTMLInputElement>(null),
    pendingChatBackgroundAssets = useRef<Set<string>>(new Set()),
    feedReferenceRef = useRef<HTMLInputElement>(null),
    groupAvatarRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void Promise.all([
      db.stickerPacks.orderBy("order").toArray(),
      getSpeechSettings(),
    ]).then(([packs, speech]) => {
      setStickerPacks(packs);
      setSpeechSettings(normalizeSpeechSettings(speech));
    });
  }, []);
  useEffect(() => {
    if (!character || !conversation) return;
    void pendingCount(character, "chat", conversation.id).then(
      setPendingMemoryCount,
    );
  }, [character?.id, conversation?.id, messageWindows[id ?? ""]?.items.length]);
  useEffect(() => {
    if (!conversation) return;
    setConversationDraft(conversationChatSettingsOf(conversation, character));
    setGroupTitle(conversation.title);
    setGroupMembers(new Set(conversation.memberIds));
    setGroupNpcs(conversation.groupNpcs ?? []);
    setGroupBooks(new Set(conversation.loreBookIds));
    setGroupAvatarId(conversation.avatarAssetId ?? "");
    if (conversation.avatarAssetId)
      void db.mediaAssets
        .get(conversation.avatarAssetId)
        .then((asset) => setGroupAvatarUrl(asset?.data ?? ""));
    else setGroupAvatarUrl("");
    const npcAssetIds = (conversation.groupNpcs ?? [])
      .map((npc) => npc.avatarAssetId)
      .filter(Boolean) as string[];
    if (npcAssetIds.length)
      void db.mediaAssets
        .bulkGet(npcAssetIds)
        .then((rows) =>
          setGroupNpcAvatars(
            new Map(
              rows.filter(Boolean).map((asset) => [asset!.id, asset!.data]),
            ),
          ),
        );
    else setGroupNpcAvatars(new Map());
    if (character) {
      const currentChat = chatSettingsOf(character);
      setCharacterDraft(currentChat);
      setContextLimitDraft(String(currentChat.contextLimit));
      setMinReplyDraft(String(currentChat.minReplyMessages ?? ""));
      setMaxReplyDraft(String(currentChat.maxReplyMessages ?? ""));
      setProactiveDraft(proactiveSettingsOf(character));
      setMemoryDraft(memoryExtractionSettingsOf(character));
    }
  }, [conversation?.id, conversation?.updatedAt, character?.updatedAt]);
  useEffect(()=>{ if(!id)return; void loadConversationWindow(id); },[id,loadConversationWindow]);
  const currentMessages = id ? (messageWindows[id]?.items ?? []) : [];
  useEffect(()=>{setBusyReply(currentMessages.some(message=>message.status==="generating"))},[currentMessages]);
  if (!conversation || !settings || !provider)
    return <Navigate to="/messages/chats" replace />;
  const title = conversationDisplayName(conversation, character),
    blocked = isCharacterBlocked(character),
    permissions = conversationDraft.permissions!,
    needsTranslation = members.some((member) =>
      shouldTranslateLanguage(member.language),
    );

  const updatePermission = (
    key: keyof NonNullable<ConversationChatSettings["permissions"]>,
    value: boolean,
  ) =>
    setConversationDraft((current) => ({
      ...current,
      permissions: { ...current.permissions!, [key]: value },
    }));
  const togglePack = (packId: string) =>
    setConversationDraft((current) => {
      const ids = new Set(current.proactiveStickerPackIds ?? []);
      ids.has(packId) ? ids.delete(packId) : ids.add(packId);
      return { ...current, proactiveStickerPackIds: [...ids] };
    });
  const chatBackgroundPreview=appearanceSourceUrl(conversationDraft.chatBackground,imageAssets);
  const chooseChatBackground=async(file?:File)=>{if(!file)return;setMessageText("");try{const asset=await compressImage(file,"chat-background");await db.imageAssets.put(asset);pendingChatBackgroundAssets.current.add(asset.id);setConversationDraft(current=>({...current,chatBackground:{type:"asset",value:asset.id}}))}catch(error){setMessageText(error instanceof Error?error.message:"聊天背景处理失败")}finally{if(chatBackgroundRef.current)chatBackgroundRef.current.value=""}};
  const applyChatBackgroundUrl=()=>{const value=chatBackgroundUrl.trim();if(!value)return;setConversationDraft(current=>({...current,chatBackground:{type:"url",value}}));setChatBackgroundUrlOpen(false);setChatBackgroundUrl("")};
  const clearChatBackground=()=>setConversationDraft(current=>({...current,chatBackground:undefined}));
  const save = async () => {
    setMessageText("");
    const contextLimit = Number(contextLimitDraft),
      hasMinReply = Boolean(minReplyDraft.trim()),
      hasMaxReply = Boolean(maxReplyDraft.trim()),
      minReplyMessages = hasMinReply ? Number(minReplyDraft) : undefined,
      maxReplyMessages = hasMaxReply ? Number(maxReplyDraft) : undefined;
    if (
      character &&
      (!contextLimitDraft.trim() ||
        !Number.isInteger(contextLimit) ||
        contextLimit < 2 ||
        contextLimit > 100)
    ) {
      setMessageText("上下文消息数需要填写 2–100 的整数。");
      return;
    }
    if (
      character &&
      (hasMinReply !== hasMaxReply ||
        (hasMinReply &&
          (!Number.isInteger(minReplyMessages) ||
            !Number.isInteger(maxReplyMessages) ||
            minReplyMessages! < 1 ||
            minReplyMessages! > 8 ||
            maxReplyMessages! < 1 ||
            maxReplyMessages! > 8 ||
            minReplyMessages! > maxReplyMessages!)))
    ) {
      setMessageText(
        "\u6700\u5c11\u548c\u6700\u591a\u6d88\u606f\u8981\u4e48\u540c\u65f6\u7559\u7a7a\u5e76\u7531\u89d2\u8272\u81ea\u7136\u51b3\u5b9a\uff0c\u8981\u4e48\u90fd\u586b\u5199 1\u20138 \u7684\u6574\u6570\uff0c\u4e14\u6700\u5c11\u6570\u4e0d\u80fd\u5927\u4e8e\u6700\u591a\u6570\u3002",
      );
      return;
    }
    const characterToSave = {
        ...characterDraft,
        contextLimit,
        minReplyMessages,
        maxReplyMessages,
        replyMessageRangeMode: hasMinReply ? ("fixed" as const) : ("adaptive" as const),
      },
      proactiveToSave = normalizedProactive(proactiveDraft),
      oldGroupAvatar = conversation.avatarAssetId;
    if (
      conversationDraft.permissions?.proactiveSticker &&
      !conversationDraft.proactiveStickerPackIds?.length
    ) {
      setMessageText("开启主动发表情包后，请至少选择一个表情包。");
      return;
    }
    if (character) {
      const invalid = (value: ProactiveSettings["message"]) =>
        value.enabled && !validChannel(value);
      if (invalid(proactiveToSave.message) || invalid(proactiveToSave.feed)) {
        setMessageText("主动互动的间隔与上限填写不完整。");
        return;
      }
      if (!validMemoryExtractionSettings(memoryDraft)) {
        setMessageText(
          "请检查记忆整理设置：自动阈值为 10–200 条，每批长期记忆为 1–12 条。",
        );
        return;
      }
    }
    if (
      conversation.type === "group" &&
      groupMembers.size + groupNpcs.filter((npc) => npc.active).length < 2
    ) {
      setMessageText("群聊至少保留两位可互动成员。");
      return;
    }
    setSaving(true);
    try {
      await db.transaction(
        "rw",
        [db.conversations, db.characters],
        async () => {
          await db.conversations.update(conversation.id, {
            title:
              conversation.type === "group"
                ? groupTitle.trim() || conversation.title
                : conversation.title,
            memberIds:
              conversation.type === "group"
                ? [...groupMembers]
                : conversation.memberIds,
            groupNpcs:
              conversation.type === "group"
                ? groupNpcs
                : conversation.groupNpcs,
            loreBookIds:
              conversation.type === "group"
                ? [...groupBooks]
                : conversation.loreBookIds,
            avatarAssetId:
              conversation.type === "group"
                ? groupAvatarId || undefined
                : conversation.avatarAssetId,
            chatSettings: {
              ...conversationDraft,
              remark:
                conversationDraft.remark?.trim().slice(0, 30) || undefined,
            },
            updatedAt: now(),
          });
          if (character)
            await db.characters.update(character.id, {
              chatSettings: {
                ...characterToSave,
                autoTranslate:
                  conversation.type === "group"
                    ? characterToSave.autoTranslate
                    : (conversationDraft.autoTranslate ?? true),
                meetInvitations: {
                  enabled:
                    conversationDraft.permissions?.proactiveMeetInvitation ??
                    false,
                },
              },
              language: characterToSave.language,
              proactiveSettings: proactiveToSave,
              memoryExtractionSettings: {
                enabled: memoryDraft.enabled,
                mode: memoryDraft.mode,
                chatThreshold: memoryDraft.chatThreshold,
                maxMemoriesPerBatch: memoryDraft.maxMemoriesPerBatch,
                includeSummary: memoryDraft.includeSummary,
                autoSaveHighConfidence: memoryDraft.autoSaveHighConfidence,
                meetMemoryEnabled: memoryDraft.meetMemoryEnabled,
              },
              loreBookIds: groupBooks.size
                ? [...groupBooks]
                : character.loreBookIds,
              updatedAt: now(),
            });
        },
      );
      if (
        conversation.type === "group" &&
        oldGroupAvatar &&
        oldGroupAvatar !== groupAvatarId
      )
        await deleteMediaIfUnused(oldGroupAvatar);
      const oldBackground=conversation.chatSettings?.chatBackground;
      await reload();
      if(oldBackground?.type==="asset"&&oldBackground.value!==conversationDraft.chatBackground?.value)void deleteImageAssetIfUnused(oldBackground.value);
      for(const assetId of pendingChatBackgroundAssets.current)if(assetId!==conversationDraft.chatBackground?.value)void deleteImageAssetIfUnused(assetId);
      pendingChatBackgroundAssets.current.clear();
      setMessageText("已保存当前聊天设置");
      window.dispatchEvent(new Event("mira:proactive-check"));
    } finally {
      setSaving(false);
    }
  };
  const chooseGroupAvatar = async (file?: File) => {
    if (!file || conversation.type !== "group") return;
    const old = groupAvatarId,
      asset = await saveImageMedia(file, "group-avatar");
    setGroupAvatarId(asset.id);
    setGroupAvatarUrl(asset.data);
  };
  const removeGroupAvatar = async () => {
    const old = groupAvatarId;
    setGroupAvatarId("");
    setGroupAvatarUrl("");
  };
  const chooseFeedReference = async (file?: File) => {
    if (!file || !character) return;
    const old = characterDraft.feedImage?.referenceAssetId,
      asset = await saveImageMedia(file, "feed-reference");
    setCharacterDraft((current) => ({
      ...current,
      feedImage: {
        enabled: current.feedImage?.enabled ?? false,
        appearancePrompt: current.feedImage?.appearancePrompt ?? "",
        referenceAssetId: asset.id,
      },
    }));
    if (old) await deleteMediaIfUnused(old);
    if (feedReferenceRef.current) feedReferenceRef.current.value = "";
  };
  const exportJson = async () => {
    const data = await createChatArchive(conversation);
    downloadFile(
      `${title}-聊天记录.json`,
      "application/json",
      stringifyChatArchive(data),
    );
  };
  const exportText = async () => {
    const allMessages = await db.messages
      .where("conversationId")
      .equals(conversation.id)
      .sortBy("createdAt");
    downloadFile(
      `${title}-聊天记录.txt`,
      "text/plain;charset=utf-8",
      chatArchiveToText(conversation, allMessages, characters, settings.userName),
    );
  };
  const readImport = async (file?: File) => {
    if (!file) return;
    try {
      const parsed = parseChatArchive(await file.text()),
        preview = await previewChatImport(parsed, conversation);
      setArchive(parsed);
      setArchivePreview(preview);
      setMessageText("");
    } catch (error) {
      setMessageText(
        error instanceof Error ? error.message : "无法读取聊天文件",
      );
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const doImport = async () => {
    if (!archive) return;
    setSaving(true);
    try {
      await importChatArchive(archive, conversation, importMode);
      setArchive(null);
      setArchivePreview(null);
      await reload();
      setMessageText(
        importMode === "merge" ? "聊天记录已合并" : "聊天记录已替换",
      );
    } catch (error) {
      setMessageText(
        error instanceof Error ? error.message : "导入失败，原聊天记录未修改",
      );
    } finally {
      setSaving(false);
    }
  };
  const doDanger = async () => {
    if (confirmText !== "删除" && confirmText !== "拉黑") return;
    if (confirmAction === "clear") {
      await clearConversationMessages(conversation);
      await reload();
      setMessageText("当前聊天记录已清空");
    } else if (confirmAction === "block" && character) {
      await db.characters.update(character.id, {
        contactState: { status: "blocked", blockedAt: now() },
        updatedAt: now(),
      });
      await reload();
      setMessageText("已拉黑该角色，聊天已变为只读");
    }
    setConfirmAction(null);
    setConfirmText("");
  };
  const unblock = async () => {
    if (!character) return;
    await db.characters.update(character.id, {
      contactState: { status: "friend" },
      updatedAt: now(),
    });
    await reload();
    setMessageText("已解除拉黑");
  };
  const summarizeNow = async () => {
    if (!character || !provider) return;
    setMessageText("");
    if (!provider.apiKey.trim()) {
      setMessageText("请先在设置 App 中配置主 API 或副 API。");
      return;
    }
    if (!pendingMemoryCount) {
      setMessageText("当前没有尚未整理的新消息。");
      return;
    }
    setSummarizing(true);
    try {
      const summaryProvider = await resolveSecondaryProvider(provider);
      await createExtractionBatch(
        summaryProvider,
        character,
        "chat",
        conversation.id,
        {
          limit: Math.min(pendingMemoryCount, memoryDraft.chatThreshold ?? 100),
          maxMemories: memoryDraft.maxMemoriesPerBatch,
          includeSummary: memoryDraft.includeSummary,
        },
      );
      await reload();
      setPendingMemoryCount(
        await pendingCount(character, "chat", conversation.id),
      );
      setMessageText("已生成记忆整理候选，请前往记忆 App 审核后保存。");
    } catch (error) {
      setMessageText(error instanceof Error ? error.message : "手动整理失败");
    } finally {
      setSummarizing(false);
    }
  };
  useEffect(()=>()=>{for(const assetId of pendingChatBackgroundAssets.current)void deleteImageAssetIfUnused(assetId)},[]);
  return (
    <div className="chat-settings-page">
      <header className="chat-settings-topbar">
        <button
          onClick={() => nav(`/messages/${conversation.id}`)}
          aria-label="返回聊天"
        >
          <ArrowLeft />
        </button>
        <b>聊天设置</b>
        <button
          className="chat-settings-save"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "保存中" : "完成"}
        </button>
      </header>
      <main>
        <section className="chat-settings-profile">
          <Avatar
            text={title}
            src={character?.avatar ?? groupAvatarUrl}
            size="lg"
          />
          <h2>{title}</h2>
          <p>
            {conversation.type === "private"
              ? character?.name
              : `${members.length} 位成员`}
          </p>
          <div>
            <button
              onClick={() =>
                nav(`/messages/${conversation.id}/search?favorites=1`)
              }
            >
              <Star />
              <span>收藏</span>
            </button>
            <button onClick={() => fileRef.current?.click()}>
              <Upload />
              <span>导入</span>
            </button>
            <button onClick={() => void exportJson()}>
              <Download />
              <span>导出</span>
            </button>
          </div>
        </section>
        {blocked && (
          <div className="chat-settings-blocked">
            <ShieldBan />
            <span>
              <b>已拉黑</b>
              <small>历史记录仍会保留，当前聊天只读。</small>
            </span>
            <button onClick={() => void unblock()}>解除</button>
          </div>
        )}
        {conversation.type === "private" && (
          <Section title="资料">
            <label className="chat-settings-field">
              <span>
                角色备注<small>只改变界面显示，不会写入模型上下文</small>
              </span>
              <input
                maxLength={30}
                value={conversationDraft.remark ?? ""}
                onChange={(event) =>
                  setConversationDraft({
                    ...conversationDraft,
                    remark: event.target.value,
                  })
                }
                placeholder={character?.name}
              />
            </label>
          </Section>
        )}
        {conversation.type === "group" && (
          <Section title="群聊资料">
            <div className="group-settings-avatar">
              <span>
                {groupAvatarUrl ? (
                  <img src={groupAvatarUrl} alt="群头像" />
                ) : (
                  <Users />
                )}
              </span>
              <div>
                <b>群头像</b>
                <small>未设置时继续显示成员组合头像</small>
              </div>
              <button
                type="button"
                className="group-avatar-change"
                onClick={() => groupAvatarRef.current?.click()}
              >
                <Camera />
                更换头像
              </button>
              <input
                className="group-avatar-file"
                ref={groupAvatarRef}
                hidden
                type="file"
                accept="image/*"
                onChange={(event) =>
                  void chooseGroupAvatar(event.target.files?.[0])
                }
              />
              {groupAvatarId && (
                <button
                  type="button"
                  className="group-avatar-remove"
                  aria-label="移除群头像"
                  onClick={() => void removeGroupAvatar()}
                >
                  <Trash2 />
                </button>
              )}
            </div>
            <label className="chat-settings-field">
              <span>群聊名称</span>
              <input
                maxLength={30}
                value={groupTitle}
                onChange={(event) => setGroupTitle(event.target.value)}
              />
            </label>
            <SwitchRow
              title="用户在群内"
              note="关闭后进入上帝视角，输入内容会成为仅你可见的幕后指导"
              checked={conversationDraft.userInGroup ?? true}
              onChange={(value) =>
                setConversationDraft({
                  ...conversationDraft,
                  userInGroup: value,
                })
              }
            />
            <div className="group-member-strip">
              {members
                .filter((item) => groupMembers.has(item.id))
                .map((item) => (
                  <button
                    key={item.id}
                    disabled={
                      groupMembers.size +
                        groupNpcs.filter((npc) => npc.active).length <=
                      2
                    }
                    onClick={() =>
                      setGroupMembers((current) => {
                        if (
                          current.size +
                            groupNpcs.filter((npc) => npc.active).length <=
                          2
                        )
                          return current;
                        const next = new Set(current);
                        next.delete(item.id);
                        return next;
                      })
                    }
                  >
                    <Avatar text={item.name} src={item.avatar} size="sm" />
                    <span>{item.name}</span>
                  </button>
                ))}
              {groupNpcs
                .filter((npc) => npc.active)
                .map((npc) => (
                  <button
                    key={npc.id}
                    disabled={
                      groupMembers.size +
                        groupNpcs.filter((item) => item.active).length <=
                      2
                    }
                    onClick={() =>
                      setGroupNpcs((current) =>
                        current.map((item) =>
                          item.id === npc.id
                            ? { ...item, active: false, updatedAt: now() }
                            : item,
                        ),
                      )
                    }
                  >
                    <Avatar
                      text={npc.name}
                      src={
                        npc.avatarAssetId
                          ? groupNpcAvatars.get(npc.avatarAssetId)
                          : undefined
                      }
                      size="sm"
                    />
                    <span>{npc.name}</span>
                  </button>
                ))}
              <button
                className="group-member-add"
                onClick={() => nav(`/messages/${conversation.id}/members/add`)}
              >
                <Plus />
                <span>邀请</span>
              </button>
            </div>
            <small className="group-member-hint">
              点击成员可移出群聊，至少保留两位角色或 NPC。
            </small>
          </Section>
        )}
        <Section title="外观">
          <label className="chat-settings-field">
            <span>当前聊天气泡</span>
            <select
              value={conversationDraft.bubbleStyle}
              onChange={(event) =>
                setConversationDraft({
                  ...conversationDraft,
                  bubbleStyle: event.target
                    .value as ConversationChatSettings["bubbleStyle"],
                })
              }
            >
              <option value="inherit">跟随全局外观</option>
              <option value="default">iMessage 默认气泡</option>
              <option value="kawaii">奶油粉气泡</option>
            </select>
          </label>
          <div className="chat-background-setting">
            <div className={`chat-background-preview ${chatBackgroundPreview?"has-image":""}`} style={chatBackgroundPreview?{backgroundImage:`linear-gradient(rgba(247,247,248,.28),rgba(247,247,248,.28)),url(${JSON.stringify(chatBackgroundPreview)})`}:undefined}><span>{chatBackgroundPreview?"当前聊天背景":"默认聊天背景"}</span></div>
            <div className="chat-background-actions"><button type="button" onClick={()=>chatBackgroundRef.current?.click()}><Upload/>相册</button><button type="button" onClick={()=>{setChatBackgroundUrlOpen(true);setChatBackgroundUrl(conversationDraft.chatBackground?.type==="url"?conversationDraft.chatBackground.value??"":"")}}><Link2/>URL</button><button type="button" disabled={!conversationDraft.chatBackground} onClick={clearChatBackground}><RefreshCw/>恢复默认</button></div>
            <input ref={chatBackgroundRef} hidden type="file" accept="image/*" onClick={event=>{event.currentTarget.value=""}} onChange={event=>void chooseChatBackground(event.currentTarget.files?.[0])}/>
          </div>
          <label className="chat-settings-slider">
            <span>
              <b>聊天头像大小</b>
              <output>{conversationDraft.characterAvatarSize}px</output>
            </span>
            <input
              type="range"
              min="24"
              max="56"
              value={conversationDraft.characterAvatarSize}
              onChange={(event) =>
                setConversationDraft({
                  ...conversationDraft,
                  characterAvatarSize: Number(event.target.value),
                })
              }
            />
          </label>
          <label className="chat-settings-slider">
            <span>
              <b>聊天字体大小</b>
              <output>{conversationDraft.fontScale}%</output>
            </span>
            <input
              type="range"
              min="85"
              max="135"
              value={conversationDraft.fontScale}
              onChange={(event) =>
                setConversationDraft({
                  ...conversationDraft,
                  fontScale: Number(event.target.value),
                })
              }
            />
          </label>
        </Section>
        <Section title="消息翻译">
          <SwitchRow
            title="自动翻译角色消息"
            note={
              needsTranslation
                ? "原文和中文译文会在同一次角色回复中一起生成。"
                : "当前聊天中的角色语言无需翻译。"
            }
            checked={conversationDraft.autoTranslate ?? true}
            onChange={(value) =>
              setConversationDraft({
                ...conversationDraft,
                autoTranslate: value,
              })
            }
          />
        </Section>
        {conversation.type === "group" && (
          <Section title={"\u89d2\u8272\u5fc3\u58f0"}>
            <SwitchRow
              title={"\u751f\u6210\u7fa4\u6210\u5458\u5fc3\u58f0"}
              note={"\u6bcf\u4f4d\u89d2\u8272\u548c NPC \u7684\u672c\u8f6e\u5fc3\u58f0\u4f1a\u4e0e\u56de\u590d\u540c\u65f6\u751f\u6210\uff0c\u70b9\u51fb\u5934\u50cf\u6216\u89d2\u8272\u540d\u67e5\u770b\u3002"}
              checked={conversationDraft.groupInnerVoiceEnabled ?? true}
              onChange={(value) =>
                setConversationDraft({
                  ...conversationDraft,
                  groupInnerVoiceEnabled: value,
                })
              }
            />
          </Section>
        )}
        {character && (
          <>
            <Section title="聊天显示">
              <SwitchRow
                title="显示用户头像"
                checked={characterDraft.avatars?.showUserAvatar ?? true}
                onChange={(value) =>
                  setCharacterDraft({
                    ...characterDraft,
                    avatars: {
                      showUserAvatar: value,
                      showCharacterAvatar:
                        characterDraft.avatars?.showCharacterAvatar ?? true,
                    },
                  })
                }
              />
              <SwitchRow
                title="显示角色头像"
                checked={characterDraft.avatars?.showCharacterAvatar ?? true}
                onChange={(value) =>
                  setCharacterDraft({
                    ...characterDraft,
                    avatars: {
                      showUserAvatar:
                        characterDraft.avatars?.showUserAvatar ?? true,
                      showCharacterAvatar: value,
                    },
                  })
                }
              />
              <label className="chat-settings-field">
                <span>输出语言</span>
                <select
                  value={characterDraft.language}
                  onChange={(event) =>
                    setCharacterDraft({
                      ...characterDraft,
                      language: event.target
                        .value as typeof characterDraft.language,
                    })
                  }
                >
                  {[
                    "中文",
                    "粤语",
                    "English",
                    "日本語",
                    "한국어",
                    "Русский",
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label className="chat-settings-field">
                <span>上下文消息数</span>
                <input
                  type="number"
                  min="2"
                  max="100"
                  value={contextLimitDraft}
                  onChange={(event) => {
                    setContextLimitDraft(event.target.value);
                    setMessageText("");
                  }}
                />
              </label>
              <div className="chat-settings-reply-range">
                <label className="chat-settings-field">
                  <span>最少回复条数</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="8"
                    value={minReplyDraft}
                    onChange={(event) => {
                      setMinReplyDraft(event.target.value);
                      setMessageText("");
                    }}
                  />
                </label>
                <label className="chat-settings-field">
                  <span>最多回复条数</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="8"
                    value={maxReplyDraft}
                    onChange={(event) => {
                      setMaxReplyDraft(event.target.value);
                      setMessageText("");
                    }}
                  />
                </label>
              </div>
              <p className="chat-settings-help">
                两项留空时，回复条数由当前上下文和角色人设自然决定；填写后每条会保存成独立气泡。
              </p>
              <SwitchRow
                title="攻略模式"
                note="根据每轮互动计算亲密度与信任度"
                checked={characterDraft.strategyMode?.enabled ?? false}
                onChange={(value) =>
                  setCharacterDraft({
                    ...characterDraft,
                    strategyMode: { enabled: value },
                  })
                }
              />
              {characterDraft.strategyMode?.enabled && (
                <div className="strategy-guide-card">
                  <header>
                    <Heart />
                    <div>
                      <b>攻略玩法</b>
                      <small>
                        当前亲密度 {character.relationship.intimacy}/100 ·
                        信任度 {character.relationship.trust}/100
                      </small>
                    </div>
                  </header>
                  <div className="strategy-bars">
                    <label>
                      <span>亲密度</span>
                      <i>
                        <em
                          style={{
                            width: `${character.relationship.intimacy}%`,
                          }}
                        />
                      </i>
                    </label>
                    <label>
                      <span>信任度</span>
                      <i>
                        <em
                          style={{ width: `${character.relationship.trust}%` }}
                        />
                      </i>
                    </label>
                  </div>
                  <ul>
                    <li>每条用户消息只评估一次，重新生成不会重复加分。</li>
                    <li>
                      真诚关心、守信与尊重边界更容易提升关系；刷屏通常不会加分。
                    </li>
                    <li>
                      每日正向上限：亲密度 +6、信任度 +4；冒犯或越界仍可能扣分。
                    </li>
                    <li>两项同时达到 100 后，只触发一次首次表白。</li>
                  </ul>
                  <small>
                    关闭后停止新的关系评估，但保留现有数值和关系事件。
                  </small>
                </div>
              )}
            </Section>
            <Section title="角色可用表情包分组">
              <div className="chat-sticker-mount-head">
                <span>
                  <b>
                    已挂载{" "}
                    {conversationDraft.proactiveStickerPackIds?.length ?? 0}{" "}
                    个分组
                  </b>
                  <small>
                    角色普通回复和主动消息只能使用这里挂载的表情包；用户仍可使用全部表情包。
                  </small>
                </span>
              </div>
              <div className="chat-settings-pack-list">
                {stickerPacks.length ? (
                  stickerPacks.map((pack) => (
                    <button
                      className={
                        conversationDraft.proactiveStickerPackIds?.includes(
                          pack.id,
                        )
                          ? "selected"
                          : ""
                      }
                      key={pack.id}
                      onClick={() => togglePack(pack.id)}
                    >
                      <span>{pack.name}</span>
                      <small>{pack.stickers.length} 个表情</small>
                    </button>
                  ))
                ) : (
                  <p>还没有表情包，请先前往表情包设置添加。</p>
                )}
              </div>
            </Section>
            <Section title="主动互动">
              <SwitchRow
                title="主动私聊"
                checked={proactiveDraft.message.enabled}
                onChange={(value) =>
                  setProactiveDraft((current) =>
                    normalizedProactive({
                      ...current,
                      message: { ...current.message, enabled: value },
                    }),
                  )
                }
              />
              <SwitchRow
                title="主动动态"
                checked={proactiveDraft.feed.enabled}
                onChange={(value) =>
                  setProactiveDraft((current) =>
                    normalizedProactive({
                      ...current,
                      feed: { ...current.feed, enabled: value },
                    }),
                  )
                }
              />
              <SwitchRow
                title="时间感知"
                checked={proactiveDraft.timeAware}
                onChange={(value) =>
                  setProactiveDraft({ ...proactiveDraft, timeAware: value })
                }
              />
              <div className="chat-settings-inline-fields">
                <label>
                  勿扰开始
                  <input
                    type="time"
                    value={proactiveDraft.quietStart}
                    onChange={(event) =>
                      setProactiveDraft({
                        ...proactiveDraft,
                        quietStart: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  勿扰结束
                  <input
                    type="time"
                    value={proactiveDraft.quietEnd}
                    onChange={(event) =>
                      setProactiveDraft({
                        ...proactiveDraft,
                        quietEnd: event.target.value,
                      })
                    }
                  />
                </label>
              </div>
              <div className="chat-settings-inline-fields">
                <label>
                  私聊间隔（小时）
                  <input
                    type="number"
                    min="1"
                    value={proactiveDraft.message.intervalHours ?? 12}
                    onChange={(event) =>
                      setProactiveDraft({
                        ...proactiveDraft,
                        message: {
                          ...proactiveDraft.message,
                          intervalHours: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  每日上限
                  <input
                    type="number"
                    min="1"
                    value={proactiveDraft.message.dailyLimit ?? 3}
                    onChange={(event) =>
                      setProactiveDraft({
                        ...proactiveDraft,
                        message: {
                          ...proactiveDraft.message,
                          dailyLimit: Number(event.target.value),
                          catchupLimit: Math.min(
                            proactiveDraft.message.catchupLimit ?? 1,
                            Number(event.target.value),
                          ),
                        },
                      })
                    }
                  />
                </label>
              </div>
              <div className="chat-settings-inline-fields">
                <label>
                  动态间隔（小时）
                  <input
                    type="number"
                    min="1"
                    value={proactiveDraft.feed.intervalHours ?? 24}
                    onChange={(event) =>
                      setProactiveDraft({
                        ...proactiveDraft,
                        feed: {
                          ...proactiveDraft.feed,
                          intervalHours: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  动态每日上限
                  <input
                    type="number"
                    min="1"
                    value={proactiveDraft.feed.dailyLimit ?? 1}
                    onChange={(event) =>
                      setProactiveDraft({
                        ...proactiveDraft,
                        feed: {
                          ...proactiveDraft.feed,
                          dailyLimit: Number(event.target.value),
                          catchupLimit: Math.min(
                            proactiveDraft.feed.catchupLimit ?? 1,
                            Number(event.target.value),
                          ),
                        },
                      })
                    }
                  />
                </label>
              </div>
              <SwitchRow
                title="生成真实图片"
                note="关闭后角色仍可根据人设发送不消耗生图额度的文字图片。"
                checked={permissions.proactiveChatImage}
                onChange={(value) =>
                  updatePermission("proactiveChatImage", value)
                }
              />
              <div className="chat-settings-inline-fields">
                <label>
                  图片频率
                  <select
                    value={proactiveDraft.image?.frequency ?? "low"}
                    onChange={(event) =>
                      setProactiveDraft({
                        ...proactiveDraft,
                        image: {
                          ...proactiveDraft.image!,
                          frequency: event.target.value as
                            "low" | "medium" | "high",
                        },
                      })
                    }
                  >
                    <option value="low">低</option>
                    <option value="medium">中</option>
                    <option value="high">高</option>
                  </select>
                </label>
                <label>
                  每日最多
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={proactiveDraft.image?.dailyLimit ?? 1}
                    onChange={(event) =>
                      setProactiveDraft({
                        ...proactiveDraft,
                        image: {
                          ...proactiveDraft.image!,
                          dailyLimit: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
              </div>
              <div className="chat-settings-inline-fields">
                <label>
                  最短间隔（小时）
                  <input
                    type="number"
                    min="1"
                    max="720"
                    value={proactiveDraft.image?.cooldownHours ?? 24}
                    onChange={(event) =>
                      setProactiveDraft({
                        ...proactiveDraft,
                        image: {
                          ...proactiveDraft.image!,
                          cooldownHours: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
              </div>
              <SwitchRow
                title="只在与聊天或生活相关时分享"
                checked={proactiveDraft.image?.onlyWhenRelevant ?? true}
                onChange={(value) =>
                  setProactiveDraft({
                    ...proactiveDraft,
                    image: {
                      ...proactiveDraft.image!,
                      onlyWhenRelevant: value,
                    },
                  })
                }
              />
              <SwitchRow
                title="使用角色参考图锁脸"
                checked={proactiveDraft.image?.useCharacterReference ?? true}
                onChange={(value) =>
                  setProactiveDraft({
                    ...proactiveDraft,
                    image: {
                      ...proactiveDraft.image!,
                      useCharacterReference: value,
                    },
                  })
                }
              />
              <SwitchRow
                title="图片附带角色文字"
                checked={proactiveDraft.image?.includeMessage ?? true}
                onChange={(value) =>
                  setProactiveDraft({
                    ...proactiveDraft,
                    image: { ...proactiveDraft.image!, includeMessage: value },
                  })
                }
              />
              <SwitchRow
                title="允许主动语音通话"
                checked={permissions.proactiveVoiceCall}
                onChange={(value) =>
                  updatePermission("proactiveVoiceCall", value)
                }
              />
              <SwitchRow
                title="允许主动视频通话"
                checked={permissions.proactiveVideoCall}
                onChange={(value) =>
                  updatePermission("proactiveVideoCall", value)
                }
              />
              <SwitchRow
                title="允许主动发起线下邀约"
                checked={permissions.proactiveMeetInvitation}
                onChange={(value) =>
                  updatePermission("proactiveMeetInvitation", value)
                }
              />
              <SwitchRow
                title="允许角色发表情包"
                checked={permissions.proactiveSticker}
                onChange={(value) =>
                  updatePermission("proactiveSticker", value)
                }
              />
            </Section>
            <Section title="动态配图">
              <div className="face-lock-status">
                <b>严格锁脸已启用</b>
                <small>
                  {character.visualProfile
                    ? "角色视觉身份已建立，资料或参考图改变后会自动重建。"
                    : "首次生图时将根据角色资料建立视觉身份。"}
                </small>
              </div>
              <SwitchRow
                title="允许主动动态生成图片"
                checked={characterDraft.feedImage?.enabled ?? false}
                onChange={(value) =>
                  setCharacterDraft({
                    ...characterDraft,
                    feedImage: {
                      enabled: value,
                      appearancePrompt:
                        characterDraft.feedImage?.appearancePrompt ?? "",
                      referenceAssetId:
                        characterDraft.feedImage?.referenceAssetId,
                    },
                  })
                }
              />
              <label className="chat-settings-field vertical">
                <span>角色形象提示词</span>
                <textarea
                  rows={4}
                  value={characterDraft.feedImage?.appearancePrompt ?? ""}
                  onChange={(event) =>
                    setCharacterDraft({
                      ...characterDraft,
                      feedImage: {
                        enabled: characterDraft.feedImage?.enabled ?? false,
                        appearancePrompt: event.target.value,
                        referenceAssetId:
                          characterDraft.feedImage?.referenceAssetId,
                      },
                    })
                  }
                />
              </label>
              <button
                className="chat-settings-secondary"
                onClick={() => feedReferenceRef.current?.click()}
              >
                <ImagePlus />
                选择角色参考图
              </button>
              <input
                hidden
                ref={feedReferenceRef}
                type="file"
                accept="image/*"
                onChange={(event) =>
                  void chooseFeedReference(event.target.files?.[0])
                }
              />
            </Section>
            <Section title="记忆整理">
              <div className="chat-memory-summary">
                <span>
                  <BrainCircuit />
                </span>
                <div>
                  <b>
                    {memoryDraft.enabled
                      ? `${pendingMemoryCount} 条消息等待整理`
                      : "海马体记忆已关闭"}
                  </b>
                  <small>
                    {!memoryDraft.enabled
                      ? "角色将停止形成和调用长期记忆，已有记忆不会删除"
                      : memoryDraft.mode === "auto"
                        ? `累计 ${memoryDraft.chatThreshold} 条后自动整理；高置信记忆可自动保存`
                        : `当前为手动整理，不会自动调用模型`}
                  </small>
                </div>
              </div>
              <SwitchRow
                title="海马体记忆"
                note="关闭后停止形成、向量化和调用长期记忆；已有记忆不会删除"
                checked={memoryDraft.enabled}
                onChange={(value) =>
                  setMemoryDraft({ ...memoryDraft, enabled: value })
                }
              />
              <label className="chat-settings-field">
                <span>整理方式</span>
                <select
                  value={memoryDraft.mode}
                  onChange={(event) =>
                    setMemoryDraft({
                      ...memoryDraft,
                      mode: event.target
                        .value as MemoryExtractionSettings["mode"],
                    })
                  }
                >
                  <option value="manual">仅手动整理</option>
                  <option value="auto">自动整理</option>
                </select>
              </label>
              {memoryDraft.enabled && memoryDraft.mode === "auto" && (
                <label className="chat-settings-field">
                  <span>每累计多少条消息自动整理一次</span>
                  <input
                    type="number"
                    min="10"
                    max="200"
                    value={memoryDraft.chatThreshold}
                    onChange={(event) =>
                      setMemoryDraft({
                        ...memoryDraft,
                        chatThreshold: Number(event.target.value),
                      })
                    }
                  />
                  <small>
                    范围 10–200 条；只统计上一次确认或放弃之后的新消息。
                  </small>
                </label>
              )}
              <label className="chat-settings-field">
                <span>每批最多提取的长期记忆</span>
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={memoryDraft.maxMemoriesPerBatch}
                  onChange={(event) =>
                    setMemoryDraft({
                      ...memoryDraft,
                      maxMemoriesPerBatch: Number(event.target.value),
                    })
                  }
                />
                <small>阶段摘要不计入这个数量，范围 1–12 条。</small>
              </label>
              <SwitchRow
                title="同时生成阶段摘要"
                note="关闭后只提取事实、剧情与关系记忆"
                checked={memoryDraft.includeSummary}
                onChange={(value) =>
                  setMemoryDraft({ ...memoryDraft, includeSummary: value })
                }
              />
              <SwitchRow
                title="高置信记忆自动保存"
                note="置信度达到 0.78 且无冲突时直接保存，其他内容进入待审核"
                checked={memoryDraft.autoSaveHighConfidence}
                onChange={(value) =>
                  setMemoryDraft({
                    ...memoryDraft,
                    autoSaveHighConfidence: value,
                  })
                }
              />
              <SwitchRow
                title="见面内容进入记忆"
                note="见面结束后为正式参与角色整理独立记忆"
                checked={memoryDraft.meetMemoryEnabled}
                onChange={(value) =>
                  setMemoryDraft({ ...memoryDraft, meetMemoryEnabled: value })
                }
              />
              <button
                className="chat-settings-secondary chat-memory-manual"
                disabled={
                  !memoryDraft.enabled || summarizing || !pendingMemoryCount
                }
                onClick={() => void summarizeNow()}
              >
                {summarizing ? (
                  <RefreshCw className="spin" />
                ) : (
                  <BrainCircuit />
                )}
                {summarizing
                  ? "正在整理…"
                  : `手动整理当前 ${pendingMemoryCount} 条消息`}
              </button>
              <LinkRow
                icon={<BrainCircuit />}
                title="查看记忆与待审核结果"
                note="候选记忆确认后才会正式保存"
                onClick={() => nav("/memories")}
              />
            </Section>
            <Section title="世界书">
              <div className="chat-settings-picks books">
                {loreBooks.length ? (
                  loreBooks.map((book) => (
                    <button
                      key={book.id}
                      className={groupBooks.has(book.id) ? "selected" : ""}
                      onClick={() =>
                        setGroupBooks((current) => {
                          const next = new Set(current);
                          next.has(book.id)
                            ? next.delete(book.id)
                            : next.add(book.id);
                          return next;
                        })
                      }
                    >
                      <BookOpen />
                      <span>{book.name}</span>
                    </button>
                  ))
                ) : (
                  <p className="chat-settings-inline-empty">
                    还没有世界书，可前往世界书 App 创建。
                  </p>
                )}
              </div>
            </Section>
            {character && (
              <Section title="消息通知">
                <SwitchRow
                  title="允许角色消息通知"
                  note="角色主动发来私聊时显示系统通知"
                  checked={conversationDraft.notifications?.messages ?? true}
                  onChange={(value) =>
                    setConversationDraft({
                      ...conversationDraft,
                      notifications: {
                        messages: value,
                        calls: conversationDraft.notifications?.calls ?? true,
                        previewContent:
                          conversationDraft.notifications?.previewContent ??
                          "inherit",
                      },
                    })
                  }
                />
                <SwitchRow
                  title="允许角色来电通知"
                  note="主动语音或视频来电时显示通知"
                  checked={conversationDraft.notifications?.calls ?? true}
                  onChange={(value) =>
                    setConversationDraft({
                      ...conversationDraft,
                      notifications: {
                        messages:
                          conversationDraft.notifications?.messages ?? true,
                        calls: value,
                        previewContent:
                          conversationDraft.notifications?.previewContent ??
                          "inherit",
                      },
                    })
                  }
                />
                <label className="chat-settings-field">
                  <span>通知正文</span>
                  <select
                    value={
                      conversationDraft.notifications?.previewContent ??
                      "inherit"
                    }
                    onChange={(event) =>
                      setConversationDraft({
                        ...conversationDraft,
                        notifications: {
                          messages:
                            conversationDraft.notifications?.messages ?? true,
                          calls: conversationDraft.notifications?.calls ?? true,
                          previewContent: event.target.value as
                            "inherit" | "show" | "hide",
                        },
                      })
                    }
                  >
                    <option value="inherit">跟随设置 App</option>
                    <option value="show">显示消息正文</option>
                    <option value="hide">隐藏消息正文</option>
                  </select>
                </label>
              </Section>
            )}
            <Section title="语音与通话">
              <label className="chat-settings-field chat-settings-speech-preset-field">
                <span>当前角色语音预设</span>
                <select
                  value={
                    normalizeCharacterSpeech(characterDraft.speech).presetId ??
                    ""
                  }
                  onChange={(event) => {
                    const presetId = event.target.value || undefined,
                      current = normalizeCharacterSpeech(characterDraft.speech);
                    setCharacterDraft({
                      ...characterDraft,
                      speech: {
                        ...current,
                        enabled: true,
                        provider: "inherit",
                        presetId,
                      },
                    });
                  }}
                >
                  <option value="">跟随全局默认语音服务</option>
                  {speechSettings?.presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name} ·{" "}
                      {preset.provider === "minimax" ? "MiniMax" : "ElevenLabs"}
                    </option>
                  ))}
                </select>
                <small>
                  {speechSettings?.presets.length
                    ? "选择后会使用预设中的服务、模型、音色和声音参数。"
                    : "还没有语音预设，请先前往语音服务页面创建。"}
                </small>
              </label>
              <LinkRow
                icon={<Volume2 />}
                title="管理语音服务与预设"
                note="配置 API、音色并保存多个角色语音方案"
                onClick={() =>
                  nav(
                    `/settings/speech?characterId=${character.id}&conversationId=${conversation.id}`,
                  )
                }
              />
            </Section>
          </>
        )}
        {conversation.type === "group" && (
          <Section title="群聊世界书">
            <div className="chat-settings-picks books">
              {loreBooks.map((book) => (
                <button
                  key={book.id}
                  className={groupBooks.has(book.id) ? "selected" : ""}
                  onClick={() =>
                    setGroupBooks((current) => {
                      const next = new Set(current);
                      next.has(book.id)
                        ? next.delete(book.id)
                        : next.add(book.id);
                      return next;
                    })
                  }
                >
                  <BookOpen />
                  <span>{book.name}</span>
                </button>
              ))}
            </div>
          </Section>
        )}
        <Section title="聊天记录">
          <LinkRow
            icon={<Search />}
            title="搜索聊天记录"
            onClick={() => nav(`/messages/${conversation.id}/search`)}
          />
          <LinkRow
            icon={<Download />}
            title="导出 JSON"
            note="可再次导入，包含消息与媒体"
            onClick={() => void exportJson()}
          />
          <LinkRow
            icon={<Download />}
            title="导出 TXT"
            note="只读时间线，不能导入"
            onClick={exportText}
          />
          <LinkRow
            icon={<Upload />}
            title="导入聊天记录"
            onClick={() => fileRef.current?.click()}
          />
          <input
            hidden
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            onChange={(event) => void readImport(event.target.files?.[0])}
          />
        </Section>
        <Section title="危险操作">
          <LinkRow
            danger
            icon={<Trash2 />}
            title="删除全部聊天记录"
            note="不会删除关系、记忆、订单和设置"
            onClick={() => {
              setConfirmAction("clear");
              setConfirmText("");
            }}
          />
          {character &&
            (blocked ? (
              <LinkRow
                icon={<UserRound />}
                title="解除拉黑"
                onClick={() => void unblock()}
              />
            ) : (
              <LinkRow
                danger
                icon={<ShieldBan />}
                title="拉黑角色"
                note="聊天会变为只读，历史记录保留"
                onClick={() => {
                  setConfirmAction("block");
                  setConfirmText("");
                }}
              />
            ))}
        </Section>
        {messageText && <p className="chat-settings-message">{messageText}</p>}
      </main>
      {archive && archivePreview && (
        <Modal
          onClose={() => {
            setArchive(null);
            setArchivePreview(null);
          }}
        >
          <div className="chat-import-modal">
            <button
              className="close"
              onClick={() => {
                setArchive(null);
                setArchivePreview(null);
              }}
            >
              <X />
            </button>
            <Upload />
            <h2>导入聊天记录</h2>
            <div className="chat-import-stats">
              <span>
                <b>{archivePreview.messageCount}</b> 条消息
              </span>
              <span>
                <b>{archivePreview.mediaCount}</b> 个媒体
              </span>
              <span>
                <b>{archivePreview.conflictCount}</b> 个冲突
              </span>
            </div>
            <p>{dateRange(archivePreview)}</p>
            <label>
              <input
                type="radio"
                checked={importMode === "merge"}
                onChange={() => setImportMode("merge")}
              />
              <span>
                <b>合并</b>
                <small>按消息 ID 去重后追加</small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                checked={importMode === "replace"}
                onChange={() => setImportMode("replace")}
              />
              <span>
                <b>替换</b>
                <small>先清空当前聊天，再恢复文件</small>
              </span>
            </label>
            <button
              className="primary"
              disabled={saving}
              onClick={() => void doImport()}
            >
              {saving ? "正在导入…" : "确认导入"}
            </button>
          </div>
        </Modal>
      )}
      {confirmAction && (
        <Modal onClose={() => setConfirmAction(null)}>
          <div className="chat-danger-modal">
            <Trash2 />
            <h2>
              {confirmAction === "clear"
                ? "删除全部聊天记录？"
                : "拉黑这个角色？"}
            </h2>
            <p>
              {confirmAction === "clear"
                ? "只删除当前会话中的消息和未再使用的媒体。请输入“删除”确认。"
                : "拉黑后双方都不能继续互动，角色之后仍可能重新发送好友申请。请输入“拉黑”确认。"}
            </p>
            <input
              autoFocus
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder={confirmAction === "clear" ? "删除" : "拉黑"}
            />
            <button
              className="danger-button"
              disabled={
                confirmText !== (confirmAction === "clear" ? "删除" : "拉黑")
              }
              onClick={() => void doDanger()}
            >
              {confirmAction === "clear" ? "永久删除" : "确认拉黑"}
            </button>
            <button
              className="cancel-button"
              onClick={() => setConfirmAction(null)}
            >
              取消
            </button>
          </div>
        </Modal>
      )}
        {chatBackgroundUrlOpen&&<Modal onClose={()=>setChatBackgroundUrlOpen(false)}><div className="sheet-head"><div><small>CHAT BACKGROUND</small><h2>使用网络背景</h2></div><button onClick={()=>setChatBackgroundUrlOpen(false)}><X/></button></div><label className="field"><span>图片地址</span><input type="url" value={chatBackgroundUrl} onChange={event=>setChatBackgroundUrl(event.currentTarget.value)} placeholder="https://example.com/background.jpg"/></label><p className="form-note">网络图片失效时会自动显示默认聊天背景。</p><button className="primary" disabled={!chatBackgroundUrl.trim()} onClick={applyChatBackgroundUrl}>使用这个地址</button></Modal>}
    </div>
  );
}

function providerHost(value: string) {
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}


