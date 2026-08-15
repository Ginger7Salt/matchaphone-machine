import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, setSetting } from "./db";
import { saveProviderPreset } from "./providerPresets";
import {
  claimNextChatReplyTask,
  enqueueChatReply,
  ensureRunnableChatReplyTask,
  processChatReplyTask,
  retryChatReply,
  stopChatReply,
} from "./chatReplyTasks";
import {
  SCHEMA_VERSION,
  type Character,
  type Conversation,
  type Message,
  type ProviderSettings,
} from "./types";

const t = 1_700_000_000_000;
const character = {
  id: "c1",
  schemaVersion: SCHEMA_VERSION,
  createdAt: t,
  updatedAt: t,
  name: "\u89d2\u8272",
  avatar: "",
  bio: "",
  personality: "\u72ec\u7acb",
  speakingStyle: "\u7b80\u77ed",
  background: "",
  language: "\u4e2d\u6587",
  coreSetting: "\u6838\u5fc3",
  persona: "\u4eba\u8bbe",
  proactive: {
    messages: false,
    timeAware: false,
    frequency: "low",
    quietStart: "23:00",
    quietEnd: "08:00",
    catchupLimit: 0,
    dailyLimit: 0,
  },
  relationship: {
    intimacy: 0,
    trust: 0,
    mood: "\u5e73\u9759",
    recentEvents: [],
  },
  lastActiveAt: t,
} as Character;
const privateConversation = {
  id: "p1",
  schemaVersion: SCHEMA_VERSION,
  createdAt: t,
  updatedAt: t,
  type: "private",
  title: "",
  memberIds: [character.id],
  lastActivityAt: t,
} as Conversation;
const groupConversation = {
  ...privateConversation,
  id: "g1",
  type: "group",
  title: "\u7fa4\u804a",
} as Conversation;
const provider: ProviderSettings = {
  baseUrl: "https://example.com/v1",
  apiKey: "test-key",
  model: "test-model",
  stream: false,
  temperature: 0.8,
  maxTokens: 800,
  contextLimit: 30,
  timeoutMs: 60_000,
};

