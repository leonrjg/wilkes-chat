import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { BranchIcon, CheckIcon, ChevronIcon, CopyIcon, EditIcon, ToolIcon } from "./icons.js";
import {
  messageElapsedLabel,
  messageText,
  type ChatMessage,
  type ChatPermissionPrompt,
  type ChatToolChip,
} from "./transcript.js";
import type { ChatPermissionOption, ChatToolLocation } from "./types.js";

function toolStatusMark(status: string) {
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  return "…";
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      className="wilkes-chat__icon-button"
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        // A clipboard the platform refused is not worth an error state; the
        // button simply does not report success.
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {});
      }}
    >
      {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
    </button>
  );
}

function PermissionPrompt({
  prompt,
  onAnswer,
}: {
  prompt: ChatPermissionPrompt;
  onAnswer: (requestId: string, option: ChatPermissionOption | null) => void;
}) {
  return (
    <div className="wilkes-chat__permission">
      <div className="wilkes-chat__permission-title">
        {prompt.title
          ? `The agent wants to: ${prompt.title}`
          : "The agent is asking permission to run a tool"}
      </div>
      {prompt.decision === null ? (
        <div className="wilkes-chat__permission-options">
          {prompt.options.map((option) => (
            <button
              key={option.option_id}
              type="button"
              className={
                option.kind.startsWith("allow")
                  ? "wilkes-chat__button wilkes-chat__button--primary"
                  : "wilkes-chat__button"
              }
              onClick={() => onAnswer(prompt.requestId, option)}
            >
              {option.name}
            </button>
          ))}
        </div>
      ) : (
        <div className="wilkes-chat__permission-decision">{prompt.decision}</div>
      )}
    </div>
  );
}

