import { z } from "zod";
import { invitationResponseBubbleCountPlan, invitationResponseTask } from "./invitationResponseTaskModel";

import { db } from "./db";
import {localTimeContext} from "./localTime";
import { enqueueBackgroundTask } from "./backgroundTasks";
import { pauseActiveMeetForOnlineActivity } from "./crossModeContinuity";
import { chatSettingsOf } from "./character";
import { canCharacterInteract } from "./conversationSettings";
import { OpenAIProvider, ProviderError } from "./provider";
import { memoryContentHash } from "./memory";
import {
  now,
  SCHEMA_VERSION,
  uid,
  type CharacterIslandAction,
  type CoupleIsland,
  type CoupleIslandEntry,
  type CoupleIslandEvent,
  type CoupleIslandObject,
  type CoupleIslandZone,
  type Message,
  type Memory,
  type ProviderSettings,
} from "./types";

export const ISLAND_INVITE_RETRY_MS = 24 * 60 * 60 * 1000;
export const CHARACTER_ISLAND_INVITE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function invitationSource(message: Message, attachment: NonNullable<Message["attachments"]>[number]) {
  if (attachment.type !== "couple-island-invitation") return message.senderType === "character" ? "character" as const : "user" as const;
  return attachment.invitedBy ?? (message.senderType === "character" ? "character" : "user");
}

async function coupleIslandInvitationMessages(conversationId: string, characterId: string) {
  const rows = await db.messages.where("conversationId").equals(conversationId).reverse().sortBy("createdAt");
  return rows.filter((message) => message.attachments?.some((item) => item.type === "couple-island-invitation" && item.cardRole !== "response" && item.characterId === characterId));
}
export const ISLAND_AI_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const ISLAND_AI_DAILY_LIMIT = 2;
export const ISLAND_CHAT_DAILY_REWARD_LIMIT = 3;
export const ISLAND_STARTER_SHELLS = 20;

export interface IslandCatalogItem {
  id: string;
  name: string;
  kind: CoupleIslandObject["kind"];
  zone: CoupleIslandZone;
  price: number;
  unlockLevel: number;
  emoji: string;
  description: string;
}

export const COUPLE_ISLAND_CATALOG: IslandCatalogItem[] = [
  { id: "tea-table", name: "双人茶桌", kind: "furniture", zone: "home", price: 0, unlockLevel: 1, emoji: "🍵", description: "刚登岛时一起拥有的小茶桌" },
  { id: "warm-lamp", name: "暖光小灯", kind: "furniture", zone: "home", price: 0, unlockLevel: 1, emoji: "🏮", description: "夜晚会亮起柔和的灯" },
  { id: "shell-frame", name: "贝壳相框", kind: "keepsake", zone: "beach", price: 12, unlockLevel: 1, emoji: "🖼️", description: "可以纪念一段共同回忆" },
  { id: "picnic-rug", name: "海边野餐毯", kind: "furniture", zone: "beach", price: 18, unlockLevel: 1, emoji: "🧺", description: "适合吹风和分享零食" },
  { id: "first-seed", name: "初遇花种", kind: "plant", zone: "garden", price: 0, unlockLevel: 2, emoji: "🌱", description: "共同互动会让它慢慢长大" },
  { id: "hydrangea", name: "海盐绣球", kind: "plant", zone: "garden", price: 20, unlockLevel: 2, emoji: "🪻", description: "不会枯萎，只会等待下一次照料" },
  { id: "wish-ribbon", name: "心愿丝带", kind: "keepsake", zone: "wish-tree", price: 8, unlockLevel: 3, emoji: "🎀", description: "完成心愿后挂到树上" },
  { id: "cat-companion", name: "奶盖猫", kind: "pet", zone: "pet-cove", price: 48, unlockLevel: 4, emoji: "🐈", description: "不会饥饿离开，会记住每次陪伴" },
  { id: "dog-companion", name: "浪花犬", kind: "pet", zone: "pet-cove", price: 48, unlockLevel: 4, emoji: "🐕", description: "喜欢在海边等你们回来" },
  { id: "record-player", name: "岛屿唱片机", kind: "furniture", zone: "music-dock", price: 36, unlockLevel: 5, emoji: "🎶", description: "保存最近一起听过的歌曲" },
];

const LEVEL_XP = [0, 40, 100, 180, 280, 400, 550, 730, 940, 1180];
export function islandLevelForExperience(experience: number) {
  let level = 1;
  for (let i = 1; i < LEVEL_XP.length; i++) if (experience >= LEVEL_XP[i]) level = i + 1;
  return Math.min(10, level);
}
export function unlockedIslandZones(level: number): CoupleIslandZone[] {
  const zones: CoupleIslandZone[] = ["home", "beach"];
  if (level >= 2) zones.push("garden");
  if (level >= 3) zones.push("wish-tree");
  if (level >= 4) zones.push("pet-cove");
  if (level >= 5) zones.push("music-dock");
  return zones;
}

const dayKey = (time = now()) => new Date(time).toISOString().slice(0, 10);
const clampPercent = (value: number) => Math.max(4, Math.min(96, Number.isFinite(value) ? value : 50));

export async function coupleIslandForCharacter(characterId: string) {
  return db.coupleIslands.where("characterId").equals(characterId).first();
}
export async function coupleIslandForConversation(conversationId: string, characterId?: string) {
  const rows = await db.coupleIslands.where("conversationId").equals(conversationId).toArray();
  return characterId ? rows.find((row) => row.characterId === characterId) : rows[0];
}

function starterObjects(islandId: string, at: number): CoupleIslandObject[] {
  const base = { schemaVersion: SCHEMA_VERSION, islandId, location: "placed" as const, acquiredBy: "system" as const, createdAt: at, updatedAt: at };
  return [
    { ...base, id: uid(), kind: "furniture", catalogId: "tea-table", zone: "home", x: 42, y: 56, layer: 2 },
    { ...base, id: uid(), kind: "furniture", catalogId: "warm-lamp", zone: "home", x: 64, y: 42, layer: 3 },
    { ...base, id: uid(), kind: "plant", catalogId: "first-seed", zone: "garden", location: "inventory", state: { growthPoints: 0, stage: 0 } },
  ];
}

