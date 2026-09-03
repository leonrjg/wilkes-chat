// The chat, headless.
//
// A store factory rather than a store, because the transport is injected: an
// application wires its IPC in once here, and a test or a browser preview wires
// a fake in and drives every state the real one can reach.

import { create, type StoreApi, type UseBoundStore } from "zustand";

import type { ChatTransport } from "./transport";
import {
  applyUpdate,
  dismissUndecided,
  emptyAssistantMessage,
  messageFromRecord,
  messageText,
  userMessage,
  type ChatMessage,
  type ChatPermissionPrompt,
} from "./transcript";
import type {
  AgentBackend,
  BackendStatus,
  ChatConfigOption,
  ChatConversationRecord,
  ChatStartResult,
} from "./types";

export interface ChatStoreOptions {
  transport: ChatTransport;
  /** The backend to prefer when starting a session, if it is available.
   *
   *  A function rather than a value because the preference lives in the
   *  application's settings and can change while the store is alive. Falling
   *  back to the first available backend is this store's job; remembering the
   *  choice is not — see `onBackendChosen`. */
  preferredBackend?: () => AgentBackend | null | undefined;
  /** Called when the user picks a backend, so an application can persist it.
   *  Not called for the fallback: being handed a working agent is not the same
   *  as choosing one, and recording it as a choice would silently overwrite a
   *  preference the user set while their agent was briefly unavailable. */
  onBackendChosen?: (backend: AgentBackend) => void;
  /** What the application wants its `ChatHost` to know, asked for afresh on
   *  every call that starts a session or a turn.
   *
   *  A function rather than a value, and asked for at the last moment, because
   *  it is the answer *now*: which documents are in context, which root to
   *  search. Sending it with each call is what makes the client the single
   *  owner of that state — a session started five minutes ago and one starting
   *  now are told the same thing by the same code path, so there is no separate
   *  push to keep in step and nothing to replay after a backend switch.
   *
   *  Nothing here reads the value. A chat with no application behind it omits
   *  this, and no host argument reaches the wire at all. */
  hostPayload?: () => unknown;
  /** Hand back the host blob a stored turn was sent under, so the application
   *  can put itself into that state before the call that needs it.
   *
   *  Called just before a conversation is reopened or branched, and never for
   *  a turn happening now. It is what makes a branch reopen on the documents
   *  its question was asked about rather than on whatever is open today —
   *  taken from the history this store already holds, not from a second copy
   *  the shell keeps.
   *
   *  Deliberately a *restore*, not an override: the application updates its own
   *  state, so the payload the very next `hostPayload()` returns is the
   *  restored one, and the client stays the single thing that decides what the
   *  chat is about. Nothing is passed when the stored turn carried no blob. */
  onHostRestore?: (host: unknown) => void;
  /** Reported instead of thrown for the failures a caller cannot act on —
   *  refreshing history, closing a replaced session. Defaults to
   *  `console.error`. */
  onBackgroundError?: (context: string, error: unknown) => void;
}

export interface ChatState {
  // Backends
  backends: BackendStatus[];
  backendsLoaded: boolean;
  backendsLoading: boolean;
  installingBackend: AgentBackend | null;
  hasAvailableBackend: boolean;

  // The open session
  sessionId: string | null;
  conversationId: string | null;
  backendSessionId: string | null;
  backend: AgentBackend | null;
  /** A session is being started or reopened. Distinct from `streaming`: this
   *  is the subprocess handshake, which can fail on its own. */
  starting: boolean;
  sessionError: string | null;
  configOptions: ChatConfigOption[];

  // History
  conversations: ChatConversationRecord[];
  conversationsLoading: boolean;

  // The thread
  messages: ChatMessage[];
  streaming: boolean;
  currentTurnId: string | null;

