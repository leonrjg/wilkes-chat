import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ChatPane } from "./ChatPane";
import { createChatStore, type ChatStore } from "./createChatStore";
import { backendStatus, createFakeTransport, type FakeTransport } from "./testing/fakeTransport";

let transport: FakeTransport;
let store: ChatStore;

function build(options: Parameters<typeof createFakeTransport>[0] = {}) {
  transport = createFakeTransport(options);
  store = createChatStore({ transport, onBackgroundError: () => {} });
}

/** Mount and wait for the session the pane opens on mount. */
async function mount(props: Partial<React.ComponentProps<typeof ChatPane>> = {}) {
  const rendered = render(<ChatPane store={store} {...props} />);
  await waitFor(() => expect(store.getState().backendsLoaded).toBe(true));
  return rendered;
}

beforeEach(() => {
  build();
});

describe("with no agent installed", () => {
  it("says so and offers to install the one that can be", async () => {
    build({
      backends: [
        backendStatus("ClaudeCode", {
          label: "Claude Code",
          available: false,
          installable: true,
          unavailable_reason: "the adapter is not downloaded yet",
        }),
      ],
    });
    await mount();

    expect(await screen.findByText("No agent is set up yet.")).toBeInTheDocument();
    expect(screen.getByText("the adapter is not downloaded yet")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /install/i }));

    await waitFor(() => expect(store.getState().hasAvailableBackend).toBe(true));
  });

  it("offers a recheck rather than only a reason", async () => {
    // Installing an agent happens outside the window; without this the only
    // way to notice is to restart the application.
    build({
      backends: [
        backendStatus("ClaudeCode", {
          available: false,
          installable: false,
          unavailable_reason: "Node.js was not found on PATH",
        }),
      ],
    });
    await mount();

    expect(await screen.findByRole("button", { name: /recheck/i })).toBeInTheDocument();
  });

  it("will not let a message be typed", async () => {
    build({
      backends: [backendStatus("ClaudeCode", { available: false, installable: true })],
    });
    await mount();

    expect(await screen.findByLabelText("Message")).toBeDisabled();
  });
});