describe("persistent chat reply tasks", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await setSetting("provider", provider);
    await db.characters.add(character);
  });
  it("atomically creates one placeholder and deduplicates an unfinished conversation task", async () => {
    await db.conversations.add(privateConversation);
    const first = await enqueueChatReply({
        conversationId: privateConversation.id,
        mode: "private",
      }),
      second = await enqueueChatReply({
        conversationId: privateConversation.id,
        mode: "private",
      });
    expect(second.id).toBe(first.id);
    const rows = await db.messages
      .where("conversationId")
      .equals(privateConversation.id)
      .toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("generating");
    expect(rows[0].generation?.taskEventId).toBe(first.eventId);
  });
  it("persists private and per-speaker group bubble targets across task recovery", async () => {
    await db.conversations.bulkAdd([privateConversation, groupConversation]);
    const privateTask = await enqueueChatReply({ conversationId: privateConversation.id, mode: "private" });
    const privateTarget = (privateTask.payload as any).targetBubbleCount;
    expect(privateTarget).toBeTypeOf("number");
    await db.backgroundTasks.update(privateTask.id, { state: "running", leaseExpiresAt: 1 });
    const recoveredPrivate = await ensureRunnableChatReplyTask({ conversationId: privateConversation.id, mode: "private" });
    expect((recoveredPrivate.task.payload as any).targetBubbleCount).toBe(privateTarget);

    const groupTask = await enqueueChatReply({ conversationId: groupConversation.id, mode: "group", speakerOrder: [character.id] });
    const groupTargets = (groupTask.payload as any).targetBubbleCounts;
    expect(groupTargets).toEqual({ [character.id]: expect.any(Number) });
    await db.backgroundTasks.update(groupTask.id, { state: "running", leaseExpiresAt: 1 });
    const recoveredGroup = await ensureRunnableChatReplyTask({ conversationId: groupConversation.id, mode: "group", speakerOrder: [character.id] });
    expect((recoveredGroup.task.payload as any).targetBubbleCounts).toEqual(groupTargets);
  });
  it("requeues a permanently failed task when the user generates again", async () => {
    await db.conversations.add(privateConversation);
    const first = await enqueueChatReply({ conversationId: privateConversation.id, mode: "private" });
    const payload = first.payload as any;
    await db.backgroundTasks.update(first.id, {
      state: "failed",
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
      lastError: "old failure",
    });
    await db.messages.update(payload.outputMessageId, { status: "error" });
    const result = await ensureRunnableChatReplyTask({ conversationId: privateConversation.id, mode: "private" });
    expect(result.action).toBe("requeued");
    expect(result.task).toMatchObject({ id: first.id, state: "pending" });
    expect(result.task.attempts).toBe(0);
    expect((result.task.payload as any).generationCycle).toBe(2);
    expect((result.task.payload as any).providerCallCount).toBe(0);
    expect(result.task.nextAttemptAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect((await db.messages.get(payload.outputMessageId))?.status).toBe("generating");
  });
  it("recovers an expired running task without creating a duplicate", async () => {
    await db.conversations.add(privateConversation);
    const first = await enqueueChatReply({ conversationId: privateConversation.id, mode: "private" });
    const originalPayload = first.payload as any;
    await db.backgroundTasks.update(first.id, {
      state: "running",
      leaseExpiresAt: 1,
      payload: {
        ...originalPayload,
        providerCallCount: 1,
        providerCallTrace: [{ ordinal: 1, purpose: "generation", state: "failed", providerCode: "transport_truncated" }],
      },
    });
    const result = await ensureRunnableChatReplyTask({ conversationId: privateConversation.id, mode: "private" });
    expect(result.action).toBe("requeued");
    expect(result.task).toMatchObject({ id: first.id, state: "pending" });
    expect((result.task.payload as any).generationCycle).toBe(originalPayload.generationCycle);
    expect((result.task.payload as any).providerCallCount).toBe(1);
    expect((result.task.payload as any).providerCallTrace).toHaveLength(1);
    expect(await db.backgroundTasks.where("conversationId").equals(privateConversation.id).count()).toBe(1);
  });
  it("keeps a running task with a valid lease", async () => {
    await db.conversations.add(privateConversation);
    const first = await enqueueChatReply({ conversationId: privateConversation.id, mode: "private" });
    await db.backgroundTasks.update(first.id, { state: "running", leaseExpiresAt: Date.now() + 60_000 });
    const result = await ensureRunnableChatReplyTask({ conversationId: privateConversation.id, mode: "private" });
    expect(result.action).toBe("reused");
    expect(result.task).toMatchObject({ id: first.id, state: "running" });
  });
  it("replaces a task whose placeholder is missing", async () => {
    await db.conversations.add(privateConversation);
    const first = await enqueueChatReply({ conversationId: privateConversation.id, mode: "private" });
    await db.messages.delete((first.payload as any).outputMessageId);
    const result = await ensureRunnableChatReplyTask({ conversationId: privateConversation.id, mode: "private" });
    expect(result.action).toBe("recovered");
    expect(result.task.id).not.toBe(first.id);
    expect((await db.backgroundTasks.get(first.id))?.state).toBe("completed");
    expect(await db.messages.get(result.placeholder.id)).toBeTruthy();
  });
  it("replaces malformed and cancelled tasks", async () => {
    await db.conversations.add(privateConversation);
    const malformed = await enqueueChatReply({ conversationId: privateConversation.id, mode: "private" });
    await db.backgroundTasks.update(malformed.id, { payload: { cancelled: true } });
    const result = await ensureRunnableChatReplyTask({ conversationId: privateConversation.id, mode: "private" });
    expect(result.action).toBe("recovered");
    expect(result.task.id).not.toBe(malformed.id);
    expect((await db.backgroundTasks.get(malformed.id))?.state).toBe("completed");
  });
  it("stopping a new reply removes only its unfinished placeholder", async () => {
    await db.conversations.add(privateConversation);
    await enqueueChatReply({
      conversationId: privateConversation.id,
      mode: "private",
    });
    await stopChatReply(privateConversation.id);
    expect(
      await db.messages
        .where("conversationId")
        .equals(privateConversation.id)
        .count(),
    ).toBe(0);
    expect((await db.backgroundTasks.toArray())[0].state).toBe("completed");
  });
  it("stopping private regeneration restores the original message", async () => {
    await db.conversations.add(privateConversation);
    const original = {
      id: "m1",
      schemaVersion: SCHEMA_VERSION,
      createdAt: t + 1,
      updatedAt: t + 1,
      conversationId: privateConversation.id,
      senderType: "character",
      senderId: character.id,
      content: "original",
      status: "complete",
    } as Message;
    await db.messages.add(original);
    await enqueueChatReply({
      conversationId: privateConversation.id,
      mode: "private",
      targetMessageId: original.id,
    });
    expect((await db.messages.get(original.id))?.content).toBe("");
    await stopChatReply(privateConversation.id);
    expect(await db.messages.get(original.id)).toMatchObject({
      content: "original",
      status: "complete",
    });
  });
  it("stopping private regeneration restores every bubble in the original speaker turn", async () => {
    await db.conversations.add(privateConversation);
    const base = {
        schemaVersion: SCHEMA_VERSION,
        conversationId: privateConversation.id,
        senderType: "character",
        senderId: character.id,
        status: "complete",
        generation: {
          model: "m",
          temperature: 0.8,
          stream: false,
          roundId: "r",
          speakerTurnId: "private-turn",
        },
      } as const,
      rows = [
        {
          ...base,
          id: "pm1",
          createdAt: t + 1,
          updatedAt: t + 1,
          content: "one",
          generation: { ...base.generation, segmentIndex: 0 },
        },
        {
          ...base,
          id: "pm2",
          createdAt: t + 2,
          updatedAt: t + 2,
          content: "two",
          generation: { ...base.generation, segmentIndex: 1 },
        },
      ] as Message[];
    await db.messages.bulkAdd(rows);
    await enqueueChatReply({
      conversationId: privateConversation.id,
      mode: "private",
      targetMessageId: "pm2",
    });
    expect(
      await db.messages
        .where("conversationId")
        .equals(privateConversation.id)
        .count(),
    ).toBe(1);
    await stopChatReply(privateConversation.id);
    const restored = await db.messages
      .where("conversationId")
      .equals(privateConversation.id)
      .sortBy("createdAt");
    expect(restored.map((message) => message.content)).toEqual(["one", "two"]);
  });
  it("stopping group regeneration restores every segment in the original speaker turn", async () => {
    await db.conversations.add(groupConversation);
    const base = {
        schemaVersion: SCHEMA_VERSION,
        conversationId: groupConversation.id,
        senderType: "character",
        senderId: character.id,
        status: "complete",
        generation: {
          model: "m",
          temperature: 0.8,
          stream: false,
          roundId: "r",
          speakerTurnId: "turn",
        },
      } as const,
      rows = [
        {
          ...base,
          id: "gm1",
          createdAt: t + 1,
          updatedAt: t + 1,
          content: "one",
          generation: { ...base.generation, segmentIndex: 0 },
        },
        {
          ...base,
          id: "gm2",
          createdAt: t + 2,
          updatedAt: t + 2,
          content: "two",
          generation: { ...base.generation, segmentIndex: 1 },
        },
      ] as Message[];
    await db.messages.bulkAdd(rows);
    await enqueueChatReply({
      conversationId: groupConversation.id,
      mode: "group",
      targetMessageId: "gm2",
      speakerOrder: [character.id],
    });
    expect(
      await db.messages
        .where("conversationId")
        .equals(groupConversation.id)
        .count(),
    ).toBe(1);
    await stopChatReply(groupConversation.id);
    const restored = await db.messages
      .where("conversationId")
      .equals(groupConversation.id)
      .sortBy("createdAt");
    expect(restored.map((message) => message.content)).toEqual(["one", "two"]);
  });
  it("persists a missing API configuration with guidance", async () => {
    await setSetting("provider", { ...provider, apiKey: "" });
    await db.conversations.add(privateConversation);
    const queued = await enqueueChatReply({
        conversationId: privateConversation.id,
        mode: "private",
      }),
      claimed = await claimNextChatReplyTask();
    expect(claimed?.id).toBe(queued.id);
    await processChatReplyTask(claimed!);
    const message = (await db.messages
      .where("conversationId")
      .equals(privateConversation.id)
      .first())!;
    expect(message.status).toBe("error");
    expect(message.generation?.apiError).toMatchObject({
      source: "api",
      kind: "auth",
      providerCode: "config_missing",
    });
    expect(
      message.generation?.apiError?.troubleshooting.length,
    ).toBeGreaterThan(1);
  });
  it("persists provider codes and clears them when the user retries", async () => {
    await db.conversations.add(privateConversation);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "No access",
              code: "invalid_api_key",
              type: "authentication_error",
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const queued = await enqueueChatReply({
        conversationId: privateConversation.id,
        mode: "private",
      }),
      claimed = await claimNextChatReplyTask();
    await processChatReplyTask(claimed!);
    let message = (await db.messages
      .where("conversationId")
      .equals(privateConversation.id)
      .first())!;
    expect(message.status).toBe("error");
    expect(message.generation?.apiError).toMatchObject({
      httpStatus: 401,
      providerCode: "invalid_api_key",
      providerType: "authentication_error",
    });
    const task = await db.backgroundTasks.get(queued.id);
    expect((task?.payload as any).lastApiError?.providerCode).toBe(
      "invalid_api_key",
    );
    await retryChatReply(queued.eventId);
    const retriedTask = await db.backgroundTasks.get(queued.id);
    expect(retriedTask?.attempts).toBe(0);
    expect((retriedTask?.payload as any).generationCycle).toBe(2);
    expect((retriedTask?.payload as any).providerCallCount).toBe(0);
    message = (await db.messages.get(message.id))!;
    expect(message.status).toBe("generating");
    expect(message.generation?.apiError).toBeUndefined();
  });

  it("uses the complete conversation preset for a persisted reply task", async () => {
    const saved = await saveProviderPreset({
        name: "conversation",
        provider: {
          ...provider,
          baseUrl: "https://conversation.test/v1",
          apiKey: "conversation-key",
          model: "conversation-model",
        },
        activate: false,
      }),
      conversation = {
        ...privateConversation,
        id: "preset-conversation",
        chatSettings: {
          bubbleStyle: "inherit",
          characterAvatarSize: 36,
          fontScale: 92,
          providerPresetId: saved.preset.id,
          autoTranslate: true,
        },
      } as Conversation;
    await db.conversations.add(conversation);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  messages: [{ content: "hello" }, { content: "again" }],
                  innerVoice: {
                    sections: {
                      physicalState: "呼吸平稳，手指微微放松。",
                      emotionAndMind: "我在谨慎判断这句话是否自然。",
                      unspokenWords: "希望你能听懂我的认真。",
                      selfDeception: "我告诉自己这只是普通寒暄。",
                      triggeredMemory: "此刻没有被触发的具体回忆",
                      angelThought: "慢一点表达，不要给对方压力。",
                      devilThought: "直接把所有情绪都说出来。",
                    },
                    continuity: { emotion: "谨慎" },
                  },
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const queued = await enqueueChatReply({
        conversationId: conversation.id,
        mode: "private",
      }),
      placeholder = await db.messages.get(queued.entityId);
    expect(placeholder?.generation?.model).toBe("conversation-model");
    const claimed = await claimNextChatReplyTask();
    await processChatReplyTask(claimed!);
    expect(((await db.backgroundTasks.get(queued.id))?.payload as any).providerCallCount).toBe(1);
    const completed = await db.messages.get(queued.entityId),
      completedRows = await db.messages
        .where("conversationId")
        .equals(conversation.id)
        .sortBy("createdAt");
    expect(completed).toMatchObject({
      content: "hello",
      status: "complete",
      generation: { model: "conversation-model", segmentIndex: 0 },
      innerVoice: {
        sections: { unspokenWords: "希望你能听懂我的认真。" },
      },
    });
    expect(completedRows.map((message) => message.content)).toEqual([
      "hello",
      "again",
    ]);
    expect(
      new Set(completedRows.map((message) => message.generation?.speakerTurnId))
        .size,
    ).toBe(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("conversation.test");
  });
});

