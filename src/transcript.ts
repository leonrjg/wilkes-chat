// The transcript, as the window holds it: the view model, the fold that keeps
// it up to date, and the scroll rules that decide whether it follows.
//
// All pure. Nothing here touches a transport, a store or the DOM, which is
// what makes the parts that are easy to get wrong — patch semantics on a tool
// call, "is the reader still at the bottom" — testable without a subprocess.

import type {
  ChatMessageRecord,
  ChatPermissionOption,
  ChatToolContentBlock,
  ChatToolLocation,
  ChatUpdate,
} from "./types.js";

export interface ChatToolChip {
  toolCallId: string;
  title: string;
  status: string;
  locations: ChatToolLocation[];
  content: ChatToolContentBlock[];
  rawInput: unknown;
  rawOutput: unknown;
}

/** A permission request surfaced for the user to answer. While `decision` is
 *  null the buttons are live; once answered it holds the chosen option's label
 *  — or "Dismissed", when the turn ended before anyone clicked. */
export interface ChatPermissionPrompt {
  requestId: string;
  toolCallId: string;
  title: string | null;
  options: ChatPermissionOption[];
  decision: string | null;
}

export type ChatMessageContentBlock =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ChatToolChip };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: ChatMessageContentBlock[];
  thought: string;
  streaming: boolean;
  error: string | null;
  permissions: ChatPermissionPrompt[];
  /** Wall-clock bounds of the turn, for the elapsed readout. Null on a message
   *  that was replayed rather than watched. */
  startedAtMs: number | null;
  endedAtMs: number | null;
}

export function emptyAssistantMessage(id: string, startedAtMs: number): ChatMessage {
  return {
    id,
    role: "assistant",
    content: [],
    thought: "",
    streaming: true,
    error: null,
    permissions: [],
    startedAtMs,
    endedAtMs: null,
  };
}

export function userMessage(id: string, text: string): ChatMessage {
  return {
    id,
    role: "user",
    content: [{ kind: "text", text }],
    thought: "",
    streaming: false,
    error: null,
    permissions: [],
    startedAtMs: null,
    endedAtMs: null,
  };
}

/** A stored message, as the window shows it. */
export function messageFromRecord(record: ChatMessageRecord): ChatMessage {
  return {
    id: record.message_id,
    role: record.role,
    content: record.content.map((block) =>
      block.kind === "text"
        ? block
        : {
            kind: "tool" as const,
            tool: {
              toolCallId: block.tool.tool_call_id,
              title: block.tool.title,
              status: block.tool.status,
              locations: block.tool.locations,
              content: block.tool.content,
              rawInput: block.tool.raw_input ?? null,
              rawOutput: block.tool.raw_output ?? null,
            },
          },
    ),
    thought: record.thought,
    streaming: false,
    error: record.error,
    permissions: [],
    startedAtMs: null,
    endedAtMs: null,
  };
}

/** The message's prose, without its tool calls — what a copy button copies.
 *
 *  Assistant blocks are joined with a blank line because a block break is
 *  where a tool call ran; user text is one block and joins to itself. */
export function messageText(message: ChatMessage): string {
  return message.content
    .filter(
      (block): block is Extract<ChatMessageContentBlock, { kind: "text" }> =>
        block.kind === "text",
    )
    .map((block) => block.text)
    .join(message.role === "assistant" ? "\n\n" : "");
}

function appendText(
  content: ChatMessageContentBlock[],
  delta: string,
): ChatMessageContentBlock[] {
  const last = content[content.length - 1];
  if (last?.kind === "text") {
    return [...content.slice(0, -1), { kind: "text", text: last.text + delta }];
  }
  // Text after a tool call starts its own block, so the reply reads in the
  // order it happened rather than collapsing across the call.
  return [...content, { kind: "text", text: delta }];
}

