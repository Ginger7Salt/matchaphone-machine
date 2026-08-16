import { replyBubblePlanOf } from "./replyBubbles";
import { SCHEMA_VERSION, uid, type BackgroundTask, type Character, type InvitationResponseTaskPayload, type InvitationResponseType, type Message } from "./types";

export function invitationResponseEventId(type: InvitationResponseType, messageId: string) {
  return `invitation-response:${type}:${messageId}`;
}
export function invitationResponseCardId(type: InvitationResponseType, messageId: string) {
  return type === "couple-island"
    ? `couple-island-response:${messageId}`
    : `music-invitation-response:${messageId}`;
}
export function invitationResponseTargetCount(character: Character, history: Message[]) {
  return replyBubblePlanOf(
    character,
    history.map((message) => ({
      role: (message.senderType === "user" ? "user" : "assistant") as "user" | "assistant",
      content: message.content,
    })),
    "private",
  ).targetCount;
}
export function invitationResponsePayload(input: {
  invitationType: InvitationResponseType;
  invitationMessageId: string;
  targetBubbleCount: number;
}): InvitationResponseTaskPayload {
  return {
    invitationType: input.invitationType,
    invitationMessageId: input.invitationMessageId,
    phase: "queued",
    generationCycle: 1,
    providerCallLimit: 2,
    providerCallCount: 0,
    providerCallTrace: [],
    targetBubbleCount: input.targetBubbleCount,
  };
}
export function invitationResponseTask(input: {
  invitationType: InvitationResponseType;
  invitationMessageId: string;
  conversationId: string;
  characterId: string;
  targetBubbleCount: number;
  createdAt?: number;
}): BackgroundTask {
  const at = input.createdAt ?? Date.now(), eventId = invitationResponseEventId(input.invitationType, input.invitationMessageId);
  return {
    id: uid(),
    schemaVersion: SCHEMA_VERSION,
    createdAt: at,
    updatedAt: at,
    type: "invitation-response",
    entityId: input.invitationMessageId,
    characterId: input.characterId,
    conversationId: input.conversationId,
    state: "pending",
    scheduledAt: at,
    nextAttemptAt: at,
    attempts: 0,
    eventId,
    payload: invitationResponsePayload(input),
  };
}
export function invitationResponseAttachmentUpdate<T extends { responseStatus?: "queued" | "deciding" | "failed"; responseTaskEventId?: string }>(attachment: T, task: BackgroundTask) {
  return { ...attachment, responseStatus: "queued" as const, responseTaskEventId: task.eventId };
}