describe("mounted reply stickers", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.delete();
    await db.open();
    await setSetting("provider", provider);
    await db.characters.add(character);
    await db.stickerPacks.add({
      id: "pack",
      schemaVersion: SCHEMA_VERSION,
      createdAt: t,
      updatedAt: t,
      name: "角色可用",
      order: 0,
      stickers: [
        {
          id: "sticker-real",
          source: "url",
          url: "https://example.com/sticker.png",
          name: "无语",
          description: "无语地看着你",
          order: 0,
        },
      ],
    });
  });

  const modelTurn = (stickerId: string) =>
    JSON.stringify({
      messages: [{ content: "好吧" }, { content: "我知道了" }],
      stickerId,
      innerVoice: {
        sections: {
          physicalState: "呼吸平稳。",
          emotionAndMind: "有一点无奈。",
          unspokenWords: "你应该懂。",
          selfDeception: "我没有在意。",
          triggeredMemory: "没有具体回忆。",
          angelThought: "温和一点。",
          devilThought: "瞪他一眼。",
        },
        continuity: { emotion: "无奈" },
      },
    });

  async function runStickerReply(stickerId: string) {
    const conversation: Conversation = {
      ...privateConversation,
      id: `sticker-${stickerId}`,
      chatSettings: {
        bubbleStyle: "inherit",
        characterAvatarSize: 36,
        fontScale: 92,
        permissions: {
          proactiveChatImage: false,
          proactiveVoiceCall: false,
          proactiveVideoCall: false,
          proactiveMeetInvitation: false,
          proactiveSticker: true,
        },
        proactiveStickerPackIds: ["pack"],
      },
    };
    await db.conversations.add(conversation);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: modelTurn(stickerId) } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    await enqueueChatReply({ conversationId: conversation.id, mode: "private" });
    const claimed = await claimNextChatReplyTask();
    await processChatReplyTask(claimed!);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return db.messages
      .where("conversationId")
      .equals(conversation.id)
      .sortBy("createdAt");
  }

  it("saves a validated mounted sticker after the text bubbles", async () => {
    const rows = await runStickerReply("sticker-real");
    expect(rows.map((row) => row.content)).toEqual(["好吧", "我知道了", "[表情包]"]);
    expect(rows[2]).toMatchObject({
      kind: "sticker",
      attachments: [
        {
          type: "sticker",
          stickerId: "sticker-real",
          description: "无语地看着你",
        },
      ],
    });
  });

  it("ignores an unmounted sticker id instead of falling back to the first sticker", async () => {
    const rows = await runStickerReply("not-mounted");
    expect(rows.map((row) => row.content)).toEqual(["好吧", "我知道了"]);
    expect(rows.some((row) => row.kind === "sticker")).toBe(false);
  });
});



