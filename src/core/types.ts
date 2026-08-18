import { z } from "zod";
export const SCHEMA_VERSION = 1;
export type Language =
  "中文" | "粤语" | "English" | "日本語" | "한국어" | "Русский";
export type Scope = {
  type: "global" | "character" | "conversation";
  id?: string;
};
export interface BaseEntity {
  id: string;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
}
export interface ProactiveConfig {
  messages: boolean;
  timeAware: boolean;
  frequency: "low" | "medium" | "high";
  quietStart: string;
  quietEnd: string;
  catchupLimit: number;
  dailyLimit: number;
}
export interface ProactiveChannelSettings {
  enabled: boolean;
  intervalHours?: number;
  catchupLimit?: number;
  dailyLimit?: number;
  lastSuccessAt?: number;
  lastCheckedAt?: number;
}
export type ProactiveImageFrequency = "low" | "medium" | "high";
export interface ProactiveImageSettings {
  frequency: ProactiveImageFrequency;
  dailyLimit: number;
  cooldownHours: number;
  onlyWhenRelevant: boolean;
  useCharacterReference: boolean;
  includeMessage: boolean;
  lastGeneratedAt?: number;
}
export interface ProactiveSettings {
  timeAware: boolean;
  quietStart: string;
  quietEnd: string;
  message: ProactiveChannelSettings;
  feed: ProactiveChannelSettings;
  image?: ProactiveImageSettings;
}
export interface RelationshipDailyProgress {
  date: string;
  intimacyGain: number;
  trustGain: number;
}
export interface CharacterPhonePrivacy {
  passcode: string;
  hint: string;
  createdAt: number;
  lastViewedAt?: number;
  lastDiscoveredAt?: number;
  discoveryCount?: number;
  failedAttempts?: number;
  lastFailedAt?: number;
  lockedUntil?: number;
}
export interface PhoneContactAddress {
  label: string;
  address: string;
  placeId?: string;
}
export interface PhoneContact {
  id: string;
  name: string;
  relationship: string;
  persona: string;
  status?: string;
  phone?: string;
  email?: string;
  avatarText?: string;
  addresses?: PhoneContactAddress[];
  characterKnowledge: string[];
  origin?: "initial" | "lore" | "plot" | "proactive";
  introducedEventId?: string;
  introducedAt?: number;
  lastInteractionAt?: number;
  interactionCount?: number;
  createdAt: number;
  updatedAt: number;
}
export interface PhoneTalkMessage {
  id: string;
  senderType: "character" | "contact";
  content: string;
  sections?: MessageInnerVoiceSections;
  translation?: ContentTranslation;
  createdAt: number;
  generationEventId?: string;
  operationTraceId?: string;
  replyStatus?: "pending" | "complete" | "failed";
}
export interface PhoneTalkThread {
  id: string;
  contactId: string;
  messages: PhoneTalkMessage[];
  updatedAt: number;
  unreadCount: number;
}
export interface PhoneMailMessage {
  id: string;
  threadId: string;
  folder: "inbox" | "sent" | "draft" | "trash";
  fromContactId?: string;
  fromAddress: string;
  toContactIds: string[];
  toAddresses: string[];
  subject: string;
  subjectTranslation?: ContentTranslation;
  body: string;
  translation?: ContentTranslation;
  quotedMessageId?: string;
  sentAt?: number;
  createdAt: number;
  updatedAt: number;
  generationEventId?: string;
  operationTraceId?: string;
  replyStatus?: "pending" | "complete" | "failed";
  previousFolder?: "inbox" | "sent" | "draft";
}
export interface PhoneMailState {
  messages: PhoneMailMessage[];
  unreadCount: number;
}
export interface PhonePlace {
  id: string;
  name: string;
  address?: string;
  category: string;
  description: string;
  relatedContactIds: string[];
}
export interface PhoneVisit {
  id: string;
  placeId: string;
  visitedAt: number;
  purpose?: string;
  sourceEventId?: string;
}
export interface PhoneMapsState {
  savedPlaces: PhonePlace[];
  recentVisits: PhoneVisit[];
  searches: Array<{ id: string; query: string; searchedAt: number }>;
}
export interface PhoneEvent {
  id: string;
  type:
    | "talk"
    | "mail"
    | "visit"
    | "call"
    | "calendar"
    | "purchase"
    | "note"
    | "user-operation";
  occurredAt: number;
  participantIds: string[];
  placeId?: string;
  summary: string;
  sourceId?: string;
  generationEventId: string;
}
export interface PhoneOperationTrace {
  id: string;
  characterId: string;
  appId: "messages" | "mail" | "notes" | "files" | "voice-memos";
  action: "compose" | "reply" | "forward" | "delete" | "toggle" | "edit";
  targetContactIds: string[];
  contentSummary: string;
  severity: "low" | "medium" | "high";
  createdAt: number;
  discoveredAt?: number;
  consequenceEventId?: string;
}
export interface PhoneSyncCursor {
  messagesAt: number;
  memoriesAt: number;
  meetAt: number;
  ordersAt: number;
  feedAt: number;
}
export interface PhoneFileItem {
  id: string;
  name: string;
  kind: "document" | "download" | "private" | "hidden";
  folder: string;
  content: string;
  sizeLabel?: string;
  updatedAt: number;
  hidden: boolean;
  sourceEventId?: string;
}
export interface PhoneFilesState {
  items: PhoneFileItem[];
}
export interface PhoneVoiceMemo {
  id: string;
  title: string;
  transcript: string;
  duration: string;
  recordedAt: number;
  category: "personal" | "unsent" | "meeting" | "class";
  sourceEventId?: string;
}
export interface PhoneReminder {
  id: string;
  title: string;
  notes: string;
  dueAt?: number;
  completed: boolean;
  completedAt?: number;
  sourceEventId?: string;
  generationEventId?: string;
}
export interface PhoneAppPermission {
  appId: string;
  label: string;
  camera: boolean;
  microphone: boolean;
  photos: boolean;
  location: "never" | "ask" | "while-using" | "always";
  notifications: boolean;
}
export interface PhoneScreenTimeItem {
  appId: string;
  label: string;
  minutes: number;
  pickups?: number;
}
export interface PhoneSystemState {
  accountName: string;
  accountEmail: string;
  deviceName: string;
  permissions: PhoneAppPermission[];
  screenTime: PhoneScreenTimeItem[];
  screenTimeDate: string;
}
export interface PhoneProactiveState {
  lastGeneratedAt?: number;
  generationEventIds: string[];
}
export interface PhoneGlobalSearchState {
  recentQueries: Array<{ id: string; query: string; searchedAt: number }>;
}
export interface PhoneRecentApp {
  appId: string;
  lastOpenedAt: number;
  openCount: number;
  targetId?: string;
}
export interface CharacterPhoneState extends BaseEntity {
  characterId: string;
  initializedAt: number;
  lastSyncedAt: number;
  contacts: PhoneContact[];
  talkThreads: PhoneTalkThread[];
  mail: PhoneMailState;
  maps: PhoneMapsState;
  files?: PhoneFilesState;
  voiceMemos?: PhoneVoiceMemo[];
  reminders?: PhoneReminder[];
  systemSettings?: PhoneSystemState;
  proactiveState?: PhoneProactiveState;
  searchState?: PhoneGlobalSearchState;
  recentApps?: PhoneRecentApp[];
  appContents: Record<string, unknown>;
  timeline: PhoneEvent[];
  operationTraces: PhoneOperationTrace[];
  syncCursor?: PhoneSyncCursor;
}
export interface RelationshipState {
  intimacy: number;
  trust: number;
  mood: string;
  recentEvents: string[];
  lastEvaluatedSourceId?: string;
  evaluatedSourceIds?: string[];
  dailyProgress?: RelationshipDailyProgress;
  confessionTriggeredAt?: number;
  confessionMessageId?: string;
}
export type SpeechProviderKind = "minimax" | "elevenlabs";
export type SpeechTendency = "low" | "medium" | "high";
export interface CharacterAutoSpeechSettings {
  enabled: boolean;
  tendency: SpeechTendency;
  dailyProgress?: { date: string; count: number };
  lastVoiceAt?: number;
}
export interface CharacterSpeechSettings {
  enabled: boolean;
  provider: "inherit" | SpeechProviderKind;
  presetId?: string;
  voiceId?: string;
  model?: string;
  autoMessages?: CharacterAutoSpeechSettings;
}
export interface CharacterFeedImageSettings {
  enabled: boolean;
  appearancePrompt: string;
  referenceAssetId?: string;
}
export interface CharacterStrategyModeSettings {
  enabled: boolean;
}
export interface CharacterMeetInvitationSettings {
  enabled: boolean;
}
export type MusicCommentaryLevel = "off" | "low" | "medium" | "high";
export interface CharacterMusicSettings {
  canInviteToListen: boolean;
  canControlPlayback: boolean;
  commentaryLevel: MusicCommentaryLevel;
  djEnabled?: boolean;
  controlMode?: "suggest" | "balanced" | "full";
  allowNeteaseSearch?: boolean;
  moodImprintEnabled?: boolean;
  moodRecallEnabled?: boolean;
  lastProactiveInviteAt?: number;
  lastCommentAt?: number;
  lastCommentTrackId?: string;
}
export interface CharacterChatAvatarSettings {
  showUserAvatar: boolean;
  showCharacterAvatar: boolean;
}
export interface CharacterChatSettings {
  language: Language;
  contextLimit: number;
  stream: boolean;
  autoTranslate?: boolean;
  minReplyMessages?: number;
  maxReplyMessages?: number;
  replyMessageRangeMode?: "adaptive" | "fixed";
  speech?: CharacterSpeechSettings;
  feedImage?: CharacterFeedImageSettings;
  strategyMode?: CharacterStrategyModeSettings;
  meetInvitations?: CharacterMeetInvitationSettings;
  music?: CharacterMusicSettings;
  avatars?: CharacterChatAvatarSettings;
}
export interface CharacterContactState {
  status: "friend" | "not-added" | "blocked" | "request-pending";
  blockedAt?: number;
  friendRequest?: {
    id: string;
    message: string;
    createdAt: number;
    status: "pending" | "accepted" | "rejected";
  };
}
export interface ConversationNotificationSettings {
  messages: boolean;
  calls: boolean;
  previewContent: "inherit" | "show" | "hide";
}
export interface ConversationChatSettings {
  remark?: string;
  bubbleStyle: "inherit" | "default" | "kawaii";
  chatBackground?: AppearanceSource;
  characterAvatarSize: number;
  fontScale: number;
  providerPresetId?: string;
  autoTranslate?: boolean;
  groupInnerVoiceEnabled?: boolean;
  permissions?: {
    proactiveChatImage: boolean;
    proactiveVoiceCall: boolean;
    proactiveVideoCall: boolean;
    proactiveMeetInvitation: boolean;
    proactiveSticker: boolean;
  };
  proactiveStickerPackIds?: string[];
  userInGroup?: boolean;
  notifications?: ConversationNotificationSettings;
}
export interface MemoryExtractionSettings {
  enabled: boolean;
  mode: "manual" | "auto";
  chatThreshold: number;
  maxMemoriesPerBatch: number;
  includeSummary: boolean;
  autoSaveHighConfidence: boolean;
  meetMemoryEnabled: boolean;
  feedThreshold?: number;
}
export type MemoryExtractionSource = "chat" | "feed" | "meet";
export type MemoryCandidateKind = "summary" | "fact" | "plot" | "relationship";
export interface StoredMemoryCandidate {
  id: string;
  kind: MemoryCandidateKind;
  title?: string;
  content: string;
  meaning?: string;
  importance: number;
  confidence?: number;
  valence?: number;
  arousal?: number;
  topics?: string[];
  entities?: string[];
  occurredAt?: number;
  sourceIds?: string[];
  selected: boolean;
  locked: boolean;
  duplicateOf?: string;
  conflictWith?: string;
  reviewReason?: string;
  relationshipEvent?: {
    kind: "positive" | "negative" | "neutral";
    importance: number;
    label: string;
  };
}
export interface MemoryExtractionBatch extends BaseEntity {
  characterId: string;
  conversationId?: string;
  source: MemoryExtractionSource;
  sourceIds: string[];
  cursorKey: string;
  status: "pending" | "confirmed" | "discarded" | "failed";
  candidates: StoredMemoryCandidate[];
  model?: string;
  error?: string;
  autoSavedCount?: number;
}
export interface CharacterVisualProfile {
  sourceHash: string;
  apparentAge: string;
  faceIdentity: string;
  immutableFeatures: string[];
  signatureFeatures: string[];
  typicalAppearance: string[];
  photoHabits: string[];
  forbiddenChanges: string[];
  lastAcceptedImageAssetId?: string;
  updatedAt: number;
}
export type ImagePromptIntent =
  | "selfie"
  | "mirror-selfie"
  | "casual-photo"
  | "portrait"
  | "full-body"
  | "outfit"
  | "food"
  | "object"
  | "scenery"
  | "environment"
  | "group-photo"
  | "story-scene";
