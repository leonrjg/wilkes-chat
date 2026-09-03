import { beforeEach, describe, expect, it, vi } from "vitest";

import { createChatStore, type ChatStore } from "./createChatStore";
import { backendStatus, createFakeTransport, type FakeTransport } from "./testing/fakeTransport";
import { messageText } from "./transcript";
import type { ChatConversationRecord } from "./types";

let transport: FakeTransport;
let store: ChatStore;

function build(
  options: Parameters<typeof createFakeTransport>[0] = {},
  storeOptions: Partial<Parameters<typeof createChatStore>[0]> = {},
) {
  transport = createFakeTransport(options);
  store = createChatStore({
    transport,
    // Silence the deliberate failures below; the assertions read state, not
    // the console.
    onBackgroundError: () => {},
    ...storeOptions,
  });
  return store;
}

beforeEach(() => {
  build();
});

describe("opening a session", () => {
  it("starts on the preferred backend when it is available", async () => {
    const onBackendChosen = vi.fn();
    build(
      { backends: [backendStatus("ClaudeCode"), backendStatus("Codex")] },
      { preferredBackend: () => "Codex", onBackendChosen },
    );

    await store.getState().initialize();

    expect(store.getState().backend).toBe("Codex");
    expect(store.getState().sessionId).toBeTruthy();
    // Nothing is written back: opening on the stored preference is reading
    // it, and an application that persisted on every mount would rewrite the
    // same value on every window.
    expect(onBackendChosen).not.toHaveBeenCalled();
  });

  it("records the agent the user picks", async () => {
    const onBackendChosen = vi.fn();
    build(
      { backends: [backendStatus("ClaudeCode"), backendStatus("Codex")] },
      { preferredBackend: () => "ClaudeCode", onBackendChosen },
    );

    await store.getState().switchBackend("Codex");

    expect(onBackendChosen).toHaveBeenCalledWith("Codex");
  });

  it("falls back to an available backend, without recording that as a choice", async () => {
    // Being handed a working agent is not the same as picking one. Recording
    // it would overwrite the user's preference while their agent is briefly
    // unavailable, and they would never get it back.
    const onBackendChosen = vi.fn();
    build(
      {
        backends: [
          backendStatus("ClaudeCode", { available: false, unavailable_reason: "not installed" }),
          backendStatus("Codex"),
        ],
      },
      { preferredBackend: () => "ClaudeCode", onBackendChosen },
    );

    await store.getState().initialize();

    expect(store.getState().backend).toBe("Codex");
    expect(onBackendChosen).not.toHaveBeenCalled();
  });

  it("opens no session when no backend is available", async () => {
    build({
      backends: [
        backendStatus("ClaudeCode", { available: false, installable: true }),
      ],
    });

    await store.getState().initialize();

    expect(store.getState().sessionId).toBeNull();
    expect(store.getState().hasAvailableBackend).toBe(false);
  });

  it("surfaces a handshake failure and leaves no half-open session", async () => {
    // An installed agent that is not logged in fails here, not at spawn, and
    // it is the one failure a user is most likely to hit.
    build({ startFails: "Claude Code exited before the ACP handshake completed" });

    await expect(store.getState().switchBackend("ClaudeCode")).rejects.toThrow();

    const state = store.getState();
    expect(state.sessionId).toBeNull();
    expect(state.starting).toBe(false);
    expect(state.sessionError).toContain("handshake");
  });

  it("closes the previous session when the agent is switched", async () => {
    build({ backends: [backendStatus("ClaudeCode"), backendStatus("Codex")] });
    await store.getState().switchBackend("ClaudeCode");
    const first = store.getState().sessionId;

    await store.getState().switchBackend("Codex");

    expect(transport.closed).toContain(first);
    expect(store.getState().sessionId).not.toBe(first);
  });

  it("stops listening to a session it has replaced", async () => {
    // The listeners outlive the session otherwise: a dead subprocess's error
    // would land on the live one and blame the wrong agent.
    await store.getState().switchBackend("ClaudeCode");
    const first = store.getState().sessionId!;

    await store.getState().switchBackend("ClaudeCode");
    transport.failSession(first, "the old one died");

    expect(store.getState().sessionError).toBeNull();
  });

  it("reports a crash on the session it belongs to", async () => {
    await store.getState().switchBackend("ClaudeCode");
    transport.failSession(store.getState().sessionId!, "subprocess exited");

    expect(store.getState().sessionError).toBe("subprocess exited");
  });
});

