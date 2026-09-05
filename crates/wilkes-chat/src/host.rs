//! What an application supplies to a chat session, and nothing more.
//!
//! Everything in this crate past the subprocess boundary is the same for every
//! host: the handshake, the streaming, the tool-call bookkeeping, the parked
//! permission request. What is *not* the same is the application's domain —
//! what the agent is being asked about, which files it may read, which of its
//! tool calls are the application's own plumbing rather than a decision for
//! the user.
//!
//! Those four questions are this trait, and they are the only way a host's
//! domain reaches a session. A host with no domain to inject implements
//! nothing: [`NoHost`] is the whole of a general-purpose chat.

use std::path::Path;
use std::sync::Arc;

use agent_client_protocol::schema::v1::{McpServer, ToolCallUpdate};

/// The application behind a chat session.
///
/// Every method has a default, and the defaults together describe a chat with
/// no application behind it at all: nothing pushed into the prompt, no MCP
/// servers, no client-side file reads, and every permission request the
/// agent raises put to the user.
pub trait ChatHost: Send + Sync + 'static {
    /// Text prepended to the user's message on every turn.
    ///
    /// Pushed rather than offered as a tool, because a host that *requires*
    /// the agent to know something must not put that requirement behind the
    /// model's discretion. `first_turn` is true for the first prompt of a
    /// session, which is where a preamble belongs — later turns pay for it
    /// again in tokens for no new information.
    ///
    /// Whatever a host returns here is quoted document/state content, not
    /// instructions; hosts that interpolate untrusted text should fence and
    /// escape it, and say so in the block itself.
    fn context_block(&self, first_turn: bool) -> Option<String> {
        let _ = first_turn;
        None
    }

    /// MCP servers to attach to the session, passed to `session/new` and
    /// `session/load`.
    ///
    /// The server's own lifetime belongs to the host. A session holds its
    /// host for as long as it lives, so a host that hangs a running server off
    /// itself gets that server torn down with the session — but nothing here
    /// starts or stops one.
    fn mcp_servers(&self) -> Vec<McpServer> {
        Vec::new()
    }

    /// Whether the client answers `fs/read_text_file` — advertised to the
    /// agent in `initialize`.
    ///
    /// False by default, and false is not a lesser mode: an agent that is not
    /// offered client-delegated reads uses its own file tools instead, which
    /// go through the permission prompt the user answers. A host offers this
    /// when it can read something the agent's own tools cannot (an extracted
    /// PDF page, a document in a cache), not to give the agent broader reach.
    fn offers_file_read(&self) -> bool {
        false
    }

    /// Answer one `fs/read_text_file`. Called only when
    /// [`Self::offers_file_read`] is true.
    ///
    /// `line` is 1-based and `limit` counts lines; both are the agent's
    /// request and neither is enforced here. An `Err` is returned to the agent
    /// as a JSON-RPC error, so its message is read by a model — say what would
    /// make the read succeed, not just that it failed.
    fn read_text_file(
        &self,
        path: &Path,
        line: Option<u32>,
        limit: Option<u32>,
    ) -> Result<String, String> {
        let _ = (line, limit);
        Err(format!(
            "{} cannot be read: this application does not perform client-side file reads",
            path.display()
        ))
    }

    /// Whether this tool call is the host's own plumbing, and so may be
    /// allowed without asking.
    ///
    /// A host that attaches an MCP server of its own answers true for that
    /// server's tools: they are the mechanism the chat itself runs on, and
    /// prompting for them would ask the user to approve the application's
    /// internals. Everything else — including every tool the agent brought
    /// with it — is the user's decision, and the default says so.
    fn auto_allows(&self, tool_call: &ToolCallUpdate) -> bool {
        let _ = tool_call;
        false
    }

    /// Strip the host's own context block back off a replayed user message.
    ///
    /// `session/load` replays what was *sent*, which includes whatever
    /// [`Self::context_block`] pushed. Without this a resumed conversation
    /// shows the user their own message with the machinery stapled to the
    /// front of it. Return `None` when the text carries no block.
    ///
    /// The host's own block, and only that. The blocks this crate pushes of
    /// its own accord — the branched-from dialogue, the user's standing
    /// instructions — are already gone by the time this is called: a host
    /// cannot be asked to undo something it never asked to have sent.
    fn strip_context_block(&self, text: &str) -> Option<String> {
        let _ = text;
        None
    }
}

/// A chat with no application behind it: no pushed context, no MCP servers, no
/// client-side reads, every permission put to the user.
///
/// This is a complete host, not a placeholder. A general-purpose chat — one
/// whose subject is whatever the user types — has no domain to inject, and
/// injecting none is the correct behaviour rather than a missing feature.
pub struct NoHost;

impl ChatHost for NoHost {}

/// Convenience for the common case of handing a session a host that needs no
/// configuration.
pub fn no_host() -> Arc<dyn ChatHost> {
    Arc::new(NoHost)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_host_injects_nothing_and_permits_nothing() {
        let host = NoHost;
        assert!(host.context_block(true).is_none());
        assert!(host.context_block(false).is_none());
        assert!(host.mcp_servers().is_empty());
        assert!(!host.offers_file_read());
        assert!(host.strip_context_block("hello").is_none());
    }

    #[test]
    fn the_default_read_names_the_path_it_refused() {
        // The message is read by a model deciding what to do next, so it has
        // to say which read failed, not merely that one did.
        let err = NoHost
            .read_text_file(Path::new("/tmp/notes.md"), None, None)
            .unwrap_err();
        assert!(err.contains("/tmp/notes.md"), "{err}");
    }
}