describe("with an agent running", () => {
  it("sends what was typed and shows the answer as it arrives", async () => {
    await mount();
    await waitFor(() => expect(store.getState().sessionId).toBeTruthy());

    await userEvent.type(screen.getByLabelText("Message"), "What is a monad?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText("What is a monad?")).toBeInTheDocument();
    const turn = transport.lastTurn();

    act(() => turn.emit({ kind: "text", delta: "A monoid in the category of endofunctors." }));
    expect(
      await screen.findByText(/A monoid in the category of endofunctors/),
    ).toBeInTheDocument();

    act(() => turn.finish());
    await waitFor(() => expect(store.getState().streaming).toBe(false));
  });

  it("sends on Enter and takes a new line on Shift+Enter", async () => {
    await mount();
    await waitFor(() => expect(store.getState().sessionId).toBeTruthy());
    const box = screen.getByLabelText("Message");

    await userEvent.type(box, "first line{Shift>}{Enter}{/Shift}second line");
    expect(transport.turns).toHaveLength(0);
    expect(box).toHaveValue("first line\nsecond line");

    await userEvent.type(box, "{Enter}");
    await waitFor(() => expect(transport.turns).toHaveLength(1));
    expect(transport.lastTurn().text).toBe("first line\nsecond line");
  });

  it("will not send an empty message", async () => {
    await mount();
    await waitFor(() => expect(store.getState().sessionId).toBeTruthy());

    await userEvent.type(screen.getByLabelText("Message"), "   ");
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });

  it("offers Stop instead of Send while a turn runs, and stops it", async () => {
    await mount();
    await waitFor(() => expect(store.getState().sessionId).toBeTruthy());

    await userEvent.type(screen.getByLabelText("Message"), "hello{Enter}");
    const stop = await screen.findByRole("button", { name: /stop/i });
    expect(screen.queryByRole("button", { name: /^send$/i })).not.toBeInTheDocument();

    await userEvent.click(stop);
    await waitFor(() => expect(transport.cancelled).toHaveLength(1));
    expect(await screen.findByRole("button", { name: /send/i })).toBeInTheDocument();
  });

  it("puts the agent's own permission options in front of the user", async () => {
    await mount();
    await waitFor(() => expect(store.getState().sessionId).toBeTruthy());
    await userEvent.type(screen.getByLabelText("Message"), "run the tests{Enter}");
    await waitFor(() => expect(transport.turns).toHaveLength(1));

    act(() =>
      transport.lastTurn().emit({
        kind: "permission",
        request_id: "r1",
        tool_call_id: "c1",
        title: "Run the test suite",
        options: [
          { option_id: "allow", name: "Allow once", kind: "allow_once" },
          { option_id: "deny", name: "Reject", kind: "reject_once" },
        ],
      }),
    );

    expect(await screen.findByText(/Run the test suite/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Allow once" }));

    // Echoed back by the agent's own option id, never reinterpreted.
    expect(transport.answered).toEqual([{ requestId: "r1", optionId: "allow" }]);
    expect(await screen.findByText("Allow once")).toBeInTheDocument();
  });

  it("shows a tool call as a chip, and its detail only when asked", async () => {
    await mount();
    await waitFor(() => expect(store.getState().sessionId).toBeTruthy());
    await userEvent.type(screen.getByLabelText("Message"), "read it{Enter}");
    await waitFor(() => expect(transport.turns).toHaveLength(1));

    act(() =>
      transport.lastTurn().emit({
        kind: "tool",
        tool_call_id: "c1",
        title: "Read config.toml",
        status: "completed",
        content: [{ kind: "text", text: "port = 8080" }],
      }),
    );

    const chip = await screen.findByRole("button", { name: /Read config\.toml/ });
    expect(screen.queryByText("port = 8080")).not.toBeInTheDocument();

    await userEvent.click(chip);
    expect(await screen.findByText("port = 8080")).toBeInTheDocument();
  });

  it("reports a dead subprocess and offers to start again", async () => {
    await mount();
    await waitFor(() => expect(store.getState().sessionId).toBeTruthy());

    act(() => transport.failSession(store.getState().sessionId!, "the agent exited"));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/the agent exited/)).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

const SAVED_THREAD = {
  conversation_id: "conv-1",
  backend: "ClaudeCode" as const,
  backend_session_id: "agent-1",
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
      role: "user" as const,
      thought: "",
      content: [{ kind: "text" as const, text: "What is a monad?" }],
      error: null,
    },
    {
      message_id: "t1",
      turn_id: "t1",
      role: "assistant" as const,
      thought: "",
      content: [{ kind: "text" as const, text: "A monoid in the category of endofunctors." }],
      error: null,
    },
  ],
};

describe("branching", () => {
  async function openSaved() {
    build({ conversations: [SAVED_THREAD] });
    await mount();
    await waitFor(() => expect(store.getState().conversations).toHaveLength(1));
    await act(async () => {
      await store.getState().openConversation("conv-1");
    });
  }

  it("offers a branch on every message once the conversation is saved", async () => {
    await openSaved();

    expect(
      await screen.findByRole("button", { name: /branch from your message/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /branch from the assistant's message/i })).toBeTruthy();
  });

  it("offers no branch on an unsaved conversation", async () => {
    // There is no record to branch from yet, so a button here would be one
    // that cannot work.
    build();
    await mount();
    await waitFor(() => expect(store.getState().sessionId).toBeTruthy());
    await userEvent.type(screen.getByLabelText("Message"), "hello{Enter}");
    await screen.findByText("hello");

    expect(screen.queryByRole("button", { name: /branch from/i })).toBeNull();
  });

  it("branches from an answer", async () => {
    await openSaved();

    await userEvent.click(
      await screen.findByRole("button", { name: /branch from the assistant's message/i }),
    );

    await waitFor(() => expect(transport.forked).toHaveLength(1));
    expect(transport.forked[0].includeMessage).toBe(true);
  });

  it("re-asks an edited question in a branch of its own", async () => {
    await openSaved();

    await userEvent.click(await screen.findByRole("button", { name: /edit your message/i }));
    const box = await screen.findByLabelText("Edit message text");
    await userEvent.clear(box);
    await userEvent.type(box, "What is a functor?");
    await userEvent.click(screen.getByRole("button", { name: /ask in a branch/i }));

    await waitFor(() => expect(transport.forked).toHaveLength(1));
    expect(transport.forked[0].includeMessage).toBe(false);
    await waitFor(() => expect(transport.turns).toHaveLength(1));
    expect(transport.lastTurn().text).toBe("What is a functor?");
  });

  it("lets an edit be abandoned", async () => {
    await openSaved();

    await userEvent.click(await screen.findByRole("button", { name: /edit your message/i }));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.queryByLabelText("Edit message text")).toBeNull();
    expect(transport.forked).toHaveLength(0);
    // The original is still there, unchanged.
    expect(screen.getByText("What is a monad?")).toBeTruthy();
  });

  it("offers no edit on an assistant message", async () => {
    await openSaved();
    await screen.findByRole("button", { name: /branch from your message/i });

    expect(screen.getAllByRole("button", { name: /edit your message/i })).toHaveLength(1);
  });
});

describe("saved chats", () => {
  it("marks a branch so it is not mistaken for an unrelated chat", async () => {
    build({
      conversations: [
        { ...SAVED_THREAD, conversation_id: "conv-2", title: "Fork of What is a monad?", parent_conversation_id: "conv-1" },
        SAVED_THREAD,
      ],
    });
    await mount();
    await waitFor(() => expect(store.getState().conversations).toHaveLength(2));

    await userEvent.click(screen.getByRole("button", { name: /saved chats/i }));
    expect(await screen.findByText(/↳/)).toBeTruthy();
  });

  it("lists them and reopens the one that is picked", async () => {
    build({
      conversations: [
        {
          conversation_id: "conv-1",
          backend: "ClaudeCode",
          backend_session_id: "agent-1",
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
        },
      ],
    });
    await mount();
    await waitFor(() => expect(store.getState().conversations).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: /saved chats/i }));
    await userEvent.click(await screen.findByText("What is a monad?"));

    await waitFor(() => expect(store.getState().conversationId).toBe("conv-1"));
    expect(await screen.findByText("What is a monad?")).toBeInTheDocument();
  });

  it("asks before deleting one", async () => {
    let asked = "";
    build({
      conversations: [
        {
          conversation_id: "conv-1",
          backend: "ClaudeCode",
          backend_session_id: "agent-1",
          cwd: "/tmp/chat",
          title: "Doomed chat",
          created_at: "2026-09-01T10:00:00Z",
          updated_at: "2026-09-01T10:05:00Z",
          last_opened_at: "2026-09-01T10:05:00Z",
          config_values: [],
          messages: [],
        },
      ],
    });
    await mount({
      confirmDelete: (title) => {
        asked = title;
        return true;
      },
    });
    await waitFor(() => expect(store.getState().conversations).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: /saved chats/i }));
    await userEvent.click(await screen.findByRole("button", { name: /delete doomed chat/i }));

    expect(asked).toBe("Doomed chat");
    await waitFor(() => expect(store.getState().conversations).toHaveLength(0));
  });
});

describe("what an application puts around the thread", () => {
  it("keeps its context bar out of the transcript's scroll", async () => {
    // The bar says what the *next* message will be answered from, so scrolling
    // back through what was already said must not carry it off the screen.
    await mount({
      contextBar: <span>Answering from paper.pdf</span>,
    });

    const bar = await screen.findByText("Answering from paper.pdf");
    expect(bar).toBeInTheDocument();
    expect(bar.closest(".wilkes-chat__transcript")).toBeNull();
  });

  it("lets a host say something more useful than the keyboard hint", async () => {
    await mount({ hint: <span>Answering about 2 documents</span> });

    expect(await screen.findByText("Answering about 2 documents")).toBeInTheDocument();
    expect(screen.queryByText(/Shift\+Enter/)).toBeNull();
  });

  it("falls back to the keyboard hint when it has nothing else to say", async () => {
    await mount();

    expect(await screen.findByText(/Shift\+Enter for a new line/)).toBeInTheDocument();
  });
});