export interface ImagePromptSubject {
  characterId?: string;
  name: string;
  appearance: string;
  faceIdentity: string;
  expression: string;
  pose: string;
  clothing: string;
}
export interface ImagePromptPlan {
  intent: ImagePromptIntent;
  subjects: ImagePromptSubject[];
  faceLock: {
    referenceAssetId?: string;
    immutableFeatures: string[];
    allowedTemporaryChanges: string[];
    forbiddenChanges: string[];
  };
  environment: string;
  composition: string;
  camera: string;
  lighting: string;
  mood: string;
  continuity: string[];
  requiredDetails: string[];
  forbiddenDetails: string[];
  openaiPrompt: string;
  novelaiPrompt: string;
  negativePrompt: string;
  visualSummary: string;
  textImageDescription: string;
  companionMessages: string[];
}
export interface FaceConsistencyReview {
  passed: boolean;
  score: number;
  mismatches: string[];
}
export interface CharacterPerformanceProfile {
  sourceHash: string;
  identityAnchors: string[];
  personalityMechanisms: string[];
  emotionalBaseline: string;
  relationshipStyle: string;
  intimacyExpression: string;
  conflictStyle: string;
  boundaries: string[];
  speechPatterns: string[];
  knowledgeLimits: string[];
  antiOocRules: string[];
  updatedAt: number;
}
export interface LoreCompiledEntity {
  name: string;
  aliases: string[];
  summary: string;
  relations: string[];
}
export interface LoreCompiledContext {
  sourceHash: string;
  overview: string;
  hardRules: string[];
  entities: LoreCompiledEntity[];
  chronology: string[];
  locations: string[];
  unresolvedConflicts: string[];
  updatedAt: number;
}
export type ChatScene =
  | "private-chat"
  | "group-chat"
  | "voice-call"
  | "proactive-message"
  | "group-event"
  | "commerce";
export type RegenerationReason =
  | "ooc"
  | "context-conflict"
  | "memory-conflict"
  | "lore-conflict"
  | "speech-style"
  | "model-leak"
  | "other";
