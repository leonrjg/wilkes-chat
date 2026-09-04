// The public surface, in two tiers.
//
// The composed pane, for a host that wants a chat; and the headless parts —
// the store, the view model, the pure transcript rules — for a host whose
// chat does not look like this one and which would otherwise reimplement the
// streaming, the stick-to-bottom and the patch semantics badly.
//
// The transport is neither: it is the seam, and a host supplies it. The
// desktop implementation is a separate entry point (`@leonrjg/wilkes-chat/tauri`)
// so `@tauri-apps/api` stays optional for hosts that are not desktop.

export { ChatPane } from "./ChatPane.js";
export type { ChatPaneProps } from "./ChatPane.js";
export { MessageBubble } from "./MessageBubble.js";
export type { MessageBubbleProps } from "./MessageBubble.js";

export { createChatStore } from "./createChatStore.js";
export type { ChatState, ChatStore, ChatStoreOptions } from "./createChatStore.js";

export { CHAT_COMMANDS, chatChannel } from "./transport.js";
export type { ChatCommand, ChatTransport } from "./transport.js";

export {
  applyUpdate,
  dismissUndecided,
  emptyAssistantMessage,
  formatConversationDate,
  formatElapsed,
  isNearBottom,
  isScrollUpKey,
  messageElapsedLabel,
  messageFromRecord,
  messageText,
  shouldStickToBottom,
  userMessage,
} from "./transcript.js";
export type {
  ChatMessage,
  ChatMessageContentBlock,
  ChatPermissionPrompt,
  ChatToolChip,
  ScrollExtent,
} from "./transcript.js";

export type {
  AgentBackend,
  BackendStatus,
  ChatBackendConfig,
  ChatConfigChoice,
  ChatConfigOption,
  ChatConfigValue,
  ChatContentBlockRecord,
  ChatConversationRecord,
  ChatDone,
  ChatMessageRecord,
  ChatPermissionOption,
  ChatSendResult,
  ChatStartResult,
  ChatToolCallRecord,
  ChatToolContentBlock,
  ChatToolLocation,
  ChatTurnEnvironment,
  ChatUpdate,
} from "./types.js";
