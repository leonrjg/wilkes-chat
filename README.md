## acp-chat (lib)

The chat that talks to a coding agent over [ACP](https://agentclientprotocol.com),
extracted from [Wilkes](https://github.com/leonrjg/Wilkes) so it is not one
application's feature. Two halves of one contract, shipped together:

| | |
| --- | --- |
| `crates/acp-chat` | the Rust crate: backends, the session, conversations on disk |
| `src` | the npm package: the store, the pane, and the Tauri transport between them |

They are in one repository because they are one thing. The wire format is
defined once, in `wire.rs`, and `src/types.ts` is its mirror; when they were in
two repositories the shell hand-wrote a `json!` per event and the client
hand-wrote a matching union, and whether a tool chip kept its raw input came
down to whether both sides had spelled `raw_input` the same way that week.

### What a host provides, and what it gets

The chat knows how to hold a conversation with an agent. It knows nothing about
documents, corpora, or whatever the application it is embedded in is *for*.
Everything application-shaped crosses one boundary, `ChatHost`, which asks four
questions:

| Question | Method | A general chat answers |
| --- | --- | --- |
| What must the agent know every turn? | `context_block` | nothing |
| Which MCP servers are attached? | `mcp_servers` | none |
| Which files may the client read for it? | `offers_file_read` / `read_text_file` | none |
| Which tool calls are the application's own? | `auto_allows` | none |

`NoHost` answers all four that way, and it is a complete host rather than a
stub — a chat whose subject is whatever the user types has no domain to inject,
and injecting none is the right behaviour. Wilkes' version of this pushed the
open document and its extracted text into every prompt, attached a read-only
MCP server, and auto-allowed that server's own tools; all three are things a
host says, not things a chat decides.

The fifth method, `strip_context_block`, exists because of the fourth's
consequence: `session/load` replays what was *sent*, so without it a resumed
conversation shows the user their own question with the machinery stapled to
the front of it.

### The permission boundary

There is one, and it is the user's.

Anything the host did not claim through `auto_allows` becomes a
`PermissionRequest` event carrying the agent's own options — allow once, allow
always, reject — echoed back by `option_id` and never reinterpreted. The turn
parks on the subprocess side until it is answered, which is why the answer path
deliberately bypasses the session's command loop: that loop is blocked awaiting
the in-flight `PromptResponse`, so a decision routed through it could never
arrive.

Client-delegated *writes* are never offered. `fs.writeTextFile` is advertised
as false, and a well-behaved agent then uses its own file tools, which go
through the prompt above. An agent that ignores that gets a refusal naming what
to use instead.

Two things follow that a host should decide deliberately:

- **`cwd` is the largest decision you make.** The agent's own file tools are
  rooted there. A directory the application owns is a different offer from the
  user's home.
- **The agent's mode is the user's other lever.** This crate surfaces
  `session/set_config_option`, and mode is one of the options an agent
  advertises there.

### Which agents, and whether they are installed

`ClaudeCode`, `Codex` and `Nanocoder`, each launched as
`npx -y <package>@<pinned version>` — one mechanism, no per-backend launch
paths to keep working. The pin is what makes a cached copy satisfy `npx`
without a registry round trip, so a second launch is offline.

Availability is read off npm's npx cache rather than by running anything, and
it has three states, not two: available, unavailable, and *installable* — the
toolchain is here but the adapter has not been fetched. That third state is why
the pane offers an Install button instead of a reason, and why nothing is
downloaded on a first send.

`is_resumable` is the other backend fact worth knowing. Only agents that keep
their own session transcript get a record in the conversation store, because a
history that can be shown but never continued is a history that lies about
being one.

### Using it

**Rust.** One workspace member, or a path dependency while the repository is
unpublished:

```toml
acp-chat = { path = "../acp-chat/crates/acp-chat" }
```

A session, in full:

```rust
let spawned = acp_chat::session::spawn(
    SpawnOptions::new(AgentBackend::ClaudeCode, chat_dir).host(my_host),
).await?;

// `spawned.events` streams for the life of the session, not one turn.
// `send` resolves with the stop reason when the agent is done.
let stop_reason = spawned.session.send(turn_id, text).await?;
```

`wire::emission` turns each event into the payload the client expects and says
whether it belongs to a turn or to the session; a host names the two channels
(`chatChannel` in `transport.ts` is what the shipped Tauri client listens on)
and does nothing else to it.

**TypeScript.**

```
npm install github:leonrjg/acp-chat#v0.1.0
```

`react`, `react-dom` and `zustand` are peer dependencies; `@tauri-apps/api` is
an optional one, needed only if you import `/tauri`.

```tsx
import { ChatPane, createChatStore } from "@leonrjg/acp-chat";
import { tauriChatTransport } from "@leonrjg/acp-chat/tauri";
import "@leonrjg/acp-chat/chat.css";

const useChat = createChatStore({ transport: tauriChatTransport() });

<ChatPane store={useChat} />
```

`createChatStore` is a factory rather than a store because the transport is
injected. That is what makes the browser preview and the test suite real:
`@leonrjg/acp-chat/testing` exports `createFakeTransport`, which drives every
state a live agent reaches on its own schedule — a permission request nobody
answers, an adapter that will not install, a subprocess that dies between
turns.

`index.ts` is the whole public surface, in two tiers: the composed pane, and
the headless parts — the store, the view model, the pure transcript rules — for
a host whose chat does not look like this one and which would otherwise
reimplement the streaming, the stick-to-bottom and the tool-call patch
semantics badly.

### Styling

`chat.css` is tokens with fallbacks, not utility classes. Every colour, radius
and size reads a custom property, so an application that defines none still
gets a finished pane, and one that defines some gets its own:

```css
@import "@leonrjg/acp-chat/chat.css";

.acp-chat {
  --acp-chat-accent: var(--accent-9);
  --acp-chat-border: var(--gray-a6);
  --acp-chat-bg-bubble: var(--gray-a2);
}
```

Deliberately not Tailwind and not Radix: the two applications this serves use
different design systems, and a pane written in either one's utilities is a
pane the other has to rewrite. For the same reason the icons are inline SVG on
`currentColor` rather than an icon dependency.

### Following the bottom of a transcript

A streaming reply grows the scroll height under the reader, and following it is
right until the reader scrolls up to read something — at which point it is the
most irritating thing a chat window can do. The rule, in `transcript.ts` and
tested there: **the reader detaches by gesture, and reattaches by arriving back
at the bottom.** Wheel, touch drag and the scroll-up keys all detach; being
*near* the bottom is not enough to reattach, because a reader who scrolled up a
little is near the bottom too.

There is no virtualizer. Wilkes' pane had one, and most of its complexity was
compensating for the way the virtualizer's own scroll correction fights the
rule above. A conversation is not a document.

### What was left behind

Deliberate omissions, not gaps to be quietly filled:

- **Wilkes' MCP server, readers and search** stayed in Wilkes. They are the
  application, and they now reach a session through `ChatHost` like anything
  else would.
- **Forking and editing a message.** Wilkes forks a conversation from any
  message and re-asks an edited one, carrying a rendered branch history into
  the new session. It is a good feature and it is not general: it rests on a
  per-turn environment record that only means something to a host with an
  environment worth recording.
- **Wilkes still has its own copy.** This extraction does not modify Wilkes;
  adopting it there is a separate change, and it is the one that turns two
  copies back into one.