  /** Load backends and history, then open a session on the preferred backend.
   *  Safe to call on every mount: it does nothing once a session is open. */
  initialize: () => Promise<void>;
  loadBackends: (opts?: { force?: boolean }) => Promise<void>;
  loadConversations: () => Promise<void>;
  installBackend: (backend: AgentBackend) => Promise<void>;
  /** Start a fresh session on `backend`, replacing whatever is open.
   *
   *  `remember` defaults to true: calling this *is* the user choosing an
   *  agent, and `onBackendChosen` is how an application persists that. The
   *  one caller that passes false is `initialize`'s fallback, which picks an
   *  agent because the preferred one was unavailable — a fact about this
   *  moment, not a preference to write down. */
  switchBackend: (backend: AgentBackend, opts?: { remember?: boolean }) => Promise<void>;
  newChat: () => Promise<void>;
  openConversation: (conversationId: string) => Promise<void>;
  forgetConversation: (conversationId: string) => Promise<void>;
  setConfigOption: (configId: string, value: string) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  /** Branch the conversation at `messageId` into a new one and open it.
   *
   *  Forking *from* an assistant answer keeps that answer, so the next thing
   *  said continues from it. Forking from a question re-asks it — which is
   *  what `editMessage` is, with different words. */
  forkFromMessage: (messageId: string) => Promise<void>;
  /** Re-ask a question, differently, in a branch of its own.
   *
   *  A fork rather than an edit in place, because the old answer was really
   *  given and the agent really has it in context; rewriting the transcript
   *  under it would make the window disagree with the agent about what was
   *  said. */
  editMessage: (messageId: string, text: string) => Promise<void>;
  answerPermission: (
    requestId: string,
    option: ChatPermissionPrompt["options"][number] | null,
  ) => Promise<void>;
  cancel: () => Promise<void>;
  /** Close the session and forget the thread. An application calls this when
   *  the chat's whole context goes away — a workspace switch, a sign-out. */
  reset: () => void;
}

export type ChatStore = UseBoundStore<StoreApi<ChatState>>;

function pickBackend(
  backends: BackendStatus[],
  preferred: AgentBackend | null | undefined,
): AgentBackend | null {
  if (preferred && backends.some((b) => b.backend === preferred && b.available)) {
    return preferred;
  }
  return backends.find((b) => b.available)?.backend ?? null;
}

/** What the last turn up to `messageId` was sent under, from the records this
 *  store already holds. Searches backwards because only the user message that
 *  opened a turn carries an environment, and a branch taken from an answer has
 *  to reach past it to the question. */
