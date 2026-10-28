//! Logging an agent in without leaving the application.
//!
//! An agent that needs a login says how in its `initialize` response. The kind
//! this module handles is ACP's `terminal` method: a command the *client* runs,
//! made of the agent's own launch command with the method's `args` appended.
//! For Claude Code that is `npx -y <adapter>@<version> --cli auth login
//! --claudeai`, which opens the browser, takes the sign-in back on a localhost
//! listener and exits — no terminal needed, so a host can run it headless and
//! learn the outcome from the exit status.
//!
//! The launch is [`resolve_launch_spec`]'s, not a path the agent hands back.
//! The adapter can also advertise an absolute command under
//! `_meta["terminal-auth"]`, but that names the node binary and the npx cache
//! directory of the process that answered — both of which a `brew upgrade` or
//! an npm cache prune moves — and it would be a second way of launching the
//! same adapter beside the one every session already uses.
//!
//! Methods of other kinds are not offered: `agent` methods are completed by an
//! `authenticate` request this crate does not send, and `env_var` methods need
//! the client to hold a secret.

use std::collections::HashMap;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use agent_client_protocol::schema::v1::{AuthMethod, InitializeResponse};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tracing::{info, warn};

use crate::backend::{label, resolve_launch_spec, AgentBackend};

/// How long a cancelled login gets to exit on `SIGTERM` before its process
/// group is killed outright. Under the three seconds a cancellation may take.
const LOGIN_STOP_GRACE: Duration = Duration::from_secs(2);

/// One way the agent offered to be logged in, as a selector shows it.
///
/// What it runs stays on this side of the wire: a client names a method by
/// `id`, and the session looks the command up among the methods its own agent
/// advertised — never one the window supplied.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ChatAuthMethod {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(skip)]
    args: Vec<String>,
    #[serde(skip)]
    env: HashMap<String, String>,
}

/// What the agent said about logging in, as of `initialize`.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct ChatAuth {
    /// The logins this client can run for the agent. Empty for an agent that
    /// offers none, which leaves the user to log in however that agent says.
    pub methods: Vec<ChatAuthMethod>,
    /// Whether the agent answers ACP's `logout`.
    pub can_log_out: bool,
}

impl ChatAuth {
    pub(crate) fn from_initialize(response: &InitializeResponse) -> Self {
        let methods = response
            .auth_methods
            .iter()
            .filter_map(|method| match method {
                AuthMethod::Terminal(terminal) => Some(ChatAuthMethod {
                    id: terminal.id.0.to_string(),
                    name: terminal.name.clone(),
                    description: terminal.description.clone(),
                    args: terminal.args.clone(),
                    env: terminal.env.clone(),
                }),
                _ => None,
            })
            .collect();
        Self {
            methods,
            can_log_out: response.agent_capabilities.auth.logout.is_some(),
        }
    }

    pub(crate) fn method(&self, id: &str) -> Option<&ChatAuthMethod> {
        self.methods.iter().find(|method| method.id == id)
    }
}

/// How a login ended, when it did not fail.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LoginOutcome {
    LoggedIn,
    Cancelled,
}

/// Run `method` for `backend` until it exits or `cancel` fires.
///
/// `cancel` firing *or being dropped* stops the login, so a session that is
/// closed mid-login takes its login with it rather than leaving a CLI waiting
/// on a browser redirect nobody will complete.
pub(crate) async fn run_login(
    backend: AgentBackend,
    method: &ChatAuthMethod,
    cancel: oneshot::Receiver<()>,
) -> anyhow::Result<LoginOutcome> {
    let spec = resolve_launch_spec(backend)?;
    let mut command = Command::new(&spec.command);
    command
        .args(&spec.args)
        .args(&method.args)
        .envs(&method.env);
    info!(backend = label(backend), method = %method.id, "chat: running an agent login");
    run_login_command(command, cancel)
        .await
        .map_err(|e| anyhow::anyhow!("{} login failed: {e:#}", label(backend)))
}

async fn run_login_command(
    mut command: Command,
    cancel: oneshot::Receiver<()>,
) -> anyhow::Result<LoginOutcome> {
    // No stdin: the login is answered in the browser, and a CLI that falls
    // back to asking for a pasted code reads end-of-file rather than hanging
    // on a terminal that is not there.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Its own process group, so stopping it reaches what it started: `npx`
    // runs node, which runs the CLI, and a signal to `npx` alone is not one
    // the CLI is guaranteed to hear.
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command.spawn()?;
    let stdout = tokio::spawn(read_all(child.stdout.take()));
    let stderr = tokio::spawn(read_all(child.stderr.take()));

    let status = tokio::select! {
        status = child.wait() => status?,
        _ = cancel => {
            stop(&mut child).await;
            return Ok(LoginOutcome::Cancelled);
        }
    };

    let stdout = stdout.await.unwrap_or_default();
    let stderr = stderr.await.unwrap_or_default();
    if status.success() {
        Ok(LoginOutcome::LoggedIn)
    } else {
        Err(exit_error(status, &stdout, &stderr))
    }
}

/// Stop a login and its children: `SIGTERM` to the group, then `SIGKILL` if it
/// is still there after [`LOGIN_STOP_GRACE`].
async fn stop(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let group = pid as libc::pid_t;
        // SAFETY: `killpg` takes plain integers; `group` is the id of a
        // process group this function's caller created and has not reaped.
        unsafe { libc::killpg(group, libc::SIGTERM) };
        if tokio::time::timeout(LOGIN_STOP_GRACE, child.wait())
            .await
            .is_ok()
        {
            return;
        }
        warn!("chat: a cancelled login ignored SIGTERM; killing it");
        // SAFETY: as above.
        unsafe { libc::killpg(group, libc::SIGKILL) };
    }
    if let Err(e) = child.kill().await {
        warn!("chat: could not reap a cancelled login: {e}");
    }
}