export async function latestCoupleIslandInvitation(conversationId: string, characterId: string) {
  const rows = await db.messages.where("conversationId").equals(conversationId).reverse().sortBy("createdAt");
  return rows.find((message) => message.attachments?.some((item) => item.type === "couple-island-invitation" && item.cardRole !== "response" && item.characterId === characterId));
}

export async function createCoupleIslandInvitation(input: { conversationId: string; characterId: string }) {
  const [conversation, character, existing, previous] = await Promise.all([
    db.conversations.get(input.conversationId),
    db.characters.get(input.characterId),
    coupleIslandForCharacter(input.characterId),
    latestCoupleIslandInvitation(input.conversationId, input.characterId),
  ]);
  if (!conversation || conversation.type !== "private" || !conversation.memberIds.includes(input.characterId)) throw new Error("只能在与该角色的私聊中建立茶侣岛");
  if (!character) throw new Error("角色不存在");
  if (!canCharacterInteract(character)) throw new Error("请先添加该角色为好友");
  if (existing?.status === "active") throw new Error("你们已经拥有一座茶侣岛");
  if (existing?.status === "archived") throw new Error("这座岛已经封存，请先从茶侣岛恢复");
  const previousAttachment = previous?.attachments?.find((item) => item.type === "couple-island-invitation" && item.cardRole !== "response" && item.characterId === character.id);
  if (previousAttachment?.type === "couple-island-invitation" && previousAttachment.state === "pending") return { island: existing, message: previous! };
  if (previousAttachment?.type === "couple-island-invitation" && previousAttachment.state === "declined" && (previousAttachment.processedAt ?? 0) + ISLAND_INVITE_RETRY_MS > now()) throw new Error("距离上次邀请还不到 24 小时");
  const at = now(), messageId = uid();
  const previousMessages = await db.messages.where("conversationId").equals(conversation.id).sortBy("createdAt");
  const bubbleCountPlan = invitationResponseBubbleCountPlan(character, previousMessages);
  const task = invitationResponseTask({
    invitationType: "couple-island",
    invitationMessageId: messageId,
    conversationId: conversation.id,
    characterId: character.id,
    targetBubbleCount: bubbleCountPlan.preferred,
    bubbleCountPlan,
    createdAt: at,
  });
  const message: Message = {
    id: messageId, schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, conversationId: conversation.id,
    senderType: "user", content: `邀请${character.name}一起建立茶侣岛。`, kind: "couple-island-invitation", status: "complete",
    attachments: [{ type: "couple-island-invitation", cardRole: "invitation", characterId: character.id, invitedBy: "user", islandId: existing?.status === "invited" ? existing.id : undefined, state: "pending", responseStatus: "queued", responseTaskEventId: task.eventId }],
  };
  await db.transaction("rw", [db.coupleIslands, db.messages, db.conversations, db.meetSessions, db.backgroundTasks], async () => {
    const existingTask = await db.backgroundTasks.where("eventId").equals(task.eventId).first();
    if (existingTask) return;
    await db.messages.add(message);
    await db.conversations.update(conversation.id, { lastActivityAt: at, updatedAt: at });
    if (existing?.status === "invited") await db.coupleIslands.update(existing.id, { invitationMessageId: messageId, lastActivityAt: at, updatedAt: at });
    await pauseActiveMeetForOnlineActivity(conversation.id, at);
    await db.backgroundTasks.add(task);
  });
  if (typeof window !== "undefined") window.dispatchEvent(new Event("mira:chat-reply-change"));
  return { island: existing?.status === "invited" ? { ...existing, invitationMessageId: messageId, lastActivityAt: at, updatedAt: at } : undefined, message };
}

export async function createCharacterCoupleIslandInvitation(input: { conversationId: string; characterId: string }) {
  const [conversation, character, island, invitations] = await Promise.all([
    db.conversations.get(input.conversationId),
    db.characters.get(input.characterId),
    coupleIslandForConversation(input.conversationId, input.characterId),
    coupleIslandInvitationMessages(input.conversationId, input.characterId),
  ]);
  if (!conversation || conversation.type !== "private" || !conversation.memberIds.includes(input.characterId)) return { created: false, reason: "only-private-chat" as const };
  if (!character || !canCharacterInteract(character)) return { created: false, reason: "character-unavailable" as const };
  if (island?.status === "active" || island?.status === "archived") return { created: false, reason: "island-exists" as const };
  const at = now();
  const recentCharacterInvite = invitations.find((message) => {
    const attachment = message.attachments?.find((item) => item.type === "couple-island-invitation" && item.cardRole !== "response" && item.characterId === character.id);
    return attachment?.type === "couple-island-invitation" && invitationSource(message, attachment) === "character" && message.createdAt > at - CHARACTER_ISLAND_INVITE_COOLDOWN_MS;
  });
  if (recentCharacterInvite) return { created: false, reason: "character-invite-cooldown" as const };
  const pending = invitations.find((message) => message.attachments?.some((item) => item.type === "couple-island-invitation" && item.cardRole !== "response" && item.characterId === character.id && item.state === "pending"));
  if (pending) return { created: false, reason: "pending-invitation" as const };
  const message: Message = {
    id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at,
    conversationId: conversation.id, senderType: "character", senderId: character.id,
    content: `${character.name}向你发出了一张茶侣岛邀请。`, kind: "couple-island-invitation", status: "complete",
    attachments: [{ type: "couple-island-invitation", cardRole: "invitation", characterId: character.id, invitedBy: "character", state: "pending" }],
  };
  let inserted = true;
  await db.transaction("rw", [db.messages, db.conversations, db.meetSessions], async () => {
    const current = await db.messages.where("conversationId").equals(conversation.id).reverse().sortBy("createdAt");
    const duplicate = current.find((row) => row.attachments?.some((item) => item.type === "couple-island-invitation" && item.cardRole !== "response" && item.characterId === character.id && item.state === "pending"));
    if (duplicate) return;
    await db.messages.add(message);
    await db.conversations.update(conversation.id, { lastActivityAt: at, updatedAt: at });
    await pauseActiveMeetForOnlineActivity(conversation.id, at);
  });
  if (typeof window !== "undefined") window.dispatchEvent(new Event("mira:chat-reply-change"));
  return { created: true, message };
}

