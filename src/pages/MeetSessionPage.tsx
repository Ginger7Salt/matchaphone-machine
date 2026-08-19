import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronLeft,
  Coffee,
  Copy,
  Heart,
  MessageCircle,
  MoreHorizontal,
  Octagon,
  Pencil,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  deleteMeetEntry,
  editMeetUserEntry,
  finishMeetSession,
  generateMeetTurn,
  meetEntryPlainText,
  regenerateMeetCharacterEntry,
  regenerateMeetRound,
  retryFailedMeetTurn,
  toggleMeetEntryFavorite,
  updateMeetScene,
} from "../core/meetService";
import { lastSuggestions, normalizeNarrativeSettings } from "../core/meet";
import { useStore } from "../core/store";
import { autoTranslateCharacter } from "../core/bilingual";
import { Avatar, Modal } from "../components/ui";
import type { MeetEntry, MeetNarrativeSettings } from "../core/types";

const Paragraphs = ({ text }: { text?: string }) =>
  text ? (
    <>
      {text
        .split(/\n+/)
        .filter(Boolean)
        .map((part, index) => (
          <p key={index}>{part}</p>
        ))}
    </>
  ) : null;
const timeLabel = (value: number) =>
  new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const meetFailureDetailText: Record<string, string> = {
  "empty-segments": "响应没有可保存的场景片段",
  "missing-dialogue": "响应没有包含有效的角色台词",
  "unknown-character": "响应引用了当前场景之外的角色",
  "invalid-segment": "响应中的场景片段结构无法识别",
  "invalid-scene-update": "响应中的场景状态更新无法识别",
  "length-out-of-range": "响应篇幅不符合见面设置",
  "style-invalid": "响应文风或结构不符合见面设置",
};
const meetGenerationErrorText = (entry: MeetEntry) => {
  const generation = entry.generation;
  if (generation?.error) return generation.error;
  if (generation?.failureClass === "provider-cors")
    return "当前 Provider 不支持浏览器直连或跨域访问，请更换支持 CORS 的接口或配置副 API";
  if (generation?.failureClass === "provider-prompt-blocked")
    return "当前内容被模型安全策略拦截，请缩短上下文或更换模型";
  if (generation?.failureClass === "response-truncated")
    return "Provider 返回的响应被截断，请重新生成";
  if (generation?.failureDetailCode && meetFailureDetailText[generation.failureDetailCode])
    return meetFailureDetailText[generation.failureDetailCode];
  if (generation?.attempts?.some((attempt) => attempt.errorKind === "rate"))
    return "当前模型暂时达到调用频率或额度限制，请稍后重试，或在设置中配置副 API";
  return "本轮场景生成未完成，请重试";
};

