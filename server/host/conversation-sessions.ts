import { Handoffs, isContextMessage } from "../delta-context.ts";
import type { Store } from "../store.ts";
import { createRoomSessions, type RoomSessionsDeps } from "./room-sessions.ts";

export interface ConversationSessionsDeps {
  store: Pick<Store, "activePath" | "taskByThread" | "setHandedMessages" | "messagesFor">;
  settings: RoomSessionsDeps["settings"];
}

export function createConversationSessions({ store, settings }: ConversationSessionsDeps) {
  const handoffs = new Handoffs({
    order: (threadId) => store.activePath(threadId).filter(isContextMessage).map((m) => m.id),
    read: (botId, threadId, instanceId) => store.taskByThread(botId, threadId)?.handedMessages?.[instanceId],
    write: (botId, threadId, instanceId, state) => store.setHandedMessages(botId, threadId, instanceId, state),
    replies: (threadId, turnId) => store.activePath(threadId)
      .filter((m) => m.role === "bot" && m.kind === "text" && !m.from && m.turnId === turnId).map((m) => m.id),
  });
  const roomSessions = createRoomSessions({ settings, messagesFor: (threadId) => store.messagesFor(threadId) });
  return { handoffs, roomSessions };
}