describe("a turn", () => {
  beforeEach(async () => {
    await store.getState().switchBackend("ClaudeCode");
  });

  it("shows the question and an answer being written", async () => {
    void store.getState().sendMessage("What is a monad?");

    const state = store.getState();
    expect(state.messages).toHaveLength(2);
    expect(messageText(state.messages[0])).toBe("What is a monad?");
    expect(state.messages[1].streaming).toBe(true);
    expect(state.streaming).toBe(true);
  });

  it("streams deltas into the answer and settles when the turn ends", async () => {
    const sent = store.getState().sendMessage("hello");
    const turn = transport.lastTurn();

    turn.emit({ kind: "text", delta: "Hi " });
    turn.emit({ kind: "text", delta: "there" });
    expect(messageText(store.getState().messages[1])).toBe("Hi there");

    turn.finish();
    await sent;

    const answer = store.getState().messages[1];
    expect(answer.streaming).toBe(false);
    expect(answer.endedAtMs).not.toBeNull();
    expect(store.getState().streaming).toBe(false);
    expect(store.getState().currentTurnId).toBeNull();
  });

  it("refuses to start a second turn while one is running", async () => {
    void store.getState().sendMessage("first");
    await store.getState().sendMessage("second");

    expect(store.getState().messages).toHaveLength(2);
    expect(transport.turns).toHaveLength(1);
  });

  it("keeps the failure on the answer it belongs to", async () => {
    const sent = store.getState().sendMessage("hello");
    transport.lastTurn().fail("the agent went away");
    await sent;

    const answer = store.getState().messages[1];
    expect(answer.error).toBe("the agent went away");
    expect(answer.streaming).toBe(false);
    expect(store.getState().streaming).toBe(false);
  });

  it("adopts the conversation the first turn minted", async () => {
    expect(store.getState().conversationId).toBeNull();
    const sent = store.getState().sendMessage("hello");
    transport.lastTurn().finish();
    await sent;

    expect(store.getState().conversationId).toBeTruthy();
  });

  it("puts the conversation the first turn minted into the history", async () => {
    // The id a turn reports has to name something the history can open, or
    // every reader of it — the menu, a fork — points at nothing.
    const sent = store.getState().sendMessage("What is a monad?");
    transport.lastTurn().emit({ kind: "text", delta: "A monoid." });
    transport.lastTurn().finish();
    await sent;
    await store.getState().loadConversations();

    const conversationId = store.getState().conversationId;
    const listed = store
      .getState()
      .conversations.find((c) => c.conversation_id === conversationId);
    expect(listed, "the turn's conversation is in the history").toBeTruthy();
    expect(listed!.title).toBe("What is a monad?");
    expect(listed!.messages).toHaveLength(2);
  });

  it("keeps a second turn in the same conversation", async () => {
    const first = store.getState().sendMessage("one");
    transport.lastTurn().finish();
    await first;
    const conversationId = store.getState().conversationId;

    const second = store.getState().sendMessage("two");
    transport.lastTurn().finish();
    await second;

    expect(store.getState().conversationId).toBe(conversationId);
    await store.getState().loadConversations();
    expect(store.getState().conversations).toHaveLength(1);
  });

  it("stops a running turn on cancel", async () => {
    const sent = store.getState().sendMessage("hello");
    const turnId = store.getState().currentTurnId;

    await store.getState().cancel();
    await sent;

    expect(transport.cancelled).toEqual([
      { sessionId: store.getState().sessionId, turnId },
    ]);
    expect(store.getState().streaming).toBe(false);
  });

  it("cancels nothing when no turn is running", async () => {
    await store.getState().cancel();
    expect(transport.cancelled).toHaveLength(0);
  });
});

