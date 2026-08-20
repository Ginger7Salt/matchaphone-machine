import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db";
import { saveModelServiceSettings } from "./modelServices";
import {
  shouldTranslateLanguage,
  translateChatMessage,
  translationSourceHash,
} from "./chatTranslation";
import {
  defaultModelServiceSettings,
  defaultProvider,
  SCHEMA_VERSION,
  type Character,
  type Conversation,
  type Message,
} from "./types";

const time = 1_700_000_000_000;
const character = {
  id: "character",
  schemaVersion: SCHEMA_VERSION,
  createdAt: time,
  updatedAt: time,
  name: "Actor",
  avatar: "",
  bio: "",
  personality: "independent",
  speakingStyle: "natural",
  background: "",
  language: "English",
  coreSetting: "actor",
  persona: "actor",
  proactive: {
    messages: false,
    timeAware: false,
    frequency: "low",
    quietStart: "23:00",
    quietEnd: "08:00",
    catchupLimit: 0,
    dailyLimit: 0,
  },
  relationship: { intimacy: 0, trust: 0, mood: "calm", recentEvents: [] },
  lastActiveAt: time,
} as Character;
const conversation = {
  id: "conversation",
  schemaVersion: SCHEMA_VERSION,
  createdAt: time,
  updatedAt: time,
  title: "chat",
  type: "private",
  memberIds: [character.id],
  presetIds: [],
  loreBookIds: [],
  lastActivityAt: time,
  chatSettings: {
    bubbleStyle: "inherit",
    characterAvatarSize: 36,
    fontScale: 92,
    autoTranslate: true,
  },
} as Conversation;
const message = {
  id: "message",
  schemaVersion: SCHEMA_VERSION,
  createdAt: time,
  updatedAt: time,
  conversationId: conversation.id,
  senderType: "character",
  senderId: character.id,
  content: "I missed you.",
  status: "complete",
} as Message;
const response = (translation: string) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              translations: [{ id: message.id, text: translation }],
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

describe("chat translation", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.characters.add(character);
    await db.conversations.add(conversation);
    await db.messages.add(message);
    await saveModelServiceSettings(defaultModelServiceSettings);
  });
  it("only enables automatic translation for supported non-Chinese languages", () => {
    expect(shouldTranslateLanguage("English")).toBe(true);
    expect(shouldTranslateLanguage("\u65e5\u672c\u8a9e")).toBe(true);
    expect(shouldTranslateLanguage("\u4e2d\u6587")).toBe(false);
    expect(shouldTranslateLanguage("\u7ca4\u8bed")).toBe(true);
  });
  it("uses the configured secondary provider and persists the translated layout data", async () => {
    await saveModelServiceSettings({
      ...defaultModelServiceSettings,
      secondary: {
        enabled: true,
        provider: {
          ...defaultProvider, networkMode: "direct" as const,
          baseUrl: "https://secondary.test/v1",
          apiKey: "secondary-key",
          model: "translator",
        },
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(response("translated"));
    vi.stubGlobal("fetch", fetchMock);
    await translateChatMessage({
      messageId: message.id,
      character,
      conversation,
      primaryProvider: {
        ...defaultProvider, networkMode: "direct" as const,
        apiKey: "main-key",
        model: "main",
      },
    });
    const saved = await db.messages.get(message.id);
    expect(saved?.translation).toMatchObject({
      status: "complete",
      text: "translated",
      model: "translator",
      sourceHash: translationSourceHash(message),
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("secondary.test");
  });
  it("falls back to the conversation primary provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("translated"));
    vi.stubGlobal("fetch", fetchMock);
    await translateChatMessage({
      messageId: message.id,
      character,
      conversation,
      primaryProvider: {
        ...defaultProvider, networkMode: "direct" as const,
        baseUrl: "https://conversation.test/v1",
        apiKey: "main-key",
        model: "conversation-model",
      },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("conversation.test");
    expect((await db.messages.get(message.id))?.translation?.model).toBe(
      "conversation-model",
    );
  });
  it("invalidates a translation when the source changes and retries only when forced", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response("old translation"))
        .mockResolvedValueOnce(response("new translation")),
    );
    const primary = { ...defaultProvider, networkMode: "direct" as const, apiKey: "key", model: "main" };
    await translateChatMessage({
      messageId: message.id,
      character,
      conversation,
      primaryProvider: primary,
    });
    await db.messages.update(message.id, {
      content: "I found you.",
      updatedAt: time + 1,
    });
    await translateChatMessage({
      messageId: message.id,
      character,
      conversation,
      primaryProvider: primary,
    });
    const saved = await db.messages.get(message.id);
    expect(saved?.translation?.text).toBe("new translation");
    expect(saved?.translation?.sourceHash).toBe(translationSourceHash(saved!));
  });
  it("keeps the original message complete when translation fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await translateChatMessage({
      messageId: message.id,
      character,
      conversation,
      primaryProvider: { ...defaultProvider, networkMode: "direct" as const, apiKey: "key" },
    });
    const saved = await db.messages.get(message.id);
    expect(saved).toMatchObject({
      content: "I missed you.",
      status: "complete",
      translation: { status: "error" },
    });
  });
});
