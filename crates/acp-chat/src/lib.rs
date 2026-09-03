//! An ACP chat client, with the application it serves kept behind one trait.
//!
//! Four things, and an application supplies none of them:
//!
//! - **[`backend`]** — which CLI answers, whether its adapter is on this
//!   machine, and how to launch it.
//! - **[`session`]** — one subprocess speaking ACP: the handshake, a streamed
//!   turn, tool calls, the parked permission request, session configuration.
//! - **[`store`]** — conversations on disk, so a chat outlives its window.
//! - **[`transcript`]** — folding streamed events back into stored messages.
//!
//! What an application *does* supply is [`host::ChatHost`]: what to push into
//! a prompt, which MCP servers to attach, which reads to answer, and which
//! tool calls are its own plumbing rather than a decision for the user. A
//! general-purpose chat supplies none of those either, and [`host::NoHost`] is
//! the whole of it.
//!
//! ```no_run
//! # async fn example() -> anyhow::Result<()> {
//! use acp_chat::{backend::AgentBackend, session};
//!
//! let spawned = session::spawn(session::SpawnOptions::new(
//!     AgentBackend::ClaudeCode,
//!     std::path::PathBuf::from("/tmp/chat"),
//! ))
//! .await?;
//!
//! // Streamed content arrives on `spawned.events`; `send` resolves with the
//! // turn's stop reason once the agent is done.
//! let stop_reason = spawned.session.send("turn-1".into(), "Hello".into()).await?;
//! # let _ = stop_reason;
//! # Ok(())
//! # }
//! ```
//!
//! The transport is stdio to a subprocess, which is the only thing an
//! application cannot substitute; everything else it can.

pub mod backend;
pub mod host;
pub mod session;
pub mod store;
pub mod transcript;

pub use backend::{
    backend_status, install_backend, is_resumable, label, list_backends, AgentBackend,
    BackendStatus,
};
pub use host::{ChatHost, NoHost};
pub use session::{
    spawn, ChatConfigOption, ChatConfigValue, ChatEvent, ChatSession, SpawnOptions,
    SpawnedChatSession,
};
pub use transcript::apply_chat_event;
