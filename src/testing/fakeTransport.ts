// A transport with no subprocess behind it.
//
// Exported from the package, not kept in its tests, because every host needs
// this: a browser preview with no desktop shell, and a test suite that has to
// reach the states a real agent reaches rarely and on its own schedule — a
// permission request nobody answers, an adapter that will not install, a
// subprocess that dies between turns.
//
// Turns do not resolve on their own. `respond`, `emit` and `finish` drive
// them, so a test says exactly when each chunk lands.

import type { ChatTransport } from "../transport";
import type {
  AgentBackend,
  BackendStatus,
  ChatConfigOption,
  ChatConversationRecord,
  ChatDone,
  ChatMessageRecord,
  ChatSendResult,
  ChatStartResult,
  ChatUpdate,
} from "../types";

/** One fixed timestamp. A fake that used the clock would make a snapshot test
 *  of the history menu fail once a day at midnight. */
const STAMP = "2026-09-01T10:00:00Z";

export interface FakeTurn {
  sessionId: string;
  turnId: string;
  userMessageId: string;
  text: string;
  /** Deliver one streamed update into this turn. */
  emit: (update: ChatUpdate) => void;
  /** End the turn. Resolves `send` with `conversationId`. */
  finish: (stopReason?: string) => void;
  /** End the turn by failing it. `send` rejects. */
  fail: (message: string) => void;
}

export interface FakeTransportOptions {
  backends?: BackendStatus[];
  conversations?: ChatConversationRecord[];
  configOptions?: ChatConfigOption[];
  /** Rejects `start` with this message instead of opening a session. */
  startFails?: string;
}

/** The names these agents go by, so a preview built on the fake reads like the
 *  real thing rather than showing the wire's own spelling. */
const LABELS: Record<AgentBackend, string> = {
  ClaudeCode: "Claude Code",
  Codex: "Codex",
  Nanocoder: "Nanocoder",
};

export function backendStatus(
  backend: AgentBackend,
  overrides: Partial<BackendStatus> = {},
): BackendStatus {
  return {
    backend,
    label: LABELS[backend],
    available: true,
    auth_note: `Log in to ${backend}`,
    installable: false,
    unavailable_reason: null,
    ...overrides,
  };
}

export interface FakeTransport extends ChatTransport {
  /** Turns that have been started and not yet finished, oldest first. */
  readonly turns: FakeTurn[];
  /** The most recent turn, for the common case of driving exactly one. */
  lastTurn(): FakeTurn;
  /** Push a session-level error, as a dying subprocess would. */
  failSession(sessionId: string, message: string): void;
  /** Push a config change the agent made on its own. */
  pushConfig(sessionId: string, options: ChatConfigOption[]): void;
  readonly closed: string[];
  readonly cancelled: Array<{ sessionId: string; turnId: string }>;
  readonly answered: Array<{ requestId: string; optionId: string | null }>;
  readonly forked: Array<{
    conversationId: string;
    messageId: string;
    includeMessage: boolean;
  }>;
}