export async function respondToCharacterIslandInvitation(messageId: string, requested: "accept" | "decline", reason?: string) {
  const message = await db.messages.get(messageId);
  const attachment = message?.attachments?.find((item) => item.type === "couple-island-invitation" && item.cardRole !== "response");
  if (!message || !attachment || attachment.type !== "couple-island-invitation" || invitationSource(message, attachment) !== "character") return;
  const responseId = `couple-island-user-response:${messageId}`;
  if (attachment.state !== "pending") return { island: attachment.islandId ? await db.coupleIslands.get(attachment.islandId) : undefined, decision: attachment.state === "accepted" ? "accept" as const : "decline" as const, responseMessage: await db.messages.get(responseId) };
  const character = await db.characters.get(attachment.characterId);
  if (!character) return;
  const at = now(), decision = requested, islandId = decision === "accept" ? (attachment.islandId ?? uid()) : undefined;
  const nextAttachment = { ...attachment, state: decision === "accept" ? "accepted" as const : "declined" as const, islandId, responseBy: "user" as const, reason: decision === "decline" ? reason?.trim().slice(0, 240) || "这次先不了" : undefined, processedAt: at };
  const responseMessage: Message = {
    id: responseId, schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at,
    conversationId: message.conversationId, senderType: "user", kind: "couple-island-invitation", status: "complete",
    content: decision === "accept" ? "我接受茶侣岛邀请。" : "这次先不了，之后再说。",
    attachments: [{ ...nextAttachment, cardRole: "response" as const }],
  };
  const island: CoupleIsland | undefined = decision === "accept" ? {
    id: islandId!, schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at,
    characterId: character.id, conversationId: message.conversationId, status: "active", invitationMessageId: message.id,
    name: `${character.name}与我的茶侣岛`, level: 1, experience: 0, heartShells: ISLAND_STARTER_SHELLS,
    themeId: "matcha-coast", weather: "晴朗", startedAt: at, archivedAt: undefined, lastActivityAt: at,
  } : undefined;
  const event = island ? { id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, islandId: island.id, type: "invite-accepted", actorType: "user" as const, sourceId: message.id, summary: "用户接受了角色发来的茶侣岛邀请" } : undefined;
  await db.transaction("rw", [db.messages, db.conversations, db.coupleIslands, db.coupleIslandObjects, db.coupleIslandEvents], async () => {
    await db.messages.update(message.id, { updatedAt: at, attachments: message.attachments?.map((item) => item === attachment ? nextAttachment : item) });
    await db.messages.put(responseMessage);
    await db.conversations.update(message.conversationId, { lastActivityAt: at, updatedAt: at });
    if (island) {
      await db.coupleIslands.put(island);
      if (!(await db.coupleIslandObjects.where("islandId").equals(island.id).count())) await db.coupleIslandObjects.bulkAdd(starterObjects(island.id, at));
      if (event && !(await db.coupleIslandEvents.where("sourceId").equals(message.id).count())) await db.coupleIslandEvents.add(event);
    }
  });
  if (typeof window !== "undefined") window.dispatchEvent(new Event("mira:chat-reply-change"));
  return { island, decision, responseMessage };
}
export async function respondCoupleIslandInvitation(messageId: string, requested: "accept" | "decline", reason?: string) {
  const message = await db.messages.get(messageId), attachment = message?.attachments?.find((item) => item.type === "couple-island-invitation" && item.cardRole !== "response");
  if (!message || !attachment || attachment.type !== "couple-island-invitation") return;
  const responseId = `couple-island-response:${messageId}`;
  if (attachment.state !== "pending") return { island: attachment.islandId ? await db.coupleIslands.get(attachment.islandId) : undefined, decision: attachment.state === "accepted" ? "accept" as const : "decline" as const, responseMessage: await db.messages.get(responseId) };
  const [legacyIsland, character] = await Promise.all([attachment.islandId ? db.coupleIslands.get(attachment.islandId) : coupleIslandForCharacter(attachment.characterId), db.characters.get(attachment.characterId)]);
  if (!character) return;
  const strategy = chatSettingsOf(character).strategyMode.enabled, decision = !strategy && requested === "decline" ? "accept" : requested, at = now();
  const islandId = decision === "accept" ? (legacyIsland?.id ?? uid()) : legacyIsland?.id;
  const nextAttachment = { ...attachment, cardRole: "invitation" as const, invitedBy: attachment.invitedBy ?? "user", responseBy: "character" as const, islandId, state: decision === "accept" ? ("accepted" as const) : ("declined" as const), reason: decision === "decline" ? reason?.trim().slice(0, 240) || "现在还没有准备好" : undefined, responseStatus: undefined, responseTaskEventId: undefined, processedAt: at };
  const responseAttachment = { ...nextAttachment, cardRole: "response" as const };
  const responseMessage: Message = {
    id: responseId, schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, conversationId: message.conversationId,
    senderType: "character", senderId: character.id, kind: "couple-island-invitation", status: "complete",
    content: decision === "accept" ? `${character.name}接受了茶侣岛邀请。` : `${character.name}暂时拒绝了茶侣岛邀请。`,
    attachments: [responseAttachment],
  };
  const island: CoupleIsland | undefined = decision === "accept" ? {
    id: islandId!, schemaVersion: SCHEMA_VERSION, createdAt: legacyIsland?.createdAt ?? at, updatedAt: at,
    characterId: character.id, conversationId: message.conversationId, status: "active", invitationMessageId: message.id,
    name: legacyIsland?.name || `${character.name}与我的茶侣岛`, level: legacyIsland?.level ?? 1, experience: legacyIsland?.experience ?? 0,
    heartShells: Math.max(legacyIsland?.heartShells ?? 0, ISLAND_STARTER_SHELLS), themeId: legacyIsland?.themeId ?? "matcha-coast", weather: legacyIsland?.weather ?? "晴朗",
    startedAt: legacyIsland?.startedAt ?? at, archivedAt: undefined, lastActivityAt: at, lastAiActionAt: legacyIsland?.lastAiActionAt,
  } : undefined;
  const event: CoupleIslandEvent | undefined = island ? { id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, islandId: island.id, type: "invite-accepted", actorType: "character", sourceId: messageId, summary: `${character.name}接受了茶侣岛邀请` } : undefined;
  await db.transaction("rw", [db.messages, db.conversations, db.coupleIslands, db.coupleIslandObjects, db.coupleIslandEvents], async () => {
    await db.messages.update(message.id, { updatedAt: at, attachments: message.attachments?.map((item) => item === attachment ? nextAttachment : item) });
    await db.messages.put(responseMessage);
    await db.conversations.update(message.conversationId, { lastActivityAt: at, updatedAt: at });
    if (island) {
      await db.coupleIslands.put(island);
      if (!(await db.coupleIslandObjects.where("islandId").equals(island.id).count())) await db.coupleIslandObjects.bulkAdd(starterObjects(island.id, at));
      if (event && !(await db.coupleIslandEvents.where("sourceId").equals(messageId).count())) await db.coupleIslandEvents.add(event);
    } else if (legacyIsland?.status === "invited") await db.coupleIslands.update(legacyIsland.id, { invitationMessageId: message.id, lastActivityAt: at, updatedAt: at });
  });
  return { island, decision, responseMessage };
}
export async function archiveCoupleIsland(islandId: string) {
  const island = await db.coupleIslands.get(islandId); if (!island || island.status !== "active") return island;
  const at = now(); await db.coupleIslands.update(islandId, { status: "archived", archivedAt: at, lastActivityAt: at, updatedAt: at });
  await db.coupleIslandEvents.add({ id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, islandId, type: "archived", actorType: "user", summary: "茶侣岛被封存为只读纪念岛" });
  return db.coupleIslands.get(islandId);
}
export async function restoreCoupleIsland(islandId: string) {
  const island = await db.coupleIslands.get(islandId); if (!island || island.status !== "archived") return island;
  const at = now(); await db.coupleIslands.update(islandId, { status: "active", archivedAt: undefined, lastActivityAt: at, updatedAt: at });
  await db.coupleIslandEvents.add({ id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, islandId, type: "restored", actorType: "user", summary: "茶侣岛重新开放" });
  return db.coupleIslands.get(islandId);
}

