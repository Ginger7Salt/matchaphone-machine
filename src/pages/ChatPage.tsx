import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUp,
  BookOpen,
  Check,
  Copy,
  Edit3,
  Forward,
  ImageDown,
  ImagePlus,
  MoreHorizontal,
  Phone,
  Plus,
  ShieldBan,
  RefreshCw,
  SendHorizonal,
  Settings,
  SmilePlus,
  Sparkles,
  Square,
  Star,
  Video,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import CallOverlay from "../components/CallOverlay";
import { InnerVoiceDialog } from "../components/InnerVoiceCard";
import {
  ChatSelectionCapturePreview,
  type ChatCaptureActor,
} from "../components/ChatSelectionCapturePreview";
import { Avatar, Modal } from "../components/ui";
import {
  ExtensionPanel,
  PhotoPanel,
  PollPanel,
  RedPacketPanel,
  RichMessageContent,
  StickerPicker,
  TransferPanel,
  VoicePanel,
  type ChatMediaPanel,
} from "../components/ChatMedia";
import {
  ComposerQuotePreview,
  MessageActionOverlay,
  MessageQuoteCard,
  MessageReactionBadge,
  type MessageActionAnchor,
} from "../components/MessageInteractions";
import { RegenerationDialog } from "../components/RegenerationDialog";
import { db } from "../core/db";
import { cleanupMoodImprintsForDeletedMessages } from "../core/musicMoodImprint";
import { isCardOnlyMessage, isStandaloneInvitationCard } from "../core/messagePresentation";
import { pauseActiveMeetForOnlineActivity } from "../core/crossModeContinuity";
import {
  prepareRoleplayResources,
  reviewCharacterReply,
} from "../core/personaEngine";
import { recallMemoriesWithEmbeddings } from "../core/embedding";
import { chatSettingsOf } from "../core/character";
import { conversationInnerVoiceEnabled } from "../core/innerVoice";
import {
  canCharacterInteract,
  contactStatusOf,
  conversationChatSettingsOf,
  conversationDisplayName,
  isCharacterBlocked,
  resolvedConversationBubble,
} from "../core/conversationSettings";
import {
  emptyProactiveSettings,
  proactiveSettingsOf,
  validChannel,
} from "../core/proactiveRules";
import {
  defaultMemoryExtractionSettings,
  memoryExtractionSettingsOf,
  pendingCount,
  validMemoryExtractionSettings,
} from "../core/memoryExtraction";
import {
  createGroupPoll,
  createGroupRedPacket,
  generateCharacterPollVotes,
  saveDirectorInstruction,
} from "../core/groupFeatures";
import {
  formatForward,
  forwardMessages,
  refreshConversationActivity,
} from "../core/messages";
import { groupActors } from "../core/groupNpcs";
import { deleteMediaIfUnused, saveImageMedia } from "../core/mediaAssets";
import { describeImageWithVision } from "../core/modelServices";
import { useStore } from "../core/store";
import {appearanceSourceUrl} from "../core/imageAssetUsage";
import { useMusicPlayer } from "../core/musicPlayer";
import { createMusicInvitationMessage, respondMusicInvitation } from "../core/music";
import { createCoupleIslandInvitation } from "../core/coupleIsland";
import { createOutgoingWalletTransfer } from "../core/mall";
import {
  now,
  SCHEMA_VERSION,
  uid,
  type ApiErrorInfo,
  type Character,
  type ChatReplyPhase,
  type MediaAsset,
  type Message,
  type MessageQuote,
  type MessageReactionKind,
  type ProviderPresetState,
  type StickerItem,
  type StickerPack,
  type RegenerationReason,
} from "../core/types";
import {
  canRegenerateMessage,
  createMessageQuote,
  selectMessageRange,
  toggleUserReaction,
  userReactionOf,
} from "../core/messageInteractions";
import { createExtractionBatch } from "../core/memoryExtraction";
import { preloadChatCapture } from "../core/chatCapture";
import {
  chatReplyDiagnostic,
  enqueueChatReply,
  ensureRunnableChatReplyTask,
  retryChatReply,
  stopChatReply,
} from "../core/chatReplyTasks";
import {wakeChatReplyPump} from "../core/chatReplyRunner";
import {
  emptyProviderPresetState,
  getProviderPresetState,
  resolveConversationProvider,
} from "../core/providerPresets";
import {
  translatableCharacterMessage,
  translateChatMessage,
} from "../core/chatTranslation";
import type {
  Language,
  MemoryExtractionSettings,
  ProactiveSettings,
} from "../core/types";

const stamp = (t: number) =>
  new Date(t).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
type Popup =
  | ChatMediaPanel
  | "actions"
  | "edit"
  | "delete"
  | "bulk-delete"
  | "forward"
  | "group"
  | "delete-group"
  | "chat-menu"
  | "chat-settings"
  | "proactive-settings"
  | "feed-image-settings"
  | "memory-settings"
  | "model-picker"
  | "regenerate"
  | null;
