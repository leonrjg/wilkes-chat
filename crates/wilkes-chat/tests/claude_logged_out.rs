//! Claude Code, logged out, through the real adapter.
//!
//! Ignored by default: it needs node, npx and the pinned adapter in npm's
//! cache. It never touches the login of whoever runs it — the CLI is pointed at
//! an empty config directory, which is a machine with nobody logged in.
//!
//! ```text
//! cargo test --test claude_logged_out -- --ignored --nocapture
//! ```

use wilkes_chat::backend::AgentBackend;
use wilkes_chat::session::{spawn, SpawnOptions, TurnError};

#[tokio::test]
#[ignore = "runs the real Claude Code adapter"]
async fn a_logged_out_claude_offers_its_logins_and_fails_the_turn_as_auth_required() {
    let config = tempfile::tempdir().unwrap();
    let cwd = tempfile::tempdir().unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", config.path());

    let spawned = spawn(SpawnOptions::new(
        AgentBackend::ClaudeCode,
        cwd.path().into(),
    ))
    .await
    .expect("a logged-out agent still completes the handshake");
    let session = spawned.session;

    let ids: Vec<&str> = session
        .auth()
        .methods
        .iter()
        .map(|m| m.id.as_str())
        .collect();
    println!(
        "offered logins: {ids:?}, logout: {}",
        session.auth().can_log_out
    );
    assert!(ids.contains(&"claude-ai-login"), "{ids:?}");
    assert!(session.auth().can_log_out);

    match session.send("t1".into(), "hello".into()).await {
        Err(TurnError::AuthRequired { message }) => println!("turn failed as: {message}"),
        other => panic!("expected auth_required, got {other:?}"),
    }

    // The refused conversation is not reopened after a login: Claude Code
    // counts the tools it announced on the refused turn as announced, and the
    // model never saw them. The store starts a new chat instead.
    session.close();
}
