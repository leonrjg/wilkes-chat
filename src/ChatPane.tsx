import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { MessageBubble } from "./MessageBubble";
import {
  CheckIcon,
  ClockIcon,
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  PlusIcon,
  RefreshIcon,
  SendIcon,
  StopIcon,
  TrashIcon,
} from "./icons";
import {
  formatConversationDate,
  isScrollUpKey,
  shouldStickToBottom,
} from "./transcript";
import type { ChatStore } from "./createChatStore";
import type { AgentBackend, ChatToolLocation } from "./types";

export interface ChatPaneProps {
  store: ChatStore;
  /** Rendered as the pane's close affordance. Omitted where the chat is a
   *  whole screen rather than a panel, and then no close button appears. */
  onClose?: () => void;
  /** Given, a tool call's file locations become buttons. */
  onOpenLocation?: (location: ChatToolLocation) => void;
  /** Asked before a conversation is deleted. Defaults to `window.confirm`;
   *  a host with its own dialog passes it here. */
  confirmDelete?: (title: string) => boolean | Promise<boolean>;
  placeholder?: string;
  /** Shown in an empty transcript. A general chat has nothing to say about
   *  itself, so a host that has something says it here. */
  emptyState?: React.ReactNode;
  className?: string;
}

/** The chat, whole: agent selector, history, transcript, composer, and the
 *  setup panel for when no agent is installed yet.
 *
 *  Styling is CSS custom properties in `chat.css`, not utility classes, so a
 *  host restyles it by redefining tokens rather than by forking the markup —
 *  the same bargain the readers in `wilkes-reader` make with their host. */