type RegenerationGuidance = {
  reasons: RegenerationReason[];
  instruction: string;
};
export default function ChatPage() {
  const { id } = useParams(),
    nav = useNavigate(),
    [searchParams] = useSearchParams(),
    store = useStore(),
    musicPlayer = useMusicPlayer(),
    {
      conversations,
      characters,
      messageWindows,
      loreBooks,
      memories,
      provider,
      settings,
      appearance,
      imageAssets,
      reload,
    } = store;
  const messages = id ? (messageWindows[id]?.items ?? []) : [],
    conversation = conversations.find((c) => c.id === id),
    [conversationRecoveryDone, setConversationRecoveryDone] = useState(false),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [localGenerating, setLocalGenerating] = useState(false),
    [popup, setPopup] = useState<Popup>(null),
    [chosen, setChosen] = useState<Message | null>(null),
    [editText, setEditText] = useState(""),
    [regenerationReasons, setRegenerationReasons] = useState<
      Set<RegenerationReason>
    >(new Set()),
    [regenerationInstruction, setRegenerationInstruction] = useState(""),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [capturePreviewOpen, setCapturePreviewOpen] = useState(false),
    [toastText, setToastText] = useState(""),
    [innerVoiceTarget, setInnerVoiceTarget] = useState<{
      actorType: "character" | "npc";
      actorId: string;
      messageId?: string;
    } | null>(null),
    [groupTitle, setGroupTitle] = useState(""),
    [groupMembers, setGroupMembers] = useState<Set<string>>(new Set()),
    [groupBooks, setGroupBooks] = useState<Set<string>>(new Set()),
    [extracting, setExtracting] = useState(false),
    [memoryTarget, setMemoryTarget] = useState(""),
    [chatDraft, setChatDraft] = useState(chatSettingsOf({} as Character)),
    [minReplyDraft, setMinReplyDraft] = useState("2"),
    [maxReplyDraft, setMaxReplyDraft] = useState("4"),
    [chatSettingsError, setChatSettingsError] = useState(""),
    [mountedBooks, setMountedBooks] = useState<string[]>([]),
    [proactiveDraft, setProactiveDraft] = useState<ProactiveSettings>(
      emptyProactiveSettings(),
    ),
    [proactiveError, setProactiveError] = useState(""),
    [memoryDraft, setMemoryDraft] = useState<MemoryExtractionSettings>(
      defaultMemoryExtractionSettings(),
    ),
    [memoryStats, setMemoryStats] = useState(0),
    [memorySettingsError, setMemorySettingsError] = useState(""),
    [autoTranslate, setAutoTranslate] = useState(true),
    [providerPresets, setProviderPresets] = useState<ProviderPresetState>(
      emptyProviderPresetState(),
    ),
    [modelSwitchStatus, setModelSwitchStatus] = useState(""),
    [mediaAssets, setMediaAssets] = useState<Map<string, MediaAsset>>(
      new Map(),
    ),
    [callType, setCallType] = useState<"voice" | "video" | null>(null),
    [callInitiatorId, setCallInitiatorId] = useState<string | null>(null),
    [quoteDraft, setQuoteDraft] = useState<MessageQuote | null>(null),
    [actionAnchor, setActionAnchor] = useState<MessageActionAnchor | null>(
      null,
    ),
    [highlightedId, setHighlightedId] = useState<string | null>(null),
    [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null),
    [lastVisibleMessageId, setLastVisibleMessageId] = useState<string | null>(
      null,
    ),
    feedReferenceRef = useRef<HTMLInputElement>(null),
    toolSending = useRef(false);
  const bottom = useRef<HTMLDivElement>(null),
    messagesPane = useRef<HTMLDivElement>(null),
    chatRoot = useRef<HTMLDivElement>(null),
    composerInput = useRef<HTMLTextAreaElement>(null),
    messageRefs = useRef<Map<string, HTMLDivElement>>(new Map()),
    nearBottom = useRef(true),
    loadingOlder = useRef(false),
    restoredConversation = useRef<string | null>(null),
    pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    pressStart = useRef<{ pointerId: number; x: number; y: number } | null>(
      null,
    ),
    actionHistory = useRef(false),
    pressProtection = useRef(false);
  const list = messages
      .filter((m) => m.conversationId === id)
      .sort((a, b) => a.createdAt - b.createdAt),
    members = characters.filter((c) => conversation?.memberIds.includes(c.id)),
    character = members[0],
    isGroup = conversation?.type === "group",
    contactStatus = isGroup ? "friend" : contactStatusOf(character),
    blocked = !isGroup && isCharacterBlocked(character),
    interactionLocked = !isGroup && !canCharacterInteract(character),
    restrictionCopy = blocked
      ? { title: "你已拉黑该角色", detail: "聊天记录保留，但当前会话只读。", action: "前往设置", path: conversation ? `/messages/${conversation.id}/settings` : "/messages/contacts" }
      : contactStatus === "request-pending"
        ? { title: "好友申请待处理", detail: "接受好友申请后即可继续聊天。", action: "查看申请", path: "/messages/contacts/requests" }
        : { title: "尚未添加为好友", detail: "先添加为好友，再继续聊天。", action: "添加好友", path: "/messages/contacts/add" },
    busy = localGenerating || list.some((message) => message.status === "generating"),
    multi = selected.size > 0,
    actors =
      isGroup && conversation
        ? groupActors(conversation, characters, [...mediaAssets.values()])
        : [],
    groupProfiles = actors.map((actor) => actor.character);

  useEffect(() => {
    let active = true;
    setConversationRecoveryDone(false);
    const missingConversation = !id || !conversation,
      missingMember = Boolean(conversation && conversation.memberIds.some((memberId) => !characters.some((item) => item.id === memberId)));
    if (!missingConversation && !missingMember) { setConversationRecoveryDone(true); return () => { active = false; }; }
    void (async () => {
      if (id) await db.conversations.get(id);
      await reload();
    })().finally(() => { if (active) setConversationRecoveryDone(true); });
    return () => { active = false; };
  }, [id, conversation?.id, characters.length, reload]);

  const scrollStorageKey = id ? `chacha-chat-scroll:${id}` : "";
  const saveScrollPosition = () => {
    const pane = messagesPane.current;
    if (!pane || !scrollStorageKey) return;
    const paneRect = pane.getBoundingClientRect();
    const elements = [
      ...pane.querySelectorAll<HTMLElement>("[data-message-id]"),
    ];
    const anchor = elements.find(
      (element) => element.getBoundingClientRect().bottom > paneRect.top,
    );
    const maxScroll = Math.max(1, pane.scrollHeight - pane.clientHeight);
    sessionStorage.setItem(
      scrollStorageKey,
      JSON.stringify({
        messageId: anchor?.dataset.messageId,
        offsetTop: anchor
          ? anchor.getBoundingClientRect().top - paneRect.top
          : 0,
        ratio: pane.scrollTop / maxScroll,
        atBottom: pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100,
      }),
    );
  };
  const updateLastVisibleMessage = () => {
    const pane = messagesPane.current;
    if (!pane || !multi) {
      setLastVisibleMessageId(null);
      return;
    }
    const bounds = pane.getBoundingClientRect();
    let last: string | null = null,
      fallback: string | null = null;
    for (const message of list) {
      const element = messageRefs.current.get(message.id);
      if (!element) continue;
      const rect = element.getBoundingClientRect(),
        content =
          (
            element.querySelector(".message-bubble-line") as HTMLElement | null
          )?.getBoundingClientRect() ?? rect;
      if (rect.bottom > bounds.top && rect.top < bounds.bottom)
        fallback = message.id;
      if (rect.bottom > bounds.top && content.bottom <= bounds.bottom - 36)
        last = message.id;
    }
    const next = last ?? fallback;
    setLastVisibleMessageId((current) => (current === next ? current : next));
  };
  useLayoutEffect(() => {
    const pane = messagesPane.current;
    if (!pane || !id || restoredConversation.current === id) return;
    const raw = sessionStorage.getItem(`chacha-chat-scroll:${id}`);
    let saved:
      | {
          messageId?: string;
          offsetTop?: number;
          ratio?: number;
          atBottom?: boolean;
        }
      | undefined;
    try {
      saved = raw ? JSON.parse(raw) : undefined;
    } catch {
      saved = undefined;
    }
    if (saved?.atBottom || !saved) pane.scrollTop = pane.scrollHeight;
    else {
      const anchor = saved.messageId
        ? messageRefs.current.get(saved.messageId)
        : undefined;
      if (anchor) {
        const paneRect = pane.getBoundingClientRect();
        pane.scrollTop +=
          anchor.getBoundingClientRect().top -
          paneRect.top -
          (saved.offsetTop ?? 0);
      } else
        pane.scrollTop =
          (saved.ratio ?? 0) *
          Math.max(0, pane.scrollHeight - pane.clientHeight);
    }
    nearBottom.current =
      pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100;
    restoredConversation.current = id;
  }, [id, list.length]);
  useEffect(() => () => saveScrollPosition(), [id]);
  useEffect(() => {
    void db.mediaAssets
      .toArray()
      .then((rows) =>
        setMediaAssets(new Map(rows.map((row) => [row.id, row]))),
      );
  }, [messages.length]);
  useEffect(() => {
    if (restoredConversation.current === id && nearBottom.current)
      bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [list.length, busy, error]);
  useEffect(() => {
    const frame = requestAnimationFrame(updateLastVisibleMessage);
    return () => cancelAnimationFrame(frame);
  }, [multi, list.length, selected.size]);
  useEffect(() => {
    const blockSelection = (event: Event) => {
      if (pressProtection.current && (event.target as HTMLElement | null)?.closest?.(".bubble")) event.preventDefault();
    }, clear = () => { pressProtection.current = false; chatRoot.current?.classList.remove("message-press-active"); };
    document.addEventListener("selectstart", blockSelection, true);
    document.addEventListener("contextmenu", blockSelection, true);
    document.addEventListener("visibilitychange", clear);
    window.addEventListener("pagehide", clear);
    return () => {
      if (pressTimer.current) clearTimeout(pressTimer.current);
      clear();
      document.removeEventListener("selectstart", blockSelection, true);
      document.removeEventListener("contextmenu", blockSelection, true);
      document.removeEventListener("visibilitychange", clear);
      window.removeEventListener("pagehide", clear);
    };
  }, []);
  useEffect(() => {
    if (popup || multi || innerVoiceTarget)
      (document.activeElement as HTMLElement | null)?.blur();
  }, [popup, multi, innerVoiceTarget]);
  useEffect(() => {
    const requested = searchParams.get("call");
    if ((requested === "voice" || requested === "video") && !interactionLocked) {
      setCallInitiatorId(searchParams.get("caller"));
      setCallType(requested);
      nav(`/messages/${id}`, { replace: true });
    }
  }, [searchParams, interactionLocked, id, nav]);
  useEffect(() => {
    const target = searchParams.get("message");
    if (!target) return;
    const timer = setTimeout(() => {
      const element = messageRefs.current.get(target);
      if (!element) return;
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedId(target);
      setTimeout(
        () =>
          setHighlightedId((current) => (current === target ? null : current)),
        1500,
      );
    }, 120);
    return () => clearTimeout(timer);
  }, [searchParams, messages.length]);
  useEffect(() => {
    const sync = () => void reload();
    window.addEventListener("mira:chat-translation-change", sync);
    return () =>
      window.removeEventListener("mira:chat-translation-change", sync);
  }, [reload]);
  useEffect(() => {
    if (!id) return;
    const sync = () => void store.reloadConversation(id).catch(() => {});
    sync();
    window.addEventListener("mira:chat-reply-change", sync);
    window.addEventListener("pageshow", sync);
    return () => {
      window.removeEventListener("mira:chat-reply-change", sync);
      window.removeEventListener("pageshow", sync);
    };
  }, [id, store.loadConversationWindow, store.reloadConversation]);
  useEffect(() => {
    if (!conversation) return;
    void Promise.all([
      getProviderPresetState().then(setProviderPresets),
      db.messages.where("conversationId").equals(conversation.id).count(),
      db.characters.bulkGet(conversation.memberIds),
    ]);
  }, [conversation?.id]);
  useEffect(() => {
    const onPop = () => {
        if (!actionHistory.current) return;
        actionHistory.current = false;
        setPopup(null);
        setActionAnchor(null);
        setChosen(null);
        setEditText("");
      },
      onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && actionHistory.current) close();
      };
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  if ((!conversation || !character) && !conversationRecoveryDone) return <div className="route-loading" role="status" aria-label="正在载入聊天"/>;
  if (!conversation || !character || !provider || !settings || !chatDraft)
    return <Navigate to="/messages" replace />;
  const avatarSettings = chatSettingsOf(character).avatars;
  useEffect(() => {
    if (!id) return;
    void (async () => {
      const unread = await db.messages
        .where("conversationId")
        .equals(id)
        .filter((m) => m.origin === "proactive" && !m.readAt)
        .toArray();
      if (unread.length) {
        const t = now();
        await db.messages.bulkUpdate(
          unread.map((m) => ({ key: m.id, changes: { readAt: t } })),
        );
        await reload();
      }
    })();
  }, [id, reload]);
  const openChatMenu = () => {
    const currentChat = chatSettingsOf(character);
    setChatDraft(currentChat);
    setMinReplyDraft(String(currentChat.minReplyMessages ?? ""));
    setMaxReplyDraft(String(currentChat.maxReplyMessages ?? ""));
    setChatSettingsError("");
    setAutoTranslate(
      conversationChatSettingsOf(conversation, character).autoTranslate ?? true,
    );
    setMountedBooks(character.loreBookIds ?? loreBooks.map((b) => b.id));
    setProactiveDraft(proactiveSettingsOf(character));
    setMemoryDraft(memoryExtractionSettingsOf(character));
    setPopup("chat-menu");
  };
  const saveChatSettings = async () => {
    const hasMinReply = Boolean(minReplyDraft.trim()),
      hasMaxReply = Boolean(maxReplyDraft.trim()),
      minReplyMessages = hasMinReply ? Number(minReplyDraft) : undefined,
      maxReplyMessages = hasMaxReply ? Number(maxReplyDraft) : undefined;
    if (
      hasMinReply !== hasMaxReply ||
      (hasMinReply &&
        (!Number.isInteger(minReplyMessages) ||
          !Number.isInteger(maxReplyMessages) ||
          minReplyMessages! < 1 ||
          minReplyMessages! > 8 ||
          maxReplyMessages! < 1 ||
          maxReplyMessages! > 8 ||
          minReplyMessages! > maxReplyMessages!))
    ) {
      setChatSettingsError(
        "\u6700\u5c11\u548c\u6700\u591a\u6d88\u606f\u8981\u4e48\u540c\u65f6\u7559\u7a7a\u5e76\u7531\u89d2\u8272\u81ea\u7136\u51b3\u5b9a\uff0c\u8981\u4e48\u90fd\u586b\u5199 1\u20138 \u7684\u6574\u6570\uff0c\u4e14\u6700\u5c11\u6570\u4e0d\u80fd\u5927\u4e8e\u6700\u591a\u6570\u3002",
      );
      return;
    }
    const nextChatDraft = {
        ...chatDraft,
        minReplyMessages,
        maxReplyMessages,
        replyMessageRangeMode: hasMinReply ? ("fixed" as const) : ("adaptive" as const),
      },
      oldReference = character.chatSettings?.feedImage?.referenceAssetId,
      newReference = nextChatDraft.feedImage?.referenceAssetId,
      conversationSettings = {
        ...conversationChatSettingsOf(conversation, character),
        autoTranslate,
      };
    await db.transaction("rw", [db.characters, db.conversations], async () => {
      await db.characters.update(character.id, {
        chatSettings: isGroup
          ? nextChatDraft
          : { ...nextChatDraft, autoTranslate },
        language: nextChatDraft.language,
        loreBookIds: mountedBooks,
        updatedAt: now(),
      });
      await db.conversations.update(conversation.id, {
        chatSettings: conversationSettings,
        updatedAt: now(),
      });
    });
    await reload();
    if (oldReference && oldReference !== newReference)
      await deleteMediaIfUnused(oldReference);
    setPopup("chat-menu");
  };
  const chooseFeedReference = async (file?: File) => {
    if (!file) return;
    const asset = await saveImageMedia(file, "feed-reference");
    setMediaAssets((current) => new Map(current).set(asset.id, asset));
    setChatDraft((current) => ({
      ...current,
      feedImage: {
        enabled: current.feedImage?.enabled ?? false,
        appearancePrompt: current.feedImage?.appearancePrompt ?? "",
        referenceAssetId: asset.id,
      },
    }));
    if (feedReferenceRef.current) feedReferenceRef.current.value = "";
  };
  const openModelPicker = async () => {
    setModelSwitchStatus("");
    setProviderPresets(await getProviderPresetState());
    setPopup("model-picker");
  };
  const selectConversationPreset = async (presetId?: string) => {
    if (busy) return;
    const nextSettings = {
      ...conversationChatSettingsOf(conversation, character),
      providerPresetId: presetId,
    };
    await db.conversations.update(conversation.id, {
      chatSettings: nextSettings,
      updatedAt: now(),
    });
    await reload();
    setPopup(null);
  };
  const saveProactiveSettings = async () => {
    const invalid = (v: ProactiveSettings["message"]) =>
      v.enabled && !validChannel(v);
    if (invalid(proactiveDraft.message) || invalid(proactiveDraft.feed)) {
      setProactiveError(
        "开启前请完整填写间隔与上限，且单次补算不能超过每日上限。",
      );
      return;
    }
    await db.characters.update(character.id, {
      proactiveSettings: proactiveDraft,
      updatedAt: now(),
    });
    await reload();
    setPopup("chat-menu");
    window.dispatchEvent(new Event("mira:proactive-check"));
  };
  const openMemorySettings = async () => {
    const cvs = conversations.filter((c) => c.memberIds.includes(character.id));
    let chatCount = 0;
    for (const cv of cvs)
      chatCount += await pendingCount(character, "chat", cv.id);
    setMemoryStats(chatCount);
    setPopup("memory-settings");
  };
  const saveMemorySettings = async () => {
    if (!validMemoryExtractionSettings(memoryDraft)) {
      setMemorySettingsError("自动模式需要填写 10–200 的聊天阈值。");
      return;
    }
    await db.characters.update(character.id, {
      memoryExtractionSettings: memoryDraft,
      updatedAt: now(),
    });
    await reload();
    setPopup("chat-menu");
    window.dispatchEvent(new Event("mira:proactive-check"));
  };
  const nameOf = (m: Message) =>
    m.senderType === "user"
      ? settings.userName || "我"
      : m.senderType === "system"
        ? "系统"
        : ((!isGroup && m.senderId === character?.id
            ? conversationDisplayName(conversation, character)
            : (characters.find((c) => c.id === m.senderId)?.name ??
              conversation.groupNpcs?.find((npc) => npc.id === m.senderId)
                ?.name)) ?? "已移出成员");
  const clearActionState = () => {
    setActionAnchor(null);
    setChosen(null);
    setEditText("");
    setRegenerationReasons(new Set());
    setRegenerationInstruction("");
  };
  const close = () => {
    pressProtection.current = false;
    chatRoot.current?.classList.remove("message-press-active");
    setPopup(null);
    clearActionState();
    if (actionHistory.current) {
      actionHistory.current = false;
      history.back();
    }
  };
  const leaveActions = (next: Popup) => {
    setPopup(next);
    setActionAnchor(null);
    if (actionHistory.current) {
      actionHistory.current = false;
      history.back();
    }
  };
  const actionAnchorOf = (element: HTMLElement): MessageActionAnchor => {
    const rect = element.getBoundingClientRect(),
      root = chatRoot.current?.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      top: rect.top - (root?.top ?? 0),
      left: rect.left - (root?.left ?? 0),
      width: rect.width,
      height: rect.height,
      rootWidth: root?.width ?? window.innerWidth,
      rootHeight: root?.height ?? window.innerHeight,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      letterSpacing: style.letterSpacing,
    };
  };
  const showActions = (m: Message, anchor: MessageActionAnchor) => {
    if (busy || m.status !== "complete") return;
    (document.activeElement as HTMLElement | null)?.blur();
    setChosen(m);
    setActionAnchor(anchor);
    setPopup("actions");
    if (!actionHistory.current) {
      history.pushState({ chatMessageActions: true }, "");
      actionHistory.current = true;
    }
  };
  const startPress = (m: Message, event: React.PointerEvent<HTMLElement>) => {
    const element = event.currentTarget,
      anchor = actionAnchorOf(element);
    pressProtection.current = true;
    chatRoot.current?.classList.add("message-press-active");
    pressStart.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      pressStart.current = null;
      showActions(m, anchor);
    }, 480);
  };
  const movePress = (event: React.PointerEvent<HTMLElement>) => {
    const start = pressStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8)
      cancelPress();
  };
  const cancelPress = () => {
    pressProtection.current = false;
    chatRoot.current?.classList.remove("message-press-active");
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressStart.current = null;
  };
  const errorText = (e: unknown) =>
    e instanceof Error ? e.message : "生成失败";
  const generate = async () => {
    if (localGenerating) return;
    setError("");
    setLocalGenerating(true);
    store.setGenerating(conversation.id);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const ensured = await ensureRunnableChatReplyTask({
        conversationId: conversation.id,
        mode: isGroup ? "group" : "private",
      });
      store.mergeMessage(ensured.placeholder);
      const foregroundWake = () =>
        wakeChatReplyPump({
          source: "foreground",
          onTaskStart: (task) => store.setGenerating(task.conversationId ?? null),
          onTaskComplete: async (task) => {
            if (task.conversationId) await store.reloadConversation(task.conversationId);
          },
          onTaskError: async (task) => {
            if (task.conversationId) await store.reloadConversation(task.conversationId);
          },
          onIdle: async () => {
            await store.reloadConversation(conversation.id).catch(() => {});
            store.setGenerating(null);
            setLocalGenerating(false);
          },
        });
      const pump = foregroundWake();
      watchdog = setTimeout(() => {
        void (async () => {
          try {
            const currentTask = await db.backgroundTasks.get(ensured.task.id);
            const currentPlaceholder = await db.messages.get(ensured.placeholder.id);
            if (
              currentTask?.state === "running" ||
              currentTask?.state === "completed" ||
              currentPlaceholder?.generation?.phase !== "queued"
            )
              return;
            const result = await ensureRunnableChatReplyTask({
              conversationId: conversation.id,
              mode: isGroup ? "group" : "private",
            });
            store.mergeMessage(result.placeholder);
            void foregroundWake();
          } catch (watchdogError) {
            setError(errorText(watchdogError));
            setLocalGenerating(false);
          }
        })();
      }, 3500);
      void pump.finally(() => {
        if (watchdog) clearTimeout(watchdog);
      });
      void store.reloadConversation(conversation.id).catch(() => {});
    } catch (e) {
      setError(errorText(e));
      setLocalGenerating(false);
      store.setGenerating(null);
    }
  };
  const stop = async () => {
    await stopChatReply(conversation.id);
    setLocalGenerating(false);
    store.setGenerating(null);
    await store.reloadConversation(conversation.id);
  };
  const sendOnly = async () => {
    const content = text.trim();
    if (interactionLocked) {
      setError(`${restrictionCopy.title}，当前聊天只读。`);
      return;
    }
    if (!content || busy) return;
    if (isGroup && conversationAppearance.userInGroup === false)
      await saveDirectorInstruction(conversation, content);
    else {
      const t = now();
      await db.transaction("rw", [db.messages, db.conversations, db.meetSessions], async () => {
        await pauseActiveMeetForOnlineActivity(conversation.id, t);
      await db.messages.add({
          id: uid(),
          schemaVersion: SCHEMA_VERSION,
          createdAt: t,
          updatedAt: t,
          conversationId: conversation.id,
          senderType: "user",
          content,
          quote: quoteDraft ?? undefined,
          status: "complete",
        });
        await db.conversations.update(conversation.id, {
          lastActivityAt: t,
          updatedAt: t,
        });
      });
    }
    setText("");
    setQuoteDraft(null);
    setError("");
    await reload();
  };
  const sendSticker = async (_pack: StickerPack, sticker: StickerItem) => {
    if (interactionLocked || busy) return;
    const t = now(),
      content = "[表情包]";
    await db.transaction("rw", [db.messages, db.conversations, db.meetSessions], async () => {
      await pauseActiveMeetForOnlineActivity(conversation.id, t);
      await db.messages.add({
        id: uid(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: t,
        updatedAt: t,
        conversationId: conversation.id,
        senderType: "user",
        content,
        kind: "sticker",
        quote: quoteDraft ?? undefined,
        attachments: [
          {
            type: "sticker",
            stickerId: sticker.id,
            assetId: sticker.assetId,
            url: sticker.url,
            name: sticker.name,
            description: sticker.description || sticker.name,
          },
        ],
        status: "complete",
      });
      await db.conversations.update(conversation.id, {
        lastActivityAt: t,
        updatedAt: t,
      });
    });
    setQuoteDraft(null);
    close();
    setError("");
    await reload();
  };
  const sendPhoto = async (
    asset: MediaAsset,
    description: string,
    visionMode: "image" | "description",
  ) => {
    if (interactionLocked) return;
    let resolvedDescription = description,
      resolvedVisionMode = visionMode;
    if (visionMode === "image")
      try {
        const recognized = await describeImageWithVision(
          asset.data,
          description,
        );
        if (recognized) {
          resolvedDescription = recognized;
          resolvedVisionMode = "description";
        }
      } catch (error) {
        setError(
          `图片已发送，但识图 API 读取失败：${error instanceof Error ? error.message : "未知错误"}`,
        );
      }
    const t = now(),
      content = resolvedDescription || "[图片]";
    await db.transaction("rw", [db.messages, db.conversations, db.meetSessions], async () => {
      await pauseActiveMeetForOnlineActivity(conversation.id, t);
      await db.messages.add({
        id: uid(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: t,
        updatedAt: t,
        conversationId: conversation.id,
        senderType: "user",
        content,
        kind: "image",
        quote: quoteDraft ?? undefined,
        attachments: [
          {
            type: "image",
            assetId: asset.id,
            description: resolvedDescription,
            visionMode: resolvedVisionMode,
            width: asset.width,
            height: asset.height,
          },
        ],
        status: "complete",
      });
      await db.conversations.update(conversation.id, {
        lastActivityAt: t,
        updatedAt: t,
      });
    });
    setQuoteDraft(null);
    close();
    await reload();
  };
  const sendVoice = async (asset: MediaAsset, transcript: string) => {
    if (interactionLocked) return;
    const t = now();
    await db.transaction("rw", [db.messages, db.conversations, db.meetSessions], async () => {
      await pauseActiveMeetForOnlineActivity(conversation.id, t);
      await db.messages.add({
        id: uid(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: t,
        updatedAt: t,
        conversationId: conversation.id,
        senderType: "user",
        content: transcript,
        kind: "voice",
        quote: quoteDraft ?? undefined,
        attachments: [
          {
            type: "voice",
            assetId: asset.id,
            durationMs: asset.durationMs ?? 0,
            transcript,
          },
        ],
        status: "complete",
      });
      await db.conversations.update(conversation.id, {
        lastActivityAt: t,
        updatedAt: t,
      });
    });
    setQuoteDraft(null);
    close();
    await reload();
  };

  const sendTransfer = async (amountCents: number, note: string) => {
    if (interactionLocked) return;
    setError("");
    try {
      await createOutgoingWalletTransfer({
        conversation,
        amountCents,
        note,
        quote: quoteDraft ?? undefined,
      });
      setQuoteDraft(null);
      close();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "转账失败");
    }
  };

  const finishCall = async (durationMs: number, summary: string) => {
    const t = now(),
      kind = callType ?? "voice",
      incoming = Boolean(callInitiatorId);
    await db.transaction("rw", [db.messages, db.conversations, db.meetSessions], async () => {
      if (!incoming) await pauseActiveMeetForOnlineActivity(conversation.id, t);
      await db.messages.add({
        id: uid(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: t,
        updatedAt: t,
        conversationId: conversation.id,
        senderType: incoming ? "character" : "user",
        senderId: incoming ? (callInitiatorId ?? undefined) : undefined,
        content: (kind === "video" ? "视频通话" : "语音通话") + " · " + summary,
        kind: "call-event",
        attachments: [
          {
            type: "call",
            callType: kind,
            durationMs,
            summary,
            participantIds: conversation.memberIds,
            direction: incoming ? "incoming" : "outgoing",
            state: "completed",
          },
        ],
        status: "complete",
      });
      await db.conversations.update(conversation.id, {
        lastActivityAt: t,
        updatedAt: t,
      });
    });
    setCallType(null);
    setCallInitiatorId(null);
    await reload();
  };

  const sendRedPacket = async (
    amountCents: number,
    count: number,
    note: string,
  ) => {
    if (!isGroup || toolSending.current) return;
    toolSending.current = true;
    setError("");
    try {
      const message = await createGroupRedPacket({
          conversation,
          members,
          npcs: conversation.groupNpcs,
          totalAmountCents: amountCents,
          packetCount: count,
          note,
        }),
        packet = message.attachments?.find(
          (item) => item.type === "red-packet",
        );
      close();
      await reload();
      if (packet?.type === "red-packet" && packet.claims.length)
        await enqueueChatReply({
          conversationId: conversation.id,
          mode: "group",
          speakerOrder: packet.claims
            .map((claim) => claim.participantId ?? claim.characterId)
            .filter((value): value is string => Boolean(value)),
          roundId: packet.eventId,
        });
    } catch (error) {
      setError(error instanceof Error ? error.message : "红包发送失败");
    } finally {
      toolSending.current = false;
    }
  };
  const sendPoll = async (
    question: string,
    mode: "single" | "multiple",
    options: string[],
  ) => {
    if (!isGroup || toolSending.current) return;
    toolSending.current = true;
    setError("");
    try {
      const message = await createGroupPoll({
        conversation,
        question,
        mode,
        options,
        createdBy:
          conversationAppearance.userInGroup === false ? "assistant" : "user",
      });
      close();
      await generateCharacterPollVotes(
        message.id,
        members,
        provider,
        conversation.groupNpcs,
      );
      await reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : "投票创建失败");
    } finally {
      toolSending.current = false;
    }
  };
  const sendMusicInvitation = async (trackId?: string) => {
    if (isGroup || interactionLocked || busy || toolSending.current || !character) return;
    toolSending.current = true;
    setError("");
    try {
      await createMusicInvitationMessage({ conversationId: conversation.id, characterId: character.id, invitedBy: "user", trackId });
      close();
      await reload();
      wakeChatReplyPump({ source: "foreground" });
    } catch (e) { setError(e instanceof Error ? e.message : "一起听邀请发送失败"); }
    finally { toolSending.current = false; }
  };
  const sendCoupleIslandInvitation = async () => {
    if (isGroup || interactionLocked || busy || toolSending.current || !character) return;
    toolSending.current = true; setError("");
    try { await createCoupleIslandInvitation({ conversationId: conversation.id, characterId: character.id }); close(); await reload(); wakeChatReplyPump({ source: "foreground" }); }
    catch (e) { setError(e instanceof Error ? e.message : "茶侣岛邀请发送失败"); }
    finally { toolSending.current = false; }
  };
  const respondToMusicInvitation = async (messageId: string, accept: boolean) => {
    await respondMusicInvitation(messageId, accept, "user");
    await reload();
    if (accept) showToast("已开始一起听");
  };

  const openExtension = (
    next:
      | Exclude<ChatMediaPanel, "extensions" | null>
      | "voice-call"
      | "video-call",
  ) => {
    if (interactionLocked) return;
    if (next === "couple-island") { void sendCoupleIslandInvitation(); return; }
    if (next === "model") {
      void openModelPicker();
      return;
    }
    if (next === "meet") {
      setPopup(null);
      nav(`/meet/new?conversationId=${conversation.id}`);
      return;
    }
    if (next === "voice-call" || next === "video-call") {
      setPopup(null);
      setCallInitiatorId(null);
      setCallType(next === "video-call" ? "video" : "voice");
      return;
    }
    setPopup(next);
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendOnly();
    }
  };
  const regenerate = async (m: Message, guidance?: RegenerationGuidance) => {
    setError("");
    try {
      await enqueueChatReply({
        conversationId: conversation.id,
        mode: isGroup ? "group" : "private",
        targetMessageId: m.id,
        guidance,
        speakerOrder: isGroup && m.senderId ? [m.senderId] : undefined,
        roundId: m.generation?.roundId,
      });
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const openRegeneration = () => {
    if (!chosen) return;
    setRegenerationReasons(new Set());
    setRegenerationInstruction("");
    leaveActions("regenerate");
  };
  const toggleRegenerationReason = (reason: RegenerationReason) =>
    setRegenerationReasons((previous) => {
      const next = new Set(previous);
      next.has(reason) ? next.delete(reason) : next.add(reason);
      return next;
    });
  const submitRegeneration = (guided: boolean) => {
    const target = chosen;
    if (!target) return;
    const guidance = guided
      ? {
          reasons: [...regenerationReasons],
          instruction: regenerationInstruction.trim(),
        }
      : undefined;
    setPopup(null);
    clearActionState();
    void regenerate(target, guidance);
  };
  const clearSelection = () => {
    setSelected(new Set());
    setSelectionAnchorId(null);
    setLastVisibleMessageId(null);
  };
  const selectAll = () => {
    setSelected(new Set(list.map((message) => message.id)));
    setSelectionAnchorId(list[0]?.id ?? null);
  };
  const toggle = (mid: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(mid) ? next.delete(mid) : next.add(mid);
      if (next.size === 0) setSelectionAnchorId(null);
      else if (!selectionAnchorId) setSelectionAnchorId(mid);
      return next;
    });
  const beginMulti = () => {
    void preloadChatCapture();
    if (chosen) {
      setSelected(new Set([chosen.id]));
      setSelectionAnchorId(chosen.id);
      close();
    }
  };
  const selectToMessage = (messageId: string) =>
    setSelected((previous) =>
      selectMessageRange(
        list.map((message) => message.id),
        previous,
        selectionAnchorId ?? [...previous][0],
        messageId,
      ),
    );
  const captureSelectedMessages = () => {
    if (!selected.size) return;
    setCapturePreviewOpen(true);
  };
  const beginQuote = () => {
    if (!chosen || chosen.status !== "complete") return;
    const quote = createMessageQuote(chosen, nameOf(chosen));
    setQuoteDraft(quote);
    close();
    setTimeout(() => composerInput.current?.focus(), 60);
  };
  const applyReaction = async (kind: MessageReactionKind) => {
    if (!chosen || chosen.status !== "complete") return;
    const messageId = chosen.id,
      reactions = toggleUserReaction(chosen.reactions, kind, now());
    await db.messages.update(messageId, { reactions, updatedAt: now() });
    close();
    await reload();
  };
  const scrollToQuotedMessage = (messageId: string) => {
    const element = messageRefs.current.get(messageId);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedId(messageId);
    setTimeout(
      () =>
        setHighlightedId((current) => (current === messageId ? null : current)),
      1500,
    );
  };
  const showToast = (value: string) => {
    setToastText(value);
    setTimeout(
      () => setToastText((current) => (current === value ? "" : current)),
      1400,
    );
  };
  const copyOne = async () => {
    if (!chosen) return;
    await navigator.clipboard.writeText(chosen.content);
    close();
    showToast("已复制");
  };
  const favoriteSelected = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    const time = now();
    await db.transaction("rw", db.messages, async () => {
      for (const messageId of ids)
        await db.messages.update(messageId, {
          favoritedAt: time,
          updatedAt: time,
        });
    });
    clearSelection();
    await reload();
    showToast(`已收藏 ${ids.length} 条消息`);
  };
  const saveEdit = async () => {
    if (!chosen || !editText.trim()) return;
    const content = editText.trim(),
      attachments = chosen.attachments?.map((a) =>
        a.type === "sticker"
          ? { ...a, description: content }
          : a.type === "image"
            ? { ...a, description: content }
            : a.type === "voice"
              ? { ...a, transcript: content }
              : a,
      );
    await db.messages.update(chosen.id, {
      content,
      attachments,
      translation: undefined,
      updatedAt: now(),
    });
    await refreshConversationActivity(conversation);
    const edited = {
      ...chosen,
      content,
      attachments,
      translation: undefined,
      updatedAt: now(),
    };
    close();
    await reload();
  };
  const deleteIds = async (ids: string[]) => {
    const deleting = await db.messages.bulkGet(ids),
      assetIds = deleting.flatMap(
        (m) =>
          m?.attachments?.flatMap((a) =>
            "assetId" in a && a.assetId ? [a.assetId] : [],
          ) ?? [],
      );
    const idSet = new Set(ids),
      allConversationMessages = await db.messages
        .where("conversationId")
        .equals(conversation.id)
        .toArray(),
      migrations = deleting
        .filter((message) => message?.innerVoice)
        .map((message) => {
          const voice = message!.innerVoice!,
            survivor = allConversationMessages
              .filter(
                (item) =>
                  !idSet.has(item.id) &&
                  item.generation?.speakerTurnId === voice.speakerTurnId,
              )
              .sort((a, b) => a.createdAt - b.createdAt)[0];
          return survivor ? { survivor, voice } : undefined;
        })
        .filter(Boolean) as Array<{ survivor: Message; voice: NonNullable<Message["innerVoice"]> }>;
    await db.transaction("rw", db.messages, async () => {
      await db.messages.bulkDelete(ids);
      for (const migration of migrations)
        await db.messages.update(migration.survivor.id, {
          innerVoice: migration.voice,
          updatedAt: now(),
        });
    });
    await cleanupMoodImprintsForDeletedMessages(ids);
    for (const assetId of new Set(assetIds)) await deleteMediaIfUnused(assetId);
    await refreshConversationActivity(conversation);
    clearSelection();
    close();
    await reload();
  };
  const targets = conversations.filter((c) => c.id !== conversation.id),
    doForward = async (targetId: string) => {
      const target = targets.find((c) => c.id === targetId);
      if (!target) return;
      await forwardMessages(
        target,
        list.filter((m) => selected.has(m.id)),
        characters,
        settings.userName,
        conversation,
      );
      clearSelection();
      close();
      await reload();
    };
  const extractMemories = async () => {
    const target = characters.find(
      (c) => c.id === (isGroup ? memoryTarget : character.id),
    );
    if (!target || !provider.apiKey) {
      setError("请先配置 API 后再整理记忆。");
      return;
    }
    setExtracting(true);
    try {
      await createExtractionBatch(provider, target, "chat", conversation.id);
      await reload();
      nav("/memories?review=1");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setExtracting(false);
    }
  };
  const openGroup = () => {
    setGroupTitle(conversation.title);
    setGroupMembers(new Set(conversation.memberIds));
    setGroupBooks(new Set(conversation.loreBookIds));
    setPopup("group");
  };
  const toggleSet = (
    set: Set<string>,
    value: string,
    apply: (s: Set<string>) => void,
  ) => {
    const next = new Set(set);
    next.has(value) ? next.delete(value) : next.add(value);
    apply(next);
  };
  const saveGroup = async () => {
    if (groupMembers.size < 2 || !groupTitle.trim()) return;
    await db.conversations.update(conversation.id, {
      title: groupTitle.trim(),
      memberIds: [...groupMembers],
      loreBookIds: [...groupBooks],
      updatedAt: now(),
    });
    close();
    await reload();
  };
  const deleteGroup = async () => {
    const assetIds = [
      conversation.avatarAssetId,
      ...(conversation.groupNpcs ?? []).map((npc) => npc.avatarAssetId),
    ].filter(Boolean) as string[];
    await db.transaction("rw", [db.messages, db.conversations, db.meetSessions], async () => {
      await db.messages
        .where("conversationId")
        .equals(conversation.id)
        .delete();
      await db.conversations.delete(conversation.id);
    });
    for (const assetId of assetIds) await deleteMediaIfUnused(assetId);
    await reload();
    nav("/messages/chats", { replace: true });
  };
  const actorForMessage = (message: Message) =>
    characters.find((item) => item.id === message.senderId) ??
    actors.find((item) => item.id === message.senderId)?.character;
  const translateOne = async (message: Message, force = true) => {
    const actor = actorForMessage(message);
    if (!actor || !translatableCharacterMessage(message, actor)) return;
    close();
    const resolved = await resolveConversationProvider(conversation, provider);
    await translateChatMessage({
      messageId: message.id,
      character: actor,
      conversation,
      primaryProvider: resolved.provider,
      force,
    });
    await reload();
  };
  const translationActionLabel =
    chosen &&
    chosen.translation?.status !== "pending" &&
    translatableCharacterMessage(chosen, actorForMessage(chosen))
      ? chosen.translation?.status === "complete" ||
        chosen.translation?.status === "error"
        ? "重新翻译"
        : "翻译这条"
      : undefined;
  const conversationAppearance = conversationChatSettingsOf(
      conversation,
      character,
    ),
    selectedProviderPreset = providerPresets.items.find(
      (item) => item.id === conversationAppearance.providerPresetId,
    ),
    bubbleStyle = resolvedConversationBubble(
      conversation,
      appearance?.chatBubbleStyle ?? "default",
    ),
    avatarShape = appearance?.chatAvatarShape ?? "circle",
    chatBackgroundUrl=appearanceSourceUrl(conversationAppearance.chatBackground,imageAssets),
    displayTitle = conversationDisplayName(conversation, character),
    captureMessages = list.filter((message) => selected.has(message.id)),
    captureActors = new Map<string, ChatCaptureActor>(
      (isGroup
        ? actors.map((actor) => [
            actor.id,
            { id: actor.id, name: actor.name, avatar: actor.avatar },
          ] as const)
        : [[
            character.id,
            { id: character.id, name: character.name, avatar: character.avatar },
          ] as const]),
    ),
    captureWidth = Math.min(
      390,
      Math.max(280, (messagesPane.current?.clientWidth ?? window.innerWidth) - 28),
    );
  const openInnerVoice = (
    actorType: "character" | "npc",
    actorId: string,
    messageId?: string,
  ) => setInnerVoiceTarget({ actorType, actorId, messageId });
  const innerVoiceActor = innerVoiceTarget
      ? actors.find(
          (actor) =>
            actor.type === innerVoiceTarget.actorType &&
            actor.id === innerVoiceTarget.actorId,
        )
      : undefined,
    innerVoiceCharacter = innerVoiceTarget
      ? characters.find(
          (item) =>
            innerVoiceTarget.actorType === "character" &&
            item.id === innerVoiceTarget.actorId,
        )
      : undefined,
    innerVoiceNpc = innerVoiceTarget
      ? conversation.groupNpcs?.find(
          (item) =>
            innerVoiceTarget.actorType === "npc" &&
            item.id === innerVoiceTarget.actorId,
        )
      : undefined,
    innerVoiceName =
      innerVoiceCharacter?.name ?? innerVoiceActor?.name ?? innerVoiceNpc?.name,
    innerVoiceAvatar =
      innerVoiceCharacter?.avatar ??
      innerVoiceActor?.avatar ??
      (innerVoiceNpc?.avatarAssetId
        ? mediaAssets.get(innerVoiceNpc.avatarAssetId)?.data
        : undefined);
  const openAllInnerVoices = () => {
    if (!innerVoiceTarget) return;
    saveScrollPosition();
    nav(
      "/messages/" +
        conversation.id +
        "/inner-voice/" +
        innerVoiceTarget.actorType +
        "/" +
        innerVoiceTarget.actorId,
    );
  };
  const openInnerVoiceSource = (messageId: string) => {
    setInnerVoiceTarget(null);
    window.setTimeout(() => scrollToQuotedMessage(messageId), 40);
  };
  return (
    <div
      ref={chatRoot}
      className={`chat-page chat-bubble-${bubbleStyle} chat-avatar-${avatarShape} ${interactionLocked ? "chat-is-blocked" : ""}`}
      style={
        {
          "--chat-character-avatar-size": `${conversationAppearance.characterAvatarSize}px`,
          "--chat-font-scale": conversationAppearance.fontScale / 100,
          "--chat-background-image": chatBackgroundUrl?`url(${JSON.stringify(chatBackgroundUrl)})`:"none",
        } as React.CSSProperties
      }
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("button,textarea,.bubble"))
          (document.activeElement as HTMLElement | null)?.blur();
      }}
    >
      {capturePreviewOpen && captureMessages.length > 0 && (
        <ChatSelectionCapturePreview
          title={displayTitle}
          messages={captureMessages}
          actors={captureActors}
          assets={mediaAssets}
          userName={settings.userName || "我"}
          userAvatar={settings.userAvatar}
          showCharacterAvatar={avatarSettings.showCharacterAvatar}
          showUserAvatar={avatarSettings.showUserAvatar}
          autoTranslate={conversationAppearance.autoTranslate !== false}
          bubbleStyle={bubbleStyle}
          avatarShape={avatarShape}
          characterAvatarSize={conversationAppearance.characterAvatarSize}
          fontScale={conversationAppearance.fontScale}
          width={captureWidth}
          backgroundUrl={chatBackgroundUrl}
          onClose={() => setCapturePreviewOpen(false)}
          onReturn={() => setCapturePreviewOpen(false)}
          onResult={showToast}
        />
      )}
      {innerVoiceTarget && innerVoiceName && (
        <InnerVoiceDialog
          actorType={innerVoiceTarget.actorType}
          actorId={innerVoiceTarget.actorId}
          actorName={innerVoiceName}
          actorAvatar={innerVoiceAvatar}
          conversationId={conversation.id}
          conversationMessages={list}
          enabled={conversationInnerVoiceEnabled(conversation)}
          onClose={() => setInnerVoiceTarget(null)}
          onChanged={reload}
          onSource={openInnerVoiceSource}
          onAll={openAllInnerVoices}
          onNotice={showToast}
        />
      )}
      <header className="chat-header">
        <div
          className={
            isGroup && !conversation.avatarAssetId ? "mini-group-avatar" : ""
          }
        >
          {isGroup ? (
            conversation.avatarAssetId ? (
              <Avatar
                text={conversation.title}
                src={mediaAssets.get(conversation.avatarAssetId)?.data}
              />
            ) : (
              actors
                .slice(0, 4)
                .map((actor) => (
                  <Avatar
                    key={`${actor.type}:${actor.id}`}
                    text={actor.name}
                    src={actor.avatar}
                    size="sm"
                  />
                ))
            )
          ) : (
            <Avatar text={character.name} src={character.avatar} />
          )}
        </div>
        <div>
          {isGroup ? <h2>{displayTitle}</h2> : (
            <button type="button" className="chat-inner-voice-title" onClick={() => openInnerVoice("character", character.id)}>{displayTitle}</button>
          )}
          {(busy || isGroup) && (
            <p>
              {busy
                ? isGroup
                  ? "群成员正在依次回复…"
                  : `${character.name} 正在思考…`
                : `${actors.length} 位成员 · ${conversationAppearance.userInGroup === false ? "上帝视角" : "全员回复"}`}
            </p>
          )}
        </div>
        <div className="chat-call-actions">
          <button
            disabled={interactionLocked}
            onClick={() => {
              setCallInitiatorId(null);
              setCallType("voice");
            }}
            aria-label="语音通话"
          >
            <Phone />
          </button>
          {!isGroup && (
            <button
              disabled={interactionLocked}
              onClick={() => {
                setCallInitiatorId(null);
                setCallType("video");
              }}
              aria-label="视频通话"
            >
              <Video />
            </button>
          )}
          <button
            onClick={() => nav(`/messages/${conversation.id}/settings`)}
            aria-label="聊天设置"
          >
            <MoreHorizontal />
          </button>
        </div>
      </header>
      {callType && (
        <CallOverlay
          type={callType}
          conversation={conversation}
          members={members}
          provider={provider}
          messages={list}
          loreBooks={loreBooks}
          memories={memories}
          mediaAssets={[...mediaAssets.values()]}
          settings={settings}
          onEnd={finishCall}
        />
      )}
      {multi && (
        <div className="selection-head">
          <button onClick={selectAll}>全选</button>
          <b>已选 {selected.size} 条</b>
          <button onClick={clearSelection}>取消</button>
        </div>
      )}
      <div
        className={`chat-messages ${chatBackgroundUrl?"has-chat-background":""}`}
        ref={messagesPane}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          updateLastVisibleMessage();
          saveScrollPosition();
        }}
        onClick={(event) => {
          if (
            multi &&
            !(event.target as HTMLElement).closest(
              "[data-message-id],.select-to-here",
            )
          )
            clearSelection();
        }}
      >
        {list.length === 0 ? (
          isGroup ? (
            <div className="chat-welcome">
              <Users size={42} />
              <h3>群聊已经准备好了</h3>
              <p>点击底部闪光按钮，所有群成员会按 AI 安排的顺序依次回复。</p>
              <span>
                <Sparkles /> 消息只保存在当前浏览器
              </span>
            </div>
          ) : (
            <div className="chat-profile-welcome">
              <Avatar text={character.name} src={character.avatar} size="lg" />
              <h3>{character.name}</h3>
              <button onClick={() => nav(`/characters/${character.id}`)}>
                查看主页
              </button>
            </div>
          )
        ) : (
          list.map((m) => {
            const speaker = characters.find((c) => c.id === m.senderId),
              npc = conversation.groupNpcs?.find(
                (item) => item.id === m.senderId,
              ),
              speakerName = speaker?.name ?? npc?.name,
              speakerAvatar =
                speaker?.avatar ??
                (npc?.avatarAssetId
                  ? mediaAssets.get(npc.avatarAssetId)?.data
                  : undefined),
              content = m.content,
              checked = selected.has(m.id),
              reaction = userReactionOf(m),
              stickerOnly =
                m.kind === "sticker" ||
                (m.attachments?.length === 1 &&
                  m.attachments[0]?.type === "sticker"),
              cardOnly = isCardOnlyMessage(m),
              standaloneInvitation = isStandaloneInvitationCard(m);
            if ((m.status === "generating" || m.status === "error") && !content)
              return (
                <div
                  className={`message-row theirs chat-task-row ${m.status === "error" ? "is-error" : ""}`}
                  key={m.id}
                >
                  {avatarSettings.showCharacterAvatar && (
                    <Avatar
                      text={speakerName ?? character?.name ?? "?"}
                      src={speakerAvatar}
                      size="sm"
                    />
                  )}
                  {m.status === "error" ? (
                    <ChatTaskError
                      apiError={m.generation?.apiError}
                      fallback={m.generation?.error}
                      canRetry={Boolean(m.generation?.taskEventId)}
                      onRetry={() => {
                        if (!m.generation?.taskEventId) return;
                        setLocalGenerating(true);
                        store.setGenerating(conversation.id);
                        void retryChatReply(m.generation.taskEventId)
                          .then(() => store.reloadConversation(conversation.id))
                          .then(() =>
                            wakeChatReplyPump({
                              source: "foreground",
                              onTaskComplete: () => store.reloadConversation(conversation.id),
                              onTaskError: () => store.reloadConversation(conversation.id),
                              onIdle: () => {
                                setLocalGenerating(false);
                                store.setGenerating(null);
                              },
                            }),
                          )
                          .catch((retryError) => {
                            setError(errorText(retryError));
                            setLocalGenerating(false);
                            store.setGenerating(null);
                          });
                      }}
                      onSettings={() => nav("/settings")}
                      onCopyDiagnostic={() =>
                        m.generation?.taskEventId &&
                        void chatReplyDiagnostic(m.generation.taskEventId)
                          .then((diagnostic) => navigator.clipboard.writeText(diagnostic))
                          .then(() => showToast("诊断已复制"))
                          .catch(() => showToast("复制诊断失败"))
                      }
                    />
                  ) : (
                    <ChatTaskThinking
                      phase={m.generation?.phase}
                      apiError={m.generation?.apiError}
                    />
                  )}
                </div>
              );
            return (
              <div
                className={`message-row ${m.kind === "director" ? "director" : m.senderType === "system" ? "system" : m.senderType === "user" ? "mine" : "theirs"} ${checked ? "selected" : ""} ${highlightedId === m.id ? "quote-highlight" : ""} ${stickerOnly ? "sticker-only" : ""} ${cardOnly ? "card-only" : ""} ${standaloneInvitation ? "standalone-invitation-card" : ""}`}
                data-message-id={m.id}
                ref={(element) => {
                  if (element) messageRefs.current.set(m.id, element);
                  else messageRefs.current.delete(m.id);
                }}
                key={m.id}
                onClick={() => multi && selectToMessage(m.id)}
              >
                {multi && (
                  <button
                    type="button"
                    className="select-dot"
                    aria-label={checked ? "取消选中" : "选中这条消息"}
                    aria-pressed={checked}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggle(m.id);
                    }}
                  >
                    {checked && <Check />}
                  </button>
                )}
                {(m.senderType === "character" || m.senderType === "npc") &&
                  avatarSettings.showCharacterAvatar && (
                    <button type="button" className="chat-inner-voice-avatar" aria-label={"\u67e5\u770b\u89d2\u8272\u5fc3\u58f0"} onClick={(event) => { event.stopPropagation(); if (!multi && m.senderId) openInnerVoice(m.senderType === "npc" ? "npc" : "character", m.senderId, m.id); }}>
                      <Avatar text={speakerName ?? "?"} src={speakerAvatar} size="sm" />
                    </button>
                  )}
                <div className="message-main">
                  {isGroup &&
                    (m.senderType === "character" ||
                      m.senderType === "npc") && (
                      <button type="button" className="speaker-name speaker-inner-voice-link" onClick={(event) => { event.stopPropagation(); if (!multi && m.senderId) openInnerVoice(m.senderType === "npc" ? "npc" : "character", m.senderId, m.id); }}>
                        {speakerName ?? "\u5df2\u79fb\u51fa\u6210\u5458"}
                      </button>
                    )}
                  {m.kind === "director" && (
                    <small className="director-label">
                      仅你可见 · 幕后指导
                    </small>
                  )}
                  {m.quote && (
                    <MessageQuoteCard
                      quote={m.quote}
                      mine={m.senderType === "user"}
                      onOpen={() => scrollToQuotedMessage(m.quote!.messageId)}
                    />
                  )}
                  <div className="message-bubble-line">
                    <div className="bubble-shell">
                      <div
                        className={`bubble ${stickerOnly ? "sticker-bubble" : ""} ${cardOnly ? "card-bubble" : ""}`}
                        onPointerDown={(e) => !multi && startPress(m, e)}
                        onPointerMove={movePress}
                        onPointerUp={cancelPress}
                        onPointerCancel={cancelPress}
                        onPointerLeave={cancelPress}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (!multi)
                            showActions(m, actionAnchorOf(e.currentTarget));
                        }}
                      >
                        <RichMessageContent
                          message={{
                            ...m,
                            content,
                            translation:
                              conversationAppearance.autoTranslate === false
                                ? undefined
                                : m.translation,
                          }}
                          assets={mediaAssets}
                          onInvitationRetry={async (eventId) => {
                            await retryChatReply(eventId);
                            wakeChatReplyPump({ source: "foreground" });
                          }}
                        />
                      </div>
                      {reaction && (
                        <MessageReactionBadge
                          kind={reaction.kind}
                          mine={m.senderType === "user"}
                        />
                      )}
                    </div>
                    <time>
                      {stamp(m.createdAt)}
                      {m.generation?.stopped ? " · 已停止" : ""}
                    </time>
                  </div>
                  {multi &&
                    selectionAnchorId &&
                    m.id !== selectionAnchorId &&
                    m.id === lastVisibleMessageId && (
                      <button
                        className={`select-to-here ${m.senderType === "user" ? "mine" : "theirs"}`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          selectToMessage(m.id);
                        }}
                      >
                        <ArrowUp />
                        选到这里
                      </button>
                    )}
                </div>
                {m.senderType === "user" && avatarSettings.showUserAvatar && (
                  <Avatar
                    text={settings.userName || "我"}
                    src={settings.userAvatar}
                    size="sm"
                  />
                )}
              </div>
            );
          })
        )}
        {error && !multi && (
          <div className="generation-error">
            <AlertCircle />
            <div>
              <b>回复没有完成</b>
              <p>{error}</p>
              <span>
                {!provider.apiKey && (
                  <button onClick={() => nav("/settings")}>
                    <Settings />
                    前往设置
                  </button>
                )}
                <button type="button" disabled={busy} onClick={generate}>
                  <RefreshCw />
                  重试回复
                </button>
              </span>
            </div>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {interactionLocked && !multi && (
        <div className="blocked-chat-banner">
          <ShieldBan />
          <span>
            <b>{restrictionCopy.title}</b>
            <small>{restrictionCopy.detail}</small>
          </span>
          <button onClick={() => nav(restrictionCopy.path)}>
            {restrictionCopy.action}
          </button>
        </div>
      )}
      {multi ? (
        <div className="multi-toolbar">
          <button onClick={() => void favoriteSelected()}>
            <Star />
            <span>收藏</span>
          </button>
          <button onClick={captureSelectedMessages}>
            <ImageDown />
            <span>截图</span>
          </button>
          <button onClick={() => setPopup("forward")}>
            <Forward />
            <span>转发</span>
          </button>
          <button onClick={() => setPopup("bulk-delete")}>
            <Trash2 />
            <span>删除</span>
          </button>
        </div>
      ) : (
        <>
          {quoteDraft && (
            <ComposerQuotePreview
              quote={quoteDraft}
              onCancel={() => setQuoteDraft(null)}
            />
          )}
          <div className="composer media-composer">
            <button
              className="composer-plus"
              aria-label="更多功能"
              disabled={busy || interactionLocked}
              onClick={() => setPopup("extensions")}
            >
              <Plus />
            </button>
            <div className="composer-input-shell">
              <textarea
                ref={composerInput}
                aria-label="输入消息"
                rows={1}
                placeholder={
                  isGroup && conversationAppearance.userInGroup === false
                    ? "输入仅角色可感知的幕后指导…"
                    : `发送给 ${displayTitle}…`
                }
                value={text}
                disabled={busy || interactionLocked}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
              />
              <button
                type="button"
                className="composer-sticker"
                aria-label="贴纸"
                disabled={busy || interactionLocked}
                onClick={() => setPopup("stickers")}
              >
                <SmilePlus />
              </button>
            </div>
            {busy ? (
              <button
                type="button"
                className="stop-button"
                aria-label="停止生成"
                onClick={stop}
              >
                <Square />
              </button>
            ) : text.trim() ? (
              <button
                className="paper-plane"
                disabled={interactionLocked}
                aria-label="发送消息"
                onClick={() => void sendOnly()}
              >
                <SendHorizonal />
              </button>
            ) : (
              <button
                type="button"
                className="generate-button"
                disabled={interactionLocked}
                aria-label={isGroup ? "生成全员回复" : "生成角色回复"}
                onClick={generate}
              >
                <Sparkles />
              </button>
            )}
          </div>
        </>
      )}
      {toastText && <div className="toast">{toastText}</div>}
      {popup === "extensions" && (
        <ExtensionPanel
          onSelect={openExtension}
          onClose={close}
          isGroup={isGroup}
          directorMode={isGroup && conversationAppearance.userInGroup === false}
        />
      )}
      {popup === "stickers" && (
        <StickerPicker
          onSelect={(pack, sticker) => void sendSticker(pack, sticker)}
          onClose={close}
        />
      )}
      {popup === "photo" && <PhotoPanel onSend={sendPhoto} onClose={close} />}
      {popup === "voice" && <VoicePanel onSend={sendVoice} onClose={close} />}
      {popup === "transfer" && (
        <TransferPanel onSend={sendTransfer} onClose={close} />
      )}
      {popup === "music" && !isGroup && (
        <Modal onClose={close}>
          <div className="sheet-head"><div><small>LISTEN TOGETHER</small><h2>邀请角色一起听</h2></div><button onClick={close}><X /></button></div>
          <div className="music-invite-picker">
            {musicPlayer.currentTrack && <button className="music-invite-current" onClick={() => void sendMusicInvitation(musicPlayer.currentTrack?.id)}><span>{musicPlayer.currentTrack.coverUrl ? <img src={musicPlayer.currentTrack.coverUrl} alt="" /> : "♪"}</span><div><small>正在播放</small><b>{musicPlayer.currentTrack.title}</b><em>{musicPlayer.currentTrack.artists.join(" / ")}</em></div></button>}
            <div className="music-invite-list">{musicPlayer.tracks.slice(0, 30).map((track) => <button key={track.id} onClick={() => void sendMusicInvitation(track.id)}><span>{track.coverUrl ? <img src={track.coverUrl} alt="" /> : "♪"}</span><div><b>{track.title}</b><small>{track.artists.join(" / ")}</small></div></button>)}</div>
            {!musicPlayer.tracks.length && <div className="music-invite-empty"><p>音乐库还没有歌曲。</p><button onClick={() => nav("/music")}>前往音乐 App 导入</button></div>}
            <button className="secondary-action" onClick={() => nav("/music")}>打开音乐 App</button>
          </div>
        </Modal>
      )}
      {popup === "red-packet" && (
        <RedPacketPanel
          maxMembers={
            members.filter((member) => canCharacterInteract(member)).length
          }
          onSend={(amount, count, note) =>
            void sendRedPacket(amount, count, note)
          }
          onClose={close}
        />
      )}
      {popup === "poll" && (
        <PollPanel
          onSend={(question, mode, options) =>
            void sendPoll(question, mode, options)
          }
          onClose={close}
        />
      )}
      {popup === "chat-menu" && (
        <Modal onClose={close}>
          <div className="sheet-head">
            <div>
              <small>CHAT MENU</small>
              <h2>{character.name} 的聊天设置</h2>
            </div>
            <button onClick={close}>
              <X />
            </button>
          </div>
          <div className="chat-settings-menu">
            <button onClick={() => setPopup("chat-settings")}>
              <Settings />
              <span>
                <b>基础聊天设置</b>
                <small>语言、上下文、流式输出与世界书</small>
              </span>
            </button>
            <button onClick={() => setPopup("proactive-settings")}>
              <Sparkles />
              <span>
                <b>主动互动</b>
                <small>主动私聊、动态与勿扰时段</small>
              </span>
            </button>
            <button onClick={() => setPopup("feed-image-settings")}>
              <ImagePlus />
              <span>
                <b>生图设置</b>
                <small>主动动态配图开关、形象提示词与参考图</small>
              </span>
            </button>
            <button onClick={openMemorySettings}>
              <BookOpen />
              <span>
                <b>记忆整理</b>
                <small>自动阈值与未整理内容</small>
              </span>
            </button>
            <button
              disabled={!list.length || extracting}
              onClick={extractMemories}
            >
              <RefreshCw />
              <span>
                <b>{extracting ? "正在整理…" : "立即整理当前聊天"}</b>
                <small>生成待审核记忆候选</small>
              </span>
            </button>
          </div>
        </Modal>
      )}
      {popup === "model-picker" && (
        <Modal onClose={() => setPopup("extensions")}>
          <div className="sheet-head">
            <h2>切换聊天模型</h2>
            <button onClick={() => setPopup("extensions")}>
              <X />
            </button>
          </div>
          <div className="chat-model-picker">
            <p>只影响当前聊天，不会修改全局主 API。</p>
            {conversationAppearance.providerPresetId &&
              !selectedProviderPreset && (
                <div className="chat-model-missing">
                  原预设已不可用，当前已回退全局主 API。
                </div>
              )}
            <button
              className={
                !conversationAppearance.providerPresetId ? "selected" : ""
              }
              disabled={busy}
              onClick={() => void selectConversationPreset()}
            >
              <span>
                <b>跟随全局主 API</b>
                <small>
                  {provider.model} · {providerHost(provider.baseUrl)}
                </small>
              </span>
              {!conversationAppearance.providerPresetId && <Check />}
            </button>
            {providerPresets.items.map((preset) => (
              <button
                key={preset.id}
                className={
                  conversationAppearance.providerPresetId === preset.id
                    ? "selected"
                    : ""
                }
                disabled={busy}
                onClick={() => void selectConversationPreset(preset.id)}
              >
                <span>
                  <b>{preset.name}</b>
                  <small>
                    {preset.provider.model} ·{" "}
                    {providerHost(preset.provider.baseUrl)}
                  </small>
                </span>
                {conversationAppearance.providerPresetId === preset.id && (
                  <Check />
                )}
              </button>
            ))}
            {!providerPresets.items.length && (
              <div className="chat-model-empty">
                <p>主 API 预设库还是空的。</p>
                <button onClick={() => nav("/settings")}>前往 API 设置</button>
              </div>
            )}
            {modelSwitchStatus && (
              <p className="form-error">{modelSwitchStatus}</p>
            )}
          </div>
        </Modal>
      )}
      {popup === "chat-settings" && (
        <Modal onClose={() => setPopup("chat-menu")}>
          <div className="sheet-head">
            <div>
              <small>CHAT SETTINGS</small>
              <h2>基础聊天设置</h2>
            </div>
            <button onClick={() => setPopup("chat-menu")}>
              <X />
            </button>
          </div>
          <div className="simple-form">
            <label>
              输出语言
              <select
                value={chatDraft.language}
                onChange={(e) =>
                  setChatDraft({
                    ...chatDraft,
                    language: e.target.value as Language,
                  })
                }
              >
                {["中文", "粤语", "English", "日本語", "한국어", "Русский"].map(
                  (x) => (
                    <option key={x}>{x}</option>
                  ),
                )}
              </select>
            </label>
            <label>
              上下文消息数量
              <input
                type="number"
                min="2"
                max="100"
                value={chatDraft.contextLimit}
                onChange={(e) =>
                  setChatDraft({
                    ...chatDraft,
                    contextLimit: Math.max(
                      2,
                      Math.min(100, Number(e.target.value)),
                    ),
                  })
                }
              />
            </label>
            <div className="chat-reply-range-fields">
              <label>
                最少回复条数
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="8"
                  value={minReplyDraft}
                  onChange={(event) => {
                    setMinReplyDraft(event.target.value);
                    setChatSettingsError("");
                  }}
                />
              </label>
              <label>
                最多回复条数
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="8"
                  value={maxReplyDraft}
                  onChange={(event) => {
                    setMaxReplyDraft(event.target.value);
                    setChatSettingsError("");
                  }}
                />
              </label>
            </div>
            <p className="form-hint chat-reply-range-help">
              两项留空时，回复条数由当前上下文和角色人设自然决定；填写后每条会保存成独立气泡。
            </p>
            <label className="switch-row">
              <span>
                <b>自动翻译</b>
                <small>
                  {chatDraft.language === "中文"
                    ? "当前语言无需翻译"
                    : "原文和中文译文会在同一次回复中一起生成"}
                </small>
              </span>
              <input
                type="checkbox"
                checked={autoTranslate}
                onChange={(e) => setAutoTranslate(e.target.checked)}
              />
            </label>
            <fieldset className="chat-avatar-settings">
              <legend>消息头像</legend>
              <label className="switch-row">
                <span>
                  <b>显示用户头像</b>
                  <small>在自己发送的消息右侧显示“我的人设”头像</small>
                </span>
                <input
                  type="checkbox"
                  checked={chatDraft.avatars?.showUserAvatar ?? true}
                  onChange={(e) =>
                    setChatDraft({
                      ...chatDraft,
                      avatars: {
                        showUserAvatar: e.target.checked,
                        showCharacterAvatar:
                          chatDraft.avatars?.showCharacterAvatar ?? true,
                      },
                    })
                  }
                />
              </label>
              <label className="switch-row">
                <span>
                  <b>显示角色头像</b>
                  <small>在角色消息左侧显示对应角色头像</small>
                </span>
                <input
                  type="checkbox"
                  checked={chatDraft.avatars?.showCharacterAvatar ?? true}
                  onChange={(e) =>
                    setChatDraft({
                      ...chatDraft,
                      avatars: {
                        showUserAvatar:
                          chatDraft.avatars?.showUserAvatar ?? true,
                        showCharacterAvatar: e.target.checked,
                      },
                    })
                  }
                />
              </label>
            </fieldset>
            <label className="switch-row strategy-mode-switch">
              <span>
                <b>攻略模式</b>
                <small>
                  根据私聊与通话中的用户表现自动调整亲密度和信任度；每轮会增加一次模型评估调用。
                </small>
              </span>
              <input
                type="checkbox"
                checked={chatDraft.strategyMode?.enabled ?? false}
                onChange={(e) =>
                  setChatDraft({
                    ...chatDraft,
                    strategyMode: { enabled: e.target.checked },
                  })
                }
              />
            </label>
            <label className="switch-row">
              <span>
                <b>角色见面邀请</b>
                <small>
                  开启后，角色在聊天中产生明确线下意图时可发送见面邀请；相关轮次会增加一次判定调用。
                </small>
              </span>
              <input
                type="checkbox"
                checked={chatDraft.meetInvitations?.enabled ?? false}
                onChange={(e) =>
                  setChatDraft({
                    ...chatDraft,
                    meetInvitations: { enabled: e.target.checked },
                  })
                }
              />
            </label>
            {!isGroup && <fieldset className="character-music-settings">
              <legend>一起听</legend>
              <label className="switch-row"><span><b>允许主动邀请</b><small>角色可在主动消息中邀请你一起听</small></span><input type="checkbox" checked={chatDraft.music?.canInviteToListen ?? true} onChange={(e) => setChatDraft({ ...chatDraft, music: { canInviteToListen: e.target.checked, canControlPlayback: chatDraft.music?.canControlPlayback ?? true, commentaryLevel: chatDraft.music?.commentaryLevel ?? "medium", djEnabled: chatDraft.music?.djEnabled ?? true, controlMode: chatDraft.music?.controlMode ?? "balanced", allowNeteaseSearch: chatDraft.music?.allowNeteaseSearch ?? true, moodImprintEnabled: chatDraft.music?.moodImprintEnabled ?? true, moodRecallEnabled: chatDraft.music?.moodRecallEnabled ?? true, lastProactiveInviteAt: chatDraft.music?.lastProactiveInviteAt, lastCommentAt: chatDraft.music?.lastCommentAt, lastCommentTrackId: chatDraft.music?.lastCommentTrackId } })} /></label>
              <label className="switch-row"><span><b>允许控制播放</b><small>角色可暂停、切歌或选择音乐库中的歌曲</small></span><input type="checkbox" checked={chatDraft.music?.canControlPlayback ?? true} onChange={(e) => setChatDraft({ ...chatDraft, music: { canInviteToListen: chatDraft.music?.canInviteToListen ?? true, canControlPlayback: e.target.checked, commentaryLevel: chatDraft.music?.commentaryLevel ?? "medium", djEnabled: chatDraft.music?.djEnabled ?? true, controlMode: chatDraft.music?.controlMode ?? "balanced", allowNeteaseSearch: chatDraft.music?.allowNeteaseSearch ?? true, moodImprintEnabled: chatDraft.music?.moodImprintEnabled ?? true, moodRecallEnabled: chatDraft.music?.moodRecallEnabled ?? true, lastProactiveInviteAt: chatDraft.music?.lastProactiveInviteAt, lastCommentAt: chatDraft.music?.lastCommentAt, lastCommentTrackId: chatDraft.music?.lastCommentTrackId } })} /></label>
              <label>聊歌频率<select value={chatDraft.music?.commentaryLevel ?? "medium"} onChange={(e) => setChatDraft({ ...chatDraft, music: { canInviteToListen: chatDraft.music?.canInviteToListen ?? true, canControlPlayback: chatDraft.music?.canControlPlayback ?? true, commentaryLevel: e.target.value as "off" | "low" | "medium" | "high", djEnabled: chatDraft.music?.djEnabled ?? true, controlMode: chatDraft.music?.controlMode ?? "balanced", allowNeteaseSearch: chatDraft.music?.allowNeteaseSearch ?? true, moodImprintEnabled: chatDraft.music?.moodImprintEnabled ?? true, moodRecallEnabled: chatDraft.music?.moodRecallEnabled ?? true, lastProactiveInviteAt: chatDraft.music?.lastProactiveInviteAt, lastCommentAt: chatDraft.music?.lastCommentAt, lastCommentTrackId: chatDraft.music?.lastCommentTrackId } })}><option value="off">关闭</option><option value="low">低</option><option value="medium">适中</option><option value="high">高</option></select></label>
              <label className="switch-row"><span><b>启用角色 DJ</b><small>允许角色根据当前氛围点歌和补充队列</small></span><input type="checkbox" checked={chatDraft.music?.djEnabled ?? true} onChange={(e) => setChatDraft({ ...chatDraft, music: { ...chatDraft.music!, canInviteToListen: chatDraft.music?.canInviteToListen ?? true, canControlPlayback: chatDraft.music?.canControlPlayback ?? true, commentaryLevel: chatDraft.music?.commentaryLevel ?? "medium", djEnabled: e.target.checked, controlMode: chatDraft.music?.controlMode ?? "balanced", allowNeteaseSearch: chatDraft.music?.allowNeteaseSearch ?? true } })} /></label>
              <label>播放控制模式<select value={chatDraft.music?.controlMode ?? "balanced"} onChange={(e) => setChatDraft({ ...chatDraft, music: { ...chatDraft.music!, canInviteToListen: chatDraft.music?.canInviteToListen ?? true, canControlPlayback: chatDraft.music?.canControlPlayback ?? true, commentaryLevel: chatDraft.music?.commentaryLevel ?? "medium", djEnabled: chatDraft.music?.djEnabled ?? true, controlMode: e.target.value as "suggest" | "balanced" | "full", allowNeteaseSearch: chatDraft.music?.allowNeteaseSearch ?? true } })}><option value="suggest">只建议</option><option value="balanced">适中</option><option value="full">完全控制</option></select></label>
              <label className="switch-row"><span><b>允许网易云搜索</b><small>本地没有合适歌曲时，可搜索官方单曲候选</small></span><input type="checkbox" checked={chatDraft.music?.allowNeteaseSearch ?? true} onChange={(e) => setChatDraft({ ...chatDraft, music: { ...chatDraft.music!, canInviteToListen: chatDraft.music?.canInviteToListen ?? true, canControlPlayback: chatDraft.music?.canControlPlayback ?? true, commentaryLevel: chatDraft.music?.commentaryLevel ?? "medium", djEnabled: chatDraft.music?.djEnabled ?? true, controlMode: chatDraft.music?.controlMode ?? "balanced", allowNeteaseSearch: e.target.checked } })} /></label>
                          <label className="switch-row"><span><b>生成心情印记</b><small>一起听期间存在真实双向聊天时，结束后保存音乐专属回忆</small></span><input type="checkbox" checked={chatDraft.music?.moodImprintEnabled ?? true} onChange={(e) => setChatDraft({ ...chatDraft, music: { ...chatDraft.music!, canInviteToListen: chatDraft.music?.canInviteToListen ?? true, canControlPlayback: chatDraft.music?.canControlPlayback ?? true, commentaryLevel: chatDraft.music?.commentaryLevel ?? "medium", moodImprintEnabled: e.target.checked, moodRecallEnabled: chatDraft.music?.moodRecallEnabled ?? true } })} /></label>
              <label className="switch-row"><span><b>允许主动回忆</b><small>再次与该角色一起听同一首歌时，有概率提起真实聊天内容</small></span><input type="checkbox" checked={chatDraft.music?.moodRecallEnabled ?? true} onChange={(e) => setChatDraft({ ...chatDraft, music: { ...chatDraft.music!, canInviteToListen: chatDraft.music?.canInviteToListen ?? true, canControlPlayback: chatDraft.music?.canControlPlayback ?? true, commentaryLevel: chatDraft.music?.commentaryLevel ?? "medium", moodImprintEnabled: chatDraft.music?.moodImprintEnabled ?? true, moodRecallEnabled: e.target.checked } })} /></label></fieldset>}
            <fieldset className="character-speech-settings">
              <legend>通话声音</legend>
              <label className="switch-row">
                <span>
                  <b>朗读角色回复</b>
                  <small>仅用于模拟通话，未配置时仍显示文字</small>
                </span>
                <input
                  type="checkbox"
                  checked={chatDraft.speech?.enabled ?? false}
                  onChange={(e) =>
                    setChatDraft({
                      ...chatDraft,
                      speech: {
                        enabled: e.target.checked,
                        provider: chatDraft.speech?.provider ?? "inherit",
                        voiceId: chatDraft.speech?.voiceId,
                        model: chatDraft.speech?.model,
                      },
                    })
                  }
                />
              </label>
              <label>
                语音服务
                <select
                  value={chatDraft.speech?.provider ?? "inherit"}
                  onChange={(e) =>
                    setChatDraft({
                      ...chatDraft,
                      speech: {
                        enabled: chatDraft.speech?.enabled ?? false,
                        provider: e.target.value as
                          "inherit" | "minimax" | "elevenlabs",
                        voiceId: chatDraft.speech?.voiceId,
                        model: chatDraft.speech?.model,
                      },
                    })
                  }
                >
                  <option value="inherit">继承全局默认</option>
                  <option value="minimax">MiniMax</option>
                  <option value="elevenlabs">ElevenLabs</option>
                </select>
              </label>
              <label>
                角色 Voice ID
                <input
                  value={chatDraft.speech?.voiceId ?? ""}
                  onChange={(e) =>
                    setChatDraft({
                      ...chatDraft,
                      speech: {
                        enabled: chatDraft.speech?.enabled ?? false,
                        provider: chatDraft.speech?.provider ?? "inherit",
                        voiceId: e.target.value,
                        model: chatDraft.speech?.model,
                      },
                    })
                  }
                  placeholder="留空时继承服务默认"
                />
              </label>
              <label>
                角色语音模型
                <input
                  value={chatDraft.speech?.model ?? ""}
                  onChange={(e) =>
                    setChatDraft({
                      ...chatDraft,
                      speech: {
                        enabled: chatDraft.speech?.enabled ?? false,
                        provider: chatDraft.speech?.provider ?? "inherit",
                        voiceId: chatDraft.speech?.voiceId,
                        model: e.target.value,
                      },
                    })
                  }
                  placeholder="留空时继承服务默认"
                />
              </label>
            </fieldset>
            <div className="lore-mount">
              <span>
                <BookOpen />
                挂载世界书
              </span>
              {loreBooks.map((b) => (
                <label key={b.id}>
                  <input
                    type="checkbox"
                    checked={mountedBooks.includes(b.id)}
                    onChange={() =>
                      setMountedBooks(
                        mountedBooks.includes(b.id)
                          ? mountedBooks.filter((x) => x !== b.id)
                          : [...mountedBooks, b.id],
                      )
                    }
                  />
                  <i />
                  {b.name}
                </label>
              ))}
            </div>
            {chatSettingsError && (
              <p className="form-error">{chatSettingsError}</p>
            )}
            <button className="primary" onClick={saveChatSettings}>
              保存聊天设置
            </button>
          </div>
        </Modal>
      )}
      {popup === "feed-image-settings" && (
        <Modal onClose={() => setPopup("chat-menu")}>
          <div className="sheet-head">
            <div>
              <small>FEED IMAGE</small>
              <h2>生图设置</h2>
            </div>
            <button onClick={() => setPopup("chat-menu")}>
              <X />
            </button>
          </div>
          <div className="simple-form feed-image-character-settings">
            <label className="switch-row">
              <span>
                <b>允许主动动态生成图片</b>
                <small>全局生图服务和本角色开关都启用时才会配图。</small>
              </span>
              <input
                type="checkbox"
                checked={chatDraft.feedImage?.enabled ?? false}
                onChange={(e) =>
                  setChatDraft({
                    ...chatDraft,
                    feedImage: {
                      enabled: e.target.checked,
                      appearancePrompt:
                        chatDraft.feedImage?.appearancePrompt ?? "",
                      referenceAssetId: chatDraft.feedImage?.referenceAssetId,
                    },
                  })
                }
              />
            </label>
            <label>
              角色形象提示词
              <textarea
                rows={5}
                value={chatDraft.feedImage?.appearancePrompt ?? ""}
                onChange={(e) =>
                  setChatDraft({
                    ...chatDraft,
                    feedImage: {
                      enabled: chatDraft.feedImage?.enabled ?? false,
                      appearancePrompt: e.target.value,
                      referenceAssetId: chatDraft.feedImage?.referenceAssetId,
                    },
                  })
                }
                placeholder="发型、服装、配色、画风和固定特征"
              />
            </label>
            {chatDraft.feedImage?.referenceAssetId && (
              <div className="feed-reference-preview">
                <img
                  src={
                    mediaAssets.get(chatDraft.feedImage.referenceAssetId)?.data
                  }
                  alt="角色参考图"
                />
                <button
                  onClick={() =>
                    setChatDraft({
                      ...chatDraft,
                      feedImage: {
                        enabled: chatDraft.feedImage?.enabled ?? false,
                        appearancePrompt:
                          chatDraft.feedImage?.appearancePrompt ?? "",
                      },
                    })
                  }
                >
                  <Trash2 />
                  移除参考图
                </button>
              </div>
            )}
            <button
              className="secondary-action"
              onClick={() => feedReferenceRef.current?.click()}
            >
              <ImagePlus />
              选择一张参考图
            </button>
            <input
              ref={feedReferenceRef}
              hidden
              type="file"
              accept="image/*"
              onChange={(e) => void chooseFeedReference(e.target.files?.[0])}
            />
            <button className="primary" onClick={saveChatSettings}>
              保存生图设置
            </button>
          </div>
        </Modal>
      )}{" "}
      {popup === "proactive-settings" && (
        <Modal onClose={() => setPopup("chat-menu")}>
          <div className="sheet-head">
            <div>
              <small>PROACTIVE</small>
              <h2>主动互动</h2>
            </div>
            <button onClick={() => setPopup("chat-menu")}>
              <X />
            </button>
          </div>
          <div className="simple-form proactive-form">
            <label className="switch-row">
              <span>
                <b>时间感知</b>
                <small>开启后会补算网页关闭期间到期的事件。</small>
              </span>
              <input
                type="checkbox"
                checked={proactiveDraft.timeAware}
                onChange={(e) =>
                  setProactiveDraft({
                    ...proactiveDraft,
                    timeAware: e.target.checked,
                  })
                }
              />
            </label>
            <div className="form-row">
              <label>
                勿扰开始
                <input
                  type="time"
                  value={proactiveDraft.quietStart}
                  onChange={(e) =>
                    setProactiveDraft({
                      ...proactiveDraft,
                      quietStart: e.target.value,
                    })
                  }
                />
              </label>
              <label>
                勿扰结束
                <input
                  type="time"
                  value={proactiveDraft.quietEnd}
                  onChange={(e) =>
                    setProactiveDraft({
                      ...proactiveDraft,
                      quietEnd: e.target.value,
                    })
                  }
                />
              </label>
            </div>
            <Channel
              title="主动私聊"
              value={proactiveDraft.message}
              set={(message) =>
                setProactiveDraft({ ...proactiveDraft, message })
              }
            />
            <Channel
              title="主动动态"
              value={proactiveDraft.feed}
              set={(feed) => setProactiveDraft({ ...proactiveDraft, feed })}
            />
            {proactiveError && <p className="form-error">{proactiveError}</p>}
            <button className="primary" onClick={saveProactiveSettings}>
              保存主动互动设置
            </button>
            <button
              className="secondary-action"
              onClick={() =>
                window.dispatchEvent(new Event("mira:proactive-check"))
              }
            >
              立即检查
            </button>
          </div>
        </Modal>
      )}
      {popup === "memory-settings" && (
        <Modal onClose={() => setPopup("chat-menu")}>
          <div className="sheet-head">
            <div>
              <small>MEMORY EXTRACTION</small>
              <h2>记忆整理</h2>
            </div>
            <button onClick={() => setPopup("chat-menu")}>
              <X />
            </button>
          </div>
          <div className="simple-form proactive-form">
            <label>
              整理模式
              <select
                value={memoryDraft.mode}
                onChange={(e) =>
                  setMemoryDraft({
                    ...memoryDraft,
                    mode: e.target.value as MemoryExtractionSettings["mode"],
                  })
                }
              >
                <option value="manual">手动整理</option>
                <option value="auto">自动提取候选</option>
              </select>
            </label>
            <label>
              聊天触发条数
              <input
                type="number"
                min="10"
                max="200"
                value={memoryDraft.chatThreshold}
                onChange={(e) =>
                  setMemoryDraft({
                    ...memoryDraft,
                    chatThreshold: Number(e.target.value) || 50,
                  })
                }
              />
            </label>
            <div className="extraction-stats">
              <span>
                未整理聊天 <b>{memoryStats}</b>
              </span>
            </div>
            <p className="form-hint">动态内容不会参与记忆整理。</p>
            {memorySettingsError && (
              <p className="form-error">{memorySettingsError}</p>
            )}
            <button className="primary" onClick={saveMemorySettings}>
              保存记忆设置
            </button>
          </div>
        </Modal>
      )}{" "}
      {popup === "actions" && chosen && actionAnchor && (
        <MessageActionOverlay
          message={
            conversationAppearance.autoTranslate === false
              ? { ...chosen, translation: undefined }
              : chosen
          }
          assets={mediaAssets}
          anchor={actionAnchor}
          currentReaction={userReactionOf(chosen)?.kind}
          canEdit={
            !chosen.kind ||
            ["text", "sticker", "image", "voice"].includes(chosen.kind)
          }
          canRegenerate={canRegenerateMessage(chosen)}
          onClose={close}
          onQuote={beginQuote}
          onRegenerate={openRegeneration}
          onCopy={() => void copyOne()}
          onEdit={() => {
            setEditText(chosen.content);
            leaveActions("edit");
          }}
          onMulti={beginMulti}
          onDelete={() => leaveActions("delete")}
          onReact={(kind) => void applyReaction(kind)}
          translationLabel={translationActionLabel}
          onTranslate={
            chosen ? () => void translateOne(chosen, true) : undefined
          }
        />
      )}
      {popup === "regenerate" && chosen && (
        <Modal onClose={close}>
          <RegenerationDialog
            originalText={chosen.content}
            reasons={regenerationReasons}
            instruction={regenerationInstruction}
            onToggle={toggleRegenerationReason}
            onInstructionChange={setRegenerationInstruction}
            onClose={close}
            onDirect={() => submitRegeneration(false)}
            onGuided={() => submitRegeneration(true)}
          />
        </Modal>
      )}{" "}
      {popup === "edit" && chosen && (
        <Modal onClose={close}>
          <div className="sheet-head">
            <div>
              <small>EDIT MESSAGE</small>
              <h2>编辑消息</h2>
            </div>
            <button onClick={close}>
              <X />
            </button>
          </div>
          <div className="edit-message">
            <textarea
              autoFocus
              rows={6}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
            />
            <button
              className="primary"
              disabled={!editText.trim()}
              onClick={saveEdit}
            >
              保存修改
            </button>
          </div>
        </Modal>
      )}
      {popup === "delete" && chosen && (
        <Modal onClose={close}>
          <Confirm
            title="删除这条消息？"
            text="只删除当前选中的消息，其他聊天内容保持不变。"
            action="删除消息"
            onCancel={close}
            onConfirm={() => deleteIds([chosen.id])}
          />
        </Modal>
      )}
      {popup === "bulk-delete" && (
        <Modal onClose={close}>
          <Confirm
            title={`删除 ${selected.size} 条消息？`}
            text="只删除已选择的消息，此操作无法撤销。"
            action="确认删除"
            onCancel={close}
            onConfirm={() => deleteIds([...selected])}
          />
        </Modal>
      )}
      {popup === "forward" && (
        <Modal onClose={close}>
          <div className="sheet-head">
            <div>
              <small>FORWARD</small>
              <h2>转发 {selected.size} 条消息</h2>
            </div>
            <button onClick={close}>
              <X />
            </button>
          </div>
          <div className="forward-preview">
            <small>合并预览</small>
            <p>
              {formatForward(
                list.filter((m) => selected.has(m.id)),
                characters,
                settings.userName,
                conversation,
              )}
            </p>
          </div>
          <div className="forward-targets">
            {targets.length ? (
              targets.map((c) => (
                <button key={c.id} onClick={() => doForward(c.id)}>
                  <Avatar text={c.title} />
                  <div>
                    <b>{c.title}</b>
                    <small>转发为一条本地消息</small>
                  </div>
                </button>
              ))
            ) : (
              <p>暂无可转发的其他会话。</p>
            )}
          </div>
        </Modal>
      )}
      {popup === "group" && (
        <Modal onClose={close}>
          <div className="sheet-head">
            <div>
              <small>GROUP SETTINGS</small>
              <h2>群聊设置</h2>
            </div>
            <button onClick={close}>
              <X />
            </button>
          </div>
          <div className="group-form">
            <label>
              群聊名称
              <input
                value={groupTitle}
                onChange={(e) => setGroupTitle(e.target.value)}
              />
            </label>
            <label>
              群成员 <em>至少保留 2 位</em>
            </label>
            <div className="picker-list">
              {characters.map((c) => (
                <button
                  className={groupMembers.has(c.id) ? "picked" : ""}
                  key={c.id}
                  onClick={() => toggleSet(groupMembers, c.id, setGroupMembers)}
                >
                  <Avatar text={c.name} src={c.avatar} />
                  <span>{c.name}</span>
                  <i>{groupMembers.has(c.id) && <Check />}</i>
                </button>
              ))}
            </div>
            <label>
              群聊专属世界书 <em>同时采用角色个人世界书</em>
            </label>
            <div className="book-picks">
              {loreBooks.map((b) => (
                <button
                  className={groupBooks.has(b.id) ? "picked" : ""}
                  key={b.id}
                  onClick={() => toggleSet(groupBooks, b.id, setGroupBooks)}
                >
                  <span>
                    <b>{b.name}</b>
                    <small>{b.entries.length} 条设定</small>
                  </span>
                  <i>{groupBooks.has(b.id) && <Check />}</i>
                </button>
              ))}
            </div>
            <button
              className="primary"
              disabled={groupMembers.size < 2 || !groupTitle.trim()}
              onClick={saveGroup}
            >
              保存群聊设置
            </button>
            <label>
              记忆视角
              <select
                value={memoryTarget}
                onChange={(e) => setMemoryTarget(e.target.value)}
              >
                {members.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary-action"
              disabled={!list.length || extracting}
              onClick={extractMemories}
            >
              <Sparkles />
              {extracting ? "正在提取…" : "整理群聊记忆"}
            </button>
            <button
              className="danger-link"
              onClick={() => setPopup("delete-group")}
            >
              <Trash2 />
              删除群聊
            </button>
          </div>
        </Modal>
      )}
      {popup === "delete-group" && (
        <Modal onClose={close}>
          <Confirm
            title="删除这个群聊？"
            text="群聊和其中全部消息将被删除，角色和世界书不会受到影响。"
            action="删除群聊"
            onCancel={close}
            onConfirm={deleteGroup}
          />
        </Modal>
      )}
    </div>
  );
}
function Confirm({
  title,
  text,
  action,
  onCancel,
  onConfirm,
}: {
  title: string;
  text: string;
  action: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="compact-confirm">
      <Trash2 />
      <h2>{title}</h2>
      <p>{text}</p>
      <button className="danger-button" onClick={onConfirm}>
        {action}
      </button>
      <button className="cancel-button" onClick={onCancel}>
        取消
      </button>
    </div>
  );
}
function Channel({
  title,
  value,
  set,
}: {
  title: string;
  value: ProactiveSettings["message"];
  set: (v: ProactiveSettings["message"]) => void;
}) {
  return (
    <fieldset className="proactive-channel">
      <label className="switch-row">
        <span>
          <b>{title}</b>
          <small>仅网页打开时运行</small>
        </span>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => set({ ...value, enabled: e.target.checked })}
        />
      </label>
      <div className="form-row">
        <label>
          间隔小时
          <input
            type="number"
            min="1"
            max="720"
            value={value.intervalHours ?? ""}
            onChange={(e) =>
              set({
                ...value,
                intervalHours: e.target.value
                  ? Number(e.target.value)
                  : undefined,
              })
            }
          />
        </label>
        <label>
          单次补算
          <input
            type="number"
            min="1"
            value={value.catchupLimit ?? ""}
            onChange={(e) =>
              set({
                ...value,
                catchupLimit: e.target.value
                  ? Number(e.target.value)
                  : undefined,
              })
            }
          />
        </label>
        <label>
          每日上限
          <input
            type="number"
            min="1"
            value={value.dailyLimit ?? ""}
            onChange={(e) =>
              set({
                ...value,
                dailyLimit: e.target.value ? Number(e.target.value) : undefined,
              })
            }
          />
        </label>
      </div>
    </fieldset>
  );
}