function storedHost(
  conversations: ChatConversationRecord[],
  conversationId: string,
  messageId?: string,
): unknown {
  const record = conversations.find((c) => c.conversation_id === conversationId);
  if (!record) return undefined;
  const upTo = messageId
    ? record.messages.slice(0, record.messages.findIndex((m) => m.message_id === messageId) + 1)
    : record.messages;
  for (let i = upTo.length - 1; i >= 0; i--) {
    const host = upTo[i].environment?.host;
    if (host !== undefined && host !== null) return host;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CLEARED_SESSION = {
  sessionId: null,
  conversationId: null,
  backendSessionId: null,
  messages: [] as ChatMessage[],
  streaming: false,
  currentTurnId: null,
  sessionError: null,
  configOptions: [] as ChatConfigOption[],
};

export function createChatStore(options: ChatStoreOptions): ChatStore {
  const { transport, hostPayload, onHostRestore } = options;
  const report =
    options.onBackgroundError ??
    ((context: string, error: unknown) => console.error(`chat: ${context}`, error));

  // Session-scoped listeners, torn down when the session they belong to is
  // replaced. Wilkes leaked these — one pair per session for the life of the
  // window — which is invisible until someone switches agents in a loop.
  let unsubscribes: Array<() => void> = [];

  /** Put the application back into the state a stored turn was sent under,
   *  before the call that reopens it. */
  function restoreHostAt(
    conversations: ChatConversationRecord[],
    conversationId: string,
    messageId?: string,
  ) {
    if (!onHostRestore) return;
    const host = storedHost(conversations, conversationId, messageId);
    if (host !== undefined) onHostRestore(host);
  }

  function releaseSubscriptions() {
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];
  }

  return create<ChatState>((set, get) => {
    async function subscribe(sessionId: string) {
      const [errorOff, configOff] = await Promise.all([
        transport.onSessionError(sessionId, (message) => {
          if (get().sessionId === sessionId) set({ sessionError: message });
        }),
        transport.onConfigOptionsUpdated(sessionId, (configOptions) => {
          if (get().sessionId === sessionId) set({ configOptions });
        }),
      ]);
      // The session may already have been replaced while these were resolving,
      // in which case they belong to nothing and are dropped immediately.
      if (get().sessionId !== sessionId) {
        errorOff();
        configOff();
        return;
      }
      unsubscribes.push(errorOff, configOff);
    }

    /** Close whatever is open and stop listening to it. The close is
     *  fire-and-forget: a session that has already died refuses politely, and
     *  waiting on it would delay the new one for no gain. */
    function closeOpenSession() {
      releaseSubscriptions();
      const sessionId = get().sessionId;
      if (sessionId) {
        transport
          .close(sessionId)
          .catch((error) => report("closing the previous session failed", error));
      }
    }

    function adopt(started: ChatStartResult, backend: AgentBackend) {
      set({
        sessionId: started.session_id,
        conversationId: started.conversation_id,
        backendSessionId: started.backend_session_id,
        backend,
        messages: started.messages.map(messageFromRecord),
        streaming: false,
        currentTurnId: null,
        sessionError: null,
        configOptions: started.config_options,
      });
      subscribe(started.session_id).catch((error) =>
        report("subscribing to the session failed", error),
      );
    }

    return {
      backends: [],
      backendsLoaded: false,
      backendsLoading: false,
      installingBackend: null,
      hasAvailableBackend: false,
      ...CLEARED_SESSION,
      backend: null,
      starting: false,
      conversations: [],
      conversationsLoading: false,

      initialize: async () => {
        await get().loadBackends();
        get()
          .loadConversations()
          .catch((error) => report("loading history failed", error));
        if (get().sessionId || get().starting) return;
        const backend = pickBackend(get().backends, options.preferredBackend?.());
        if (!backend) return;
        await get()
          .switchBackend(backend, { remember: false })
          .catch(() => {
            /* surfaced as `sessionError` by switchBackend */
          });
      },

      loadBackends: async (opts = {}) => {
        if (get().backendsLoaded && !opts.force) return;
        set({ backendsLoading: true });
        try {
          const backends = await transport.listBackends(Boolean(opts.force));
          set({
            backends,
            backendsLoaded: true,
            hasAvailableBackend: backends.some((b) => b.available),
            backendsLoading: false,
          });
        } catch (error) {
          set({ backendsLoading: false, sessionError: errorMessage(error) });
          throw error;
        }
      },

      loadConversations: async () => {
        set({ conversationsLoading: true });
        try {
          const conversations = await transport.listConversations();
          set({ conversations, conversationsLoading: false });
        } catch (error) {
          set({ conversationsLoading: false });
          throw error;
        }
      },

      installBackend: async (backend) => {
        set({ installingBackend: backend, sessionError: null });
        try {
          const status = await transport.installBackend(backend);
          const backends = get().backends.some((b) => b.backend === status.backend)
            ? get().backends.map((b) => (b.backend === status.backend ? status : b))
            : [...get().backends, status];
          set({
            backends,
            backendsLoaded: true,
            hasAvailableBackend: backends.some((b) => b.available),
            installingBackend: null,
          });
        } catch (error) {
          set({ installingBackend: null, sessionError: errorMessage(error) });
          throw error;
        }
      },

      switchBackend: async (backend, opts = {}) => {
        closeOpenSession();
        set({ ...CLEARED_SESSION, backend, starting: true });

        let started: ChatStartResult;
        try {
          started = await transport.start(backend, hostPayload?.());
        } catch (error) {
          // Only report onto a session the user is still waiting for: a second
          // switch may have overtaken this one, and its failure is not news
          // about the agent now selected.
          if (get().backend === backend) {
            set({ ...CLEARED_SESSION, sessionError: errorMessage(error), starting: false });
          }
          throw error;
        }

        if (get().backend !== backend) {
          // Overtaken while starting. The session is real and nobody owns it.
          transport
            .close(started.session_id)
            .catch((error) => report("closing an overtaken session failed", error));
          return;
        }

        adopt(started, backend);
        set({ starting: false });
        if (opts.remember !== false) options.onBackendChosen?.(backend);
        get()
          .loadConversations()
          .catch((error) => report("loading history failed", error));
      },

      forkFromMessage: async (messageId) => {
        const { conversationId, messages, streaming, backend } = get();
        const message = messages.find((m) => m.id === messageId);
        // Nothing to fork from an unsaved conversation: the fork is taken from
        // the record on disk, and a backend that keeps no record has none.
        if (!conversationId || !message || streaming || !backend) return;

        restoreHostAt(get().conversations, conversationId, messageId);
        const started = await transport.forkConversation(
          conversationId,
          messageId,
          message.role === "assistant",
          hostPayload?.(),
        );
        closeOpenSession();
        adopt(started, backend);
        get()
          .loadConversations()
          .catch((error) => report("loading history failed", error));

        // Forking from a question means asking it again — the fork excluded
        // it, so nothing has been asked yet.
        //
        // Started, not awaited. Resolving this promise when the *branch* is
        // open rather than when the answer is finished is the contract a
        // caller can use: awaiting a whole turn here would make a click
        // handler hang for as long as the agent talks, and `sendMessage`
        // reports its own failures onto the message either way.
        if (message.role === "user") void get().sendMessage(messageText(message));
      },

      editMessage: async (messageId, text) => {
        const { conversationId, messages, streaming, backend } = get();
        const message = messages.find((m) => m.id === messageId);
        if (!conversationId || !message || message.role !== "user" || streaming || !backend) {
          return;
        }
        const edited = text.trim();
        if (!edited) return;

        restoreHostAt(get().conversations, conversationId, messageId);
        const started = await transport.forkConversation(
          conversationId,
          messageId,
          false,
          hostPayload?.(),
        );
        closeOpenSession();
        adopt(started, backend);
        get()
          .loadConversations()
          .catch((error) => report("loading history failed", error));
        // Started, not awaited — see `forkFromMessage`.
        void get().sendMessage(edited);
      },

      newChat: async () => {
        const backend = get().backend;
        if (backend) await get().switchBackend(backend);
      },

      openConversation: async (conversationId) => {
        closeOpenSession();
        const known = get().conversations.find(
          (c) => c.conversation_id === conversationId,
        );
        set({
          ...CLEARED_SESSION,
          conversationId,
          backend: known?.backend ?? get().backend,
          starting: true,
        });

        try {
          restoreHostAt(get().conversations, conversationId);
          const started = await transport.openConversation(conversationId, hostPayload?.());
          if (get().conversationId !== conversationId) {
            transport
              .close(started.session_id)
              .catch((error) => report("closing an overtaken session failed", error));
            return;
          }
          adopt(started, known?.backend ?? get().backend ?? "ClaudeCode");
          set({ conversationId, starting: false });
          get()
            .loadConversations()
            .catch((error) => report("loading history failed", error));
        } catch (error) {
          if (get().conversationId === conversationId) {
            set({ ...CLEARED_SESSION, sessionError: errorMessage(error), starting: false });
          }
          throw error;
        }
      },

      forgetConversation: async (conversationId) => {
        await transport.forgetConversation(conversationId);
        set((s) => ({
          conversations: s.conversations.filter(
            (c) => c.conversation_id !== conversationId,
          ),
        }));
        // The session behind it is still alive and still usable; only its
        // record is gone, so the thread stays and simply stops being saved.
        if (get().conversationId === conversationId) set({ conversationId: null });
      },

      setConfigOption: async (configId, value) => {
        const sessionId = get().sessionId;
        if (!sessionId) return;
        // Optimistic, then reconciled: setting one option can move others (a
        // model that does not support the selected thought level, say), and
        // only the agent knows which.
        set((s) => ({
          configOptions: s.configOptions.map((o) =>
            o.id === configId ? { ...o, current_value: value } : o,
          ),
        }));
        try {
          const configOptions = await transport.setConfigOption(sessionId, configId, value);
          if (get().sessionId === sessionId) set({ configOptions });
        } catch (error) {
          report("setting a config option failed", error);
          if (get().sessionId === sessionId) {
            set({ sessionError: errorMessage(error) });
          }
        }
      },

      sendMessage: async (text) => {
        const { sessionId, streaming, conversationId } = get();
        if (!sessionId || streaming) return;

        // Two ids from the one generator: the turn, which the event channels
        // are keyed by, and the user's message, which the host records the
        // turn against. They are minted here rather than by the backend
        // because the placeholder pair below has to exist before anything is
        // in flight — see the note on `ChatTransport`.
        const turnId = transport.newTurnId();
        const sent = userMessage(transport.newTurnId(), text);
        const answer = emptyAssistantMessage(turnId, performance.now());
        set((s) => ({
          messages: [...s.messages, sent, answer],
          streaming: true,
          currentTurnId: turnId,
        }));

        const patchAnswer = (patch: (m: ChatMessage) => ChatMessage) =>
          set((s) => ({
            messages: s.messages.map((m) => (m.id === turnId ? patch(m) : m)),
          }));

        const finish = (patch: (m: ChatMessage) => ChatMessage) => {
          patchAnswer((m) => ({
            ...patch(m),
            streaming: false,
            endedAtMs: performance.now(),
            permissions: dismissUndecided(m.permissions),
          }));
          if (get().currentTurnId === turnId) {
            set({ streaming: false, currentTurnId: null });
          }
        };

        try {
          const result = await transport.send(
            sessionId,
            turnId,
            sent.id,
            text,
            hostPayload?.(),
            (update) => patchAnswer((m) => applyUpdate(m, update)),
            () => finish((m) => m),
          );
          if (get().sessionId !== sessionId) return;
          if (result.conversation_id) {
            if (get().conversationId !== result.conversation_id) {
              set({ conversationId: result.conversation_id });
            }
            // The first turn is what mints the conversation, so that is when
            // it appears in the history menu.
            if (!conversationId) {
              get()
                .loadConversations()
                .catch((error) => report("loading history failed", error));
            }
          }
        } catch (error) {
          report("the turn failed", error);
          finish((m) => ({ ...m, error: errorMessage(error) }));
        }
      },

      answerPermission: async (requestId, option) => {
        const sessionId = get().sessionId;
        if (!sessionId) return;
        // Resolve the buttons to a label immediately: the same call is what
        // unblocks the agent, so waiting on it would leave the prompt live
        // while the turn is already moving again.
        const decision = option ? option.name : "Dismissed";
        set((s) => ({
          messages: s.messages.map((m) =>
            m.permissions.some((p) => p.requestId === requestId && p.decision === null)
              ? {
                  ...m,
                  permissions: m.permissions.map((p) =>
                    p.requestId === requestId ? { ...p, decision } : p,
                  ),
                }
              : m,
          ),
        }));
        try {
          await transport.answerPermission(sessionId, requestId, option?.option_id ?? null);
        } catch (error) {
          report("answering a permission request failed", error);
        }
      },

      cancel: async () => {
        const { sessionId, currentTurnId } = get();
        if (!sessionId || !currentTurnId) return;
        await transport
          .cancel(sessionId, currentTurnId)
          .catch((error) => report("cancelling the turn failed", error));
      },

      reset: () => {
        closeOpenSession();
        set({
          ...CLEARED_SESSION,
          backend: null,
          starting: false,
          conversations: [],
          conversationsLoading: false,
        });
      },
    };
  });
}
