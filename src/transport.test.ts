import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { CHAT_COMMANDS, chatChannel } from "./transport";

const calls: Array<{ command: string; args: Record<string, unknown> }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    return Promise.resolve({});
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

// `CHAT_COMMANDS` is what a host asserts its `generate_handler!` against, so
// it has to be the truth about what this package actually calls. Two lists in
// two files is how it stops being that — and the failure is silent on both
// sides: a host would register a command nothing invokes, and the client would
// invoke one nothing registered.

const here = dirname(fileURLToPath(import.meta.url));
const client = readFileSync(resolve(here, "./tauri.ts"), "utf8");

function invoked(source: string): string[] {
  return [...source.matchAll(/\binvoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

describe("the commands this package promises to call", () => {
  const actual = [...new Set(invoked(client))].sort();

  it("finds them at all", () => {
    // A regex that quietly stopped matching would make the comparison below
    // vacuously true, which is this kind of test's whole failure mode.
    expect(actual.length).toBeGreaterThan(5);
  });

  it("is exactly what CHAT_COMMANDS says", () => {
    expect(actual).toEqual([...CHAT_COMMANDS].sort());
  });
});

describe("the event channels", () => {
  it("are keyed by the id they belong to", () => {
    // A turn's channel carries the turn id and the session's carries the
    // session id. Getting that backwards would deliver a crash to a client
    // listening for one message, and only when a subprocess died between
    // turns — which is when nobody is listening for a message at all.
    expect(chatChannel.update("t1")).toBe("chat/update-t1");
    expect(chatChannel.done("t1")).toBe("chat/done-t1");
    expect(chatChannel.sessionError("s1")).toBe("chat/session-error-s1");
    expect(chatChannel.config("s1")).toBe("chat/config-s1");
  });
});

describe("the host blob on the wire", () => {
  it("is absent from the payload when the application has no domain", async () => {
    // A general-purpose chat's commands do not declare a `host` argument.
    // Sending `host: null` would make them fail to deserialize on hosts that
    // never asked for one — so the key must not be there at all.
    const { tauriChatTransport } = await import("./tauri");
    calls.length = 0;
    const transport = tauriChatTransport();

    await transport.start("ClaudeCode");
    await transport.openConversation("c1");
    await transport.forkConversation("c1", "m1", true);

    expect(calls.map((call) => call.command)).toEqual([
      "chat_start",
      "chat_open_conversation",
      "chat_fork_conversation",
    ]);
    for (const call of calls) {
      expect(Object.keys(call.args)).not.toContain("host");
    }
  });

  it("rides along under one agreed name when there is one", async () => {
    // One name, chosen here, for every call that carries it: the shell has a
    // single argument to accept and a single place to apply it.
    const { tauriChatTransport } = await import("./tauri");
    calls.length = 0;
    const transport = tauriChatTransport();
    const host = { root: "/library", documents: ["a.pdf"] };

    await transport.start("ClaudeCode", host);
    await transport.openConversation("c1", host);
    await transport.forkConversation("c1", "m1", false, host);
    await transport.send("s1", "t1", "m1", "Hello", host, () => {}, () => {});

    expect(calls.map((call) => call.args.host)).toEqual([host, host, host, host]);
    // The call's own arguments are still there beside it.
    expect(calls[3].args).toMatchObject({ sessionId: "s1", turnId: "t1", text: "Hello" });
  });
});