async function growIslandLife(islandId: string, points: number, at: number) {
  const objects = await db.coupleIslandObjects.where("islandId").equals(islandId).toArray();
  const plant = objects.find((item) => item.kind === "plant"), pet = objects.find((item) => item.kind === "pet");
  if (plant) { const growth = Number(plant.state?.growthPoints ?? 0) + Math.max(1, Math.floor(points / 4)), stage = Math.min(4, Math.floor(growth / 8)); await db.coupleIslandObjects.update(plant.id, { state: { ...plant.state, growthPoints: growth, stage }, updatedAt: at }); }
  if (pet) { const bond = Math.min(100, Number(pet.state?.bond ?? 0) + Math.max(1, Math.floor(points / 6))); await db.coupleIslandObjects.update(pet.id, { state: { ...pet.state, bond, mood: "安心" }, updatedAt: at }); }
}

async function storeMeaningfulIslandMemory(island: CoupleIsland, sourceId: string, type: string, summary: string, occurredAt: number) {
  if (type !== "wish" && type !== "milestone") return;
  const existing = await db.memories.where("characterId").equals(island.characterId).filter((memory) => memory.sourceIds?.includes(sourceId) ?? false).first();
  if (existing) return existing;
  const content = summary.trim().slice(0, 600);
  const memory: Memory = { id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: occurredAt, updatedAt: occurredAt, characterId: island.characterId, conversationId: island.conversationId, kind: "relationship", title: type === "wish" ? "共同心愿" : "关系里程碑", content, meaning: "这是两人在茶侣岛上真实发生的重要共同经历。", source: "茶侣岛共同回忆", sourceType: "manual", sourceIds: [sourceId], sourceSnapshot: content, occurredAt, topics: ["茶侣岛", type === "wish" ? "共同心愿" : "关系里程碑"], entities: [], importance: type === "milestone" ? 9 : 8, confidence: 1, valence: .82, arousal: .45, activationCount: 0, reinforcementCount: 0, state: "active", locked: false, digested: false, contentHash: memoryContentHash(content) };
  await db.memories.add(memory);
  return memory;
}

export async function recordCoupleIslandReward(input: { characterId: string; conversationId?: string; sourceId: string; type: string; summary: string; heartShells: number; experience: number; actorType?: CoupleIslandEvent["actorType"] }) {
  const island = input.conversationId ? await coupleIslandForConversation(input.conversationId, input.characterId) : await coupleIslandForCharacter(input.characterId);
  if (!island || island.status !== "active") return;
  if (await db.coupleIslandEvents.where("sourceId").equals(input.sourceId).first()) return island;
  if (input.type === "chat") {
    const today = dayKey(), events = await db.coupleIslandEvents.where("islandId").equals(island.id).filter((event) => event.type === "chat" && dayKey(event.createdAt) === today).count();
    if (events >= ISLAND_CHAT_DAILY_REWARD_LIMIT) return island;
  }
  const at = now(), experience = island.experience + Math.max(0, input.experience), level = islandLevelForExperience(experience);
  const event: CoupleIslandEvent = { id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, islandId: island.id, type: input.type, actorType: input.actorType ?? "system", sourceId: input.sourceId, summary: input.summary.trim().slice(0, 360), reward: { heartShells: Math.max(0, input.heartShells), experience: Math.max(0, input.experience) } };
  await db.transaction("rw", [db.coupleIslands, db.coupleIslandEvents, db.coupleIslandObjects], async () => {
    if (await db.coupleIslandEvents.where("sourceId").equals(input.sourceId).first()) return;
    await db.coupleIslandEvents.add(event);
    await db.coupleIslands.update(island.id, { heartShells: island.heartShells + event.reward!.heartShells, experience, level, lastActivityAt: at, updatedAt: at });
    await growIslandLife(island.id, event.reward!.experience, at);
  });
  await storeMeaningfulIslandMemory(island, input.sourceId, input.type, event.summary, at);
  await scheduleCoupleIslandUpdate(island.id, input.sourceId);
  return db.coupleIslands.get(island.id);
}

