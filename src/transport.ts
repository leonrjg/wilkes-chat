import type {
  AgentBackend,
  BackendStatus,
  ChatConfigOption,
  ChatConversationRecord,
  ChatDone,
  ChatSendResult,
  ChatStartResult,
  ChatUpdate,
} from "./types";

/** How the client reaches the sessions.
 *
 *  Everything in this package that is not a pixel goes through this interface,
 *  and nothing in it knows what carries the calls. A desktop host implements it
 *  over IPC (`@leonrjg/acp-chat/tauri` is that implementation); a test or a
 *  browser preview implements it with a fake and gets the same store, the same
 *  pane and the same states, including the ones that are hard to reach on
 *  purpose — a backend that will not install, a permission request nobody
 *  answers, a subprocess that dies mid-turn.
 *
 *  The one shape worth explaining is `send`. It takes the listeners rather than
 *  returning a stream because the listeners must be registered *before* the
 *  turn starts: an agent can answer faster than a promise resolves, and a
 *  client that subscribed after `await send(...)` would miss the first chunks
 *  of short replies and only those. `newTurnId` exists for the same reason —
 *  the caller needs the id to key a placeholder message before anything is in
 *  flight. */
export interface ChatTransport {
  /** Every backend and whether it is usable. `refresh` re-probes rather than
   *  answering from cache — what the Recheck button calls. */
  listBackends(refresh?: boolean): Promise<BackendStatus[]>;

  /** Download a backend's adapter. Resolves with that backend's new status. */
  installBackend(backend: AgentBackend): Promise<BackendStatus>;

  listConversations(): Promise<ChatConversationRecord[]>;
  forgetConversation(conversationId: string): Promise<void>;

  /** Start a subprocess and complete the ACP handshake. Rejects if the backend
   *  is installed but not usable — being logged out, most often — which is why
   *  this resolves after the handshake and not after the spawn. */
  start(backend: AgentBackend): Promise<ChatStartResult>;

  /** Reattach to the agent's own session for a saved conversation. */
  openConversation(conversationId: string): Promise<ChatStartResult>;

  close(sessionId: string): Promise<void>;

  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<ChatConfigOption[]>;

  /** A turn id, minted synchronously. See the note on this interface. */
  newTurnId(): string;

  send(
    sessionId: string,
    turnId: string,
    userMessageId: string,
    text: string,
    onUpdate: (update: ChatUpdate) => void,
    onDone: (done: ChatDone) => void,
  ): Promise<ChatSendResult>;

  cancel(sessionId: string, turnId: string): Promise<void>;

  /** Answer a surfaced permission request. `optionId` is null when the user
   *  dismissed it without choosing one of the agent's options. */
  answerPermission(
    sessionId: string,
    requestId: string,
    optionId: string | null,
  ): Promise<void>;

  /** The subprocess died outside any turn's request/response cycle. Registered
   *  once per session; resolves to an unsubscribe. */
  onSessionError(
    sessionId: string,
    handler: (message: string) => void,
  ): Promise<() => void>;

  /** The agent's own config changed — because we set it, or because it did. */
  onConfigOptionsUpdated(
    sessionId: string,
    handler: (options: ChatConfigOption[]) => void,
  ): Promise<() => void>;
}

/** The command names a desktop host registers, and the event channels it
 *  emits on.
 *
 *  Exported because a host has to name these on its own side of the IPC, and
 *  two hand-written lists of the same strings is how a renamed command becomes
 *  a runtime "command not found" that only shows up on one screen. A host can
 *  assert its registered commands against `CHAT_COMMANDS` in a test. */
export const CHAT_COMMANDS = [
  "chat_list_backends",
  "chat_install_backend",
  "chat_list_conversations",
  "chat_forget_conversation",
  "chat_start",
  "chat_open_conversation",
  "chat_close",
  "chat_set_config_option",
  "chat_send",
  "chat_cancel",
  "chat_answer_permission",
] as const;

export type ChatCommand = (typeof CHAT_COMMANDS)[number];

/** Per-turn and per-session event channels. Suffixed with the id they belong
 *  to so a client subscribes to one turn rather than filtering every update
 *  the application emits. */
export const chatChannel = {
  update: (turnId: string) => `chat/update-${turnId}`,
  done: (turnId: string) => `chat/done-${turnId}`,
  sessionError: (sessionId: string) => `chat/session-error-${sessionId}`,
  config: (sessionId: string) => `chat/config-${sessionId}`,
} as const;