function apiErrorCode(error?: ApiErrorInfo) {
  if (!error) return "";
  return [
    error.httpStatus ? "HTTP " + error.httpStatus : undefined,
    error.providerCode,
    error.httpStatus || error.providerCode
      ? undefined
      : error.kind.toUpperCase(),
  ]
    .filter(Boolean)
    .join(" · ");
}
function ChatTaskThinking({
  phase,
  apiError,
}: {
  phase?: ChatReplyPhase;
  apiError?: ApiErrorInfo;
}) {
  const paused = phase === "paused" && apiError;
  return (
    <div className="chat-task-thinking">
      <div className="thinking">
        <i />
        <i />
        <i />
      </div>
      {!paused && (
        <small>
          {phase === "queued"
            ? "排队中…"
            : phase === "preparing"
              ? "正在准备…"
              : phase === "validating" || phase === "reviewing"
                ? "正在检查回复…"
                : "正在生成…"}
        </small>
      )}
      {paused && (
        <small>
          {apiErrorCode(apiError) && <b>{apiErrorCode(apiError)}</b>}
          {apiError.meaning + "，等待自动恢复（1/1）"}
        </small>
      )}
    </div>
  );
}
function ChatTaskError({
  apiError,
  fallback,
  canRetry,
  onRetry,
  onSettings,
  onCopyDiagnostic,
}: {
  apiError?: ApiErrorInfo;
  fallback?: string;
  canRetry: boolean;
  onRetry: () => void;
  onSettings: () => void;
  onCopyDiagnostic: () => void;
}) {
  if (!apiError)
    return (
      <div className="chat-task-error">
        <AlertCircle />
        <div>
          <b>回复没有完成</b>
          <p>{fallback ?? "请稍后重试"}</p>
          {canRetry && (
            <button type="button" onClick={onRetry}>
              <RefreshCw />
              重试
            </button>
          )}
          <button type="button" onClick={onCopyDiagnostic}>复制诊断</button>
        </div>
      </div>
    );
  const code = apiErrorCode(apiError),
    showSettings =
      apiError.kind === "auth" ||
      apiError.kind === "model" ||
      apiError.providerCode === "config_missing",
    requestFailure =
      apiError.httpStatus !== undefined ||
      ["auth", "model", "rate", "timeout", "cors", "network", "server", "interrupted"].includes(apiError.kind),
    errorTitle = requestFailure
      ? "API 请求失败"
      : apiError.failureStage === "inner-voice" || apiError.providerCode === "missing_inner_voice"
        ? "回复缺少完整心声"
        : apiError.failureStage === "persistence"
          ? "回复保存失败"
          : "回复格式未完成";
  return (
    <div className="chat-task-error chat-api-error">
      <AlertCircle />
      <div>
        <b>{errorTitle}</b>
        {code && <span className="chat-api-error-code">{code}</span>}
        <strong>{apiError.meaning}</strong>
        {apiError.detail && apiError.detail !== apiError.meaning && (
          <p>{apiError.detail}</p>
        )}
        <section>
          <b>{requestFailure ? "排查解决办法" : "处理建议"}</b>
          <ol>
            {apiError.troubleshooting.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ol>
        </section>
        <div className="chat-api-error-actions">
          {canRetry && (
            <button type="button" onClick={onRetry}>
              <RefreshCw />
              重试
            </button>
          )}
          {showSettings && (
            <button type="button" onClick={onSettings}>
              <Settings />
              前往 API 设置
            </button>
          )}
          <button type="button" onClick={onCopyDiagnostic}>复制诊断</button>
        </div>
      </div>
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


