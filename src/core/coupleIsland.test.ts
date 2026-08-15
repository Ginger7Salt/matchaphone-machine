import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db";
import {
  ISLAND_AI_COOLDOWN_MS,
  ISLAND_CHAT_DAILY_REWARD_LIMIT,
  ISLAND_INVITE_RETRY_MS,
  archiveCoupleIsland,
  buyIslandCatalogItem,
  completeIslandWish,
  createCoupleIslandInvitation,
  deleteCoupleIslandDataForCharacter,
  executeCharacterIslandAction,
  addIslandEntry,
  interactIslandPet,
  recordCoupleIslandReward,
  respondCoupleIslandInvitation,
  restoreCoupleIsland,
  rewardIslandChat,
  scheduleCoupleIslandUpdate,
  waterIslandPlant,
  diarySimilarity,
  isRepeatedCharacterDiary,
  runCoupleIslandUpdate,
} from "./coupleIsland";
import { defaultProvider, type Character, type Conversation, type CoupleIsland, type CoupleIslandObject, type MeetSession } from "./types";
import { OpenAIProvider } from "./provider";

const baseTime = Date.UTC(2026, 7, 9, 1, 0, 0);
const character = (id: string, strategy = false): Character => ({
  id, schemaVersion: 1, createdAt: baseTime, updatedAt: baseTime, name: id, avatar: "", bio: "", personality: "gentle", speakingStyle: "brief", background: "", language: "中文",
  proactive: { messages: false, timeAware: false, frequency: "low", quietStart: "23:00", quietEnd: "08:00", catchupLimit: 1, dailyLimit: 1 },
  chatSettings: { language: "中文", contextLimit: 30, stream: false, strategyMode: { enabled: strategy } },
  relationship: { intimacy: 20, trust: 20, mood: "calm", recentEvents: [] }, lastActiveAt: baseTime,
} as Character);
const conversation = (id: string, characterId: string): Conversation => ({ id, schemaVersion: 1, createdAt: baseTime, updatedAt: baseTime, type: "private", title: id, memberIds: [characterId], lastActivityAt: baseTime } as Conversation);

async function seedPair(id = "a", strategy = false) {
  const ch = character(id, strategy), conv = conversation(`conversation-${id}`, id);
  await db.characters.add(ch); await db.conversations.add(conv);
  return { ch, conv };
}
async function activeIsland(id = "a", strategy = false) {
  const pair = await seedPair(id, strategy);
  const invitation = await createCoupleIslandInvitation({ conversationId: pair.conv.id, characterId: pair.ch.id });
  const accepted = await respondCoupleIslandInvitation(invitation.message.id, "accept");
  if (!accepted?.island) throw new Error("island acceptance failed");
  return { ...pair, message: invitation.message, island: accepted.island };
}