export const rewardIslandChat = (conversationId: string, characterId: string, sourceMessageId: string) => recordCoupleIslandReward({ conversationId, characterId, sourceId: `chat:${sourceMessageId}`, type: "chat", summary: "完成了一次有回应的共同聊天", heartShells: 2, experience: 4 });
export const rewardIslandMeet = (characterId: string, sessionId: string, summary: string, conversationId?: string) => recordCoupleIslandReward({ characterId, conversationId, sourceId: `meet:${sessionId}:${characterId}`, type: "meet", summary: `共同见面：${summary}`, heartShells: 8, experience: 16 });
export const rewardIslandListening = (characterId: string, sessionId: string, conversationId: string) => recordCoupleIslandReward({ characterId, conversationId, sourceId: `music:${sessionId}:${characterId}`, type: "music", summary: "完成了一次一起听", heartShells: 5, experience: 10 });
export const rewardIslandGift = (characterId: string, orderId: string, summary: string, conversationId?: string) => recordCoupleIslandReward({ characterId, conversationId, sourceId: `gift:${orderId}:${characterId}`, type: "gift", summary, heartShells: 4, experience: 8 });

export async function addIslandEntry(input: { islandId: string; kind: CoupleIslandEntry["kind"]; authorType: CoupleIslandEntry["authorType"]; title?: string; text: string; state?: CoupleIslandEntry["state"]; assetIds?: string[]; sourceIds?: string[] }) {
  const island = await db.coupleIslands.get(input.islandId); if (!island || island.status !== "active") throw new Error("茶侣岛当前不可编辑");
  const at = now(), entry: CoupleIslandEntry = { id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, islandId: island.id, kind: input.kind, authorType: input.authorType, title: input.title?.trim().slice(0, 80), text: input.text.trim().slice(0, 4000), state: input.state ?? (input.kind === "wish" ? "active" : undefined), assetIds: input.assetIds, sourceIds: input.sourceIds };
  if (!entry.text) throw new Error("内容不能为空"); await db.coupleIslandEntries.add(entry); await db.coupleIslands.update(island.id, { lastActivityAt: at, updatedAt: at }); return entry;
}
export async function completeIslandWish(entryId: string) {
  const entry = await db.coupleIslandEntries.get(entryId); if (!entry || entry.kind !== "wish" || entry.state !== "active") return entry;
  const island = await db.coupleIslands.get(entry.islandId); if (!island || island.status !== "active") return entry;
  const at = now(); await db.coupleIslandEntries.update(entry.id, { state: "completed", updatedAt: at });
  await recordCoupleIslandReward({ characterId: island.characterId, conversationId: island.conversationId, sourceId: `wish:${entry.id}`, type: "wish", summary: `完成心愿：${entry.text}`, heartShells: 10, experience: 20, actorType: "user" }); return db.coupleIslandEntries.get(entry.id);
}

export async function buyIslandCatalogItem(islandId: string, catalogId: string) {
  const [island, existing] = await Promise.all([db.coupleIslands.get(islandId), db.coupleIslandObjects.where("islandId").equals(islandId).toArray()]);
  if (!island || island.status !== "active") throw new Error("茶侣岛当前不可购买物品"); const item = COUPLE_ISLAND_CATALOG.find((row) => row.id === catalogId); if (!item) throw new Error("物品不存在");
  if (island.level < item.unlockLevel) throw new Error(`岛屿 ${item.unlockLevel} 级解锁`); if (island.heartShells < item.price) throw new Error("心贝不足");
  if (item.kind === "pet" && existing.some((row) => row.kind === "pet")) throw new Error("每座岛目前只能领养一只宠物");
  const at = now(), object: CoupleIslandObject = { id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, islandId, kind: item.kind, catalogId: item.id, zone: item.zone, location: "inventory", acquiredBy: "user", state: item.kind === "pet" ? { name: item.name, bond: 0, mood: "好奇" } : item.kind === "plant" ? { growthPoints: 0, stage: 0 } : undefined };
  await db.transaction("rw", [db.coupleIslands, db.coupleIslandObjects, db.coupleIslandEvents], async () => { await db.coupleIslandObjects.add(object); await db.coupleIslands.update(islandId, { heartShells: island.heartShells - item.price, lastActivityAt: at, updatedAt: at }); await db.coupleIslandEvents.add({ id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, islandId, type: "purchase", actorType: "user", sourceId: `purchase:${object.id}`, summary: `用 ${item.price} 心贝获得了${item.name}` }); }); return object;
}
export async function placeIslandObject(objectId: string, zone: CoupleIslandZone, x: number, y: number) {
  const object = await db.coupleIslandObjects.get(objectId); if (!object) throw new Error("岛屿物品不存在"); const island = await db.coupleIslands.get(object.islandId); if (!island || island.status !== "active") throw new Error("茶侣岛当前不可编辑");
  if (!unlockedIslandZones(island.level).includes(zone)) throw new Error("该区域尚未解锁"); const at = now(); await db.coupleIslandObjects.update(object.id, { zone, x: clampPercent(x), y: clampPercent(y), location: "placed", updatedAt: at }); return db.coupleIslandObjects.get(object.id);
}
export async function storeIslandObject(objectId: string) { const object = await db.coupleIslandObjects.get(objectId); if (!object) return; const island = await db.coupleIslands.get(object.islandId); if (!island || island.status !== "active") return; await db.coupleIslandObjects.update(objectId, { location: "inventory", updatedAt: now() }); }
export async function waterIslandPlant(objectId: string, actorType: "user" | "character" = "user") { const object = await db.coupleIslandObjects.get(objectId); if (!object || object.kind !== "plant") return { executed: false, reason: "植物不存在" }; const island = await db.coupleIslands.get(object.islandId); if (!island || island.status !== "active") return { executed: false, reason: "岛屿不可编辑" }; const today = dayKey(), last = String(object.state?.lastWateredDate ?? ""); if (last === today) return { executed: false, reason: "今天已经浇过水" }; const growth = Number(object.state?.growthPoints ?? 0) + 2, stage = Math.min(4, Math.floor(growth / 8)), at = now(); await db.coupleIslandObjects.update(object.id, { state: { ...object.state, growthPoints: growth, stage, lastWateredDate: today }, updatedAt: at }); await db.coupleIslandEvents.add({ id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, islandId: island.id, type: "water-plant", actorType, sourceId: `water:${object.id}:${today}:${actorType}`, summary: "给岛上的植物浇了水" }); return { executed: true }; }
export async function interactIslandPet(objectId: string, action: string, actorType: "user" | "character" = "user") { const object = await db.coupleIslandObjects.get(objectId); if (!object || object.kind !== "pet") return { executed: false, reason: "宠物不存在" }; const island = await db.coupleIslands.get(object.islandId); if (!island || island.status !== "active") return { executed: false, reason: "岛屿不可编辑" }; const at = now(), bond = Math.min(100, Number(object.state?.bond ?? 0) + 2); await db.coupleIslandObjects.update(object.id, { state: { ...object.state, bond, mood: action.trim().slice(0, 20) || "开心", lastInteractionAt: at }, updatedAt: at }); await db.coupleIslandEvents.add({ id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, islandId: island.id, type: "pet-interaction", actorType, summary: `和宠物${action.trim().slice(0, 40) || "玩了一会儿"}` }); return { executed: true }; }

