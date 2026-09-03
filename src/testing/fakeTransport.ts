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
  ChatSendResult,
  ChatStartResult,
  ChatUpdate,
} from "../types";

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
}

export function createFakeTransport(options: FakeTransportOptions = {}): FakeTransport {
  const backends = options.backends ?? [backendStatus("ClaudeCode")];
  let conversations = options.conversations ?? [];
  const configOptions = options.configOptions ?? [];

  const turns: FakeTurn[] = [];
  const closed: string[] = [];
  const cancelled: Array<{ sessionId: string; turnId: string }> = [];
  const answered: Array<{ requestId: string; optionId: string | null }> = [];
  const errorHandlers = new Map<string, (message: string) => void>();
  const configHandlers = new Map<string, (options: ChatConfigOption[]) => void>();

  let nextId = 0;
  const id = (prefix: string) => `${prefix}-${++nextId}`;

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
        const turn: FakeTurn = {
          sessionId,
          turnId,
          userMessageId,
          text,
          emit: onUpdate,
          finish: (stopReason = "end_turn") => {
            const done: ChatDone = { stop_reason: stopReason };
            onDone(done);
            turns.splice(turns.indexOf(turn), 1);
            resolve({ conversation_id: `conversation-for-${sessionId}` });
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