describe("chat reply provider budget and lease fencing",()=>{
 beforeEach(async()=>{
  vi.restoreAllMocks();
  await db.delete();
  await db.open();
  await setSetting("provider",provider);
  await db.characters.add(character);
  await db.conversations.add(privateConversation);
 });
 it("never makes a third provider call after two malformed responses",async()=>{
  const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({id:"unknown",metadata:{shape:true}}),{status:200,headers:{"Content-Type":"application/json"}}));
  vi.stubGlobal("fetch",fetchMock);
  const queued=await enqueueChatReply({conversationId:privateConversation.id,mode:"private"});
  const claimed=await claimNextChatReplyTask();
  await processChatReplyTask(claimed!);
  const stored=await db.backgroundTasks.get(queued.id);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(stored?.state).toBe("failed");
  expect((stored?.payload as any).providerCallCount).toBe(2);
  expect((stored?.payload as any).providerCallTrace).toHaveLength(2);
  expect(await claimNextChatReplyTask()).toBeUndefined();
 });
 it("shares the two-call limit across automatic task resume",async()=>{
  const fetchMock=vi.fn().mockRejectedValue(new TypeError("offline"));
  vi.stubGlobal("fetch",fetchMock);
  const queued=await enqueueChatReply({conversationId:privateConversation.id,mode:"private"});
  await processChatReplyTask((await claimNextChatReplyTask())!);
  await db.backgroundTasks.update(queued.id,{nextAttemptAt:0});
  await processChatReplyTask((await claimNextChatReplyTask())!);
  const stored=await db.backgroundTasks.get(queued.id);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect((stored?.payload as any).providerCallCount).toBe(2);
  expect(stored?.nextAttemptAt).toBe(Number.MAX_SAFE_INTEGER);
  expect(await claimNextChatReplyTask()).toBeUndefined();
 });
 it("does not allow post-processing to make a third model call",async()=>{
  await db.characters.update(character.id,{chatSettings:{...(character.chatSettings as any),strategyMode:{enabled:true}} as any,updatedAt:t+1});
  await db.messages.add({id:"source",schemaVersion:SCHEMA_VERSION,createdAt:t+2,updatedAt:t+2,conversationId:privateConversation.id,senderType:"user",content:"hello",status:"complete"} as Message);
  const turn=JSON.stringify({messages:[{content:"\u4f60\u597d"}],innerVoice:{sections:{physicalState:"\u547c\u5438\u5e73\u7a33",emotionAndMind:"\u6b63\u5728\u601d\u8003",unspokenWords:"\u8fd8\u6709\u8bdd\u60f3\u8bf4",selfDeception:"\u5047\u88c5\u4e0d\u5728\u610f",triggeredMemory:"\u60f3\u8d77\u4e00\u4ef6\u5c0f\u4e8b",angelThought:"\u6e29\u548c\u4e00\u70b9",devilThought:"\u76f4\u63a5\u4e00\u70b9"},continuity:{emotion:"\u5e73\u9759"}}});
  const fetchMock=vi.fn()
   .mockResolvedValueOnce(new Response(JSON.stringify({id:"unknown"}),{status:200,headers:{"Content-Type":"application/json"}}))
   .mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:turn}}]}),{status:200,headers:{"Content-Type":"application/json"}}))
   .mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:'{"intimacyDelta":0,"trustDelta":0,"reason":"ok"}'}}]}),{status:200,headers:{"Content-Type":"application/json"}}));
  vi.stubGlobal("fetch",fetchMock);
  const queued=await enqueueChatReply({conversationId:privateConversation.id,mode:"private"});
  await processChatReplyTask((await claimNextChatReplyTask())!);
  await new Promise(resolve=>setTimeout(resolve,100));
  const stored=await db.backgroundTasks.get(queued.id);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect((stored?.payload as any).providerCallCount).toBe(2);
  expect(stored?.state).toBe("completed");
 });
  it("lazily preserves legacy group call usage without a Dexie migration", async () => {
    await db.conversations.add(groupConversation);
    const completeTurn = JSON.stringify({
      messages: [{ content: "你好" }, { content: "再说一句" }],
      innerVoice: {
        sections: {
          physicalState: "呼吸平稳",
          emotionAndMind: "正在思考",
          unspokenWords: "还有话想说",
          selfDeception: "假装不在意",
          triggeredMemory: "想起一件小事",
          angelThought: "温和一点",
          devilThought: "直接一点",
        },
        continuity: { emotion: "平静" },
      },
    });
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: completeTurn } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    vi.stubGlobal("fetch", fetchMock);
    const queued = await enqueueChatReply({
      conversationId: groupConversation.id,
      mode: "group",
      speakerOrder: [character.id],
    });
    const legacyPayload = { ...(queued.payload as any) };
    delete legacyPayload.groupProviderCallBudgets;
    legacyPayload.providerCallCount = 1;
    legacyPayload.providerCallTrace = [{
      ordinal: 1,
      purpose: "generation",
      state: "failed",
      errorKind: "network",
      providerCode: "network_error",
    }];
    await db.backgroundTasks.update(queued.id, { payload: legacyPayload });
    await processChatReplyTask((await claimNextChatReplyTask())!);
    const stored = await db.backgroundTasks.get(queued.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stored?.state).toBe("completed");
    expect((stored?.payload as any).groupProviderCallBudgets[character.id]).toMatchObject({
      providerCallCount: 2,
      state: "completed",
    });
    expect((stored?.payload as any).groupProviderCallBudgets[character.id].providerCallTrace).toHaveLength(2);
  });
  it("gives every group speaker an independent two-call budget", async () => {
    const character2 = { ...character, id: "c2", name: "角色二", createdAt: t + 1, updatedAt: t + 1 } as Character;
    const character3 = { ...character, id: "c3", name: "角色三", createdAt: t + 2, updatedAt: t + 2 } as Character;
    await db.characters.bulkAdd([character2, character3]);
    await db.conversations.add({ ...groupConversation, memberIds: [character.id, character2.id, character3.id] });
    const completeTurn = JSON.stringify({
      messages: [{ content: "你好" }, { content: "再说一句" }],
      innerVoice: {
        sections: {
          physicalState: "呼吸平稳",
          emotionAndMind: "正在思考",
          unspokenWords: "还有话想说",
          selfDeception: "假装不在意",
          triggeredMemory: "想起一件小事",
          angelThought: "温和一点",
          devilThought: "直接一点",
        },
        continuity: { emotion: "平静" },
      },
    });
    const response = (content: string) => new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response('{"messages":['))
      .mockImplementation(() => Promise.resolve(response(completeTurn)));
    vi.stubGlobal("fetch", fetchMock);
    const queued = await enqueueChatReply({
      conversationId: groupConversation.id,
      mode: "group",
      speakerOrder: [character.id, character2.id, character3.id],
    });
    await processChatReplyTask((await claimNextChatReplyTask())!);
    const stored = await db.backgroundTasks.get(queued.id);
    const budgets = (stored?.payload as any).groupProviderCallBudgets;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(stored?.state).toBe("completed");
    expect((stored?.payload as any).providerCallCount).toBe(0);
    expect(budgets[character.id]).toMatchObject({ providerCallLimit: 2, providerCallCount: 2, state: "completed" });
    expect(budgets[character2.id]).toMatchObject({ providerCallLimit: 2, providerCallCount: 1, state: "completed" });
    expect(budgets[character3.id]).toMatchObject({ providerCallLimit: 2, providerCallCount: 1, state: "completed" });
    expect(budgets[character.id].providerCallTrace).toHaveLength(2);
    expect(budgets[character2.id].providerCallTrace).toHaveLength(1);
    expect(budgets[character3.id].providerCallTrace).toHaveLength(1);
  });
  it("keeps completed group speakers and their budgets across automatic resume", async () => {
    const character2 = { ...character, id: "c2", name: "角色二", createdAt: t + 1, updatedAt: t + 1 } as Character;
    await db.characters.add(character2);
    await db.conversations.add({
      ...groupConversation,
      memberIds: [character.id, character2.id],
    });
    const completeTurn = JSON.stringify({
      messages: [{ content: "你好" }, { content: "再说一句" }],
      innerVoice: {
        sections: {
          physicalState: "呼吸平稳",
          emotionAndMind: "正在思考",
          unspokenWords: "还有话想说",
          selfDeception: "假装不在意",
          triggeredMemory: "想起一件小事",
          angelThought: "温和一点",
          devilThought: "直接一点",
        },
        continuity: { emotion: "平静" },
      },
    });
    const response = () => new Response(
      JSON.stringify({ choices: [{ message: { content: completeTurn } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(response()))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockImplementation(() => Promise.resolve(response()));
    vi.stubGlobal("fetch", fetchMock);
    const queued = await enqueueChatReply({
      conversationId: groupConversation.id,
      mode: "group",
      speakerOrder: [character.id, character2.id],
    });
    await processChatReplyTask((await claimNextChatReplyTask())!);
    let stored = await db.backgroundTasks.get(queued.id);
    expect(stored?.state).toBe("failed");
    expect((stored?.payload as any).nextSpeakerIndex).toBe(1);
    expect((stored?.payload as any).groupProviderCallBudgets[character.id]).toMatchObject({
      providerCallCount: 1,
      state: "completed",
    });
    const firstSpeakerIdsBeforeResume = (
      await db.messages.where("conversationId").equals(groupConversation.id).toArray()
    )
      .filter((message) => message.senderId === character.id)
      .map((message) => message.id)
      .sort();
    await db.backgroundTasks.update(queued.id, { nextAttemptAt: 0 });
    await processChatReplyTask((await claimNextChatReplyTask())!);
    stored = await db.backgroundTasks.get(queued.id);
    const budgets = (stored?.payload as any).groupProviderCallBudgets;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(stored?.state).toBe("completed");
    expect(budgets[character.id]).toMatchObject({ providerCallCount: 1, state: "completed" });
    expect(budgets[character2.id]).toMatchObject({ providerCallCount: 2, state: "completed" });
    const rows = await db.messages.where("conversationId").equals(groupConversation.id).toArray();
    const firstSpeakerRows = rows.filter((message) => message.senderId === character.id);
    const resumedSpeakerRows = rows.filter((message) => message.senderId === character2.id);
    expect(firstSpeakerRows.map((message) => message.id).sort()).toEqual(firstSpeakerIdsBeforeResume);
    expect(firstSpeakerRows.every((message) => message.status === "complete")).toBe(true);
    expect(resumedSpeakerRows.length).toBeGreaterThan(0);
    expect(resumedSpeakerRows.every((message) => message.status === "complete")).toBe(true);
  });
  it("rejects stale lease generations before they can call or save",async()=>{
  const turn=JSON.stringify({messages:[{content:"\u4f60\u597d"},{content:"\u518d\u8bf4\u4e00\u53e5"}],innerVoice:{sections:{physicalState:"\u547c\u5438\u5e73\u7a33",emotionAndMind:"\u6b63\u5728\u601d\u8003",unspokenWords:"\u8fd8\u6709\u8bdd\u60f3\u8bf4",selfDeception:"\u5047\u88c5\u4e0d\u5728\u610f",triggeredMemory:"\u60f3\u8d77\u4e00\u4ef6\u5c0f\u4e8b",angelThought:"\u6e29\u548c\u4e00\u70b9",devilThought:"\u76f4\u63a5\u4e00\u70b9"},continuity:{emotion:"\u5e73\u9759"}}});
  const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:turn}}]}),{status:200,headers:{"Content-Type":"application/json"}}));
  vi.stubGlobal("fetch",fetchMock);
  const queued=await enqueueChatReply({conversationId:privateConversation.id,mode:"private"});
  const stale=(await claimNextChatReplyTask())!;
  await db.backgroundTasks.update(queued.id,{leaseExpiresAt:0});
  const current=(await claimNextChatReplyTask())!;
  expect(current.leaseGeneration).toBeGreaterThan(stale.leaseGeneration??0);
  await processChatReplyTask(stale);
  expect(fetchMock).not.toHaveBeenCalled();
  await processChatReplyTask(current);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const stored=await db.backgroundTasks.get(queued.id);
  const reply=await db.messages.get(queued.entityId);
  expect(stored?.state).toBe("completed");
  expect(reply).toMatchObject({status:"complete",content:"\u4f60\u597d"});
  expect(reply?.innerVoice).toBeTruthy();
 });
});