function upsertTool(
  content: ChatMessageContentBlock[],
  update: Extract<ChatUpdate, { kind: "tool" }>,
): ChatMessageContentBlock[] {
  const idx = content.findIndex(
    (block) => block.kind === "tool" && block.tool.toolCallId === update.tool_call_id,
  );
  if (idx === -1) {
    return [
      ...content,
      {
        kind: "tool",
        tool: {
          toolCallId: update.tool_call_id,
          title: update.title ?? "Tool call",
          status: update.status ?? "pending",
          locations: update.locations ?? [],
          content: update.content ?? [],
          rawInput: update.raw_input ?? null,
          rawOutput: update.raw_output ?? null,
        },
      },
    ];
  }
  const block = content[idx];
  if (block.kind !== "tool") return content;
  const prev = block.tool;
  const next = [...content];
  // Patch, not replace: an update reports what moved. `??` is deliberate over
  // a presence check — the wire sends absent and null interchangeably.
  next[idx] = {
    kind: "tool",
    tool: {
      ...prev,
      title: update.title ?? prev.title,
      status: update.status ?? prev.status,
      locations: update.locations ?? prev.locations,
      content: update.content ?? prev.content,
      rawInput: update.raw_input !== undefined ? update.raw_input : prev.rawInput,
      rawOutput: update.raw_output !== undefined ? update.raw_output : prev.rawOutput,
    },
  };
  return next;
}

function upsertPermission(
  permissions: ChatPermissionPrompt[],
  update: Extract<ChatUpdate, { kind: "permission" }>,
): ChatPermissionPrompt[] {
  if (permissions.some((p) => p.requestId === update.request_id)) return permissions;
  return [
    ...permissions,
    {
      requestId: update.request_id,
      toolCallId: update.tool_call_id,
      title: update.title ?? null,
      options: update.options,
      decision: null,
    },
  ];
}

/** When a turn ends the agent's side cancels any request nobody answered;
 *  reflect that so a stale prompt stops offering buttons that do nothing. */
export function dismissUndecided(
  permissions: ChatPermissionPrompt[],
): ChatPermissionPrompt[] {
  if (!permissions.some((p) => p.decision === null)) return permissions;
  return permissions.map((p) =>
    p.decision === null ? { ...p, decision: "Dismissed" } : p,
  );
}

export function applyUpdate(message: ChatMessage, update: ChatUpdate): ChatMessage {
  switch (update.kind) {
    case "text":
      return { ...message, content: appendText(message.content, update.delta) };
    case "thought":
      return { ...message, thought: message.thought + update.delta };
    case "tool":
      return { ...message, content: upsertTool(message.content, update) };
    case "permission":
      return {
        ...message,
        permissions: upsertPermission(message.permissions, update),
      };
    case "error":
      return { ...message, error: update.message };
  }
}

// ── Following the bottom of a transcript ────────────────────────────────────
//
// A streaming reply grows the scroll height under the reader. Following it is
// right until the reader scrolls up to read something, and then it is the
// single most irritating thing a chat window can do. These decide when to let
// go and when to take hold again — the rule being that the reader detaches by
// gesture and reattaches by arriving back at the bottom.

export interface ScrollExtent {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function isNearBottom(scroll: ScrollExtent, thresholdPx = 48): boolean {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= thresholdPx;
}

export function isScrollUpKey(key: string): boolean {
  return key === "ArrowUp" || key === "PageUp" || key === "Home";
}

/** Whether the transcript should still be pinned to its bottom.
 *
 *  Being near the bottom is necessary but not sufficient: a reader who scrolled
 *  up a little is near the bottom too, and re-pinning them there would undo the
 *  gesture they just made. So a detached transcript only reattaches on a
 *  *downward* movement that reaches the bottom. */
export function shouldStickToBottom(
  scroll: ScrollExtent,
  previousScrollTop: number,
  currentlyStuck: boolean,
): boolean {
  if (!isNearBottom(scroll)) return false;
  return currentlyStuck || scroll.scrollTop > previousScrollTop;
}

/** `1:04:09`, `4:09`, `0:09`. Hours appear only once there are any. */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

export function messageElapsedLabel(
  message: ChatMessage,
  nowMs: number,
): string | null {
  if (message.role !== "assistant" || message.startedAtMs == null) return null;
  return formatElapsed((message.endedAtMs ?? nowMs) - message.startedAtMs);
}

/** `Mar 4`. Undated rather than wrong when the timestamp will not parse. */
export function formatConversationDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
