import { describe, expect, it } from "vitest";

import {
  applyUpdate,
  dismissUndecided,
  emptyAssistantMessage,
  formatElapsed,
  isNearBottom,
  messageText,
  shouldStickToBottom,
  userMessage,
  type ChatMessage,
} from "./transcript.js";

function answer(): ChatMessage {
  return emptyAssistantMessage("t1", 0);
}

describe("folding updates into a message", () => {
  it("accumulates text deltas into one block", () => {
    let message = answer();
    message = applyUpdate(message, { kind: "text", delta: "Hel" });
    message = applyUpdate(message, { kind: "text", delta: "lo" });

    expect(message.content).toHaveLength(1);
    expect(messageText(message)).toBe("Hello");
  });

  it("starts a new block for text that comes after a tool call", () => {
    // Otherwise the reply reads out of order: what the agent said after the
    // tool ran would be appended to what it said before.
    let message = answer();
    message = applyUpdate(message, { kind: "text", delta: "Looking…" });
    message = applyUpdate(message, {
      kind: "tool",
      tool_call_id: "c1",
      title: "Read",
      status: "completed",
    });
    message = applyUpdate(message, { kind: "text", delta: "Found it." });

    expect(message.content).toHaveLength(3);
    expect(messageText(message)).toBe("Looking…\n\nFound it.");
  });

  it("keeps a tool field the update did not carry", () => {
    let message = answer();
    message = applyUpdate(message, {
      kind: "tool",
      tool_call_id: "c1",
      title: "Read config.toml",
      status: "pending",
    });
    message = applyUpdate(message, {
      kind: "tool",
      tool_call_id: "c1",
      status: "completed",
    });

    expect(message.content).toHaveLength(1);
    const block = message.content[0];
    expect(block.kind).toBe("tool");
    if (block.kind !== "tool") throw new Error("unreachable");
    expect(block.tool.status).toBe("completed");
    expect(block.tool.title).toBe("Read config.toml");
  });

  it("gives a tool call reported with no title a name anyway", () => {
    // A chip with an empty label is a chip nobody can identify; the agent is
    // allowed to send the update before it knows what to call it.
    let message = answer();
    message = applyUpdate(message, { kind: "tool", tool_call_id: "c1" });

    const block = message.content[0];
    if (block.kind !== "tool") throw new Error("expected a tool block");
    expect(block.tool.title).toBe("Tool call");
    expect(block.tool.status).toBe("pending");
  });

  it("ignores a second permission request with an id it already has", () => {
    // The agent can repeat a request; showing it twice would ask the user to
    // decide the same thing two ways.
    let message = answer();
    const request = {
      kind: "permission" as const,
      request_id: "r1",
      tool_call_id: "c1",
      title: "Run tests",
      options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }],
    };
    message = applyUpdate(message, request);
    message = applyUpdate(message, request);

    expect(message.permissions).toHaveLength(1);
  });

  it("marks an unanswered permission dismissed once the turn ends", () => {
    let message = answer();
    message = applyUpdate(message, {
      kind: "permission",
      request_id: "r1",
      tool_call_id: "c1",
      title: null,
      options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }],
    });

    const settled = dismissUndecided(message.permissions);
    expect(settled[0].decision).toBe("Dismissed");
  });

  it("leaves an already-answered permission alone", () => {
    const answered = [
      {
        requestId: "r1",
        toolCallId: "c1",
        title: null,
        options: [],
        decision: "Allow",
      },
    ];
    expect(dismissUndecided(answered)).toBe(answered);
  });

  it("keeps a user message's text as one block", () => {
    expect(messageText(userMessage("m1", "hello"))).toBe("hello");
  });
});

describe("deciding whether the transcript follows its bottom", () => {
  const atBottom = { scrollHeight: 1000, scrollTop: 900, clientHeight: 100 };
  const scrolledUp = { scrollHeight: 1000, scrollTop: 200, clientHeight: 100 };

  it("stays attached while the reader is at the bottom", () => {
    expect(shouldStickToBottom(atBottom, 900, true)).toBe(true);
  });

  it("detaches as soon as the reader is away from the bottom", () => {
    expect(shouldStickToBottom(scrolledUp, 900, true)).toBe(false);
  });

  it("does not reattach merely because the reader is near the bottom", () => {
    // A reader who scrolled up a little is near the bottom too; re-pinning
    // them would undo the gesture they just made.
    const nudgedUp = { scrollHeight: 1000, scrollTop: 880, clientHeight: 100 };
    expect(shouldStickToBottom(nudgedUp, 900, false)).toBe(false);
  });

  it("reattaches on a downward move that arrives at the bottom", () => {
    expect(shouldStickToBottom(atBottom, 880, false)).toBe(true);
  });

  it("treats a transcript shorter than its viewport as at the bottom", () => {
    expect(isNearBottom({ scrollHeight: 50, scrollTop: 0, clientHeight: 400 })).toBe(true);
  });
});

describe("the elapsed readout", () => {
  it("shows minutes and seconds", () => {
    expect(formatElapsed(9_000)).toBe("0:09");
    expect(formatElapsed(249_000)).toBe("4:09");
  });

  it("shows hours only once there are any", () => {
    expect(formatElapsed(3_849_000)).toBe("1:04:09");
  });

  it("never shows a negative time", () => {
    // Clocks can move; a turn that appears to have ended before it started is
    // a display bug, not something to report as one.
    expect(formatElapsed(-5_000)).toBe("0:00");
  });
});
