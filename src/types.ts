// The wire, as the client sees it.
//
// Every shape here is the mirror of one in `crates/wilkes-chat` — `ChatUpdate` of
// `wire::ChatUpdate`, `ChatMessageRecord` of `store::ChatMessageRecord`, and so
// on. They ship in the same package and change in the same commit, which is
// the only thing that keeps them honest: no compiler sees both sides.
//
// Field names are snake_case here and nowhere else in this package, because
// they are Rust's names arriving over serde rather than names this code chose.

/** Which CLI answers. The wire form is the Rust variant name. */
export type AgentBackend = "ClaudeCode" | "Codex" | "Nanocoder";

/** One row of an agent selector. An unavailable backend is still listed —
 *  `auth_note` and `unavailable_reason` are where a user learns what to do
 *  about it, so filtering it out would hide the fix along with the problem. */
export interface BackendStatus {
  backend: AgentBackend;
  label: string;
  available: boolean;
  auth_note: string;
  /** The adapter is not downloaded, but the toolchain to download it is here. */
  installable: boolean;
  unavailable_reason: string | null;
}

export interface ChatConfigChoice {
  value: string;
  name: string;
  /** Set only for grouped selectors, e.g. models organised by provider. */
  group: string | null;
}

/** One ACP session config option: the model, the mode, the thought level. */
export interface ChatConfigOption {
  id: string;
  name: string;
  category: string | null;
  current_value: string;
  choices: ChatConfigChoice[];
}

export interface ChatConfigValue {
  id: string;
  value: string;
}

export interface ChatToolLocation {
  path: string;
  line: number | null;
}

export type ChatToolContentBlock =
  | { kind: "text"; text: string }
  | { kind: "diff"; path: string; old_text: string | null; new_text: string }
  | { kind: "terminal"; terminal_id: string };

export interface ChatToolCallRecord {
  tool_call_id: string;
  title: string;
  status: string;
  locations: ChatToolLocation[];
  content: ChatToolContentBlock[];
  raw_input: unknown;
  raw_output: unknown;
}

export type ChatContentBlockRecord =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ChatToolCallRecord };

/** What was true when a turn was sent, so a fork of it reopens under the same
 *  conditions rather than under today's. `host` is an opaque blob the
 *  application writes and reads; nothing here interprets it. */
export interface ChatTurnEnvironment {
  config_values: ChatConfigValue[];
  host?: unknown;
}

export interface ChatMessageRecord {
  message_id: string;
  turn_id: string | null;
  role: "user" | "assistant";
  thought: string;
  content: ChatContentBlockRecord[];
  error: string | null;
  /** Set on the user message that opened a turn, and nowhere else. */
  environment?: ChatTurnEnvironment | null;
}

export interface ChatConversationRecord {
  conversation_id: string;
  backend: AgentBackend;
  backend_session_id: string;
  cwd: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
  config_values: ChatConfigValue[];
  messages: ChatMessageRecord[];
  /** The conversation this one was branched out of, if any. A history menu
   *  marks these so a fork is not mistaken for an unrelated chat with a
   *  similar name. */
  parent_conversation_id?: string | null;
  forked_from_message_id?: string | null;
  branch_history_pending?: boolean;
}

/** The configuration last chosen for one agent, which a host persists so a new
 *  chat starts where the last one left off. */
export interface ChatBackendConfig {
  backend: AgentBackend;
  values: ChatConfigValue[];
}

/** One choice the agent offered for a permission request. Echoed back by
 *  `option_id` so the agent's own semantics (allow/reject, once/always) are
 *  never reinterpreted here. */
export interface ChatPermissionOption {
  option_id: string;
  name: string;
  kind: string;
}

/** One update inside a turn.
 *
 *  `tool` fields are optional with patch semantics: absent means "unchanged",
 *  and a client keeps what it had. An update reports what moved, not the whole
 *  call, so treating absence as a clear would blank a title mid-call. */
export type ChatUpdate =
  | { kind: "text"; delta: string }
  | { kind: "thought"; delta: string }
  | {
      kind: "tool";
      tool_call_id: string;
      title?: string | null;
      status?: string | null;
      locations?: ChatToolLocation[] | null;
      content?: ChatToolContentBlock[] | null;
      raw_input?: unknown;
      raw_output?: unknown;
    }
  | {
      kind: "permission";
      request_id: string;
      tool_call_id: string;
      title: string | null;
      options: ChatPermissionOption[];
    }
  | { kind: "error"; message: string };

/** What starting or reopening a session yields. */
export interface ChatStartResult {
  session_id: string;
  /** Null for a backend whose conversations cannot be resumed, so there is
   *  nothing worth saving a record of. */
  conversation_id: string | null;
  backend_session_id: string | null;
  config_options: ChatConfigOption[];
  messages: ChatMessageRecord[];
}

export interface ChatSendResult {
  /** The conversation the turn was recorded in — minted on the first turn, so
   *  a caller learns its id here rather than at session start. */
  conversation_id: string | null;
}

/** The end of a turn: the agent's stop reason, or nothing if it never got
 *  far enough to have one. */
export interface ChatDone {
  stop_reason: string | null;
}