export function createFakeTransport(options: FakeTransportOptions = {}): FakeTransport {
  const backends = options.backends ?? [backendStatus("ClaudeCode")];
  let conversations = options.conversations ?? [];
  const configOptions = options.configOptions ?? [];

  const turns: FakeTurn[] = [];
  const closed: string[] = [];
  const cancelled: Array<{ sessionId: string; turnId: string }> = [];
  const answered: Array<{ requestId: string; optionId: string | null }> = [];
  const forked: FakeTransport["forked"] = [];
  /** Which conversation each session is writing into, so a second turn lands
   *  in the same one rather than minting another. */
  const conversationForSession = new Map<string, string>();
  const errorHandlers = new Map<string, (message: string) => void>();
  const configHandlers = new Map<string, (options: ChatConfigOption[]) => void>();

  let nextId = 0;
  const id = (prefix: string) => `${prefix}-${++nextId}`;

  /** Append a finished turn to this session's conversation, creating it on the
   *  first turn the way the real backend does. Returns its id. */
  function recordTurn(
    sessionId: string,
    userMessageId: string,
    turnId: string,
    asked: string,
    answered: string,
  ): string {
    const conversationId = conversationForSession.get(sessionId) ?? id("conversation");
    conversationForSession.set(sessionId, conversationId);

    const turnMessages: ChatMessageRecord[] = [
      {
        message_id: userMessageId,
        turn_id: turnId,
        role: "user",
        thought: "",
        content: [{ kind: "text", text: asked }],
        error: null,
        environment: { config_values: [] },
      },
      {
        message_id: turnId,
        turn_id: turnId,
        role: "assistant",
        thought: "",
        content: answered ? [{ kind: "text", text: answered }] : [],
        error: null,
      },
    ];

    const existing = conversations.find((c) => c.conversation_id === conversationId);
    if (existing) {
      conversations = conversations.map((c) =>
        c.conversation_id === conversationId
          ? { ...c, messages: [...c.messages, ...turnMessages], updated_at: c.updated_at }
          : c,
      );
      return conversationId;
    }

    conversations = [
      {
        conversation_id: conversationId,
        backend: backends[0]?.backend ?? "ClaudeCode",
        backend_session_id: `backend-${sessionId}`,
        cwd: "/tmp/chat",
        // The real store names a conversation after the first thing said in
        // it, and keeps that name.
        title: asked.split(/\s+/).join(" ").slice(0, 80) || "Untitled chat",
        created_at: STAMP,
        updated_at: STAMP,
        last_opened_at: STAMP,
        config_values: [],
        messages: turnMessages,
      },
      ...conversations,
    ];
    return conversationId;
  }

  function started(sessionId: string, conversationId: string | null): ChatStartResult {
    return {
      session_id: sessionId,
      conversation_id: conversationId,
      backend_session_id: `backend-${sessionId}`,
      config_options: configOptions,
      messages: [],
    };
  }

  return {
    turns,
    closed,
    cancelled,
    answered,
    forked,

    lastTurn() {
      const turn = turns[turns.length - 1];
      if (!turn) throw new Error("no turn has been started");
      return turn;
    },

    failSession(sessionId, message) {
      errorHandlers.get(sessionId)?.(message);
    },

    pushConfig(sessionId, next) {
      configHandlers.get(sessionId)?.(next);
    },

    listBackends: async () => backends,

    installBackend: async (backend) => {
      const status = backendStatus(backend, { available: true, installable: false });
      const index = backends.findIndex((b) => b.backend === backend);
      if (index >= 0) backends[index] = status;
      return status;
    },

    listConversations: async () => conversations,

    forgetConversation: async (conversationId) => {
      conversations = conversations.filter((c) => c.conversation_id !== conversationId);
    },

    start: async () => {
      if (options.startFails) throw new Error(options.startFails);
      return started(id("session"), null);
    },

    openConversation: async (conversationId) => {
      const record = conversations.find((c) => c.conversation_id === conversationId);
      if (!record) throw new Error(`no such conversation: ${conversationId}`);
      return { ...started(id("session"), conversationId), messages: record.messages };
    },

    forkConversation: async (conversationId, messageId, includeMessage) => {
      const source = conversations.find((c) => c.conversation_id === conversationId);
      if (!source) throw new Error(`no such conversation: ${conversationId}`);
      const index = source.messages.findIndex((m) => m.message_id === messageId);
      if (index === -1) throw new Error(`no such message: ${messageId}`);

      const fork: ChatConversationRecord = {
        ...source,
        conversation_id: id("conversation"),
        title: `Fork of ${source.title}`,
        messages: source.messages.slice(0, includeMessage ? index + 1 : index),
        parent_conversation_id: conversationId,
        forked_from_message_id: messageId,
      };
      conversations = [fork, ...conversations];
      forked.push({ conversationId, messageId, includeMessage });
      const sessionId = id("session");
      // The new session writes into the fork, not into a conversation of its
      // own — the same as the real one, which was handed the fork's record.
      conversationForSession.set(sessionId, fork.conversation_id);
      return {
        ...started(sessionId, fork.conversation_id),
        messages: fork.messages,
      };
    },

    close: async (sessionId) => {
      closed.push(sessionId);
      errorHandlers.delete(sessionId);
      configHandlers.delete(sessionId);
    },

    setConfigOption: async (_sessionId, configId, value) =>
      configOptions.map((option) =>
        option.id === configId ? { ...option, current_value: value } : option,
      ),

    newTurnId: () => id("turn"),

    send: (sessionId, turnId, userMessageId, text, onUpdate, onDone) =>
      new Promise<ChatSendResult>((resolve, reject) => {
        // What the answer said, so the turn can be written into the fake's own
        // history when it ends. Without this the fake reports a conversation
        // id it does not hold, and every reader of that id — the history menu,
        // a fork — is looking for something that was never there.
        let answered = "";
        const turn: FakeTurn = {
          sessionId,
          turnId,
          userMessageId,
          text,
          emit: (update) => {
            if (update.kind === "text") answered += update.delta;
            onUpdate(update);
          },
          finish: (stopReason = "end_turn") => {
            const done: ChatDone = { stop_reason: stopReason };
            onDone(done);
            turns.splice(turns.indexOf(turn), 1);
            resolve({ conversation_id: recordTurn(sessionId, userMessageId, turnId, text, answered) });
          },
          fail: (message) => {
            turns.splice(turns.indexOf(turn), 1);
            reject(new Error(message));
          },
        };
        turns.push(turn);
      }),

    cancel: async (sessionId, turnId) => {
      cancelled.push({ sessionId, turnId });
      // A real cancel ends the turn; the agent reports `cancelled` and the
      // prompt resolves, so the fake does the same rather than leaving the
      // store streaming forever.
      turns.find((turn) => turn.turnId === turnId)?.finish("cancelled");
    },

    answerPermission: async (_sessionId, requestId, optionId) => {
      answered.push({ requestId, optionId });
    },

    onSessionError: async (sessionId, handler) => {
      errorHandlers.set(sessionId, handler);
      return () => errorHandlers.delete(sessionId);
    },

    onConfigOptionsUpdated: async (sessionId, handler) => {
      configHandlers.set(sessionId, handler);
      return () => configHandlers.delete(sessionId);
    },
  };
}
