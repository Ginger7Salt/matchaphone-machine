import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db";
import { OpenAIProvider } from "./provider";
import { finishMeetSession, generateMeetTurn, refineMeetSessionSummary } from "./meetService";
import { defaultProvider, type Character, type Conversation, type MeetSession } from "./types";

const conversation: Conversation = {
  id: "conversation",
  schemaVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  title: "阿茶",
  type: "private",
  memberIds: ["character"],
  presetIds: [],
  loreBookIds: [],
  lastActivityAt: 1,
};

const character: Character = {
  id: "character",
  schemaVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  name: "阿茶",
  avatar: "",
  bio: "朋友",
  personality: "冷静",
  speakingStyle: "简短直接",
  background: "普通人",
  language: "中文",
  proactive: {
    messages: false,
    timeAware: false,
    frequency: "medium",
    quietStart: "23:00",
    quietEnd: "08:00",
    catchupLimit: 3,
    dailyLimit: 10,
  },
  memoryExtractionSettings: {
    enabled: true,
    mode: "auto",
    chatThreshold: 50,
    maxMemoriesPerBatch: 8,
    includeSummary: true,
    autoSaveHighConfidence: true,
    meetMemoryEnabled: true,
  },
  relationship: { intimacy: 10, trust: 10, mood: "平静", recentEvents: [] },
  lastActiveAt: 1,
};

function activeSession(): MeetSession {
  return {
    id: "meet",
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 20,
    conversationId: conversation.id,
    participantIds: [character.id],
    initiator: "user",
    scene: { opening: "在咖啡店见面", location: "咖啡店" },
    suggestionsEnabled: false,
    status: "active",
    entries: [
      {
        id: "opening",
        roundId: "round-1",
        senderType: "user",
        content: "我们聊周末的安排",
        createdAt: 1,
      },
    ],
    startedAt: 1,
    lastActivityAt: 20,
    modeBridge: {
      currentMode: "online-paused",
      switchedAt: 20,
      latestOnlineWindow: { startedAt: 20 },
    },
  };
}

describe("meet mode bridge service", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.characters.add(character);
    await db.conversations.add(conversation);
  });

  it("resumes a paused meet when the user submits a new offline turn", async () => {
    await db.meetSessions.add(activeSession());
    await db.settings.put({ key: "provider", value: { ...defaultProvider, networkMode: "direct", apiKey: "test-key", model: "test-model" } });
    vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockResolvedValue({
      text: JSON.stringify({ version: 1, segments: [{ type: "narration", text: "下午的咖啡店安静下来。" }, { type: "dialogue", characterId: "character", text: "那就下午见。" }] }),
      finishReason: "stop",
      truncated: false,
      responseShape: "choices",
      rawLength: 100,
      outputTokens: 20,
    });
    await db.messages.add({
      id: "online",
      schemaVersion: 1,
      createdAt: 21,
      updatedAt: 21,
      conversationId: conversation.id,
      senderType: "user",
      content: "周末改成下午吧",
      status: "complete",
    });
    const result = await generateMeetTurn("meet", "好，那就继续聊下午的安排");
    const saved = await db.meetSessions.get("meet");
    expect(result.entries.length).toBeGreaterThan(0);
    expect(saved?.modeBridge?.currentMode).toBe("meet");
    expect(saved?.modeBridge?.latestOnlineWindow?.endedAt).toBeTypeOf("number");
    expect(saved?.entries.some((entry) => entry.content === "好，那就继续聊下午的安排")).toBe(true);
  });

  it("ends immediately with a local summary and queues independent background work", async () => {
    await db.meetSessions.add(activeSession());
    const ended = await finishMeetSession("meet");
    expect(ended?.status).toBe("ended");
    expect(ended?.summary).toBeTruthy();
    expect(ended?.summaryMessageId).toBeTruthy();
    expect(ended?.modeBridge?.latestOnlineWindow?.endedAt).toBeTypeOf("number");
    const message = ended?.summaryMessageId
      ? await db.messages.get(ended.summaryMessageId)
      : undefined;
    expect(message?.content).toContain("见面结束：");
    expect(
      await db.backgroundTasks.where("eventId").equals("meet-summary:meet").first(),
    ).toMatchObject({ type: "meet-summary", state: "pending" });
    expect(
      await db.backgroundTasks.where("eventId").equals("meet-memory:meet:character").first(),
    ).toMatchObject({ type: "memory-extraction", state: "pending" });
  });

  it("keeps the local summary when refinement has no configured API", async () => {
    await db.meetSessions.add(activeSession());
    const ended = await finishMeetSession("meet");
    const local = ended?.summary;
    await expect(refineMeetSessionSummary("meet")).rejects.toThrow("API");
    expect((await db.meetSessions.get("meet"))?.summary).toBe(local);
  });
});