export interface CharacterReplyReview {
  passed: boolean;
  issues: Array<{
    type:
      | "ooc"
      | "context-conflict"
      | "memory-conflict"
      | "lore-conflict"
      | "speech-style"
      | "model-leak"
      | "format";
    reason: string;
  }>;
  revisedMessages: string[];
  revisedTranslations?: string[];
  revisedInnerVoice?: {
    content: string;
    sections: MessageInnerVoiceSections;
    continuity: MessageInnerVoiceContinuity;
  };
}
export interface Character extends BaseEntity {
  name: string;
  aliases?: string[];
  avatar: string;
  bio: string;
  personality: string;
  speakingStyle: string;
  background: string;
  language: Language;
  coreSetting?: string;
  persona?: string;
  loreBookIds?: string[];
  chatSettings?: CharacterChatSettings;
  proactive: ProactiveConfig;
  proactiveSettings?: ProactiveSettings;
  memoryExtractionSettings?: MemoryExtractionSettings;
  performanceProfile?: CharacterPerformanceProfile;
  visualProfile?: CharacterVisualProfile;
  phonePrivacy?: CharacterPhonePrivacy;
  contactState?: CharacterContactState;
  relationship: RelationshipState;
  lastActiveAt: number;
}
export interface GroupNpc {
  id: string;
  name: string;
  age?: string;
  identity?: string;
  basicInfo?: string;
  persona: string;
  speakingStyle?: string;
  avatarAssetId?: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface Conversation extends BaseEntity {
  title: string;
  type: "private" | "group";
  memberIds: string[];
  groupNpcs?: GroupNpc[];
  presetIds: string[];
  loreBookIds: string[];
  lastActivityAt: number;
  avatarAssetId?: string;
  chatSettings?: ConversationChatSettings;
}
export type BackgroundTaskType =
  | "proactive-check"
  | "proactive-message"
  | "proactive-call"
  | "notification"
  | "github-backup"
  | "memory-extraction"
  | "meet-summary"
  | "embedding"
  | "chat-reply"
  | "invitation-response"
  | "roleplay-cache-refresh"
  | "couple-island-update"
  | "music-dj-turn";
export type ChatReplyPhase =
  | "queued"
  | "preparing"
  | "generating"
  | "requesting"
  | "parsing"
  | "validating"
  | "reviewing"
  | "saving"
  | "post-processing"
  | "completed"
  | "failed"
  | "paused";

export type ChatProviderCallPurpose =
  | "generation"
  | "regeneration"
  | "review"
  | "auxiliary";
export type ChatProviderTransportMode = "non-stream" | "sse" | "ndjson" | "json-fallback";
export type ChatReplyWireFormat = "legacy" | "compact";
export type ChatProviderTailKind = "quote" | "object-close" | "array-close" | "comma" | "colon" | "escape" | "other";
export type ReplyBubbleCountMode = "adaptive" | "range" | "exact";
export type ReplyBubbleCountResolution = "unchanged" | "merged" | "split" | "retry-required";
export interface ReplyBubbleCountPlan {
  mode: ReplyBubbleCountMode;
  min: number;
  max: number;
  preferred: number;
}
export interface ReplyBubbleCountDiagnostics {
  countMode: ReplyBubbleCountMode;
  allowedMin: number;
  allowedMax: number;
  preferredCount: number;
  rawMessageCount: number;
  finalMessageCount: number;
  countResolution: ReplyBubbleCountResolution;
  countCompliant: boolean;
}
export interface ChatProviderCallTrace {
  ordinal: 1 | 2;
  purpose: ChatProviderCallPurpose;
  state: "started" | "completed" | "failed" | "aborted";
  responseShape?: string;
  rawLength?: number;
  finishReason?: string;
  errorKind?: string;
  providerCode?: string;
  transportMode?: ChatProviderTransportMode;
  receivedChars?: number;
  receivedBytes?: number;
  declaredContentLength?: number;
  contentLengthMatched?: boolean;
  parseStatus?: "strict-json" | "repaired-json" | "unrecoverable-json" | "truncated-json";
  strictParseSucceeded?: boolean;
  repairAttempted?: boolean;
  repairedParseSucceeded?: boolean;
  outerContainerClosed?: boolean;
  unterminatedString?: boolean;
  hasMessages?: boolean;
  hasInnerVoice?: boolean;
  wireFormat?: ChatReplyWireFormat;
  protocolValidationReached?: boolean;
  completeVisibleFieldRecovered?: boolean;
  tailKind?: ChatProviderTailKind;
  failureStage?: "provider-parse" | "role-protocol" | "inner-voice" | "bubble-count" | "persistence";
  countMode?: ReplyBubbleCountMode;
  allowedMin?: number;
  allowedMax?: number;
  preferredCount?: number;
  rawMessageCount?: number;
  finalMessageCount?: number;
  countResolution?: ReplyBubbleCountResolution;
  countCompliant?: boolean;
}
export interface ChatGroupProviderCallBudget {
  providerCallLimit: 2;
  providerCallCount: number;
  providerCallTrace: ChatProviderCallTrace[];
  leaseGeneration?: number;
  state?: "pending" | "running" | "completed" | "failed";
}
export interface ContextSectionDiagnostics {
  personaTokens: number;
  relationshipTokens: number;
  historyTokens: number;
  memoryTokens: number;
  loreTokens: number;
  continuityTokens: number;
  protocolTokens: number;
  totalInputTokens: number;
  providerWindow: number;
  memoryCount: number;
  loreCount: number;
  /** True when optional context sections were omitted to fit the request budget. */
  contextPruned?: boolean;
  /** The per-attempt input budget used by the context compiler. */
  contextBudgetTokens?: number;
}
export interface ProviderConnectivityResult {
  ok: boolean;
  kind?: "auth" | "cors" | "network" | "rate" | "server" | "format";
  httpStatus?: number;
  providerCode?: string;
  model?: string;
}
export interface ChatReplyTaskPayload {
  mode: "private" | "group";
  outputMessageId?: string;
  sourceMessageId?: string;
  regenerationTargetId?: string;
  regenerationReasons?: RegenerationReason[];
  regenerationInstruction?: string;
  roundId?: string;
  speakerOrder?: string[];
  nextSpeakerIndex?: number;
  providerPresetId?: string;
  innerVoiceRequired?: boolean;
  phase: ChatReplyPhase;
  autoResumeCount: number;
  originalMessage?: Message;
  originalMessages?: Message[];
  lastApiError?: ApiErrorInfo;
  /** Manual generation cycle; reset/incremented when the user explicitly retries. */
  generationCycle?: number;
  /** Provider calls made in the current generation cycle. */
  providerCallCount?: number;
  /** Private-chat bubble target selected before the task starts (legacy preference field). */
  targetBubbleCount?: number;
  /** Per-speaker bubble targets selected before a group task starts (legacy preference field). */
  targetBubbleCounts?: Record<string, number>;
  /** Persisted hard bubble-count plan for this generation cycle. */
  bubbleCountPlan?: ReplyBubbleCountPlan;
  /** Persisted hard bubble-count plans for group speakers. */
  bubbleCountPlans?: Record<string, ReplyBubbleCountPlan>;
  /** Sanitized count diagnostics for the private task. */
  bubbleCountDiagnostics?: ReplyBubbleCountDiagnostics;
  /** Sanitized count diagnostics for group speakers. */
  bubbleCountDiagnosticsByActor?: Record<string, ReplyBubbleCountDiagnostics>;
  /** Shared private-chat limit; retained as a legacy field for group tasks. */
  providerCallLimit?: 2;
  /** Sanitized provider call lifecycle; never stores prompts or response text. */
  providerCallTrace?: ChatProviderCallTrace[];
  /** Per-speaker provider budgets for group chat; optional for legacy rows. */
  groupProviderCallBudgets?: Record<string, ChatGroupProviderCallBudget>;
  /** Sanitized generation strategy diagnostics; never contains prompt or response text. */
  regeneration?: boolean;
  variationApplied?: boolean;
  reviewerInvoked?: boolean;
  retryContextCompacted?: boolean;
  /** Sanitized context size diagnostics; never contains prompt text. */
  contextDiagnostics?: ContextSectionDiagnostics;
  contextDiagnosticsByActor?: Record<string, ContextSectionDiagnostics>;
  /** Last deterministic failure stage, used only for status/diagnostics. */
  failureStage?: "provider-parse" | "role-protocol" | "inner-voice" | "bubble-count" | "persistence";
  cancelled?: boolean;
}
export type InvitationResponseType = "couple-island" | "music";
export type InvitationDecision =
  | { type: "accept" }
  | { type: "decline"; reason: string };
export interface InvitationResponseTaskPayload {
  invitationType: InvitationResponseType;
  invitationMessageId: string;
  phase: "queued" | "deciding" | "saving" | "completed" | "failed";
  generationCycle: number;
  providerCallLimit: 2;
  providerCallCount: number;
  providerCallTrace: ChatProviderCallTrace[];
  targetBubbleCount: number;
  bubbleCountPlan?: ReplyBubbleCountPlan;
  bubbleCountDiagnostics?: ReplyBubbleCountDiagnostics;
  cardSaved?: boolean;
  textSaved?: boolean;
  decision?: InvitationDecision;
  lastApiError?: ApiErrorInfo;
}
export interface BackgroundTask extends BaseEntity {
  type: BackgroundTaskType;
  entityId: string;
  characterId?: string;
  conversationId?: string;
  state: "pending" | "running" | "completed" | "failed";
  scheduledAt: number;
  nextAttemptAt: number;
  attempts: number;
  leaseExpiresAt?: number;
  /** Runtime owner of the current lease; optional for legacy rows. */
  leaseOwnerId?: string;
  /** Monotonic fencing generation used to reject stale tabs. */
  leaseGeneration?: number;
  eventId: string;
  payload: unknown;
  lastError?: string;
}
export type MallCatalogKind = "shop" | "restaurant" | "food";
export interface MallCatalogItem extends BaseEntity {
  searchId: string;
  query: string;
  kind: MallCatalogKind;
  title: string;
  merchantName: string;
  merchantId?: string;
  category: string;
  description: string;
  priceCents: number;
  tone: number;
  colors?: string[];
  sizes?: string[];
  rating?: number;
  etaMinutes?: number;
  deliveryFeeCents?: number;
}
export interface MallCartItem extends BaseEntity {
  cartKind: "shop" | "eats";
  catalogItemId: string;
  quantity: number;
  merchantId?: string;
}
export interface MallOrderItem {
  id: string;
  catalogItemId?: string;
  title: string;
  merchantName: string;
  category: string;
  priceCents: number;
  quantity: number;
  tone: number;
}
export type MallOrderKind = "shop" | "eats" | "gift";
export type MallOrderStatus =
  "placed" | "preparing" | "shipped" | "delivering" | "delivered" | "cancelled";
export interface MallOrder extends BaseEntity {
  kind: MallOrderKind;
  source: "checkout" | "character";
  payerType: "user" | "character";
  payerId?: string;
  payerName: string;
  recipientType: "user" | "character";
  recipientId?: string;
  recipientName: string;
  items: MallOrderItem[];
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  userChargeCents: number;
  status: MallOrderStatus;
  conversationId?: string;
  messageId?: string;
  characterReplyMessageId?: string;
  sourceMessageId?: string;
  note?: string;
}
export type WalletTransactionKind =
  | "adjustment"
  | "purchase"
  | "food"
  | "gift"
  | "transfer-out"
  | "transfer-in"
  | "refund"
  | "red-packet";
export interface WalletTransaction extends BaseEntity {
  kind: WalletTransactionKind;
  amountCents: number;
  state: "pending" | "completed" | "refunded";
  title: string;
  orderId?: string;
  messageId?: string;
  counterpartyId?: string;
  counterpartyName?: string;
}
export interface MallWalletSettings {
  balanceCents: number;
  initializedAt: number;
  updatedAt: number;
}
export interface ForumImageSource {
  type: "asset" | "url";
  value: string;
}
export interface ForumNpc {
  id: string;
  name: string;
  handle?: string;
  avatar?: ForumImageSource;
  persona: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface ForumCharacterQuota {
  postsPerRun: number;
  repliesPerRun: number;
  enabled: boolean;
}
export type ForumDirectIntent =
  | "greeting"
  | "flirt"
  | "business"
  | "daily"
  | "praise"
  | "question"
  | "invitation"
  | "request"
  | "apology"
  | "complaint"
  | "reconnect"
  | "other";
export interface ForumActivitySettings {
  enabled: boolean;
  intervalMinutes: number;
  intervalHours?: number;
  postsPerRun: number;
  repliesPerRun: number;
  directMessagesPerRun?: number;
  characterQuotas: Record<string, ForumCharacterQuota>;
  lastRunAt?: number;
  nextRunAt?: number;
  lastEventId?: string;
  lastStatus?: "success" | "partial" | "skipped" | "error";
  lastSummary?: string;
  lastGeneratedPosts?: number;
  lastGeneratedReplies?: number;
  lastGeneratedDirectMessages?: number;
}
export interface ForumCommunityProfile {
  displayName: string;
  handle: string;
  bio: string;
  persona: string;
  anonymousMode?: boolean;
  followingIds?: string[];
  followerIds?: string[];
  followingCount?: number;
  followerCount?: number;
  chatInterop?: { enabled: boolean; characterIds: string[] };
  banner?: ForumImageSource;
  joinedAt: number;
  updatedAt: number;
}
export interface ForumDirectMessage {
  id: string;
  senderType: "user" | "character" | "npc";
  content: string;
  createdAt: number;
  intent?: ForumDirectIntent;
  anonymous?: boolean;
  generationEventId?: string;
}
export interface ForumDirectThread {
  id: string;
  participantType: "character" | "npc";
  participantId: string;
  participantName: string;
  participantHandle?: string;
  participantPersona?: string;
  participantOrigin?: "configured" | "generated";
  participantAvatar?: ForumImageSource;
  messages: ForumDirectMessage[];
  updatedAt: number;
  unreadCount: number;
}
export interface ForumProfileLike {
  id: string;
  actorType: "character" | "npc";
  actorId: string;
  postId: string;
  replyId?: string;
  createdAt: number;
  generationEventId: string;
}
export interface ForumMemberProfile {
  actorType: "character" | "npc";
  actorId: string;
  displayName: string;
  handle: string;
  bio: string;
  persona: string;
  avatar?: ForumImageSource;
  banner?: ForumImageSource;
  joinedAt: number;
  updatedAt: number;
}
export interface ForumServer extends BaseEntity {
  name: string;
  description: string;
  introduction?: string;
  iconText: string;
  color: string;
  avatar?: ForumImageSource;
  banner?: ForumImageSource;
  characterIds?: string[];
  npcs?: ForumNpc[];
  loreBookIds?: string[];
  activitySettings?: ForumActivitySettings;
  userProfile?: ForumCommunityProfile;
  directThreads?: ForumDirectThread[];
  profileLikes?: ForumProfileLike[];
  memberProfiles?: Record<string, ForumMemberProfile>;
  order: number;
}
export interface ForumChannel extends BaseEntity {
  serverId: string;
  name: string;
  topic: string;
  kind: "forum" | "announcement";
  order: number;
}
export type ForumReactionKind = "like" | "heart" | "laugh" | "insightful";
export interface ForumReaction {
  kind: ForumReactionKind;
  count: number;
  reacted: boolean;
}
export interface ForumPostImage {
  id: string;
  source: "asset" | "description" | "sticker";
  assetId?: string;
  url?: string;
  description: string;
}
export interface ForumReply {
  id: string;
  authorType: "user" | "character" | "npc" | "system";
  authorId?: string;
  authorName: string;
  authorHandle?: string;
  authorAvatar?: ForumImageSource;
  content: string;
  createdAt: number;
  replyToId?: string;
  replyToName?: string;
  reactions: ForumReaction[];
  generationEventId?: string;
  authorAnonymous?: boolean;
  authorPersonaSnapshot?: string;
  authorOrigin?: "configured" | "generated";
  translation?: ContentTranslation;
}
export interface ForumPost extends BaseEntity {
  channelId: string;
  authorType: "user" | "character" | "npc" | "system";
  authorId?: string;
  authorName: string;
  authorHandle?: string;
  authorAvatar?: ForumImageSource;
  title: string;
  titleTranslation?: ContentTranslation;
  content: string;
  sections?: MessageInnerVoiceSections;
  translation?: ContentTranslation;
  tags: string[];
  images?: ForumPostImage[];
  pinned: boolean;
  reactions: ForumReaction[];
  replies: ForumReply[];
  lastActivityAt: number;
  shareCount?: number;
  generationEventId?: string;
  authorAnonymous?: boolean;
  authorPersonaSnapshot?: string;
  authorOrigin?: "configured" | "generated";
}
export type MessageKind =
  | "text"
  | "sticker"
  | "image"
  | "voice"
  | "transfer"
  | "commerce"
  | "call-event"
  | "meet-invitation"
  | "meet-event"
  | "director"
  | "group-event"
  | "red-packet"
  | "poll"
  | "music-invitation"
  | "music-event"
  | "music-search-candidates"
  | "music-control-proposal"
  | "music-session-summary"
  | "couple-island-invitation";
export type MessageReactionKind =
  "heart" | "like" | "dislike" | "laugh" | "emphasis" | "question";
export type ApiErrorKind =
  | "auth"
  | "rate"
  | "model"
  | "timeout"
  | "network"
  | "cors"
  | "server"
  | "format"
  | "interrupted";
export interface ApiErrorInfo {
  source: "api";
  kind: ApiErrorKind;
  httpStatus?: number;
  retryAfterSeconds?: number;
  providerCode?: string;
  providerType?: string;
  param?: string;
  meaning: string;
  detail?: string;
  responseShape?: string;
  rawLength?: number;
  contentType?: string;
  visibleCandidatePaths?: string[];
  parseStatus?: "strict-json" | "repaired-json" | "unrecoverable-json" | "truncated-json";
  strictParseSucceeded?: boolean;
  repairAttempted?: boolean;
  repairedParseSucceeded?: boolean;
  outerContainerClosed?: boolean;
  unterminatedString?: boolean;
  hasMessages?: boolean;
  hasInnerVoice?: boolean;
  wireFormat?: ChatReplyWireFormat;
  transportMarkedIncomplete?: boolean;
  protocolValidationReached?: boolean;
  transportMode?: ChatProviderTransportMode;
  receivedChars?: number;
  receivedBytes?: number;
  declaredContentLength?: number;
  contentLengthMatched?: boolean;
  completeVisibleFieldRecovered?: boolean;
  tailKind?: ChatProviderTailKind;
  finishReason?: string;
  failureStage?: "provider-parse" | "role-protocol" | "inner-voice" | "bubble-count" | "persistence";
  countMode?: ReplyBubbleCountMode;
  allowedMin?: number;
  allowedMax?: number;
  preferredCount?: number;
  rawMessageCount?: number;
  finalMessageCount?: number;
  countResolution?: ReplyBubbleCountResolution;
  countCompliant?: boolean;
  troubleshooting: string[];
}
export interface ContentTranslation {
  targetLanguage: "zh-CN";
  text?: string;
  sourceHash: string;
  source?: "same-generation" | "manual";
  status: "pending" | "complete" | "error";
  model?: string;
  error?: string;
  updatedAt: number;
}
export type MessageTranslation = ContentTranslation;
export interface MessageInnerVoiceSections {
  physicalState: string;
  emotionAndMind: string;
  unspokenWords: string;
  selfDeception: string;
  triggeredMemory: string;
  angelThought: string;
  devilThought: string;
}
export interface MessageInnerVoiceContinuity {
  emotion: string;
  concern?: string;
  pendingIntent?: string;
  physicalState?: string;
}
export interface MessageInnerVoice {
  id: string;
  actorType: "character" | "npc";
  actorId: string;
  speakerTurnId: string;
  content: string;
  sections?: MessageInnerVoiceSections;
  translation?: ContentTranslation;
  continuity: MessageInnerVoiceContinuity;
  sourceHash: string;
  createdAt: number;
  favoritedAt?: number;
}
export interface MessageReaction {
  kind: MessageReactionKind;
  reactorType: "user" | "character" | "npc";
  reactorId?: string;
  createdAt: number;
}
export interface MessageQuote {
  messageId: string;
  senderType: "user" | "character" | "npc" | "system";
  senderId?: string;
  senderName: string;
  kind: MessageKind | "text";
  preview: string;
}
export interface RedPacketClaim {
  participantType?: "character" | "npc";
  participantId?: string;
  participantName?: string;
  characterId?: string;
  characterName?: string;
  amountCents: number;
  claimedAt: number;
}
export interface PollVote {
  voterType: "user" | "character" | "npc";
  voterId?: string;
  voterName: string;
  optionIds: string[];
  createdAt: number;
}
export interface PollOption {
  id: string;
  text: string;
}
export type MessageAttachment =
  | {
      type: "sticker";
      stickerId: string;
      assetId?: string;
      url?: string;
      name: string;
      description: string;
    }
  | {
      type: "image";
      assetId?: string;
      url?: string;
      description: string;
      visionMode: "image" | "description";
      width?: number;
      height?: number;
    }
  | {
      type: "text-image";
      description: string;
      intent: ImagePromptIntent;
      characterId: string;
      generationEventId: string;
      createdAt: number;
    }
  | { type: "voice"; assetId: string; durationMs: number; transcript: string }
  | {
      type: "transfer";
      amountCents: number;
      currency: "CNY";
      note?: string;
      state: "pending" | "accepted" | "refunded";
      direction?: "user-to-character" | "character-to-user";
      walletTransactionId?: string;
      handledBy?: string;
      processedAt?: number;
    }
  | {
      type: "commerce";
      orderId: string;
      commerceType: MallOrderKind;
      direction: "user-to-character" | "character-to-user";
      title: string;
      itemNames: string[];
      amountCents: number;
      currency: "CNY";
      recipientName: string;
      status: MallOrderStatus;
    }
  | {
      type: "call";
      callType: "voice" | "video";
      durationMs: number;
      summary: string;
      participantIds: string[];
      direction?: "incoming" | "outgoing";
      state?: "ringing" | "missed" | "rejected" | "completed";
      eventId?: string;
      expiresAt?: number;
    }
  | {
      type: "meet-invitation";
      invitationId: string;
      sessionId?: string;
      conversationId: string;
      characterId: string;
      participantIds: string[];
      invitationText: string;
      scene: MeetScene;
      state: MeetInvitationState;
      expiresAt?: number;
      processedAt?: number;
    }
  | {
      type: "meet-event";
      sessionId: string;
      participantIds: string[];
      durationMs: number;
      summary: string;
    }
  | {
      type: "red-packet";
      eventId: string;
      totalAmountCents: number;
      packetCount: number;
      note: string;
      claims: RedPacketClaim[];
      walletTransactionId: string;
      state: "completed";
    }
  | {
      type: "poll";
      pollId: string;
      question: string;
      mode: "single" | "multiple";
      options: PollOption[];
      votes: PollVote[];
      state: "open" | "closed";
      createdBy: "user" | "assistant";
      closedAt?: number;
    }
  | {
      type: "music-invitation";
      cardRole?: "invitation" | "response";
      sessionId: string;
      characterId: string;
      state: "pending" | "accepted" | "declined" | "ended";
      trackId?: string;
      reason?: string;
      responseStatus?: "queued" | "deciding" | "failed";
      responseTaskEventId?: string;
      processedAt?: number;
    }
  | {
      type: "music-event";
      sessionId: string;
      eventType: MusicEventType;
      trackId?: string;
      positionMs?: number;
    }
  | {
      type: "music-search-candidates";
      sessionId: string;
      characterId: string;
      query: string;
      trackIds: string[];
      placement: "next" | "end";
      state: "pending" | "selected" | "expired";
      selectedTrackId?: string;
      processedAt?: number;
    }
  | {
      type: "music-control-proposal";
      sessionId: string;
      characterId: string;
      control: "pause" | "next" | "clear-queue";
      reason: string;
      state: "pending" | "accepted" | "declined" | "expired";
      processedAt?: number;
    }
  | {
      type: "music-session-summary";
      sessionId: string;
      characterId: string;
      trackIds: string[];
      queueEntries?: ListeningQueueEntry[];
      listenedMs: number;
      representativeTrackId?: string;
      closingNote?: string;
    }
  | {
      type: "couple-island-invitation";
      cardRole?: "invitation" | "response";
      characterId: string;
      invitedBy?: "user" | "character";
      responseBy?: "user" | "character";
      islandId?: string;
      state: "pending" | "accepted" | "declined";
      reason?: string;
      responseStatus?: "queued" | "deciding" | "failed";
      responseTaskEventId?: string;
      processedAt?: number;
    };
export interface Message extends BaseEntity {
  conversationId: string;
  senderType: "user" | "character" | "npc" | "system";
  senderId?: string;
  content: string;
  kind?: MessageKind;
  attachments?: MessageAttachment[];
  status: "complete" | "generating" | "error";
  parentId?: string;
  generation?: {
    model: string;
    temperature: number;
    stream?: boolean;
    stopped?: boolean;
    roundId?: string;
    speakerTurnId?: string;
    segmentIndex?: number;
    voiceDecision?: "voice" | "text" | "failed";
    taskEventId?: string;
    phase?: ChatReplyPhase;
    attempt?: number;
    startedAt?: number;
    lastProgressAt?: number;
    error?: string;
    apiError?: ApiErrorInfo;
  };
  translation?: MessageTranslation;
  innerVoice?: MessageInnerVoice;
  quote?: MessageQuote;
  reactions?: MessageReaction[];
  favoritedAt?: number;
  origin?: "manual" | "proactive" | "phone-inspection";
  proactiveEventId?: string;
  readAt?: number;
  visibility?: "chat" | "private";
}
export interface MeetScene {
  opening: string;
  outline?: string;
  location?: string;
  time?: string;
  weather?: string;
  atmosphere?: string;
  appearance?: string;
  objective?: string;
}
export interface MeetScenePatch {
  characterPosition?: string;
  characterPosture?: string;
  characterFacing?: string;
  distanceToUser?: string;
  appearance?: string;
  clothing?: string[];
  heldItems?: string[];
  physicalState?: string[];
  visibleEmotion?: string;
  environmentFacts?: string[];
  changedObjects?: string[];
  unresolvedAction?: string;
  unresolvedEvents?: string[];
}
export interface MeetSceneParticipantState {
  characterId: string;
  present: boolean;
  position: string;
  posture: string;
  facing?: string;
  distanceToUser?: string;
  appearance: string;
  clothing: string[];
  heldItems: string[];
  physicalState: string[];
  visibleEmotion: string;
  currentIntention?: string;
  unresolvedAction?: string;
}
export interface MeetSceneState {
  location: string;
  subLocation?: string;
  time?: string;
  weather?: string;
  atmosphere?: string;
  environmentFacts: string[];
  changedObjects: string[];
  participants: MeetSceneParticipantState[];
  userKnownState: {
    position?: string;
    posture?: string;
    heldItems: string[];
    explicitActions: string[];
  };
  unresolvedEvents: string[];
  updatedAt: number;
}
export interface MeetCompiledStyle {
  sourceHash: string;
  overview: string;
  narrativeDistance: string;
  pacing: string;
  sentencePatterns: string[];
  paragraphPatterns: string[];
  vocabularyPreferences: string[];
  descriptionPriorities: string[];
  dialogueIntegration: string;
  thoughtStyle: string;
  requiredTraits: string[];
  forbiddenTraits: string[];
  updatedAt: number;
}
export type MeetPlotContribution =
  "respond" | "observe" | "conflict" | "reveal" | "decide" | "act" | "withdraw";
export interface MeetPlotProgress {
  advanced: boolean;
  threadId?: string;
  actionType?:
    | "decision"
    | "reveal"
    | "conflict"
    | "proposal"
    | "consequence"
    | "relationship"
    | "environment";
  summary?: string;
  newConflict?: string;
  newGoal?: string;
  pendingConsequence?: string;
  requiresUserResponse: boolean;
}
export interface MeetPlotState {
  activeThreads: Array<{
    id: string;
    title: string;
    summary: string;
    importance: number;
    state: "open" | "progressing" | "resolved" | "abandoned";
    involvedCharacterIds: string[];
  }>;
  characterGoals: Record<
    string,
    Array<{
      goal: string;
      motivation: string;
      obstacle?: string;
      hidden: boolean;
      progress: number;
    }>
  >;
  conflicts: Array<{
    id: string;
    parties: string[];
    issue: string;
    intensity: number;
    status: "latent" | "active" | "easing" | "resolved";
  }>;
  secrets: Array<{
    ownerCharacterId: string;
    content: string;
    knownBy: string[];
    revealCondition?: string;
    revealed: boolean;
  }>;
  pendingConsequences: Array<{
    sourceEntryId: string;
    description: string;
    dueCondition: string;
  }>;
  lastProgressSummary?: string;
  lastProgressAt?: number;
  updatedAt: number;
}
export interface MeetResponderPlan {
  responders: Array<{
    characterId: string;
    reason: string;
    heardUser: boolean;
    observedUser: boolean;
    intendedContribution: MeetPlotContribution;
  }>;
  plotBeat?: {
    threadId?: string;
    purpose: string;
    permittedChange: string;
    mustLeaveUserChoice: boolean;
  };
  sharedEnvironmentChange?: string;
}
export type MeetRoundSegment =
  | { type: "narration"; text: string }
  | { type: "dialogue"; characterId: string; text: string; translation?: string };
export interface MeetRoundPayload {
  version: 1;
  segments: MeetRoundSegment[];
  thoughts?: Array<{
    characterId: string;
    text: string;
    translation?: string;
  }>;
  updates?: Array<{
    characterId: string;
    scenePatch?: MeetScenePatch;
    plotProgress?: MeetPlotProgress;
  }>;
  suggestions?: string[];
  warnings?: string[];
}

export type MeetFailureDetailCode =
  | "empty-segments"
  | "missing-dialogue"
  | "unknown-character"
  | "invalid-segment"
  | "invalid-scene-update"
  | "length-out-of-range"
  | "style-invalid";
export type MeetRetryDecision =
  | "secondary-fallback"
  | "compact-primary-retry"
  | "structure-primary-retry"
  | "stop-no-distinct-secondary"
  | "stop-after-second-attempt";

export interface MeetEntry {
  id: string;
  roundId: string;
  translations?: Partial<
    Record<
      "content" | "narration" | "prose" | "thought" | "dialogue",
      ContentTranslation
    >
  >;
  senderType: "user" | "character" | "system";
  senderId?: string;
  content?: string;
  narration?: string;
  prose?: string;
  appearance?: string;
  action?: string;
  thought?: string;
  dialogue?: string;
  suggestions?: string[];
  format?: "unified-round-v1";
  scenePatch?: MeetScenePatch;
  plotProgress?: MeetPlotProgress;
  favoritedAt?: number;
  generation?: {
    status: "generating" | "complete" | "partial" | "failed";
    protocol?: "unified-round-v1";
    runId?: string;
    stage?:
      | "building-context"
      | "requesting"
      | "normalizing"
      | "parsing"
      | "validating"
      | "saving"
      | "post-processing";
    failureClass?:
      | "provider-rate-limit"
      | "provider-cors"
      | "provider-prompt-blocked"
      | "provider-timeout"
      | "response-truncated"
      | "response-invalid"
      | "invalid-meet-round"
      | "storage-failed"
      | "aborted";
    failureDetailCode?: MeetFailureDetailCode;
    retryDecision?: MeetRetryDecision;
    normalizationPath?: string;
    sameProviderRetryPrevented?: boolean;
    error?: string;
    model?: string;
    fallbackUsed?: boolean;
    normalizedResponse?: boolean;
    contextPruned?: boolean;
    contextBudgetTokens?: number;
    responseNormalized?: boolean;
    repairApplied?: boolean;
    repairRejected?: boolean;
    postProcessingStatus?: "pending" | "complete" | "failed";
    responseShape?: string;
    rawLength?: number;
    outputTokens?: number;
    finishReason?: string;
    truncated?: boolean;
    estimatedInputTokens?: number;
    injectedLoreEntries?: number;
    skippedLoreEntries?: number;
    saveResult?: "not-attempted" | "pending" | "saved" | "failed";
    warnings?: string[];
    contextDiagnostics?: ContextSectionDiagnostics;
    attempts?: Array<{
      ordinal: 1 | 2;
      stage: "requesting" | "parsing" | "validating";
      model?: string;
      providerRole?: "primary" | "secondary-fallback";
      httpStatus?: number;
      retryAfterSeconds?: number;
      responseShape?: string;
      rawLength?: number;
      outputTokens?: number;
      finishReason?: string;
      truncated?: boolean;
      inputTokens?: number;
      errorKind?: string;
      providerCode?: string;
      failureDetailCode?: MeetFailureDetailCode;
      retryDecision?: MeetRetryDecision;
      normalizationPath?: string;
    }>;
    characterResults?: Array<{
      characterId: string;
      status: "generating" | "complete" | "silent";
      attempts: number;
      providerCode?: string;
    }>;
  };
  createdAt: number;
}
export type MeetNarrativePerspective = "first" | "second" | "third";
export type MeetNarrativeStyleMode = "plain" | "custom";
export interface MeetStyleDefinition {
  id: string;
  name: string;
  version: number;
  description: string;
  contract: string;
  narrativeDistance: string;
  pacing: string;
  sentencePatterns: string[];
  paragraphPatterns: string[];
  vocabularyPreferences: string[];
  descriptionPriorities: string[];
  thoughtStyle: string;
  requiredTraits: string[];
  forbiddenTraits: string[];
}
export interface MeetNarrativeSettings {
  version?: 2 | 3;
  minChars: number;
  maxChars: number;
  thoughtsEnabled: boolean;
  perspective: MeetNarrativePerspective;
  styleMode: MeetNarrativeStyleMode;
  styleSource?: "builtin" | "custom";
  styleId?: string;
  customStyle: string;
  compiledStyle?: MeetCompiledStyle;
  showThoughts?: boolean;
}
export type MeetInvitationState =
  "pending" | "accepted" | "declined" | "expired";
export interface MeetModeBridge {
  currentMode: "meet" | "online-paused";
  switchedAt: number;
  latestOnlineWindow?: {
    startedAt: number;
    endedAt?: number;
  };
}
export interface CrossModeContinuityEvent {
  id: string;
  mode: "online" | "meet";
  createdAt: number;
  senderType: "user" | "character" | "system";
  senderId?: string;
  text: string;
}
export interface MeetSession extends BaseEntity {
  conversationId?: string;
  participantIds: string[];
  initiator: "user" | "character";
  invitationMessageId?: string;
  scene: MeetScene;
  suggestionsEnabled: boolean;
  timeAware?: boolean;
  narrativeSettings?: MeetNarrativeSettings;
  sceneState?: MeetSceneState;
  plotState?: MeetPlotState;
  status: "active" | "ended";
  entries: MeetEntry[];
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  summary?: string;
  summaryMessageId?: string;
  modeBridge?: MeetModeBridge;
}
export interface Preset extends BaseEntity {
  name: string;
  systemPrompt: string;
  replyRules: string;
  temperature?: number;
  maxTokens?: number;
  scope: Scope;
  enabled: boolean;
}
export type LoreMountMode = "global" | "selected" | "none";
export interface LoreMount {
  mode: LoreMountMode;
  characterIds: string[];
  conversationIds: string[];
}
export interface LoreTriggerSettings {
  defaultScanDepth: number;
  /** Runtime-only injection budget. Undefined means use the global context profile. */
  maxContextChars?: number;
}
export type LoreInsertionPosition =
  | "base-rules"
  | "after-character"
  | "after-memory"
  | "before-history"
  | "before-user";
export interface LoreEntry {
  id: string;
  title?: string;
  keywords: string[];
  secondaryKeywords?: string[];
  secondaryLogic?: "and" | "or";
  constant?: boolean;
  probability?: number;
  scanDepth?: number;
  insertionPosition?: LoreInsertionPosition;
  content: string;
  priority: number;
  enabled: boolean;
  scope: Scope;
  createdAt?: number;
  updatedAt?: number;
}
export interface LoreShelfGroup {
  id: string;
  name: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}
export interface LoreBook extends BaseEntity {
  name: string;
  description: string;
  entries: LoreEntry[];
  enabled: boolean;
  mount?: LoreMount;
  triggerSettings?: LoreTriggerSettings;
  compiledContext?: LoreCompiledContext;
  shelfGroupId?: string;
}
export type MemoryKind = "summary" | "fact" | "plot" | "relationship";
export type MemorySourceType = "chat" | "meet" | "manual";
export type MemoryState = "active" | "faded" | "archived";
export interface Memory extends BaseEntity {
  characterId: string;
  conversationId?: string;
  kind: MemoryKind;
  title?: string;
  content: string;
  meaning?: string;
  source: string;
  sourceType?: MemorySourceType;
  sourceIds?: string[];
  sourceSnapshot?: string;
  occurredAt?: number;
  topics?: string[];
  entities?: string[];
  importance: number;
  confidence?: number;
  valence?: number;
  arousal?: number;
  activationCount?: number;
  reinforcementCount?: number;
  lastAccessedAt?: number;
  lastActivationEventId?: string;
  state?: MemoryState;
  locked: boolean;
  dontSurface?: boolean;
  resolved?: boolean;
  digested?: boolean;
  contentHash?: string;
  archivedCandidateAt?: number;
}
export interface MemoryVector {
  memoryId: string;
  characterId: string;
  model: string;
  dimensions: number;
  contentHash: string;
  vector: ArrayBuffer;
  updatedAt: number;
}
export interface EmbeddingServiceSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;
  batchSize: number;
}
export interface FeedComment {
  id: string;
  authorType: "user" | "character";
  authorId?: string;
  content: string;
  sections?: MessageInnerVoiceSections;
  translation?: ContentTranslation;
  createdAt: number;
  parentId?: string;
  threadRootId?: string;
  replyToAuthorType?: "user" | "character";
  replyToAuthorId?: string;
  origin?: "manual" | "proactive";
  status?: "complete" | "error";
  scheduledAt?: number;
  readAt?: number;
}
export interface PendingFeedInteraction {
  id: string;
  kind: "initial-comment" | "reply";
  characterId: string;
  scheduledAt: number;
  parentId?: string;
  threadRootId?: string;
  replyToAuthorType?: "user" | "character";
  replyToAuthorId?: string;
}
export interface FeedImageAttachment {
  id: string;
  source: "asset" | "url";
  assetId?: string;
  url?: string;
  description?: string;
  width?: number;
  height?: number;
  generated?: boolean;
}
export interface FeedPost extends BaseEntity {
  authorType?: "user" | "character";
  authorId?: string;
  content: string;
  sections?: MessageInnerVoiceSections;
  translation?: ContentTranslation;
  images?: FeedImageAttachment[];
  imageDescription?: string;
  liked: boolean;
  comments: FeedComment[];
  origin?: "manual" | "proactive";
  proactiveEventId?: string;
  readAt?: number;
  pendingInteractions?: PendingFeedInteraction[];
  imageGeneration?: {
    provider: "openai" | "novelai";
    model: string;
    prompt: string;
  };
}
export interface ProviderSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  stream: boolean;
  temperature: number;
  maxTokens: number;
  contextLimit: number;
  timeoutMs: number;
}
export interface ProviderPreset {
  id: string;
  name: string;
  provider: ProviderSettings;
  createdAt: number;
  updatedAt: number;
}
export interface ProviderPresetState {
  version: 1;
  activeId?: string;
  items: ProviderPreset[];
}
export interface DedicatedProviderSettings {
  enabled: boolean;
  provider: ProviderSettings;
}
export interface VisionProviderSettings extends DedicatedProviderSettings {
  instruction: string;
}
export interface ModelServiceSettings {
  version: 1;
  secondary: DedicatedProviderSettings;
  vision: VisionProviderSettings;
}
export interface SpeechVendorSettings {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  defaultVoiceId: string;
  speed: number;
  volume?: number;
  pitch?: number;
  languageBoost?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
}
export interface SpeechPreset {
  id: string;
  name: string;
  provider: SpeechProviderKind;
  settings: SpeechVendorSettings;
  createdAt: number;
  updatedAt: number;
}
export interface SpeechSettings {
  defaultProvider: SpeechProviderKind;
  minimax: SpeechVendorSettings;
  elevenlabs: SpeechVendorSettings;
  presets: SpeechPreset[];
}
export type ImageGenerationProviderKind = "openai" | "novelai";
export interface OpenAIImageSettings {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  size: string;
  quality: string;
  positivePrompt: string;
  negativePrompt: string;
}
export interface NovelAIImageSettings {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  width: number;
  height: number;
  sampler: string;
  steps: number;
  scale: number;
  positivePrompt: string;
  negativePrompt: string;
}
export interface ImageGenerationSettings {
  provider: ImageGenerationProviderKind;
  openai: OpenAIImageSettings;
  novelai: NovelAIImageSettings;
}
export type MusicSource = "netease" | "local-file" | "direct-url";
export interface MusicTrack extends BaseEntity {
  source: MusicSource;
  externalId?: string;
  title: string;
  artists: string[];
  album?: string;
  coverUrl?: string;
  durationMs?: number;
  directUrl?: string;
  localFileId?: string;
  unavailableReason?: string;
  favorite?: boolean;
  libraryStatus?: "saved" | "temporary";
  lastPlayedAt?: number;
  playCount?: number;
  customLyrics?: string;
  customTranslatedLyrics?: string;
  lyricsKind?: "lrc" | "plain";
  importedAt: number;
}
export interface MusicFile extends BaseEntity {
  name: string;
  mimeType: string;
  sizeBytes: number;
  blob: Blob;
}
export interface MusicPlaylist extends BaseEntity {
  source: "netease" | "local";
  externalId?: string;
  name: string;
  description?: string;
  coverUrl?: string;
  trackIds: string[];
  ownerName?: string;
  syncedAt?: number;
}
export type ListeningSessionState = "invited" | "active" | "ended";
export interface ListeningQueueEntry {
  trackId: string;
  selectedBy: "user" | "character";
  addedAt: number;
}
export interface MusicMoodImprintQuote {
  messageId: string;
  senderType: "user" | "character";
  textSnapshot: string;
  createdAt: number;
}
export interface MusicMoodImprintTrack {
  trackId: string;
  title: string;
  artists: string[];
  source: MusicSource;
  externalId?: string;
}
export interface MusicMoodImprint {
  id: string;
  sessionId: string;
  characterId: string;
  conversationId: string;
  tracks: MusicMoodImprintTrack[];
  representativeTrackId?: string;
  summary: string;
  moodTags: string[];
  quotes: MusicMoodImprintQuote[];
  recallEnabled: boolean;
  recallCount: number;
  lastRecalledAt?: number;
  createdAt: number;
  updatedAt: number;
}
export interface ListeningSession extends BaseEntity {
  conversationId: string;
  characterId: string;
  state: ListeningSessionState;
  invitedBy: "user" | "character";
  invitationMessageId?: string;
  currentTrackId?: string;
  queue: string[];
  queueEntries?: ListeningQueueEntry[];
  currentIndex: number;
  playbackState: "playing" | "paused";
  positionMs: number;
  selectedBy: "user" | "character";
  startedAt: number;
  endedAt?: number;
  summaryMessageId?: string;
  totalListenedMs?: number;
  djTurnCount?: number;
  moodImprint?: MusicMoodImprint;
}
export type MusicEventType = "invite" | "accept" | "decline" | "play" | "pause" | "seek" | "track-change" | "leave" | "queue-add" | "queue-remove" | "candidate-search" | "control-proposal" | "comment" | "summary" | "mood-imprint" | "mood-recall";
export interface MusicEvent extends BaseEntity {
  sessionId: string;
  conversationId: string;
  characterId: string;
  type: MusicEventType;
  actor: "user" | "character" | "system";
  trackId?: string;
  positionMs?: number;
  detail?: string;
}
export interface ListeningContext {
  sessionId: string;
  state: "invited" | "active";
  track?: MusicTrack;
  positionMs: number;
  playbackState: "playing" | "paused";
  selectedBy: "user" | "character";
  lyricWindow: string[];
  recentEvents: MusicEvent[];
  candidates?: MusicTrack[];
}
export type CharacterMusicAction =
  | { type: "accept-invite" }
  | { type: "decline-invite" }
  | { type: "invite"; trackId?: string }
  | { type: "play"; trackId: string }
  | { type: "pause" }
  | { type: "next" }
  | { type: "leave" }
  | { type: "queue-track"; trackId: string; placement: "next" | "end"; reason?: string }
  | { type: "search-track"; query: string; placement: "next" | "end"; reason?: string }
  | { type: "propose-control"; control: "pause" | "next" | "clear-queue"; reason: string };
