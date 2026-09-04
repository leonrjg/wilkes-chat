// The desktop half of the contract in `transport.ts`, over Tauri's IPC.
//
// It ships here rather than in each application because the command names and
// event channels are this package's — `crates/wilkes-chat` is what the host wires
// them to — and a host re-deriving them is a second place for them to drift.
//
// `@tauri-apps/api` is an optional peer dependency: importing this module is
// what pulls it in, and a browser-only host never does.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { chatChannel, type ChatTransport } from "./transport.js";
import type {
  AgentBackend,
  BackendStatus,
  ChatConfigOption,
  ChatConversationRecord,
  ChatDone,
  ChatSendResult,
  ChatStartResult,
  ChatUpdate,
} from "./types.js";

/** A random id for a turn or a message.
 *
 *  `crypto.randomUUID` is present in every webview this runs in; the fallback
 *  is for jsdom without it, where these ids only have to be distinct. */
export function randomId(): string {
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === "function") return globalThis.crypto.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/** Add the application's opaque host blob to a command payload, or leave the
 *  payload untouched when there is none. */
function withHost(args: Record<string, unknown>, host: unknown): Record<string, unknown> {
  return host === undefined ? args : { ...args, host };
}

export function tauriChatTransport(): ChatTransport {
  return {
    listBackends: (refresh = false) =>
      invoke<BackendStatus[]>("chat_list_backends", { refresh }),

    installBackend: (backend: AgentBackend) =>
      invoke<BackendStatus>("chat_install_backend", { backend }),

    listConversations: () =>
      invoke<ChatConversationRecord[]>("chat_list_conversations"),

    forgetConversation: (conversationId: string) =>
      invoke<void>("chat_forget_conversation", { conversationId }),

    // `host` is left off the payload entirely when there is none, rather than
    // sent as null: an application whose commands take no such argument must
    // not have to declare one to be called at all.
    start: (backend: AgentBackend, host?: unknown) =>
      invoke<ChatStartResult>("chat_start", withHost({ backend }, host)),

    openConversation: (conversationId: string, host?: unknown) =>
      invoke<ChatStartResult>("chat_open_conversation", withHost({ conversationId }, host)),

    forkConversation: (
      conversationId: string,
      messageId: string,
      includeMessage: boolean,
      host?: unknown,
    ) =>
      invoke<ChatStartResult>(
        "chat_fork_conversation",
        withHost({ conversationId, messageId, includeMessage }, host),
      ),

    close: (sessionId: string) => invoke<void>("chat_close", { sessionId }),

    setConfigOption: (sessionId: string, configId: string, value: string) =>
      invoke<ChatConfigOption[]>("chat_set_config_option", {
        sessionId,
        configId,
        value,
      }),

    newTurnId: randomId,

    async send(sessionId, turnId, userMessageId, text, host, onUpdate, onDone) {
      // Both listeners are registered before the invoke, not after: a short
      // reply can finish before an awaited `invoke` resolves, and a client
      // that subscribed afterwards would lose exactly the fastest answers.
      const unlistenUpdate = await listen<ChatUpdate>(
        chatChannel.update(turnId),
        (event) => onUpdate(event.payload),
      );
      const unlistenDone = await listen<ChatDone>(
        chatChannel.done(turnId),
        (event) => {
          unlistenUpdate();
          unlistenDone();
          onDone(event.payload);
        },
      );

      try {
        return await invoke<ChatSendResult>(
          "chat_send",
          withHost({ sessionId, turnId, userMessageId, text }, host),
        );
      } catch (error) {
        // The turn never started, so `chat/done` will never fire and these two
        // would leak for the life of the window. The caller still sees the
        // rejection and renders the failure.
        unlistenUpdate();
        unlistenDone();
        throw error;
      }
    },

    cancel: (sessionId: string, turnId: string) =>
      invoke<void>("chat_cancel", { sessionId, turnId }),

    answerPermission: (
      sessionId: string,
      requestId: string,
      optionId: string | null,
    ) =>
      invoke<void>("chat_answer_permission", { sessionId, requestId, optionId }),

    onSessionError: (sessionId: string, handler: (message: string) => void) =>
      listen<{ message: string }>(chatChannel.sessionError(sessionId), (event) =>
        handler(event.payload.message),
      ),

    onConfigOptionsUpdated: (
      sessionId: string,
      handler: (options: ChatConfigOption[]) => void,
    ) =>
      listen<ChatConfigOption[]>(chatChannel.config(sessionId), (event) =>
        handler(event.payload),
      ),
  };
}
