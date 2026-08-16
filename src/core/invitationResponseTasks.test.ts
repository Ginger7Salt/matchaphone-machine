import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, setSetting } from "./db";
import { createCoupleIslandInvitation } from "./coupleIsland";
import { createMusicInvitationMessage } from "./music";
import { claimNextChatReplyTask, processChatReplyTask } from "./chatReplyTasks";
import { isStandaloneInvitationCard } from "./messagePresentation";
import { SCHEMA_VERSION, type Character, type Conversation, type ProviderSettings } from "./types";

const timestamp = 1_700_000_000_000;
const provider: ProviderSettings = { baseUrl: "https://example.com/v1", apiKey: "test-key", model: "test-model", stream: false, temperature: 0.2, maxTokens: 800, contextLimit: 30, timeoutMs: 60_000 };
function character(id: string): Character {
  return { id, schemaVersion: SCHEMA_VERSION, createdAt: timestamp, updatedAt: timestamp, name: "茶茶", avatar: "", bio: "", personality: "温柔", speakingStyle: "自然", background: "", language: "中文", coreSetting: "", persona: "", proactive: { messages: false, timeAware: false, frequency: "low", quietStart: "23:00", quietEnd: "08:00", catchupLimit: 0, dailyLimit: 0 }, relationship: { intimacy: 10, trust: 10, mood: "平静", recentEvents: [] }, lastActiveAt: timestamp } as Character;
}
function conversation(id: string, characterId: string): Conversation { return { id, schemaVersion: SCHEMA_VERSION, createdAt: timestamp, updatedAt: timestamp, type: "private", title: "测试", memberIds: [characterId], lastActivityAt: timestamp } as Conversation; }
function compactReply(count: number) { return JSON.stringify({ d: { type: "accept" }, m: Array.from({ length: count }, (_, i) => ({ c: i ? "我也想和你一起。" : "好，我会认真回应这次邀请。" })), v: { s: { p: "呼吸平稳", e: "心里有些期待", u: "想和你多待一会儿", d: "假装不在意", r: "想起共同经历", a: "接受这份靠近", x: "害怕表现得太明显" }, q: { e: "期待" } } }); }

beforeEach(async () => { await db.delete(); await db.open(); await setSetting("provider", provider); });
﻿
describe("invitation response tasks", () => {
  it("creates a dedicated task without a normal chat placeholder and claims it", async () => {
    const ch = character("c1"), conv = conversation("conv1", ch.id); await db.characters.add(ch); await db.conversations.add(conv);
    const result = await createCoupleIslandInvitation({ conversationId: conv.id, characterId: ch.id });
    const task = await db.backgroundTasks.where("eventId").equals(`invitation-response:couple-island:${result.message.id}`).first();
    expect(task?.type).toBe("invitation-response");
    expect(await db.messages.where("conversationId").equals(conv.id).filter((row) => row.status === "generating").count()).toBe(0);
    expect(isStandaloneInvitationCard(result.message)).toBe(true);
    expect((await claimNextChatReplyTask())?.id).toBe(task?.id);
  });

  it("saves the response card before optional text and never creates a third call", async () => {
    const ch = character("c2"), conv = conversation("conv2", ch.id); await db.characters.add(ch); await db.conversations.add(conv);
    const result = await createCoupleIslandInvitation({ conversationId: conv.id, characterId: ch.id });
    const queued = await db.backgroundTasks.where("eventId").equals(`invitation-response:couple-island:${result.message.id}`).first();
    const count = (queued?.payload as { targetBubbleCount: number }).targetBubbleCount;
    let calls = 0; vi.stubGlobal("fetch", vi.fn(async () => { calls += 1; return new Response(JSON.stringify({ choices: [{ message: { content: compactReply(count) }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } }); }));
    const claimed = await claimNextChatReplyTask(); expect(claimed).toBeTruthy(); await processChatReplyTask(claimed!);
    expect(calls).toBe(1);
    expect(await db.messages.get(`couple-island-response:${result.message.id}`)).toMatchObject({ senderType: "character" });
    expect(await db.messages.where("conversationId").equals(conv.id).filter((row) => row.generation?.taskEventId === claimed!.eventId && row.status === "complete").count()).toBeGreaterThan(0);
    expect(await db.backgroundTasks.get(claimed!.id)).toMatchObject({ state: "completed" });
  });

  it("creates a standalone music response task for a user invitation", async () => {
    const ch = character("c3"), conv = conversation("conv3", ch.id); await db.characters.add(ch); await db.conversations.add(conv);
    const result = await createMusicInvitationMessage({ conversationId: conv.id, characterId: ch.id, invitedBy: "user" });
    expect(isStandaloneInvitationCard(result.message)).toBe(true);
    expect(await db.backgroundTasks.where("eventId").equals(`invitation-response:music:${result.message.id}`).count()).toBe(1);
  });
});