export interface MusicAccountProfile {
  userId: string;
  nickname: string;
  avatarUrl?: string;
}
export type MusicSleepTimer =
  | { mode: "duration"; endsAt: number }
  | { mode: "track-end"; trackId: string };

export interface MusicClientSettings {
  account?: MusicAccountProfile;
  backgroundPlayback: boolean;
  volume: number;
  repeatMode: "off" | "all" | "one";
  shuffle: boolean;
  lyricsTranslationVisible?: boolean;
  lyricsFontSize?: "small" | "medium" | "large";
  sleepTimer?: MusicSleepTimer;
}
export type MusicReportPeriod = "week" | "month" | "year";
export interface MusicListeningTrackAggregate {
  trackId: string;
  title: string;
  artists: string[];
  source: MusicSource;
  listenedMs: number;
  starts: number;
  completes: number;
  skips: number;
}
export interface MusicListeningDailyAggregate {
  date: string;
  totalListenedMs: number;
  hourlyMs: number[];
  tracks: Record<string, MusicListeningTrackAggregate>;
  characterMs: Record<string, number>;
  characterTrackMs: Record<string, Record<string, number>>;
  characterSelectedCount: Record<string, number>;
  createdAt: number;
  updatedAt: number;
}
export interface MusicReportCommentary {
  period: MusicReportPeriod;
  periodKey: string;
  characterId: string;
  statsFingerprint: string;
  text: string;
  generatedAt: number;
  lastManualAttemptAt?: number;
}
export interface MusicReportPreferences {
  trackingStartedAt: number;
  selectedCharacterId?: string;
  period: MusicReportPeriod;
  anchorDate: string;
}


