
import { db } from "./db";
import type { Conversation, Message } from "./types";

export const MESSAGE_PAGE_SIZE = 80;
export const MESSAGE_WINDOW_LIMIT = 3;

export interface MessageCursor {
  createdAt: number;
  id: string;
}

export interface ConversationMessageSummary {
  conversationId: string;
  latestMessage?: Message;
  proactiveUnreadCount: number;
}

export interface ConversationMessageWindow {
  items: Message[];
  oldest?: MessageCursor;
  hasMore: boolean;
  loading: boolean;
  initialized: boolean;
}

const messageBounds = (conversationId: string) => ({
  lower: [conversationId, 0, ""] as [string, unknown, unknown],
  upper: [conversationId, Number.MAX_SAFE_INTEGER, "\uffff"] as [string, unknown, unknown],
});

export function compareMessages(left: Message, right: Message) {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

export function cursorOf(message: Message): MessageCursor {
  return { createdAt: message.createdAt, id: message.id };
}

export async function readConversationMessagePage(
  conversationId: string,
  cursor?: MessageCursor,
  limit = MESSAGE_PAGE_SIZE,
): Promise<{ items: Message[]; oldest?: MessageCursor; hasMore: boolean }> {
  const { lower, upper } = messageBounds(conversationId);
  const effectiveUpper = cursor
    ? ([conversationId, cursor.createdAt, cursor.id] as [string, number, string])
    : upper;
  const rows = await db.messages
    .where("[conversationId+createdAt+id]")
    .between(lower, effectiveUpper, true, !cursor)
    .reverse()
    .limit(limit + 1)
    .toArray();
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).sort(compareMessages);
  return { items, oldest: items[0] ? cursorOf(items[0]) : undefined, hasMore };
}

export async function readConversationLatestMessages(
  conversationId: string,
  limit: number,
) {
  return (await readConversationMessagePage(conversationId, undefined, limit)).items;
}

export async function readConversationSummaries(
  conversations: Pick<Conversation, "id">[],
): Promise<Record<string, ConversationMessageSummary>> {
  const [latestRows, proactiveRows] = await Promise.all([
    Promise.all(
      conversations.map(async ({ id }) => ({
        conversationId: id,
        latestMessage: (
          await db.messages
            .where("[conversationId+createdAt+id]")
            .between(
              [id, 0, ""],
              [id, Number.MAX_SAFE_INTEGER, "\uffff"],
              true,
              true,
            )
            .reverse()
            .first()
        ),
      })),
    ),
    db.messages.where("origin").equals("proactive").toArray(),
  ]);
  const unread = new Map<string, number>();
  for (const message of proactiveRows) {
    if (!message.readAt)
      unread.set(message.conversationId, (unread.get(message.conversationId) ?? 0) + 1);
  }
  return Object.fromEntries(
    latestRows.map((row) => [
      row.conversationId,
      { ...row, proactiveUnreadCount: unread.get(row.conversationId) ?? 0 },
    ]),
  );
}

export function mergeMessageItems(items: Message[], message: Message) {
  return [...items.filter((row) => row.id !== message.id), message].sort(compareMessages);
}