function RawJson({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="wilkes-chat__raw">
      <div className="wilkes-chat__raw-label">{label}</div>
      <pre className="wilkes-chat__pre">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

/** What a tool call actually did: its own reported content, then the raw input
 *  and output ACP carried for it. Behind a click because a chip that expanded
 *  by default would bury the answer the tool was called in service of. */
function ToolCallDetail({
  tool,
  onOpenLocation,
}: {
  tool: ChatToolChip;
  onOpenLocation?: (location: ChatToolLocation) => void;
}) {
  const hasDetail =
    tool.locations.length > 0 ||
    tool.content.length > 0 ||
    tool.rawInput != null ||
    tool.rawOutput != null;

  return (
    <div className="wilkes-chat__tool-detail">
      {tool.locations.length > 0 && (
        <div className="wilkes-chat__locations">
          {tool.locations.map((location, i) =>
            onOpenLocation ? (
              <button
                key={i}
                type="button"
                className="wilkes-chat__location wilkes-chat__location--actionable"
                onClick={() => onOpenLocation(location)}
              >
                {location.path}
                {location.line != null && `:${location.line}`}
              </button>
            ) : (
              <span key={i} className="wilkes-chat__location">
                {location.path}
                {location.line != null && `:${location.line}`}
              </span>
            ),
          )}
        </div>
      )}
      {tool.content.map((block, i) => {
        if (block.kind === "text") {
          return (
            <pre key={i} className="wilkes-chat__pre">
              {block.text}
            </pre>
          );
        }
        if (block.kind === "diff") {
          return (
            <div key={i} className="wilkes-chat__diff">
              <div className="wilkes-chat__diff-path">{block.path}</div>
              {block.old_text != null && (
                <pre className="wilkes-chat__pre wilkes-chat__pre--removed">- {block.old_text}</pre>
              )}
              <pre className="wilkes-chat__pre wilkes-chat__pre--added">+ {block.new_text}</pre>
            </div>
          );
        }
        return (
          <div key={i} className="wilkes-chat__muted">
            Terminal output ({block.terminal_id})
          </div>
        );
      })}
      {tool.rawInput != null && <RawJson label="Input" value={tool.rawInput} />}
      {tool.rawOutput != null && <RawJson label="Output" value={tool.rawOutput} />}
      {!hasDetail && (
        <div className="wilkes-chat__muted">No further detail was reported for this call.</div>
      )}
    </div>
  );
}

export interface MessageBubbleProps {
  message: ChatMessage;
  /** Ticks while a reply streams, so the elapsed readout advances. Ignored for
   *  a finished message, which reads its own end. */
  nowMs: number;
  onAnswerPermission: (requestId: string, option: ChatPermissionOption | null) => void;
  /** Given, a tool call's file locations become buttons. A general chat has
   *  nowhere to open them and leaves them as text. */
  onOpenLocation?: (location: ChatToolLocation) => void;
  /** Branch the conversation here. Absent where there is nothing to branch —
   *  an unsaved conversation, a backend that keeps no record. */
  onFork?: (messageId: string) => void;
  /** Re-ask this question differently, in a branch of its own. Offered on the
   *  user's own messages only. */
  onEdit?: (messageId: string, text: string) => void;
  /** True while a turn is running or the conversation is not yet saved: both
   *  actions above start a new session, which is not a thing to do underneath
   *  an answer that is still arriving. */
  actionsDisabled?: boolean;
}

export function MessageBubble({
  message,
  nowMs,
  onAnswerPermission,
  onOpenLocation,
  onFork,
  onEdit,
  actionsDisabled = false,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const text = messageText(message);
  const elapsed = messageElapsedLabel(message, nowMs);
  const hasThought = !isUser && message.thought.trim().length > 0;

  return (
    <div className={`wilkes-chat__message wilkes-chat__message--${isUser ? "user" : "assistant"}`}>
      <div className="wilkes-chat__message-meta">
        <span>{isUser ? "You" : "Assistant"}</span>
        {elapsed && <span className="wilkes-chat__dim"> · {elapsed}</span>}
      </div>

      <div className="wilkes-chat__bubble">
        {hasThought && (
          <div className="wilkes-chat__thought">
            <button
              type="button"
              className="wilkes-chat__chip"
              aria-expanded={thinkingOpen}
              onClick={() => setThinkingOpen((open) => !open)}
            >
              <ChevronIcon
                size={10}
                className={thinkingOpen ? "wilkes-chat__chevron" : "wilkes-chat__chevron wilkes-chat__chevron--closed"}
              />
              <span>{message.streaming ? "Thinking…" : "Thinking"}</span>
            </button>
            {thinkingOpen && <pre className="wilkes-chat__pre">{message.thought}</pre>}
          </div>
        )}

        {message.permissions.length > 0 && (
          <div className="wilkes-chat__permissions">
            {message.permissions.map((prompt) => (
              <PermissionPrompt
                key={prompt.requestId}
                prompt={prompt}
                onAnswer={onAnswerPermission}
              />
            ))}
          </div>
        )}

        {isUser && editing ? (
          <div className="wilkes-chat__edit">
            <textarea
              className="wilkes-chat__textarea"
              aria-label="Edit message text"
              value={draft}
              rows={Math.max(2, Math.min(10, draft.split("\n").length))}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setEditing(false);
              }}
            />
            <div className="wilkes-chat__edit-actions">
              <button
                type="button"
                className="wilkes-chat__button"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="wilkes-chat__button wilkes-chat__button--primary"
                disabled={!draft.trim()}
                onClick={() => {
                  setEditing(false);
                  onEdit?.(message.id, draft.trim());
                }}
              >
                Ask in a branch
              </button>
            </div>
          </div>
        ) : isUser ? (
          <span className="wilkes-chat__user-text">{text}</span>
        ) : (
          <div className="wilkes-chat__blocks">
            {message.content.map((block, index) => {
              if (block.kind === "text") {
                return (
                  <div className="wilkes-chat__prose" key={`text-${index}`}>
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        // Every link leaves the application, so none of them
                        // navigate it: a chat is not a browser, and a relative
                        // href from a model has no meaning here.
                        a: ({ children, href }) => (
                          <a href={href} target="_blank" rel="noreferrer noopener">
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {block.text}
                    </ReactMarkdown>
                  </div>
                );
              }
              const tool = block.tool;
              const expanded = expandedToolId === tool.toolCallId;
              return (
                <div key={`tool-${tool.toolCallId}`} className="wilkes-chat__tool">
                  <button
                    type="button"
                    className="wilkes-chat__chip"
                    aria-expanded={expanded}
                    onClick={() => setExpandedToolId(expanded ? null : tool.toolCallId)}
                  >
                    <ToolIcon size={10} />
                    <span className="wilkes-chat__tool-title">{tool.title}</span>
                    <span className="wilkes-chat__dim">{toolStatusMark(tool.status)}</span>
                  </button>
                  {expanded && (
                    <ToolCallDetail tool={tool} onOpenLocation={onOpenLocation} />
                  )}
                </div>
              );
            })}
            {message.content.length === 0 && message.streaming && (
              <span className="wilkes-chat__dim">…</span>
            )}
            {message.streaming && <span className="wilkes-chat__caret">▍</span>}
          </div>
        )}

        {message.error && <div className="wilkes-chat__message-error">{message.error}</div>}
      </div>

      <div className="wilkes-chat__message-actions">
        <CopyButton text={text} label={`Copy ${isUser ? "your" : "the assistant's"} message`} />
        {isUser && onEdit && !editing && (
          <button
            type="button"
            className="wilkes-chat__icon-button"
            title="Ask this differently, in a branch"
            aria-label="Edit your message"
            disabled={actionsDisabled}
            onClick={() => {
              setDraft(text);
              setEditing(true);
            }}
          >
            <EditIcon size={11} />
          </button>
        )}
        {onFork && (
          <button
            type="button"
            className="wilkes-chat__icon-button"
            title="Branch the conversation here"
            aria-label={`Branch from ${isUser ? "your" : "the assistant's"} message`}
            disabled={actionsDisabled || message.streaming}
            onClick={() => onFork(message.id)}
          >
            <BranchIcon size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