export type CoupleIslandStatus = "invited" | "active" | "archived";
export type CoupleIslandZone = "home" | "garden" | "beach" | "wish-tree" | "pet-cove" | "music-dock";
export interface CoupleIsland extends BaseEntity {
  characterId: string;
  conversationId: string;
  status: CoupleIslandStatus;
  invitationMessageId?: string;
  name: string;
  level: number;
  experience: number;
  heartShells: number;
  themeId: string;
  weather: string;
  startedAt?: number;
  archivedAt?: number;
  lastActivityAt: number;
  lastAiActionAt?: number;
}
export interface CoupleIslandObject extends BaseEntity {
  islandId: string;
  kind: "furniture" | "plant" | "pet" | "keepsake";
  catalogId: string;
  zone: CoupleIslandZone;
  location: "inventory" | "placed";
  x?: number;
  y?: number;
  layer?: number;
  state?: Record<string, unknown>;
  acquiredBy: "user" | "character" | "system";
}
export interface CoupleIslandEntry extends BaseEntity {
  islandId: string;
  kind: "diary" | "letter" | "wish" | "memory" | "photo" | "milestone";
  authorType: "user" | "character" | "both" | "system";
  title?: string;
  text: string;
  state?: "active" | "completed" | "archived";
  assetIds?: string[];
  sourceIds?: string[];
}
export interface CoupleIslandEvent extends BaseEntity {
  islandId: string;
  type: string;
  actorType: "user" | "character" | "system";
  sourceId?: string;
  summary: string;
  reward?: { heartShells: number; experience: number };
}
export type CharacterIslandAction =
  | { type: "invite-user" }
  | { type: "accept-invite" }
  | { type: "decline-invite"; reason: string }
  | { type: "leave-letter"; title?: string; text: string }
  | { type: "write-diary"; text: string }
  | { type: "water-plant"; objectId: string }
  | { type: "interact-pet"; objectId: string; action: string }
  | { type: "move-decoration"; objectId: string; x: number; y: number }
  | { type: "suggest-purchase"; catalogId: string; reason: string }
  | { type: "progress-wish"; entryId: string; note: string };