describe("couple island domain", () => {
  beforeEach(async () => { await db.delete(); await db.open(); });
  afterEach(() => vi.restoreAllMocks());

  it("creates one private invitation, pauses an active meet, and grants idempotent starter items", async () => {
    const { ch, conv } = await seedPair();
    await db.meetSessions.add({ id: "meet", schemaVersion: 1, createdAt: baseTime, updatedAt: baseTime, conversationId: conv.id, participantIds: [ch.id], initiator: "user", scene: { opening: "hello" }, suggestionsEnabled: false, status: "active", entries: [], startedAt: baseTime, lastActivityAt: baseTime } as MeetSession);
    const first = await createCoupleIslandInvitation({ conversationId: conv.id, characterId: ch.id });
    const second = await createCoupleIslandInvitation({ conversationId: conv.id, characterId: ch.id });
    expect(second.message.id).toBe(first.message.id);
    expect((await db.meetSessions.get("meet"))?.modeBridge?.currentMode).toBe("online-paused");
    expect(first.island).toBeUndefined();
    const accepted = await respondCoupleIslandInvitation(first.message.id, "accept");
    await respondCoupleIslandInvitation(first.message.id, "accept");
    if (!accepted?.island) throw new Error("island acceptance failed");
    const island = await db.coupleIslands.get(accepted.island.id), objects = await db.coupleIslandObjects.where("islandId").equals(accepted.island.id).toArray();
    expect(island).toMatchObject({ status: "active", heartShells: 20, level: 1 });
    expect(objects).toHaveLength(3);
    expect(objects.find(item => item.catalogId === "first-seed")?.location).toBe("inventory");
    expect(await db.messages.where("conversationId").equals(conv.id).filter(message => message.id === `couple-island-response:${first.message.id}`).count()).toBe(1);
  });

  it("forces acceptance outside strategy mode and enforces a 24 hour retry after a strategy decline", async () => {
    const ordinary = await seedPair("ordinary", false), ordinaryInvite = await createCoupleIslandInvitation({ conversationId: ordinary.conv.id, characterId: ordinary.ch.id });
    expect((await respondCoupleIslandInvitation(ordinaryInvite.message.id, "decline", "no"))?.decision).toBe("accept");
    const strategic = await seedPair("strategic", true), strategicInvite = await createCoupleIslandInvitation({ conversationId: strategic.conv.id, characterId: strategic.ch.id });
    const declined = await respondCoupleIslandInvitation(strategicInvite.message.id, "decline", "later");
    expect(declined?.decision).toBe("decline");
    expect(declined?.island).toBeUndefined();
    expect(await db.coupleIslands.where("characterId").equals(strategic.ch.id).count()).toBe(0);
    expect((await db.messages.get(`couple-island-response:${strategicInvite.message.id}`))?.senderType).toBe("character");
    await expect(createCoupleIslandInvitation({ conversationId: strategic.conv.id, characterId: strategic.ch.id })).rejects.toThrow("24");
    const declinedMessage = await db.messages.get(strategicInvite.message.id);
    await db.messages.update(strategicInvite.message.id, { attachments: declinedMessage?.attachments?.map(item => item.type === "couple-island-invitation" ? { ...item, processedAt: Date.now() - ISLAND_INVITE_RETRY_MS - 1 } : item) });
    const retry = await createCoupleIslandInvitation({ conversationId: strategic.conv.id, characterId: strategic.ch.id });
    expect(retry.message.id).not.toBe(strategicInvite.message.id);
  });

  it("requires friendship before creating an invitation", async () => {
    const { ch, conv } = await seedPair("stranger");
    await db.characters.update(ch.id, { contactState: { status: "not-added" } });
    await expect(createCoupleIslandInvitation({ conversationId: conv.id, characterId: ch.id })).rejects.toThrow("好友");
    expect(await db.messages.where("conversationId").equals(conv.id).count()).toBe(0);
  });

  it("keeps character islands, rewards, entries, and action ids isolated", async () => {
    const first = await activeIsland("first"), second = await activeIsland("second");
    await recordCoupleIslandReward({ characterId: first.ch.id, sourceId: "event:first", type: "milestone", summary: "first only", heartShells: 5, experience: 10 });
    expect((await db.coupleIslands.get(first.island.id))?.heartShells).toBe(25);
    expect((await db.coupleIslands.get(second.island.id))?.heartShells).toBe(20);
    expect(await db.memories.where("characterId").equals(first.ch.id).filter(memory => memory.sourceIds?.includes("event:first") ?? false).count()).toBe(1);
    expect(await db.memories.where("characterId").equals(second.ch.id).count()).toBe(0);
    const foreign = (await db.coupleIslandObjects.where("islandId").equals(second.island.id).first())!;
    const result = await executeCharacterIslandAction({ conversationId: first.conv.id, characterId: first.ch.id, action: { type: "water-plant", objectId: foreign.id } });
    expect(result).toMatchObject({ executed: false, reason: "对象不属于当前岛屿" });
  });

  it("deduplicates rewards and caps ordinary chat rewards per day", async () => {
    const { ch, conv, island } = await activeIsland();
    await recordCoupleIslandReward({ characterId: ch.id, conversationId: conv.id, sourceId: "same", type: "gift", summary: "gift", heartShells: 4, experience: 8 });
    await recordCoupleIslandReward({ characterId: ch.id, conversationId: conv.id, sourceId: "same", type: "gift", summary: "gift", heartShells: 4, experience: 8 });
    for (let index = 0; index < ISLAND_CHAT_DAILY_REWARD_LIMIT + 2; index++) await rewardIslandChat(conv.id, ch.id, `message-${index}`);
    const saved = await db.coupleIslands.get(island.id);
    expect(saved?.heartShells).toBe(20 + 4 + ISLAND_CHAT_DAILY_REWARD_LIMIT * 2);
    expect(await db.coupleIslandEvents.where("sourceId").equals("same").count()).toBe(1);
    expect(await db.coupleIslandEvents.where("islandId").equals(island.id).filter(event => event.type === "chat").count()).toBe(ISLAND_CHAT_DAILY_REWARD_LIMIT);
  });

  it("completes wishes once, enforces shop levels, and keeps plants and pets pressure-free", async () => {
    const { island } = await activeIsland();
    const wish = await addIslandEntry({ islandId: island.id, kind: "wish", authorType: "user", text: "watch sunrise" });
    await completeIslandWish(wish.id); await completeIslandWish(wish.id);
    expect((await db.coupleIslandEntries.get(wish.id))?.state).toBe("completed");
    expect(await db.coupleIslandEvents.where("sourceId").equals(`wish:${wish.id}`).count()).toBe(1);
    await expect(buyIslandCatalogItem(island.id, "hydrangea")).rejects.toThrow("2");
    await db.coupleIslands.update(island.id, { level: 4, heartShells: 200 });
    const plant = await buyIslandCatalogItem(island.id, "hydrangea"), pet = await buyIslandCatalogItem(island.id, "cat-companion");
    expect((await waterIslandPlant(plant.id)).executed).toBe(true);
    expect((await waterIslandPlant(plant.id)).executed).toBe(false);
    for (let index = 0; index < 60; index++) await interactIslandPet(pet.id, "play");
    expect(Number((await db.coupleIslandObjects.get(pet.id))?.state?.bond)).toBe(100);
    expect(await db.coupleIslandObjects.get(pet.id)).toBeTruthy();
  });

  it("archives as read-only, restores intact state, and cascades data only on character deletion", async () => {
    const { ch, island } = await activeIsland();
    const entry = await addIslandEntry({ islandId: island.id, kind: "diary", authorType: "user", text: "kept" });
    await archiveCoupleIsland(island.id);
    await expect(addIslandEntry({ islandId: island.id, kind: "diary", authorType: "user", text: "blocked" })).rejects.toThrow();
    expect(await db.coupleIslandEntries.get(entry.id)).toBeTruthy();
    await restoreCoupleIsland(island.id);
    expect((await db.coupleIslands.get(island.id))?.status).toBe("active");
    await deleteCoupleIslandDataForCharacter(ch.id);
    expect(await db.coupleIslands.get(island.id)).toBeUndefined();
    expect(await db.coupleIslandEntries.where("islandId").equals(island.id).count()).toBe(0);
    expect(await db.coupleIslandObjects.where("islandId").equals(island.id).count()).toBe(0);
  });

  it("schedules first-open AI work at the cooldown boundary instead of dropping it early", async () => {
    const { island } = await activeIsland();
    const lastAiActionAt = Date.now();
    await db.coupleIslands.update(island.id, { lastAiActionAt });
    const task = await scheduleCoupleIslandUpdate(island.id, "new-event");
    expect(task?.scheduledAt).toBe(lastAiActionAt + ISLAND_AI_COOLDOWN_MS);
  });
  it("rejects repeated character diary candidates without touching user entries",()=>{const previous=[{text:"A quiet morning by the sea, we watched the light change."}];expect(diarySimilarity(previous[0].text,previous[0].text)).toBe(1);expect(isRepeatedCharacterDiary("A quiet morning by the sea, we watched the light change.",previous)).toBe(true);expect(isRepeatedCharacterDiary("We repaired the old lamp together and laughed at the rain.",previous)).toBe(false)});
  it("regenerates one repeated automatic diary and saves only the distinct candidate", async () => {
    const { island } = await activeIsland();
    const repeated = "A quiet morning by the sea, we watched the light change.";
    const distinct = "We repaired the old lamp together and laughed when the rain began.";
    await addIslandEntry({ islandId: island.id, kind: "diary", authorType: "character", text: repeated });
    const chat = vi.spyOn(OpenAIProvider.prototype, "chat")
      .mockResolvedValueOnce(JSON.stringify({ kind: "diary", text: repeated }))
      .mockResolvedValueOnce(JSON.stringify({ kind: "diary", text: distinct }));
    const saved = await runCoupleIslandUpdate(island.id, { ...defaultProvider, apiKey: "test" });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(saved?.text).toBe(distinct);
    const diaries = await db.coupleIslandEntries.where("islandId").equals(island.id).filter((entry) => entry.kind === "diary" && entry.authorType === "character").toArray();
    expect(diaries.map((entry) => entry.text).sort()).toEqual([repeated, distinct].sort());
  });

  it("skips automatic diary persistence after two repeated candidates", async () => {
    const { island } = await activeIsland();
    const repeated = "A quiet morning by the sea, we watched the light change.";
    await addIslandEntry({ islandId: island.id, kind: "diary", authorType: "character", text: repeated });
    const chat = vi.spyOn(OpenAIProvider.prototype, "chat")
      .mockResolvedValue(JSON.stringify({ kind: "diary", text: repeated }));
    const saved = await runCoupleIslandUpdate(island.id, { ...defaultProvider, apiKey: "test" });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(saved).toBeUndefined();
    const diaries = await db.coupleIslandEntries.where("islandId").equals(island.id).filter((entry) => entry.kind === "diary" && entry.authorType === "character").toArray();
    expect(diaries.map((entry) => entry.text)).toEqual([repeated]);
  });

});