export function ChatPane({
  store: useChatStore,
  onClose,
  onOpenLocation,
  confirmDelete,
  placeholder = "Ask anything…",
  emptyState,
  className,
}: ChatPaneProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastTouchYRef = useRef<number | null>(null);
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copiedSessionId, setCopiedSessionId] = useState(false);

  const backends = useChatStore((s) => s.backends);
  const backendsLoading = useChatStore((s) => s.backendsLoading);
  const backendsLoaded = useChatStore((s) => s.backendsLoaded);
  const hasAvailableBackend = useChatStore((s) => s.hasAvailableBackend);
  const installingBackend = useChatStore((s) => s.installingBackend);
  const backend = useChatStore((s) => s.backend);
  const sessionId = useChatStore((s) => s.sessionId);
  const conversationId = useChatStore((s) => s.conversationId);
  const conversations = useChatStore((s) => s.conversations);
  const conversationsLoading = useChatStore((s) => s.conversationsLoading);
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const starting = useChatStore((s) => s.starting);
  const sessionError = useChatStore((s) => s.sessionError);
  const configOptions = useChatStore((s) => s.configOptions);
  const backendSessionId = useChatStore((s) => s.backendSessionId);

  const initialize = useChatStore((s) => s.initialize);
  const loadBackends = useChatStore((s) => s.loadBackends);
  const installBackend = useChatStore((s) => s.installBackend);
  const switchBackend = useChatStore((s) => s.switchBackend);
  const newChat = useChatStore((s) => s.newChat);
  const openConversation = useChatStore((s) => s.openConversation);
  const forgetConversation = useChatStore((s) => s.forgetConversation);
  const setConfigOption = useChatStore((s) => s.setConfigOption);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const answerPermission = useChatStore((s) => s.answerPermission);
  const forkFromMessage = useChatStore((s) => s.forkFromMessage);
  const editMessage = useChatStore((s) => s.editMessage);
  const cancel = useChatStore((s) => s.cancel);

  // Swallowed rather than thrown: every one of these already reports itself
  // through `sessionError`, and an unhandled rejection out of an effect or a
  // click handler is noise on top of a message the user can already read.
  const ignore = () => {};

  useEffect(() => {
    initialize().catch(ignore);
  }, [initialize]);

  // A new conversation starts attached to its bottom, whatever the last one
  // was doing.
  useEffect(() => {
    stickRef.current = true;
    lastScrollTopRef.current = 0;
  }, [sessionId, conversationId]);

  useLayoutEffect(() => {
    if (!stickRef.current) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const [nowMs, setNowMs] = useState(() => performance.now());
  const anyStreaming = messages.some((m) => m.streaming);
  useEffect(() => {
    if (!anyStreaming) return;
    setNowMs(performance.now());
    const timer = window.setInterval(() => setNowMs(performance.now()), 1000);
    return () => window.clearInterval(timer);
  }, [anyStreaming]);

  const activeBackend = backends.find((b) => b.backend === backend);

  const send = () => {
    const text = draft.trim();
    if (!text || streaming || !sessionId) return;
    setDraft("");
    sendMessage(text).catch(ignore);
  };

  const deleteConversation = async (id: string, title: string) => {
    const ask = confirmDelete ?? ((t: string) => window.confirm(`Delete "${t}"? This cannot be undone.`));
    if (!(await ask(title))) return;
    forgetConversation(id).catch(ignore);
  };

  return (
    <div className={className ? `wilkes-chat ${className}` : "wilkes-chat"}>
      <header className="wilkes-chat__header">
        <div className="wilkes-chat__header-row">
          <span
            className={`wilkes-chat__status-dot${activeBackend?.available ? " wilkes-chat__status-dot--on" : ""}`}
            aria-hidden="true"
          />
          <label className="wilkes-chat__visually-hidden" htmlFor="wilkes-chat-agent">
            Agent
          </label>
          <select
            id="wilkes-chat-agent"
            className="wilkes-chat__select wilkes-chat__select--agent"
            value={backend ?? ""}
            disabled={starting || streaming}
            onChange={(event) => switchBackend(event.target.value as AgentBackend).catch(ignore)}
          >
            {backend === null && <option value="">Select an agent</option>}
            {backends.map((b) => (
              <option key={b.backend} value={b.backend} disabled={!b.available}>
                {b.label}
                {b.available ? "" : ` — ${b.unavailable_reason ?? b.auth_note}`}
              </option>
            ))}
          </select>

          <div className="wilkes-chat__header-actions">
            <button
              type="button"
              className="wilkes-chat__icon-button"
              title="New chat"
              aria-label="New chat"
              disabled={!sessionId || starting || streaming}
              onClick={() => newChat().catch(ignore)}
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className="wilkes-chat__icon-button"
              title="Saved chats"
              aria-label="Saved chats"
              aria-expanded={historyOpen}
              disabled={starting}
              onClick={() => setHistoryOpen((open) => !open)}
            >
              <ClockIcon />
            </button>
            <button
              type="button"
              className="wilkes-chat__icon-button"
              // The agent's own id for this conversation, not ours: it is what
              // identifies the thread in the CLI's own logs and storage, which
              // is the only place anyone would go looking with it.
              title="Copy the agent's session id"
              aria-label={copiedSessionId ? "Copied" : "Copy the agent's session id"}
              disabled={!backendSessionId}
              onClick={() => {
                if (!backendSessionId) return;
                navigator.clipboard
                  ?.writeText(backendSessionId)
                  .then(() => {
                    setCopiedSessionId(true);
                    window.setTimeout(() => setCopiedSessionId(false), 1200);
                  })
                  .catch(() => {});
              }}
            >
              {copiedSessionId ? <CheckIcon /> : <CopyIcon />}
            </button>
            {onClose && (
              <button
                type="button"
                className="wilkes-chat__icon-button"
                title="Close chat"
                aria-label="Close chat"
                onClick={onClose}
              >
                <CloseIcon size={14} />
              </button>
            )}
          </div>
        </div>

        {configOptions.length > 0 && (
          <div className="wilkes-chat__config">
            {configOptions.map((option) => (
              <label key={option.id} className="wilkes-chat__config-option" title={option.name}>
                <span className="wilkes-chat__visually-hidden">{option.name}</span>
                <select
                  className="wilkes-chat__select"
                  value={option.current_value}
                  disabled={streaming}
                  onChange={(event) => setConfigOption(option.id, event.target.value)}
                >
                  {/* A value the agent reports but does not offer as a choice
                      still has to be selectable, or the control would silently
                      show a different model than the one in use. */}
                  {!option.choices.some((c) => c.value === option.current_value) && (
                    <option value={option.current_value}>{option.current_value}</option>
                  )}
                  {option.choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.group ? `${choice.group} · ${choice.name}` : choice.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
      </header>

      {historyOpen && (
        <div className="wilkes-chat__history">
          {conversations.length === 0 ? (
            <div className="wilkes-chat__muted wilkes-chat__history-empty">
              {conversationsLoading ? "Loading saved chats…" : "No saved chats yet."}
            </div>
          ) : (
            <ul className="wilkes-chat__history-list">
              {conversations.map((conversation) => (
                <li
                  key={conversation.conversation_id}
                  className={
                    conversation.conversation_id === conversationId
                      ? "wilkes-chat__history-item wilkes-chat__history-item--current"
                      : "wilkes-chat__history-item"
                  }
                >
                  <button
                    type="button"
                    className="wilkes-chat__history-open"
                    disabled={streaming || starting}
                    onClick={() => {
                      setHistoryOpen(false);
                      openConversation(conversation.conversation_id).catch(ignore);
                    }}
                  >
                    <span className="wilkes-chat__history-title">
                      {/* A fork carries its parent's name; without this it
                          reads as an unrelated chat that happens to be called
                          the same thing. */}
                      {conversation.parent_conversation_id ? "↳ " : ""}
                      {conversation.title}
                    </span>
                    <span className="wilkes-chat__dim">
                      {formatConversationDate(conversation.updated_at)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="wilkes-chat__icon-button wilkes-chat__icon-button--danger"
                    title="Delete this chat"
                    aria-label={`Delete ${conversation.title}`}
                    onClick={() =>
                      deleteConversation(conversation.conversation_id, conversation.title)
                    }
                  >
                    <TrashIcon size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {starting && (
        <div className="wilkes-chat__banner">Starting the agent…</div>
      )}

      {sessionError && (
        <div className="wilkes-chat__banner wilkes-chat__banner--error" role="alert">
          <span className="wilkes-chat__banner-text">
            {activeBackend?.label ?? "The agent"} — {sessionError}
          </span>
          {backend && (
            <button
              type="button"
              className="wilkes-chat__button"
              onClick={() => switchBackend(backend).catch(ignore)}
            >
              <RefreshIcon size={11} /> Retry
            </button>
          )}
        </div>
      )}

      {backendsLoading && !backendsLoaded ? (
        <div className="wilkes-chat__pending">Checking which agents are installed…</div>
      ) : !hasAvailableBackend && backendsLoaded ? (
        <div className="wilkes-chat__setup">
          <p className="wilkes-chat__setup-lead">No agent is set up yet.</p>
          {backends.map((b) => (
            <div key={b.backend} className="wilkes-chat__setup-row">
              <div className="wilkes-chat__setup-name">{b.label}</div>
              <div className="wilkes-chat__muted">{b.unavailable_reason ?? b.auth_note}</div>
              {b.installable && (
                <button
                  type="button"
                  className="wilkes-chat__button wilkes-chat__button--primary"
                  disabled={installingBackend !== null}
                  onClick={() => installBackend(b.backend).catch(ignore)}
                >
                  <DownloadIcon size={11} />
                  {installingBackend === b.backend ? "Installing…" : "Install"}
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="wilkes-chat__button"
            disabled={backendsLoading || installingBackend !== null}
            onClick={() => loadBackends({ force: true }).catch(ignore)}
          >
            <RefreshIcon size={11} /> {backendsLoading ? "Checking…" : "Recheck"}
          </button>
        </div>
      ) : (
        <div
          ref={transcriptRef}
          className="wilkes-chat__transcript"
          tabIndex={0}
          // Following the bottom is right until the reader scrolls up to read
          // something. Every gesture that means "I am reading" detaches; only
          // arriving back at the bottom reattaches.
          onScroll={(event) => {
            const el = event.currentTarget;
            stickRef.current = shouldStickToBottom(el, lastScrollTopRef.current, stickRef.current);
            lastScrollTopRef.current = el.scrollTop;
          }}
          onWheelCapture={(event) => {
            if (event.deltaY < 0) stickRef.current = false;
          }}
          onTouchStart={(event) => {
            lastTouchYRef.current = event.touches[0]?.clientY ?? null;
          }}
          onTouchMove={(event) => {
            const y = event.touches[0]?.clientY;
            if (y == null) return;
            if (lastTouchYRef.current != null && y > lastTouchYRef.current) {
              stickRef.current = false;
            }
            lastTouchYRef.current = y;
          }}
          onTouchEnd={() => {
            lastTouchYRef.current = null;
          }}
          onKeyDownCapture={(event) => {
            if (isScrollUpKey(event.key)) stickRef.current = false;
          }}
        >
          {messages.length === 0 && !starting && (
            <div className="wilkes-chat__empty">{emptyState}</div>
          )}
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              nowMs={nowMs}
              onAnswerPermission={(requestId, option) =>
                answerPermission(requestId, option).catch(ignore)
              }
              onOpenLocation={onOpenLocation}
              // Both start a fresh session from the record on disk, so both
              // are offered only once there is a record: a backend that keeps
              // none has nothing to branch.
              onFork={
                conversationId ? (id) => forkFromMessage(id).catch(ignore) : undefined
              }
              onEdit={
                conversationId
                  ? (id, edited) => editMessage(id, edited).catch(ignore)
                  : undefined
              }
              actionsDisabled={streaming || starting}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      <form
        className="wilkes-chat__composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          className="wilkes-chat__textarea"
          value={draft}
          rows={2}
          placeholder={placeholder}
          aria-label="Message"
          disabled={!hasAvailableBackend}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            } else if (event.key === "Escape") {
              event.currentTarget.blur();
            }
          }}
        />
        <div className="wilkes-chat__composer-actions">
          <span className="wilkes-chat__dim wilkes-chat__hint">
            Enter to send · Shift+Enter for a new line
          </span>
          {streaming ? (
            <button
              type="button"
              className="wilkes-chat__button"
              onClick={() => cancel().catch(ignore)}
            >
              <StopIcon size={10} /> Stop
            </button>
          ) : (
            <button
              type="submit"
              className="wilkes-chat__button wilkes-chat__button--primary"
              disabled={!draft.trim() || !sessionId || starting}
            >
              <SendIcon size={10} /> Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