export type DesktopAppId =
  | "messages"
  | "characters"
  | "lore"
  | "memories"
  | "appearance"
  | "settings"
  | "meet"
  | "mall"
  | "phone-check"
  | "forum"
  | "music"
  | "couple-island";
export type AppearanceSource = {
  type: "default" | "color" | "asset" | "url";
  value?: string;
};
export type DesktopWidgetType =
  | "hero-profile"
  | "photo-square"
  | "photo-banner"
  | "profile-status"
  | "compliment-bubble";
export interface HeroWidgetData {
  topBackground?: AppearanceSource;
  sideImage?: AppearanceSource;
  bottomImageOne?: AppearanceSource;
  bottomImageTwo?: AppearanceSource;
  bottomImageThree?: AppearanceSource;
  pillText: string;
  titleText: string;
  banner?: AppearanceSource;
  avatar?: AppearanceSource;
  rowOneImage?: AppearanceSource;
  rowTwoImage?: AppearanceSource;
  label?: string;
  rowOneText?: string;
  rowTwoText?: string;
}
export interface ProfileStatusWidgetData {
  image?: AppearanceSource;
  captionText: string;
  typingText: string;
}
export interface ComplimentBubbleWidgetData {
  text: string;
}
export interface DesktopItem {
  id: string;
  kind: "app" | "widget";
  appId?: DesktopAppId;
  widgetType?: DesktopWidgetType;
  assetId?: string;
  url?: string;
  hero?: HeroWidgetData;
  profileStatus?: ProfileStatusWidgetData;
  complimentBubble?: ComplimentBubbleWidgetData;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface AppearanceFont {
  id: string;
  name: string;
  source: "local" | "url";
  fileName?: string;
  mimeType?: string;
  format: "woff2" | "woff" | "truetype" | "opentype";
  sizeBytes?: number;
  data?: string;
  url?: string;
}
export type AppearanceThemeMode = "light" | "dark" | "system";
export type AppearanceChatBubbleStyle = "default" | "kawaii";
export type AppearanceChatAvatarShape = "square" | "rounded" | "circle";
export interface AppearanceSettings {
  version:
    1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22;
  themeMode: AppearanceThemeMode;
  chatBubbleStyle: AppearanceChatBubbleStyle;
  chatAvatarShape: AppearanceChatAvatarShape;
  wallpaper: AppearanceSource;
  feedCover: AppearanceSource;
  iconSources: Partial<Record<DesktopAppId, AppearanceSource>>;
  dock: DesktopAppId[];
  items: DesktopItem[];
  fonts: AppearanceFont[];
  activeFontId?: string;
  fontScale: number;
  font?: AppearanceFont;
}
export interface ImageAsset {
  id: string;
  createdAt: number;
  updatedAt: number;
  purpose: "wallpaper" | "icon" | "widget" | "feed-cover" | "couple-island" | "chat-background";
  mimeType: string;
  width: number;
  height: number;
  data: string;
}
export interface MediaAsset {
  id: string;
  createdAt: number;
  updatedAt: number;
  purpose:
    | "chat-image"
    | "feed-image"
    | "feed-reference"
    | "sticker"
    | "voice"
    | "forum-avatar"
    | "forum-banner"
    | "forum-npc-avatar"
    | "forum-post-image"
    | "forum-profile-banner"
    | "forum-member-avatar"
    | "forum-member-banner"
    | "group-avatar"
    | "group-npc-avatar";
  mimeType: string;
  sizeBytes: number;
  data: string;
  width?: number;
  height?: number;
  durationMs?: number;
}
export interface StickerImportEntry {
  url: string;
  name: string;
  description: string;
  sourceLine: number;
}
export interface StickerImportPreview {
  entries: StickerImportEntry[];
  warnings: string[];
  ignoredLines: string[];
}
export interface StickerItem {
  id: string;
  source: "asset" | "url";
  assetId?: string;
  url?: string;
  name: string;
  description: string;
  order: number;
}
export interface StickerPack extends BaseEntity {
  name: string;
  order: number;
  coverStickerId?: string;
  stickers: StickerItem[];
}
export type BackgroundActivityKeepaliveMode = "oscillator" | "silent-audio";
export type BackgroundActivityMode = "off" | BackgroundActivityKeepaliveMode;
export interface NotificationSettings {
  enabled: boolean;
  previewContent: boolean;
  proactiveMessages: boolean;
  incomingCalls: boolean;
  permission: "default" | "granted" | "denied";
}
export interface BackgroundActivitySettings {
  mode: BackgroundActivityMode;
  modes?: BackgroundActivityKeepaliveMode[];
  enabled: boolean;
  lastStartedAt?: number;
}
export interface AppSettings {
  onboarded: boolean;
  adultConfirmed: boolean;
  sensitiveContent: boolean;
  accent: string;
  userName: string;
  userNickname?: string;
  userHandle?: string;
  userBio?: string;
  userAvatar?: string;
  userPersona?: string;
  notifications?: NotificationSettings;
  backgroundActivity?: BackgroundActivitySettings;
}
export const defaultProvider: ProviderSettings = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1-mini",
  stream: false,
  temperature: 0.85,
  maxTokens: 800,
  contextLimit: 30,
  timeoutMs: 60000,
};
export const defaultEmbeddingServiceSettings: EmbeddingServiceSettings = {
  enabled: false,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "text-embedding-3-small",
  batchSize: 20,
};
export const defaultModelServiceSettings: ModelServiceSettings = {
  version: 1,
  secondary: {
    enabled: false,
    provider: { ...defaultProvider, stream: false, temperature: 0.3 },
  },
  vision: {
    enabled: false,
    provider: {
      ...defaultProvider,
      model: "gpt-4.1-mini",
      stream: false,
      temperature: 0.2,
      maxTokens: 500,
    },
    instruction:
      "请客观描述图片中的人物、物体、环境、动作、文字和重要细节，不要臆测无法确认的信息。",
  },
};
export const defaultImageGenerationSettings: ImageGenerationSettings = {
  provider: "openai",
  openai: {
    enabled: false,
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-image-2",
    size: "1024x1024",
    quality: "medium",
    positivePrompt: "clean composition, coherent lighting, detailed",
    negativePrompt: "blurry, distorted anatomy, malformed hands, low quality",
  },
  novelai: {
    enabled: false,
    apiKey: "",
    baseUrl: "https://image.novelai.net",
    model: "nai-diffusion-4-full",
    width: 832,
    height: 1216,
    sampler: "k_euler_ancestral",
    steps: 28,
    scale: 5,
    positivePrompt: "masterpiece, best quality, detailed",
    negativePrompt: "low quality, blurry, malformed",
  },
};
export const defaultSpeechSettings: SpeechSettings = {
  defaultProvider: "minimax",
  presets: [],
  minimax: {
    enabled: false,
    apiKey: "",
    baseUrl: "https://api.minimax.io/v1",
    model: "speech-02-hd",
    defaultVoiceId: "",
    speed: 1,
    volume: 1,
    pitch: 0,
    languageBoost: "auto",
  },
  elevenlabs: {
    enabled: false,
    apiKey: "",
    baseUrl: "https://api.elevenlabs.io/v1",
    model: "eleven_multilingual_v2",
    defaultVoiceId: "",
    speed: 1,
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0,
    useSpeakerBoost: true,
  },
};
export const defaultNotificationSettings: NotificationSettings = {
  enabled: false,
  previewContent: true,
  proactiveMessages: true,
  incomingCalls: true,
  permission: "default",
};
export const defaultBackgroundActivitySettings: BackgroundActivitySettings = {
  mode: "off",
  modes: [],
  enabled: false,
};
export const defaultAppSettings: AppSettings = {
  onboarded: false,
  adultConfirmed: false,
  sensitiveContent: false,
  accent: "#7c6df2",
  userName: "我",
  notifications: defaultNotificationSettings,
  backgroundActivity: defaultBackgroundActivitySettings,
};
export const scopeSchema = z.object({
  type: z.enum(["global", "character", "conversation"]),
  id: z.string().optional(),
});
export const backupSchema = z.object({
  schemaVersion: z.number(),
  exportedAt: z.number(),
  data: z.object({
    characters: z.array(z.any()),
    conversations: z.array(z.any()),
    messages: z.array(z.any()),
    presets: z.array(z.any()),
    loreBooks: z.array(z.any()),
    loreShelfGroups: z.array(z.any()).optional(),
    memories: z.array(z.any()),
    feedPosts: z.array(z.any()),
    appearance: z.any().optional(),
    imageAssets: z.array(z.any()).optional(),
    mediaAssets: z.array(z.any()).optional(),
    stickerPacks: z.array(z.any()).optional(),
    meetSessions: z.array(z.any()).optional(),
    mallCatalogItems: z.array(z.any()).optional(),
    mallCartItems: z.array(z.any()).optional(),
    mallOrders: z.array(z.any()).optional(),
    walletTransactions: z.array(z.any()).optional(),
    forumServers: z.array(z.any()).optional(),
    forumChannels: z.array(z.any()).optional(),
    forumPosts: z.array(z.any()).optional(),
    characterPhoneStates: z.array(z.any()).optional(),
    musicTracks: z.array(z.any()).optional(),
    musicPlaylists: z.array(z.any()).optional(),
    listeningSessions: z.array(z.any()).optional(),
    musicEvents: z.array(z.any()).optional(),
    musicListeningStats: z.array(z.any()).optional(),
    musicReportCommentaries: z.array(z.any()).optional(),
    musicReportPreferences: z.any().optional(),
    coupleIslands: z.array(z.any()).optional(),
    coupleIslandObjects: z.array(z.any()).optional(),
    coupleIslandEntries: z.array(z.any()).optional(),
    coupleIslandEvents: z.array(z.any()).optional(),
    mallWalletSettings: z.any().optional(),
    speechSettings: z.any().optional(),
    imageGenerationSettings: z.any().optional(),
    memoryExtractionBatches: z.array(z.any()).optional(),
    memoryExtractionCursors: z.array(z.any()).optional(),
    appSettings: z.any(),
  }),
});
export const uid = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  )
    crypto.getRandomValues(bytes);
  else
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
export const now = () => Date.now();

export interface GitHubBackupSettings {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  token: string;
  passphraseHint?: string;
  lastBackupAt?: number;
  lastSha?: string;
}