async fn read_all(stream: Option<impl AsyncRead + Unpin>) -> String {
    let Some(mut stream) = stream else {
        return String::new();
    };
    let mut bytes = Vec::new();
    if let Err(e) = stream.read_to_end(&mut bytes).await {
        warn!("chat: could not read a login's output: {e}");
    }
    String::from_utf8_lossy(&bytes).trim().to_string()
}

/// What a failed login said, for the person who has to decide what to do
/// about it. Its error stream when it wrote one, otherwise what it printed.
fn exit_error(status: ExitStatus, stdout: &str, stderr: &str) -> anyhow::Error {
    let said = if stderr.is_empty() { stdout } else { stderr };
    if said.is_empty() {
        anyhow::anyhow!("the login exited with {status}")
    } else {
        anyhow::anyhow!("the login exited with {status}: {said}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// The `initialize` answer `claude-agent-acp` gives a client that
    /// advertises `auth.terminal`, trimmed to what this module reads.
    fn claude_initialize() -> InitializeResponse {
        serde_json::from_value(serde_json::json!({
            "protocolVersion": 1,
            "agentCapabilities": { "auth": { "logout": {} } },
            "authMethods": [
                {
                    "id": "claude-ai-login",
                    "name": "Claude Subscription",
                    "description": "Use Claude subscription ",
                    "type": "terminal",
                    "args": ["--cli", "auth", "login", "--claudeai"]
                },
                {
                    "id": "console-login",
                    "name": "Anthropic Console",
                    "type": "terminal",
                    "args": ["--cli", "auth", "login", "--console"],
                    "env": { "EXAMPLE": "1" }
                },
                { "id": "gateway", "name": "Custom model gateway" }
            ]
        }))
        .unwrap()
    }

    #[test]
    fn terminal_methods_are_offered_and_others_are_not() {
        let auth = ChatAuth::from_initialize(&claude_initialize());
        let ids: Vec<&str> = auth.methods.iter().map(|m| m.id.as_str()).collect();
        // `gateway` is an `agent` method: completed by `authenticate`, which
        // this crate does not send, so offering it would be a dead button.
        assert_eq!(ids, ["claude-ai-login", "console-login"]);
        assert!(auth.can_log_out);

        let console = auth.method("console-login").unwrap();
        assert_eq!(console.args, ["--cli", "auth", "login", "--console"]);
        assert_eq!(console.env.get("EXAMPLE").map(String::as_str), Some("1"));
    }

    #[test]
    fn an_agent_without_logout_is_not_offered_one() {
        let response: InitializeResponse =
            serde_json::from_value(serde_json::json!({ "protocolVersion": 1 })).unwrap();
        assert_eq!(ChatAuth::from_initialize(&response), ChatAuth::default());
    }

    #[test]
    fn what_a_login_runs_never_reaches_the_wire() {
        // A window names a method; it does not get to say what is executed.
        let auth = ChatAuth::from_initialize(&claude_initialize());
        let json = serde_json::to_value(&auth).unwrap();
        assert_eq!(json["methods"][0]["id"], "claude-ai-login");
        assert!(json["methods"][0].get("args").is_none());
        assert!(json["methods"][1].get("env").is_none());
    }

    fn sh(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        command
    }

    #[tokio::test]
    async fn a_login_that_exits_cleanly_is_logged_in() {
        let (_cancel, cancelled) = oneshot::channel();
        let outcome = run_login_command(sh("echo Login successful."), cancelled).await;
        assert_eq!(outcome.unwrap(), LoginOutcome::LoggedIn);
    }

    #[tokio::test]
    async fn a_failed_login_reports_what_it_said() {
        let (_cancel, cancelled) = oneshot::channel();
        let error = run_login_command(sh("echo 'OAuth error: denied' >&2; exit 3"), cancelled)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("OAuth error: denied"), "{error}");
    }

    #[tokio::test]
    async fn a_cancelled_login_stops_within_three_seconds_children_included() {
        let marker = tempfile::tempdir().unwrap();
        let pid_file = marker.path().join("child.pid");
        // A grandchild that would outlive a signal sent to its parent alone,
        // which is the shape `npx` → node → CLI has.
        let script = format!("sleep 30 & echo $! > '{}'; wait", pid_file.display());
        let (cancel, cancelled) = oneshot::channel();
        let login = tokio::spawn(run_login_command(sh(&script), cancelled));

        while !pid_file.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let grandchild: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();

        let asked = Instant::now();
        cancel.send(()).unwrap();
        assert_eq!(login.await.unwrap().unwrap(), LoginOutcome::Cancelled);
        assert!(
            asked.elapsed() < Duration::from_secs(3),
            "{:?}",
            asked.elapsed()
        );

        // Signal 0 checks for existence; ESRCH means it is gone.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let alive = unsafe { libc::kill(grandchild, 0) } == 0;
        assert!(!alive, "the login's child survived the cancel");
    }

    #[tokio::test]
    async fn dropping_the_cancel_handle_stops_the_login() {
        // What a closed session does: it holds the sender, and goes away.
        let (cancel, cancelled) = oneshot::channel::<()>();
        let login = tokio::spawn(run_login_command(sh("sleep 30"), cancelled));
        drop(cancel);
        let outcome = tokio::time::timeout(Duration::from_secs(3), login)
            .await
            .expect("the login outlived its session")
            .unwrap()
            .unwrap();
        assert_eq!(outcome, LoginOutcome::Cancelled);
    }
}