describe("a permission request", () => {
  beforeEach(async () => {
    await store.getState().switchBackend("ClaudeCode");
  });

  const request = {
    kind: "permission" as const,
    request_id: "r1",
    tool_call_id: "c1",
    title: "Run the test suite",
    options: [
      { option_id: "allow", name: "Allow once", kind: "allow_once" },
      { option_id: "deny", name: "Reject", kind: "reject_once" },
    ],
  };

  it("resolves to the chosen option's own label", async () => {
    void store.getState().sendMessage("run the tests");
    transport.lastTurn().emit(request);

    await store.getState().answerPermission("r1", request.options[0]);

    expect(store.getState().messages[1].permissions[0].decision).toBe("Allow once");
    expect(transport.answered).toEqual([{ requestId: "r1", optionId: "allow" }]);
  });

  it("dismisses an unanswered request when the turn ends", async () => {
    // The agent's side cancels it, so live buttons would be offering a choice
    // that no longer reaches anything.
    const sent = store.getState().sendMessage("run the tests");
    const turn = transport.lastTurn();
    turn.emit(request);
    turn.finish();
    await sent;

    expect(store.getState().messages[1].permissions[0].decision).toBe("Dismissed");
  });

  it("sends a null option when the user chooses none", async () => {
    void store.getState().sendMessage("run the tests");
    transport.lastTurn().emit(request);

    await store.getState().answerPermission("r1", null);

    expect(transport.answered).toEqual([{ requestId: "r1", optionId: null }]);
    expect(store.getState().messages[1].permissions[0].decision).toBe("Dismissed");
  });
});

describe("session configuration", () => {
  const model = {
    id: "model",
    name: "Model",
    category: "model",
    current_value: "sonnet",
    choices: [
      { value: "sonnet", name: "Sonnet", group: null },
      { value: "opus", name: "Opus", group: null },
    ],
  };

  it("moves the selection immediately and then takes the agent's answer", async () => {
    build({ configOptions: [model] });
    await store.getState().switchBackend("ClaudeCode");

    const pending = store.getState().setConfigOption("model", "opus");
    expect(store.getState().configOptions[0].current_value).toBe("opus");
    await pending;
    expect(store.getState().configOptions[0].current_value).toBe("opus");
  });

  it("takes a change the agent made on its own", async () => {
    build({ configOptions: [model] });
    await store.getState().switchBackend("ClaudeCode");

    transport.pushConfig(store.getState().sessionId!, [
      { ...model, current_value: "opus" },
    ]);

    expect(store.getState().configOptions[0].current_value).toBe("opus");
  });
});

describe("saved conversations", () => {
  const saved: ChatConversationRecord = {
    conversation_id: "conv-1",
    backend: "ClaudeCode",
    backend_session_id: "agent-session-1",
    cwd: "/tmp/chat",
    title: "What is a monad?",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:05:00Z",
    last_opened_at: "2026-09-01T10:05:00Z",
    config_values: [],
    messages: [
      {
        message_id: "m1",
        turn_id: null,
        role: "user",
        thought: "",
        content: [{ kind: "text", text: "What is a monad?" }],
        error: null,
      },
    ],
  };

  it("reopens one with its transcript", async () => {
    build({ conversations: [saved] });
    await store.getState().loadConversations();

    await store.getState().openConversation("conv-1");

    const state = store.getState();
    expect(state.conversationId).toBe("conv-1");
    expect(state.sessionId).toBeTruthy();
    expect(messageText(state.messages[0])).toBe("What is a monad?");
  });

  it("surfaces a failed reopen without leaving a dead session behind", async () => {
    build({ conversations: [saved] });
    await store.getState().loadConversations();

    await expect(store.getState().openConversation("conv-missing")).rejects.toThrow();

    expect(store.getState().sessionId).toBeNull();
    expect(store.getState().sessionError).toContain("conv-missing");
    expect(store.getState().starting).toBe(false);
  });

  it("keeps the open thread when its record is deleted", async () => {
    // Forgetting a conversation deletes what was saved, not what is on
    // screen — the session is alive and the user may still be reading it.
    build({ conversations: [saved] });
    await store.getState().loadConversations();
    await store.getState().openConversation("conv-1");

    await store.getState().forgetConversation("conv-1");

    expect(store.getState().conversations).toHaveLength(0);
    expect(store.getState().conversationId).toBeNull();
    expect(store.getState().sessionId).toBeTruthy();
    expect(store.getState().messages).toHaveLength(1);
  });
});