export default function MeetSessionPage() {
  const { id = "" } = useParams(),
    nav = useNavigate(),
    [searchParams] = useSearchParams(),
    targetEntryId = searchParams.get("entry"),
    { meetSessions, characters, settings: appSettings, reload } = useStore(),
    session = meetSessions.find((item) => item.id === id);
  const [text, setText] = useState(""),
    [generating, setGenerating] = useState(false),
    [settingsOpen, setSettingsOpen] = useState(false),
    [scene, setScene] = useState(session?.scene),
    [suggestionsEnabled, setSuggestionsEnabled] = useState(
      session?.suggestionsEnabled ?? false,
    ),
    [timeAware, setTimeAware] = useState(session?.timeAware ?? false),
    [narrative, setNarrative] = useState<MeetNarrativeSettings>(() =>
      normalizeNarrativeSettings(session?.narrativeSettings),
    ),
    [error, setError] = useState("");
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null),
    [editingEntryId, setEditingEntryId] = useState<string | null>(null),
    [deletingEntryId, setDeletingEntryId] = useState<string | null>(null),
    [regeneratingId, setRegeneratingId] = useState<string | null>(null),
    [editText, setEditText] = useState(""),
    [toast, setToast] = useState(""),
    [thoughtEntryId, setThoughtEntryId] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null),
    bottom = useRef<HTMLDivElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    styleFileRef = useRef<HTMLInputElement>(null),
    characterMap = useMemo(
      () => new Map(characters.map((character) => [character.id, character])),
      [characters],
    );
  const translationOf = (
    entry: MeetEntry,
    key: "prose" | "thought" | "dialogue",
  ) => {
    const character = characterMap.get(entry.senderId ?? ""),
      translation = entry.translations?.[key];
    return character &&
      autoTranslateCharacter(character) &&
      translation?.status === "complete"
      ? translation.text
      : undefined;
  };
  useEffect(() => {
    if (!targetEntryId) bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.entries.length, generating, targetEntryId]);
  useEffect(() => {
    if (!session) return;
    setScene(session.scene);
    setSuggestionsEnabled(session.suggestionsEnabled);
    setTimeAware(session.timeAware ?? false);
    setNarrative(normalizeNarrativeSettings(session.narrativeSettings));
  }, [session?.id]);
  useEffect(() => {
    if (!targetEntryId || !session) return;
    const timer = window.setTimeout(
      () =>
        document
          .getElementById(`meet-entry-${targetEntryId}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" }),
      120,
    );
    return () => window.clearTimeout(timer);
  }, [targetEntryId, session?.entries.length]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);
  if (!session)
    return (
      <div className="meet-missing">
        <Coffee />
        <h2>没有找到这次见面</h2>
        <button onClick={() => nav("/meet")}>返回见面</button>
      </div>
    );
  const ended = session.status === "ended",
    participantNames = session.participantIds
      .map((pid) => characterMap.get(pid)?.name ?? "已删除角色")
      .join("、"),
    suggestions = lastSuggestions(session.entries),
    selected = session.entries.find((entry) => entry.id === selectedEntryId),
    editing = session.entries.find((entry) => entry.id === editingEntryId),
    deleting = session.entries.find((entry) => entry.id === deletingEntryId),
    hasRoundResponse = (entry: MeetEntry) =>
      session.entries.some(
        (candidate) =>
          candidate.senderType === "character" &&
          candidate.roundId === entry.roundId,
      ),
    isLegacyFalseSavingFailure = (entry: MeetEntry) =>
      entry.generation?.protocol !== "unified-round-v1" &&
      entry.generation?.status === "failed" &&
      entry.generation?.stage === "saving" &&
      entry.generation?.saveResult === "failed" &&
      !entry.generation?.rawLength &&
      !hasRoundResponse(entry);
  const send = async () => {
    if (!text.trim() || generating || ended) return;
    const value = text;
    setText("");
    setGenerating(true);
    setError("");
    controller.current = new AbortController();
    try {
      const result = await generateMeetTurn(id, value, controller.current.signal);
      await reload();
      if (result.warning) setToast(result.warning);
    } catch {
      await reload();
    } finally {
      setGenerating(false);
      controller.current = null;
    }
  };
  const finish = async () => {
    controller.current?.abort();
    setGenerating(false);
    await finishMeetSession(id);
    await reload();
    nav("/meet");
  };
  const saveScene = async () => {
    if (!scene) return;
    try {
      const normalized = normalizeNarrativeSettings(narrative);
      await updateMeetScene(
        id,
        scene,
        suggestionsEnabled,
        normalized,
        timeAware,
      );
      await reload();
      setNarrative(normalized);
      setSettingsOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    }
  };
  const importStyle = async (file?: File) => {
    if (!file) return;
    try {
      if (
        !file.name.toLowerCase().endsWith(".txt") &&
        file.type !== "text/plain"
      )
        throw new Error("请选择 TXT 文风文件");
      const content = (await file.text()).trim();
      if (!content) throw new Error("TXT 文风文件不能为空");
      const clipped = content.slice(0, 20000);
      setNarrative((current) => ({
        ...current,
        styleMode: "custom",
        customStyle: clipped,
      }));
      setToast(
        content.length > 20000 ? "文风已导入，并截取前 20000 字" : "文风已导入",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "文风导入失败");
    } finally {
      if (styleFileRef.current) styleFileRef.current.value = "";
    }
  };
  const fillSuggestion = (value: string) => {
    setText(value);
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const favorite = async (entryId: string) => {
    await toggleMeetEntryFavorite(id, entryId);
    await reload();
  };
  const roundEntriesOf = (roundId: string) =>
    session.entries.filter(
      (entry) => entry.roundId === roundId && entry.senderType !== "user",
    );
  const isLastUnifiedDialogue = (entry: MeetEntry) => {
    if (entry.format !== "unified-round-v1" || entry.senderType !== "character")
      return false;
    return (
      [...roundEntriesOf(entry.roundId)]
        .reverse()
        .find((candidate) => candidate.senderType === "character")?.id === entry.id
    );
  };
  const isFirstCharacterInRound = (entry: MeetEntry) =>
    session.entries.find(
      (candidate) =>
        candidate.roundId === entry.roundId &&
        candidate.senderType === "character",
    )?.id === entry.id;
  const copy = async (entry: MeetEntry) => {
    try {
      const content =
        entry.format === "unified-round-v1"
          ? roundEntriesOf(entry.roundId)
              .map((item) => {
                if (item.senderType === "system")
                  return meetEntryPlainText(item);
                const name = characterMap.get(item.senderId ?? "")?.name ?? "角色";
                return `${name}：${meetEntryPlainText(item)}`;
              })
              .filter(Boolean)
              .join("\n\n")
          : meetEntryPlainText(entry);
      await navigator.clipboard.writeText(content);
      setToast(
        entry.format === "unified-round-v1" ? "已复制整轮场景" : "已复制帖子",
      );
    } catch {
      setToast("复制失败，请长按正文复制");
    }
    setSelectedEntryId(null);
  };
  const startEdit = (entry: MeetEntry) => {
    setEditText(entry.content ?? "");
    setEditingEntryId(entry.id);
    setSelectedEntryId(null);
  };
  const saveEdit = async () => {
    if (!editingEntryId) return;
    try {
      await editMeetUserEntry(id, editingEntryId, editText);
      await reload();
      setEditingEntryId(null);
      setToast("帖子已更新");
    } catch (e) {
      setError(e instanceof Error ? e.message : "编辑失败");
    }
  };
  const confirmDelete = async () => {
    if (!deletingEntryId) return;
    try {
      await deleteMeetEntry(id, deletingEntryId);
      await reload();
      setDeletingEntryId(null);
      setToast("帖子已删除");
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };
  const retryFailedTurn = async (entryId: string) => {
    if (generating || ended) return;
    setGenerating(true);
    setError("");
    const aborter = new AbortController();
    controller.current = aborter;
    try {
      const result = await retryFailedMeetTurn(id, entryId, aborter.signal);
      await reload();
      if (result.warning) setToast(result.warning);
      else setToast("\u5df2\u91cd\u65b0\u751f\u6210\u8fd9\u4e00\u8f6e");
    } catch {
      await reload();
    } finally {
      setGenerating(false);
      controller.current = null;
    }
  };
  const copyGenerationDiagnostic = async (entry: MeetEntry) => {
    const generation = entry.generation;
    if (!generation) return;
    const attemptLines = (generation.attempts ?? []).flatMap((attempt) => [
      `attempt${attempt.ordinal}.stage=${attempt.stage}`,
      `attempt${attempt.ordinal}.model=${attempt.model ?? "unknown"}`,
      `attempt${attempt.ordinal}.providerRole=${attempt.providerRole ?? "unknown"}`,
      `attempt${attempt.ordinal}.httpStatus=${attempt.httpStatus ?? "unknown"}`,
      `attempt${attempt.ordinal}.retryAfterSeconds=${attempt.retryAfterSeconds ?? "unknown"}`,
      `attempt${attempt.ordinal}.responseShape=${attempt.responseShape ?? "unknown"}`,
      `attempt${attempt.ordinal}.rawLength=${attempt.rawLength ?? "unknown"}`,
      `attempt${attempt.ordinal}.outputTokens=${attempt.outputTokens ?? "unknown"}`,
      `attempt${attempt.ordinal}.finishReason=${attempt.finishReason ?? "unknown"}`,
      `attempt${attempt.ordinal}.truncated=${Boolean(attempt.truncated)}`,
      `attempt${attempt.ordinal}.inputTokens=${attempt.inputTokens ?? "unknown"}`,
      `attempt${attempt.ordinal}.errorKind=${attempt.errorKind ?? "none"}`,
      `attempt${attempt.ordinal}.providerCode=${attempt.providerCode ?? "none"}`,
      `attempt${attempt.ordinal}.failureDetailCode=${attempt.failureDetailCode ?? "none"}`,
      `attempt${attempt.ordinal}.retryDecision=${attempt.retryDecision ?? "none"}`,
      `attempt${attempt.ordinal}.normalizationPath=${attempt.normalizationPath ?? "none"}`,
    ]);
    const diagnostic = [
      "feature=meet",
      "protocol=" + (generation.protocol ?? "legacy"),
      "runId=" + (generation.runId ?? "legacy"),
      "stage=" + (generation.stage ?? "unknown"),
      "failureClass=" + (generation.failureClass ?? "none"),
      "normalizedResponse=" + Boolean(generation.normalizedResponse),
      "responseNormalized=" + Boolean(generation.responseNormalized),
      "contextPruned=" + Boolean(generation.contextPruned),
      "contextBudgetTokens=" + (generation.contextBudgetTokens ?? "unknown"),
      "requestedInputBudgetTokens=" + (generation.requestedInputBudgetTokens ?? "unknown"),
      "effectiveInputBudgetTokens=" + (generation.effectiveInputBudgetTokens ?? "unknown"),
      "requiredInputTokens=" + (generation.requiredInputTokens ?? "unknown"),
      "coreInputTokens=" + (generation.coreInputTokens ?? "unknown"),
      "optionalInputTokens=" + (generation.optionalInputTokens ?? "unknown"),
      "actualInputTokens=" + (generation.actualInputTokens ?? "unknown"),
      "outputReserveTokens=" + (generation.outputReserveTokens ?? "unknown"),
      "contextWindowTokens=" + (generation.contextWindowTokens ?? "unknown"),
      "contextWindowSource=" + (generation.contextWindowSource ?? "unknown"),
      "responseAdapter=" + (generation.responseAdapter ?? "unknown"),
      "sseMode=" + (generation.sseMode ?? "not-applicable"),
      "repairApplied=" + Boolean(generation.repairApplied),
      "repairRejected=" + Boolean(generation.repairRejected),
      "failureDetailCode=" + (generation.failureDetailCode ?? "none"),
      "retryDecision=" + (generation.retryDecision ?? "none"),
      "normalizationPath=" + (generation.normalizationPath ?? "none"),
      "sameProviderRetryPrevented=" + Boolean(generation.sameProviderRetryPrevented),
      "postProcessingStatus=" + (generation.postProcessingStatus ?? "not-applicable"),
      "model=" + (generation.model ?? "unknown"),
      "responseShape=" + (generation.responseShape ?? "unknown"),
      "rawLength=" + (generation.rawLength ?? 0),
      "outputTokens=" + (generation.outputTokens ?? "unknown"),
      "finishReason=" + (generation.finishReason ?? "unknown"),
      "truncated=" + Boolean(generation.truncated),
      "inputTokens=" + (generation.estimatedInputTokens ?? "unknown"),
      "loreInjected=" + (generation.injectedLoreEntries ?? "unknown"),
      "loreSkipped=" + (generation.skippedLoreEntries ?? "unknown"),
      "saveResult=" + (generation.saveResult ?? "unknown"),
      "fallbackUsed=" + Boolean(generation.fallbackUsed),
      ...attemptLines,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(diagnostic);
      setToast("已复制脱敏诊断");
    } catch {
      setToast("复制失败");
    }
  };
  const regenerate = async (entry: MeetEntry) => {
    setSelectedEntryId(null);
    const key =
      entry.format === "unified-round-v1"
        ? `round:${entry.roundId}`
        : entry.id;
    setRegeneratingId(key);
    setError("");
    const aborter = new AbortController();
    controller.current = aborter;
    try {
      if (entry.format === "unified-round-v1")
        await regenerateMeetRound(id, entry.roundId, aborter.signal);
      else await regenerateMeetCharacterEntry(id, entry.id, aborter.signal);
      await reload();
      setToast(
        entry.format === "unified-round-v1"
          ? "已重新生成整轮场景"
          : "已重新写好这一段",
      );
    } catch (e) {
      await reload();
      if (!(e instanceof Error && e.message.includes("停止")))
        setToast(
          entry.format === "unified-round-v1"
            ? e instanceof Error
              ? e.message
              : "整轮重新生成未完成，已保留原场景"
            : e instanceof Error
              ? e.message
              : "重新生成失败",
        );
    } finally {
      setRegeneratingId(null);
      controller.current = null;
    }
  };
  const postActions = (entry: MeetEntry) => {
    const regenerationKey =
        entry.format === "unified-round-v1"
          ? `round:${entry.roundId}`
          : entry.id,
      showThought =
        entry.senderType === "character" &&
        (entry.format !== "unified-round-v1" || Boolean(entry.thought?.trim())),
      showRegenerate =
        entry.senderType === "character" &&
        (entry.format !== "unified-round-v1" || isLastUnifiedDialogue(entry));
    return (
      <div className="thread-post-actions">
        <button
          className={entry.favoritedAt ? "favorited" : ""}
          aria-label={entry.favoritedAt ? "取消收藏" : "收藏帖子"}
          aria-pressed={Boolean(entry.favoritedAt)}
          onClick={() => void favorite(entry.id)}
        >
          <Heart fill={entry.favoritedAt ? "currentColor" : "none"} />
        </button>
        {showThought ? (
          <button
            className={`thread-thought-toggle ${thoughtEntryId === entry.id ? "active" : ""}`}
            aria-label={
              thoughtEntryId === entry.id ? "收起角色思维" : "查看角色思维"
            }
            aria-expanded={thoughtEntryId === entry.id}
            onClick={() =>
              setThoughtEntryId((current) =>
                current === entry.id ? null : entry.id,
              )
            }
          >
            <MessageCircle
              fill={thoughtEntryId === entry.id ? "currentColor" : "none"}
            />
          </button>
        ) : (
          <span aria-label="评论">
            <MessageCircle />
          </span>
        )}
        {showRegenerate && (
          <button
            className={`thread-regenerate-button ${regeneratingId === regenerationKey ? "loading" : ""}`}
            aria-label={
              regeneratingId === regenerationKey
                ? "正在重新生成"
                : entry.format === "unified-round-v1"
                  ? "重新生成整轮"
                  : "重新生成这一段"
            }
            disabled={ended || generating || Boolean(regeneratingId)}
            onClick={() => void regenerate(entry)}
          >
            <RefreshCw />
            <span>
              {regeneratingId === regenerationKey
                ? "生成中"
                : entry.format === "unified-round-v1"
                  ? "重新生成整轮"
                  : "重新生成"}
            </span>
          </button>
        )}
        <span aria-label="分享">
          <Send />
        </span>
      </div>
    );
  };
  const postHeader = (entry: MeetEntry, name: string) => (
    <header>
      <b>{name}</b>
      <time>{timeLabel(entry.createdAt)}</time>
      <button
        className="thread-post-menu"
        aria-label="帖子设置"
        onClick={() => setSelectedEntryId(entry.id)}
      >
        <MoreHorizontal />
      </button>
    </header>
  );
  return (
    <div className={`meet-room threads-meet ${ended ? "ended" : ""}`}>
      <header className="threads-meet-header">
        <button onClick={() => nav("/meet")} aria-label="返回见面">
          <ChevronLeft />
        </button>
        <div>
          <b>{participantNames}</b>
          <small>
            {ended ? "见面已结束" : session.scene.location || "正在见面"}
          </small>
        </div>
        <button
          onClick={() => {
            setScene(session.scene);
            setSuggestionsEnabled(session.suggestionsEnabled);
            setTimeAware(session.timeAware ?? false);
            setNarrative(normalizeNarrativeSettings(session.narrativeSettings));
            setSettingsOpen(true);
          }}
          aria-label="见面设置"
        >
          <MoreHorizontal />
        </button>
      </header>
      <main className="meet-transcript threads-feed">
        {session.entries
          .filter(
            (entry) =>
              entry.senderType !== "system" ||
              entry.format === "unified-round-v1",
          )
          .map((entry) =>
            entry.senderType === "user" ? (
              <article
                id={`meet-entry-${entry.id}`}
                className={`thread-post user-thread ${targetEntryId === entry.id ? "targeted" : ""}`}
                key={entry.id}
              >
                <div className="thread-rail">
                  <Avatar
                    text={appSettings?.userName ?? "我"}
                    src={appSettings?.userAvatar}
                    size="sm"
                  />
                </div>
                <div className="thread-body">
                  {postHeader(entry, appSettings?.userName || "你")}
                  <div className="thread-user-copy">
                    <Paragraphs text={entry.content} />
                  </div>
                  {entry.generation?.status === "generating" && <p className="meet-generation-status" role="status">角色正在生成回复…</p>}
                  {entry.generation?.status === "partial" && (
                    <p className="meet-generation-status">部分角色本轮保持安静</p>
                  )}
                  {entry.generation?.status === "failed" && !hasRoundResponse(entry) && (
                    <div className="meet-generation-failure" role="alert">
                      <span>{isLegacyFalseSavingFailure(entry) ? "旧版生成未完成" : meetGenerationErrorText(entry)}</span>
                      <div>
                        <button type="button" disabled={generating} onClick={() => void retryFailedTurn(entry.id)}>
                          {generating ? "\u751f\u6210\u4e2d" : "\u91cd\u65b0\u751f\u6210"}
                        </button>
                        <button type="button" onClick={() => void copyGenerationDiagnostic(entry)}>
                          {"\u590d\u5236\u8bca\u65ad"}
                        </button>
                      </div>
                    </div>
                  )}
                  {postActions(entry)}
                </div>
              </article>
            ) : entry.senderType === "system" ? (
              <article
                id={`meet-entry-${entry.id}`}
                className={`meet-round-narration ${targetEntryId === entry.id ? "targeted" : ""}`}
                key={entry.id}
              >
                <div className="meet-round-narration-line" aria-hidden="true" />
                <div className="meet-round-narration-copy">
                  <Paragraphs text={entry.narration ?? entry.content} />
                </div>
              </article>
            ) : (
              <article
                id={`meet-entry-${entry.id}`}
                className={`thread-post character-thread ${entry.format === "unified-round-v1" ? "unified-round-dialogue" : ""} ${targetEntryId === entry.id ? "targeted" : ""}`}
                key={entry.id}
              >
                <div className="thread-rail">
                  <Avatar
                    text={characterMap.get(entry.senderId ?? "")?.name ?? "?"}
                    src={characterMap.get(entry.senderId ?? "")?.avatar}
                    size="sm"
                  />
                </div>
                <div className="thread-body">
                  {postHeader(
                    entry,
                    characterMap.get(entry.senderId ?? "")?.name ?? "角色",
                  )}
                  <div className="thread-prose">
                    <Paragraphs
                      text={[
                        entry.format === "unified-round-v1" ||
                        !isFirstCharacterInRound(entry)
                          ? undefined
                          : session.entries.find(
                              (item) =>
                                item.senderType === "system" &&
                                item.roundId === entry.roundId,
                            )?.narration,
                        entry.narration,
                        entry.prose,
                        entry.appearance,
                        entry.action,
                      ]
                        .filter(
                          (value, index, all): value is string =>
                            Boolean(value) && all.indexOf(value) === index,
                        )
                        .join("\n\n")}
                    />
                  </div>
                  {translationOf(entry, "prose") && (
                    <div className="content-translation meet-translation">
                      <Paragraphs text={translationOf(entry, "prose")} />
                    </div>
                  )}
                  {entry.dialogue && (
                    <div className="thread-dialogue strong-dialogue">
                      <Paragraphs text={entry.dialogue} />
                      {translationOf(entry, "dialogue") && (
                        <div className="content-translation meet-dialogue-translation">
                          <Paragraphs text={translationOf(entry, "dialogue")} />
                        </div>
                      )}
                    </div>
                  )}
                  {regeneratingId === (entry.format === "unified-round-v1" ? `round:${entry.roundId}` : entry.id) && (
                    <div className="thread-regenerating">
                      <RefreshCw />
                      {entry.format === "unified-round-v1" ? "正在重新生成整轮场景…" : "正在重新写这一段…"}
                    </div>
                  )}
                  {postActions(entry)}
                  {thoughtEntryId === entry.id && (
                    <section
                      className={`thread-thought-reveal ${entry.thought?.trim() ? "" : "empty"}`}
                      aria-label="角色输出前的思维"
                    >
                      <header>
                        <span>
                          <Sparkles />
                        </span>
                        <div>
                          <b>输出前的角色思维</b>
                          <small>
                            {characterMap.get(entry.senderId ?? "")?.name ??
                              "角色"}
                          </small>
                        </div>
                      </header>
                      {entry.thought?.trim() ? (
                        <>
                          <Paragraphs text={entry.thought} />
                          {translationOf(entry, "thought") && (
                            <div className="content-translation meet-thought-translation">
                              <Paragraphs
                                text={translationOf(entry, "thought")}
                              />
                            </div>
                          )}
                        </>
                      ) : (
                        <p>
                          这条回复没有单独保存角色思维。请在线下设置中开启“角色思维链”，再继续见面或重新生成这一段。
                        </p>
                      )}
                      <footer>
                        包含角色对本轮内容的反应、情绪变化、联想、顾虑与行动动机；不包含模型隐藏推理、系统资料或提示词。
                      </footer>
                    </section>
                  )}
                </div>
              </article>
            ),
          )}
        {generating && (
          <div className="meet-thinking thread-thinking">
            <span>
              <Sparkles />
            </span>
            <i />
            <i />
            <i />
            <b>正在感受现场并组织回应…</b>
          </div>
        )}
        {error && <p className="meet-error">{error}</p>}
        <div ref={bottom} />
      </main>
      {toast && <div className="meet-toast">{toast}</div>}
      {ended ? (
        <footer className="meet-ended">
          <span>这次见面已经结束</span>
          <button onClick={() => nav("/meet")}>返回记录</button>
        </footer>
      ) : (
        <footer className="meet-composer threads-composer">
          {session.suggestionsEnabled && suggestions.length > 0 && (
            <div className="meet-suggestions">
              {suggestions.map((item) => (
                <button key={item} onClick={() => fillSuggestion(item)}>
                  {item}
                </button>
              ))}
            </div>
          )}
          <div className="threads-reply-box">
            <Avatar
              text={appSettings?.userName ?? "我"}
              src={appSettings?.userAvatar}
              size="sm"
            />
            <textarea
              ref={textarea}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="写下你说的话、动作或反应…"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {generating ? (
              <button
                className="stop"
                aria-label="停止生成"
                onClick={() => controller.current?.abort()}
              >
                <Octagon />
              </button>
            ) : (
              <button
                aria-label="发送"
                disabled={!text.trim()}
                onClick={() => void send()}
              >
                <ArrowUp />
              </button>
            )}
          </div>
        </footer>
      )}
      {selected && (
        <Modal onClose={() => setSelectedEntryId(null)}>
          <div className="thread-action-sheet">
            <header>
              <span>帖子操作</span>
              <button onClick={() => setSelectedEntryId(null)}>
                <X />
              </button>
            </header>
            <button onClick={() => void copy(selected)}>
              <Copy />
              {selected.format === "unified-round-v1" ? "复制整轮" : "复制正文"}
            </button>
            {!ended && selected.senderType === "user" && (
              <button onClick={() => startEdit(selected)}>
                <Pencil />
                编辑正文
              </button>
            )}
            {!ended && selected.senderType === "character" && (
              <button
                disabled={Boolean(regeneratingId)}
                onClick={() => void regenerate(selected)}
              >
                <RefreshCw />
                {selected.format === "unified-round-v1"
                  ? "重新生成整轮"
                  : "重新生成这一段"}
              </button>
            )}
            {!ended && (
              <button
                className="danger"
                onClick={() => {
                  setDeletingEntryId(selected.id);
                  setSelectedEntryId(null);
                }}
              >
                <Trash2 />
                删除帖子
              </button>
            )}
          </div>
        </Modal>
      )}
      {editing && (
        <Modal onClose={() => setEditingEntryId(null)}>
          <div className="thread-edit-sheet">
            <div className="sheet-head">
              <div>
                <small>EDIT POST</small>
                <h2>编辑你的帖子</h2>
              </div>
              <button onClick={() => setEditingEntryId(null)}>
                <X />
              </button>
            </div>
            <textarea
              rows={6}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              autoFocus
            />
            <button
              className="primary"
              disabled={!editText.trim()}
              onClick={() => void saveEdit()}
            >
              保存修改
            </button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal onClose={() => setDeletingEntryId(null)}>
          <div className="thread-delete-sheet">
            <span>
              <Trash2 />
            </span>
            <h2>删除这篇帖子？</h2>
            <p>删除后无法恢复，收藏状态也会一起消失。</p>
            <div>
              <button onClick={() => setDeletingEntryId(null)}>取消</button>
              <button className="danger" onClick={() => void confirmDelete()}>
                确认删除
              </button>
            </div>
          </div>
        </Modal>
      )}
      {settingsOpen && scene && (
        <Modal onClose={() => setSettingsOpen(false)}>
          <div className="sheet-head">
            <div>
              <small>MEET SETTINGS</small>
              <h2>线下设置</h2>
            </div>
            <button onClick={() => setSettingsOpen(false)}>
              <X />
            </button>
          </div>
          <div className="meet-create meet-narrative-settings">
            <label>
              剧情大纲
              <textarea
                rows={4}
                value={scene.outline ?? ""}
                onChange={(e) =>
                  setScene({ ...scene, outline: e.target.value })
                }
                placeholder="选填，用于约束后续剧情方向"
              />
            </label>
            <label>
              开场白
              <textarea
                rows={3}
                value={scene.opening}
                onChange={(e) =>
                  setScene({ ...scene, opening: e.target.value })
                }
              />
            </label>
            <label className="switch-row meet-time-aware-setting">
              <span>
                <b>时间感知</b>
                <small>
                  开启后会读取设备当前日期、星期与时段，并自然融入线下环境。
                </small>
              </span>
              <input
                type="checkbox"
                checked={timeAware}
                onChange={(e) => setTimeAware(e.target.checked)}
              />
            </label>
            <fieldset className="meet-length-settings">
              <legend>每轮场景总篇幅</legend>
              <div>
                <label>
                  最少字数
                  <input
                    type="number"
                    min="80"
                    value={narrative.minChars}
                    onChange={(e) =>
                      setNarrative({
                        ...narrative,
                        minChars: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <span>—</span>
                <label>
                  最多字数
                  <input
                    type="number"
                    min="80"
                    value={narrative.maxChars}
                    onChange={(e) =>
                      setNarrative({
                        ...narrative,
                        maxChars: Number(e.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <small>
                单人和多人都按本轮共享描写与全部角色台词的可见正文合计；思想、译文和 JSON 字段不计入篇幅。
              </small>
            </fieldset>
            <section className="meet-perspective-settings">
              <b>叙事人称</b>
              <div>
                {(["first", "second", "third"] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={narrative.perspective === value ? "active" : ""}
                    onClick={() =>
                      setNarrative({ ...narrative, perspective: value })
                    }
                  >
                    {value === "first"
                      ? "第一人称"
                      : value === "second"
                        ? "第二人称"
                        : "第三人称"}
                  </button>
                ))}
              </div>
              <small>
                第三人称为默认；多人见面会使用一段连续场景，并按顺序区分每位角色的发言。
              </small>
            </section>
            <label className="switch-row meet-thought-chain-setting">
              <span>
                <b>角色思维链</b>
                <small>
                  仅展示符合角色认知的内心独白，不展示模型的隐藏推理过程。
                </small>
              </span>
              <input
                type="checkbox"
                checked={narrative.thoughtsEnabled}
                onChange={(e) =>
                  setNarrative({
                    ...narrative,
                    thoughtsEnabled: e.target.checked,
                  })
                }
              />
            </label>
            <details className="meet-style-settings">
              <summary>
                <span>
                  <b>叙事文风</b>
                  <small>
                    {narrative.styleMode === "plain" ? "白描" : "自定义"}
                  </small>
                </span>
              </summary>
              <div className="meet-style-content">
                <div className="meet-style-mode">
                  <button
                    type="button"
                    className={narrative.styleMode === "plain" ? "active" : ""}
                    onClick={() =>
                      setNarrative({ ...narrative, styleMode: "plain" })
                    }
                  >
                    白描
                  </button>
                  <button
                    type="button"
                    className={narrative.styleMode === "custom" ? "active" : ""}
                    onClick={() =>
                      setNarrative({ ...narrative, styleMode: "custom" })
                    }
                  >
                    自定义
                  </button>
                </div>
                {narrative.styleMode === "plain" ? (
                  <p>
                    默认白描：直接、克制地呈现动作、环境与对话，减少华丽辞藻和堆叠比喻。
                  </p>
                ) : (
                  <div className="meet-style-editor">
                    <textarea
                      rows={7}
                      maxLength={20000}
                      value={narrative.customStyle}
                      onChange={(e) =>
                        setNarrative({
                          ...narrative,
                          customStyle: e.target.value,
                        })
                      }
                      placeholder="输入希望模仿的文风、节奏、句式或示例片段……"
                    />
                    <footer>
                      <small>{narrative.customStyle.length}/20000</small>
                      <button
                        type="button"
                        onClick={() => styleFileRef.current?.click()}
                      >
                        <Upload />
                        导入 TXT
                      </button>
                      <input
                        ref={styleFileRef}
                        hidden
                        type="file"
                        accept=".txt,text/plain"
                        onChange={(e) => void importStyle(e.target.files?.[0])}
                      />
                    </footer>
                  </div>
                )}
              </div>
            </details>
            <label className="switch-row">
              <span>
                <b>行动建议</b>
                <small>每轮最多显示 3 项，点击只填入输入框。</small>
              </span>
              <input
                type="checkbox"
                checked={suggestionsEnabled}
                onChange={(e) => setSuggestionsEnabled(e.target.checked)}
              />
            </label>
            <button className="primary" onClick={() => void saveScene()}>
              保存线下设置
            </button>
            {!ended && (
              <button className="meet-end-danger" onClick={() => void finish()}>
                结束这次见面
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
