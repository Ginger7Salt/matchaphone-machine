import { replyBubbleCountPlanOf } from "./replyBubbles";
import { SCHEMA_VERSION, uid, type BackgroundTask, type Character, type InvitationResponseTaskPayload, type InvitationResponseType, type Message, type ReplyBubbleCountPlan } from "./types";

export function invitationResponseEventId(type: InvitationResponseType, messageId: string) {
  return `invitation-response:${type}:${messageId}`;
}
export function invitationResponseCardId(type: InvitationResponseType, messageId: string) {
  return type === "couple-island"
    ? `couple-island-response:${messageId}`
    : `music-invitation-response:${messageId}`;
}
export function invitationResponseBubbleCountPlan(character: Character, history: Message[]) {
  return replyBubbleCountPlanOf(
    character,
    history.map((message) => ({
      role: (message.senderType === "user" ? "user" : "assistant") as "user" | "assistant",
      content: message.content,
    })),
    "private",
  );
}
export function invitationResponseTargetCount(character: Character, history: Message[]) {
  return invitationResponseBubbleCountPlan(character, history).preferred;
}
export function invitationResponsePayload(input: {
  invitationType: InvitationResponseType;
  invitationMessageId: string;
  targetBubbleCount: number;
  bubbleCountPlan?: ReplyBubbleCountPlan;
}): InvitationResponseTaskPayload {
  const bubbleCountPlan = input.bubbleCountPlan ?? {
    mode: "adaptive" as const,
    min: 1,
    max: 8,
    preferred: Math.max(1, Math.min(8, Math.trunc(input.targetBubbleCount))),
  };
  return {
    invitationType: input.invitationType,
    invitationMessageId: input.invitationMessageId,
    phase: "queued",
    generationCycle: 1,
    providerCallLimit: 2,
    providerCallCount: 0,
    providerCallTrace: [],
    targetBubbleCount: bubbleCountPlan.preferred,
    bubbleCountPlan,
  };
}
export function invitationResponseTask(input: {
  invitationType: InvitationResponseType;
  invitationMessageId: string;
  conversationId: string;
  characterId: string;
  targetBubbleCount: number;
  bubbleCountPlan?: ReplyBubbleCountPlan;
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