describe("branching a conversation", () => {
  const saved: ChatConversationRecord = {
    conversation_id: "conv-1",
    backend: "ClaudeCode",
    backend_session_id: "agent-session-1",
    cwd: "/tmp/chat",
    title: "What is a monad?",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:05:00Z",
    last_opened_at: "2026-09-01T10:05:00Z",
    config_values: [],
    messages: [
      {
        message_id: "m1",
        turn_id: "t1",
        role: "user",
        thought: "",
        content: [{ kind: "text", text: "What is a monad?" }],
        error: null,
      },
      {
        message_id: "t1",
        turn_id: "t1",
        role: "assistant",
        thought: "",
        content: [{ kind: "text", text: "A monoid in the category of endofunctors." }],
        error: null,
      },
    ],
  };

  async function opened() {
    build({ conversations: [saved] });
    await store.getState().loadConversations();
    await store.getState().openConversation("conv-1");
  }

  it("keeps an answer when branching from it, and does not re-ask anything", async () => {
    await opened();

    await store.getState().forkFromMessage("t1");

    expect(transport.forked).toEqual([
      { conversationId: "conv-1", messageId: "t1", includeMessage: true },
    ]);
    // Branching from an answer continues *after* it; nothing has been asked.
    expect(transport.turns).toHaveLength(0);
    expect(store.getState().messages).toHaveLength(2);
  });

  it("re-asks a question when branching from it", async () => {
    await opened();

    await store.getState().forkFromMessage("m1");

    expect(transport.forked[0].includeMessage).toBe(false);
    expect(transport.turns).toHaveLength(1);
    expect(transport.lastTurn().text).toBe("What is a monad?");
  });

  it("closes the session it branched away from", async () => {
    await opened();
    const before = store.getState().sessionId;

    await store.getState().forkFromMessage("t1");

    expect(transport.closed).toContain(before);
    expect(store.getState().sessionId).not.toBe(before);
  });

  it("asks the edited question instead of the original", async () => {
    await opened();

    await store.getState().editMessage("m1", "  What is a functor?  ");

    expect(transport.forked[0]).toEqual({
      conversationId: "conv-1",
      messageId: "m1",
      includeMessage: false,
    });
    expect(transport.lastTurn().text).toBe("What is a functor?");
  });

  it("will not edit an answer, only a question", async () => {
    await opened();

    await store.getState().editMessage("t1", "rewritten");

    expect(transport.forked).toHaveLength(0);
  });

  it("will not edit a question to nothing", async () => {
    await opened();

    await store.getState().editMessage("m1", "   ");

    expect(transport.forked).toHaveLength(0);
  });

  it("branches nothing from an unsaved conversation", async () => {
    // The fork is taken from the record on disk, and a backend that keeps no
    // record has none to take.
    build();
    await store.getState().switchBackend("ClaudeCode");

    await store.getState().forkFromMessage("whatever");

    expect(transport.forked).toHaveLength(0);
  });

  it("branches nothing while a turn is running", async () => {
    await opened();
    void store.getState().sendMessage("hold on");

    await store.getState().forkFromMessage("t1");

    expect(transport.forked).toHaveLength(0);
  });
});

describe("resetting", () => {
  it("closes the session and empties the thread", async () => {
    await store.getState().switchBackend("ClaudeCode");
    const sessionId = store.getState().sessionId;

    store.getState().reset();

    expect(transport.closed).toContain(sessionId);
    expect(store.getState().sessionId).toBeNull();
    expect(store.getState().messages).toHaveLength(0);
    expect(store.getState().backend).toBeNull();
  });
});
