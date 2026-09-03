import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CHAT_COMMANDS, chatChannel } from "./transport";

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