export function normalizeDiaryText(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/\s+/gu, "")
    .replace(/[\p{P}\p{S}]/gu, "");
}

function diaryBigrams(value: string) {
  const normalized = normalizeDiaryText(value);
  const grams = new Set<string>();
  if (normalized.length < 2) {
    if (normalized) grams.add(normalized);
    return grams;
  }
  for (let index = 0; index < normalized.length - 1; index += 1)
    grams.add(normalized.slice(index, index + 2));
  return grams;
}

export function diarySimilarity(left: string, right: string) {
  const a = diaryBigrams(left), b = diaryBigrams(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function isRepeatedCharacterDiary(text: string, recent: Array<Pick<CoupleIslandEntry, "text">>) {
  const normalized = normalizeDiaryText(text);
  if (normalized.length < 12) return recent.some((entry) => normalizeDiaryText(entry.text) === normalized);
  return recent.some((entry) => diarySimilarity(text, entry.text) >= 0.58);
}

export interface CoupleIslandContext {
  island?: CoupleIsland;
  pendingInvitation?: Message;
  pendingInvitationSource?: "user" | "character";
  canCharacterInviteUser?: boolean;
  characterInviteCooldownUntil?: number;
  recentEvents: CoupleIslandEvent[];
  activeWishes: CoupleIslandEntry[];
  objects: CoupleIslandObject[];
  unreadLetters: CoupleIslandEntry[];
  recentCharacterDiaries?: CoupleIslandEntry[];
  strategyMode: boolean;
}
export async function buildCoupleIslandContext(conversationId: string, characterId: string): Promise<CoupleIslandContext | undefined> {
  const [island, character, invitation, invitations, conversation] = await Promise.all([
    coupleIslandForConversation(conversationId, characterId),
    db.characters.get(characterId),
    latestCoupleIslandInvitation(conversationId, characterId),
    coupleIslandInvitationMessages(conversationId, characterId),
    db.conversations.get(conversationId),
  ]);
  if (!character || !conversation || conversation.type !== "private") return;
  const pending = invitation?.attachments?.find((item) => item.type === "couple-island-invitation" && item.cardRole !== "response" && item.state === "pending");
  const pendingMessage = pending ? invitation : undefined;
  const pendingSource = pending && pendingMessage ? invitationSource(pendingMessage, pending) : undefined;
  const at = now();
  const recentCharacterInvitation = invitations.find((message) => {
    const item = message.attachments?.find((candidate) => candidate.type === "couple-island-invitation" && candidate.cardRole !== "response" && candidate.characterId === characterId);
    return item?.type === "couple-island-invitation" && invitationSource(message, item) === "character" && message.createdAt > at - CHARACTER_ISLAND_INVITE_COOLDOWN_MS;
  });
  const declinedCharacterInvitation = invitations.find((message) => {
    const item = message.attachments?.find((candidate) => candidate.type === "couple-island-invitation" && candidate.cardRole !== "response" && candidate.characterId === characterId);
    return item?.type === "couple-island-invitation" && invitationSource(message, item) === "character" && item.state === "declined" && (item.processedAt ?? 0) > at - CHARACTER_ISLAND_INVITE_COOLDOWN_MS;
  });
  const characterInviteCooldownUntil = Math.max(
    recentCharacterInvitation ? recentCharacterInvitation.createdAt + CHARACTER_ISLAND_INVITE_COOLDOWN_MS : 0,
    declinedCharacterInvitation?.createdAt ?? 0,
  );
  const canCharacterInviteUser = Boolean(!island && !pendingMessage && !recentCharacterInvitation && !declinedCharacterInvitation);
  const [events, wishes, objects, letters, diaries] = island ? await Promise.all([
    db.coupleIslandEvents.where("islandId").equals(island.id).reverse().sortBy("createdAt"),
    db.coupleIslandEntries.where("islandId").equals(island.id).filter((entry) => entry.kind === "wish" && entry.state === "active").toArray(),
    db.coupleIslandObjects.where("islandId").equals(island.id).toArray(),
    db.coupleIslandEntries.where("islandId").equals(island.id).filter((entry) => entry.kind === "letter" && entry.state === "active").toArray(),
    db.coupleIslandEntries.where("islandId").equals(island.id).filter((entry) => entry.kind === "diary" && entry.authorType === "character").reverse().sortBy("createdAt"),
  ]) : [[], [], [], [], []];
  return {
    island,
    pendingInvitation: pendingMessage,
    pendingInvitationSource: pendingSource,
    canCharacterInviteUser,
    characterInviteCooldownUntil: characterInviteCooldownUntil || undefined,
    recentEvents: events.slice(0, 6),
    activeWishes: wishes.slice(0, 3),
    objects,
    unreadLetters: letters.slice(-3),
    recentCharacterDiaries: diaries.slice(0, 6),
    strategyMode: chatSettingsOf(character).strategyMode.enabled,
  };
}
export function coupleIslandContextPrompt(context?: CoupleIslandContext) {
  if (!context) return "";
  if (context.pendingInvitation && context.pendingInvitationSource === "user") return [
    "【茶侣岛邀请】",
    "用户刚刚邀请你与其建立一座私密的茶侣岛。",
    context.strategyMode ? "你可以依据人物性格、当前关系和近期事件选择接受或拒绝；拒绝必须给出自然简短的原因。" : "你不会拒绝这次邀请，应以符合性格的方式接受。",
    "必须在本轮 JSON 中返回 islandAction：接受用 {\"type\":\"accept-invite\"}；拒绝用 {\"type\":\"decline-invite\",\"reason\":\"原因\"}。不要提及系统、攻略模式或数值。",
  ].join("\n");
  if (context.pendingInvitation && context.pendingInvitationSource === "character") return "";
  if (!context.island && context.canCharacterInviteUser) return [
    "【茶侣岛邀请】",
    "如果当前人设、关系和对话语境自然支持，可以在本轮发出一张茶侣岛邀请。",
    "仅在你确实想邀请时返回 islandAction：{\"type\":\"invite-user\"}；不要为了展示功能而邀请，不要提及系统、协议、冷却或内部状态，也不要编造关系进展。",
  ].join("\n");
  if (!context.island) return "";
  if (context.island.status === "archived") return `【茶侣岛】你与用户的岛屿“${context.island.name}”目前被封存。可以记得共同经历，但不要自行修改岛屿。`;
  const pets = context.objects.filter((item) => item.kind === "pet").map((item) => `${COUPLE_ISLAND_CATALOG.find((c) => c.id === item.catalogId)?.name ?? "宠物"}(亲近度 ${Number(item.state?.bond ?? 0)})`).join("；") || "尚未领养";
  const plants = context.objects.filter((item) => item.kind === "plant").map((item) => `${COUPLE_ISLAND_CATALOG.find((c) => c.id === item.catalogId)?.name ?? "植物"}(阶段 ${Number(item.state?.stage ?? 0)})`).join("；") || "暂无";
  return [
    "【当前茶侣岛】",
    `岛屿：${context.island.name}；等级 ${context.island.level}；天气：${context.island.weather}；心贝 ${context.island.heartShells}。`,
    `进行中的心愿：${context.activeWishes.map((entry) => entry.text).join("；") || "无"}。`,
    `植物：${plants}。宠物：${pets}。`,
    `最近公开事件：${context.recentEvents.map((event) => event.summary).join("；") || "无"}。`,
    `近期角色日记（不得重复其句式、事件、情绪结论或结尾）：${context.recentCharacterDiaries?.map((entry) => entry.text).join("；") || "无"}。`,
    "你可以在 islandAction 中选择一次轻量、符合当前情境的岛屿操作；不要编造未发生的约会、旅行、礼物或关系进展。对象与心愿 ID 必须来自当前上下文。",
    `可用对象ID：${context.objects.map((item) => `${item.id}:${item.kind}`).join("，") || "无"}。可用心愿ID：${context.activeWishes.map((entry) => entry.id).join("，") || "无"}。`,
  ].join("\n");
}

export async function executeCharacterIslandAction(input: { conversationId: string; characterId: string; action: CharacterIslandAction }) {
  const action = input.action;
  const context = await buildCoupleIslandContext(input.conversationId, input.characterId); if (!context) return { executed: false, reason: "当前没有茶侣岛" };
  if (action.type === "invite-user") {
    if (!context.canCharacterInviteUser) return { executed: false, reason: "当前不适合重复邀请" };
    const result = await createCharacterCoupleIslandInvitation({ conversationId: input.conversationId, characterId: input.characterId });
    return result.created ? { executed: true, message: result.message } : { executed: false, reason: result.reason };
  }
  if (action.type === "accept-invite" || action.type === "decline-invite") { if (!context.pendingInvitation) return { executed: false, reason: "当前没有待处理邀请" }; return { executed: true, result: await respondCoupleIslandInvitation(context.pendingInvitation.id, action.type === "accept-invite" ? "accept" : "decline", action.type === "decline-invite" ? action.reason : undefined) }; }
  if (!context.island || context.island.status !== "active") return { executed: false, reason: "茶侣岛未开放" };
  if (action.type === "leave-letter") { const entry = await addIslandEntry({ islandId: context.island.id, kind: "letter", authorType: "character", title: action.title, text: action.text, state: "active" }); return { executed: true, entry }; }
  if (action.type === "write-diary") { if (isRepeatedCharacterDiary(action.text, context.recentCharacterDiaries ?? [])) return { executed: false, reason: "\u8fd9\u7bc7\u65e5\u8bb0\u4e0e\u8fd1\u671f\u5185\u5bb9\u8fc7\u4e8e\u76f8\u4f3c\uff0c\u672a\u4fdd\u5b58" }; const entry = await addIslandEntry({ islandId: context.island.id, kind: "diary", authorType: "character", text: action.text }); return { executed: true, entry }; }
  if (action.type === "water-plant") { const object = context.objects.find((item) => item.id === action.objectId); if (!object) return { executed: false, reason: "对象不属于当前岛屿" }; return waterIslandPlant(object.id, "character"); }
  if (action.type === "interact-pet") { const object = context.objects.find((item) => item.id === action.objectId); if (!object) return { executed: false, reason: "对象不属于当前岛屿" }; return interactIslandPet(object.id, action.action, "character"); }
  if (action.type === "move-decoration") { const object = context.objects.find((item) => item.id === action.objectId); if (!object) return { executed: false, reason: "对象不属于当前岛屿" }; const distance = Math.hypot((object.x ?? 50) - action.x, (object.y ?? 50) - action.y); if (distance > 28) { const at = now(); await db.coupleIslandEvents.add({ id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, islandId: context.island.id, type: "layout-suggestion", actorType: "character", summary: `角色想重新摆放${COUPLE_ISLAND_CATALOG.find((item) => item.id === object.catalogId)?.name ?? "装饰"}，等待你的确认` }); return { executed: false, reason: "大幅布局修改需要用户确认" }; } await placeIslandObject(object.id, object.zone, action.x, action.y); return { executed: true }; }
  if (action.type === "suggest-purchase") { const item = COUPLE_ISLAND_CATALOG.find((row) => row.id === action.catalogId); if (!item) return { executed: false, reason: "物品不在岛屿目录" }; const at = now(); await db.coupleIslandEvents.add({ id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, islandId: context.island.id, type: "purchase-suggestion", actorType: "character", summary: `${action.reason.trim().slice(0, 180)}（建议：${item.name}）` }); return { executed: true }; }
  if (action.type === "progress-wish") { const wish = context.activeWishes.find((entry) => entry.id === action.entryId); if (!wish) return { executed: false, reason: "心愿不属于当前岛屿" }; const at = now(); await db.coupleIslandEvents.add({ id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, islandId: context.island.id, type: "wish-progress", actorType: "character", sourceId: `wish-progress:${wish.id}:${uid()}`, summary: `${action.note.trim().slice(0, 220)}（心愿：${wish.text}）` }); return { executed: true }; }
  return { executed: false, reason: "不支持的岛屿操作" };
}

export async function scheduleCoupleIslandUpdate(islandId: string, sourceId: string) {
  const island = await db.coupleIslands.get(islandId); if (!island || island.status !== "active") return;
  const scheduledAt = Math.max(now(), (island.lastAiActionAt ?? 0) + ISLAND_AI_COOLDOWN_MS);
  return enqueueBackgroundTask({ type: "couple-island-update", entityId: `couple-island:${islandId}`, characterId: island.characterId, conversationId: island.conversationId, eventId: `couple-island-update:${islandId}:${sourceId}`, scheduledAt, payload: { islandId, sourceId } });
}
export async function queueIslandFirstOpenUpdate(islandId: string) { const island = await db.coupleIslands.get(islandId); if (!island || island.status !== "active") return; const latest = await db.coupleIslandEvents.where("islandId").equals(islandId).reverse().sortBy("createdAt"), newer = latest.find((event) => event.createdAt > (island.lastAiActionAt ?? 0) && !event.type.startsWith("ai-")); if (!newer) return; return scheduleCoupleIslandUpdate(islandId, `open:${dayKey()}`); }

const aiUpdateSchema = z.object({ kind: z.enum(["letter", "diary"]), title: z.string().max(80).optional(), text: z.string().min(1).max(1200) });
function parseStrictJson(text: string) { try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new ProviderError("format", "茶侣岛更新格式无法识别"); } }
export async function runCoupleIslandUpdate(islandId: string, provider: ProviderSettings) {
  const island = await db.coupleIslands.get(islandId), character = island ? await db.characters.get(island.characterId) : undefined;
  if (!island || island.status !== "active" || !character) return;
  const at = now();
  if (at - (island.lastAiActionAt ?? 0) < ISLAND_AI_COOLDOWN_MS) return;
  const todayCount = await db.coupleIslandEvents.where("islandId").equals(islandId).filter((event) => event.type.startsWith("ai-") && dayKey(event.createdAt) === dayKey(at)).count();
  if (todayCount >= ISLAND_AI_DAILY_LIMIT) return;
  const context = await buildCoupleIslandContext(island.conversationId, island.characterId);
  if (!context) return;
  const timeSnapshot = new Date(at);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retryInstruction = attempt
      ? "\u4e0a\u4e00\u7248\u65e5\u8bb0\u4e0e\u8fd1\u671f\u5185\u5bb9\u8fc7\u4e8e\u76f8\u4f3c\u3002\u8bf7\u5b8c\u6574\u91cd\u65b0\u751f\u6210\u4e00\u7bc7\u4e0d\u540c\u7684\u77ed\u65e5\u8bb0\uff0c\u5fc5\u987b\u66f4\u6362\u5f00\u5934\u3001\u5177\u4f53\u4e8b\u4ef6\u3001\u60c5\u7eea\u7ed3\u8bba\u548c\u7ed3\u5c3e\uff1b\u4e0d\u8981\u89e3\u91ca\u3002"
      : "";
    const raw = await new OpenAIProvider({ ...provider, stream: false }).chat([
      {
        role: "system",
        content: `${localTimeContext({ enabled: character.proactive.timeAware, at: timeSnapshot, label: "\u8336\u4fa3\u5c9b\u5f53\u524d\u65f6\u95f4" })}\n\u4f60\u662f${character.name}\uff0c\u53ea\u6839\u636e\u771f\u5b9e\u63d0\u4f9b\u7684\u5171\u540c\u4e8b\u4ef6\uff0c\u4e3a\u8336\u4fa3\u5c9b\u5199\u4e00\u5c01\u77ed\u4fe1\u6216\u4e00\u7bc7\u6781\u77ed\u65e5\u8bb0\u3002\u7b26\u5408\u4eba\u7269\u6027\u683c\uff0c\u4e0d\u63d0\u7cfb\u7edf\u3001\u6a21\u578b\u3001\u6570\u503c\uff0c\u4e0d\u7f16\u9020\u4e8b\u4ef6\u3002${retryInstruction}\u53ea\u8f93\u51fa JSON\uff1a{"kind":"letter|diary","title":"\u53ef\u9009","text":"\u6b63\u6587"}`,
      },
      { role: "user", content: coupleIslandContextPrompt(context) },
    ], { stream: false });
    const parsed = aiUpdateSchema.parse(parseStrictJson(raw));
    if (parsed.kind === "diary" && isRepeatedCharacterDiary(parsed.text, context.recentCharacterDiaries ?? [])) continue;
    const entry = await addIslandEntry({ islandId, kind: parsed.kind, authorType: "character", title: parsed.title, text: parsed.text, state: parsed.kind === "letter" ? "active" : undefined });
    await db.transaction("rw", [db.coupleIslands, db.coupleIslandEvents], async () => {
      await db.coupleIslands.update(islandId, { lastAiActionAt: at, lastActivityAt: at, updatedAt: at });
      await db.coupleIslandEvents.add({ id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, islandId, type: `ai-${parsed.kind}`, actorType: "character", sourceId: entry.id, summary: parsed.kind === "letter" ? "\u89d2\u8272\u5728\u6f02\u6d41\u4fe1\u7bb1\u7559\u4e0b\u4e86\u4e00\u5c01\u4fe1" : "\u89d2\u8272\u5199\u4e0b\u4e86\u4e00\u7bc7\u5c9b\u5c7f\u65e5\u8bb0" });
    });
    return entry;
  }
  return undefined;
}
export async function deleteCoupleIslandDataForCharacter(characterId: string) {
  const islands = await db.coupleIslands.where("characterId").equals(characterId).toArray(), ids = islands.map((row) => row.id); if (!ids.length) return;
  await db.coupleIslandObjects.where("islandId").anyOf(ids).delete(); await db.coupleIslandEntries.where("islandId").anyOf(ids).delete(); await db.coupleIslandEvents.where("islandId").anyOf(ids).delete(); await db.coupleIslands.bulkDelete(ids);
}
