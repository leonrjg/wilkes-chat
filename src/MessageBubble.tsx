import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CheckIcon, ChevronIcon, CopyIcon, ToolIcon } from "./icons";
import {
  messageElapsedLabel,
  messageText,
  type ChatMessage,
  type ChatPermissionPrompt,
  type ChatToolChip,
} from "./transcript";
import type { ChatPermissionOption, ChatToolLocation } from "./types";

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
      className="acp-chat__icon-button"
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
    <div className="acp-chat__permission">
      <div className="acp-chat__permission-title">
        {prompt.title
          ? `The agent wants to: ${prompt.title}`
          : "The agent is asking permission to run a tool"}
      </div>
      {prompt.decision === null ? (
        <div className="acp-chat__permission-options">
          {prompt.options.map((option) => (
            <button
              key={option.option_id}
              type="button"
              className={
                option.kind.startsWith("allow")
                  ? "acp-chat__button acp-chat__button--primary"
                  : "acp-chat__button"
              }
              onClick={() => onAnswer(prompt.requestId, option)}
            >
              {option.name}
            </button>
          ))}
        </div>
      ) : (
        <div className="acp-chat__permission-decision">{prompt.decision}</div>
      )}
    </div>
  );
}

function RawJson({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="acp-chat__raw">
      <div className="acp-chat__raw-label">{label}</div>
      <pre className="acp-chat__pre">{JSON.stringify(value, null, 2)}</pre>
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
    <div className="acp-chat__tool-detail">
      {tool.locations.length > 0 && (
        <div className="acp-chat__locations">
          {tool.locations.map((location, i) =>
            onOpenLocation ? (
              <button
                key={i}
                type="button"
                className="acp-chat__location acp-chat__location--actionable"
                onClick={() => onOpenLocation(location)}
              >
                {location.path}
                {location.line != null && `:${location.line}`}
              </button>
            ) : (
              <span key={i} className="acp-chat__location">
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
            <pre key={i} className="acp-chat__pre">
              {block.text}
            </pre>
          );
        }
        if (block.kind === "diff") {
          return (
            <div key={i} className="acp-chat__diff">
              <div className="acp-chat__diff-path">{block.path}</div>
              {block.old_text != null && (
                <pre className="acp-chat__pre acp-chat__pre--removed">- {block.old_text}</pre>
              )}
              <pre className="acp-chat__pre acp-chat__pre--added">+ {block.new_text}</pre>
            </div>
          );
        }
        return (
          <div key={i} className="acp-chat__muted">
            Terminal output ({block.terminal_id})
          </div>
        );
      })}
      {tool.rawInput != null && <RawJson label="Input" value={tool.rawInput} />}
      {tool.rawOutput != null && <RawJson label="Output" value={tool.rawOutput} />}
      {!hasDetail && (
        <div className="acp-chat__muted">No further detail was reported for this call.</div>
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
}

export function MessageBubble({
  message,
  nowMs,
  onAnswerPermission,
  onOpenLocation,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const text = messageText(message);
  const elapsed = messageElapsedLabel(message, nowMs);
  const hasThought = !isUser && message.thought.trim().length > 0;

  return (
    <div className={`acp-chat__message acp-chat__message--${isUser ? "user" : "assistant"}`}>
      <div className="acp-chat__message-meta">
        <span>{isUser ? "You" : "Assistant"}</span>
        {elapsed && <span className="acp-chat__dim"> · {elapsed}</span>}
      </div>

      <div className="acp-chat__bubble">
        {hasThought && (
          <div className="acp-chat__thought">
            <button
              type="button"
              className="acp-chat__chip"
              aria-expanded={thinkingOpen}
              onClick={() => setThinkingOpen((open) => !open)}
            >
              <ChevronIcon
                size={10}
                className={thinkingOpen ? "acp-chat__chevron" : "acp-chat__chevron acp-chat__chevron--closed"}
              />
              <span>{message.streaming ? "Thinking…" : "Thinking"}</span>
            </button>
            {thinkingOpen && <pre className="acp-chat__pre">{message.thought}</pre>}
          </div>
        )}

        {message.permissions.length > 0 && (
          <div className="acp-chat__permissions">
            {message.permissions.map((prompt) => (
              <PermissionPrompt
                key={prompt.requestId}
                prompt={prompt}
                onAnswer={onAnswerPermission}
              />
            ))}
          </div>
        )}

        {isUser ? (
          <span className="acp-chat__user-text">{text}</span>
        ) : (
          <div className="acp-chat__blocks">
            {message.content.map((block, index) => {
              if (block.kind === "text") {
                return (
                  <div className="acp-chat__prose" key={`text-${index}`}>
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
                <div key={`tool-${tool.toolCallId}`} className="acp-chat__tool">
                  <button
                    type="button"
                    className="acp-chat__chip"
                    aria-expanded={expanded}
                    onClick={() => setExpandedToolId(expanded ? null : tool.toolCallId)}
                  >
                    <ToolIcon size={10} />
                    <span className="acp-chat__tool-title">{tool.title}</span>
                    <span className="acp-chat__dim">{toolStatusMark(tool.status)}</span>
                  </button>
                  {expanded && (
                    <ToolCallDetail tool={tool} onOpenLocation={onOpenLocation} />
                  )}
                </div>
              );
            })}
            {message.content.length === 0 && message.streaming && (
              <span className="acp-chat__dim">…</span>
            )}
            {message.streaming && <span className="acp-chat__caret">▍</span>}
          </div>
        )}

        {message.error && <div className="acp-chat__message-error">{message.error}</div>}
      </div>

      <div className="acp-chat__message-actions">
        <CopyButton text={text} label={`Copy ${isUser ? "your" : "the assistant's"} message`} />
      </div>
    </div>
  );
}
