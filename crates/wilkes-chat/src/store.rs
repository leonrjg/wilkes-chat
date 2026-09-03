//! Conversations on disk, so a chat outlives the window it was typed into.
//!
//! What is stored here is the *transcript* — what to show when a conversation
//! is reopened. The conversation itself lives in the agent: `backend_session_id`
//! is the handle [`crate::session::SessionOpenMode::Load`] reattaches to, and
//! the agent, not this file, is what remembers the model's own context.
//!
//! That is why only a resumable backend gets a record at all
//! ([`crate::backend::is_resumable`]): a transcript we could show but never
//! continue would be a history that lies about being one.

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::backend::{is_resumable, AgentBackend};
use crate::session::{
    config_values_from_options, ChatConfigOption, ChatConfigValue, ChatReplayContentBlock,
    ChatReplayMessage,
};

/// The on-disk format's version. Bumped when a change would make an older
/// reader wrong rather than merely incomplete.
///
/// Version 1 files are still read: everything version 2 added is `#[serde(default)]`,
/// so a file written before forking existed loads with no fork, no environment
/// and no parent — which is the truth about it. They are rewritten as 2 on the
/// next write.
const STORE_VERSION: u32 = 2;
const OLDEST_READABLE_VERSION: u32 = 1;

/// The longest a derived title gets. Past this the history menu is showing a
/// paragraph, not a name.
const TITLE_CHAR_LIMIT: usize = 80;

/// What was true when a turn was sent, kept so a fork of it can be opened
/// under the same conditions rather than under today's.
///
/// `config_values` is this crate's: the model and mode that answered. `host` is
/// an opaque blob the host writes and reads and this crate only carries —
/// whatever else an application counts as part of "the conditions" (which
/// documents were in context, which root was being searched) lives there,
/// because a fork that silently changed those would be answering a different
/// question from the one being branched.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ChatTurnEnvironment {
    #[serde(default)]
    pub config_values: Vec<ChatConfigValue>,
    #[serde(default)]
    pub host: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessageRecord {
    pub message_id: String,
    /// The turn this message belongs to, for routing streamed updates into it.
    /// `None` for messages that arrived by replay rather than by being sent.
    pub turn_id: Option<String>,
    pub role: String,
    pub thought: String,
    pub content: Vec<ChatReplayContentBlock>,
    pub error: Option<String>,
    /// Set on the user message that opened a turn, and nowhere else — it is
    /// the only message a fork can be taken *from* with conditions attached.
    #[serde(default)]
    pub environment: Option<ChatTurnEnvironment>,
}

impl ChatMessageRecord {
    pub fn user(message_id: String, turn_id: String, text: String) -> Self {
        Self {
            message_id,
            turn_id: Some(turn_id),
            role: "user".to_string(),
            thought: String::new(),
            content: vec![ChatReplayContentBlock::Text { text }],
            error: None,
            environment: None,
        }
    }

    /// The same, with the conditions the turn was sent under attached — what a
    /// fork of this message is reopened with.
    pub fn user_in(
        message_id: String,
        turn_id: String,
        text: String,
        environment: ChatTurnEnvironment,
    ) -> Self {
        Self {
            environment: Some(environment),
            ..Self::user(message_id, turn_id, text)
        }
    }

    /// The empty assistant message a turn streams into.
    pub fn assistant_placeholder(turn_id: String) -> Self {
        Self {
            message_id: turn_id.clone(),
            turn_id: Some(turn_id),
            role: "assistant".to_string(),
            thought: String::new(),
            content: Vec::new(),
            error: None,
            environment: None,
        }
    }

    /// The message's text, with tool calls left out — what a title is derived
    /// from and what a copy button copies.
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|block| match block {
                ChatReplayContentBlock::Text { text } => Some(text.as_str()),
                ChatReplayContentBlock::Tool { .. } => None,
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatConversationRecord {
    pub conversation_id: String,
    pub backend: AgentBackend,
    /// The agent's own session id — the handle a resume reattaches to.
    pub backend_session_id: String,
    pub cwd: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: String,
    pub config_values: Vec<ChatConfigValue>,
    pub messages: Vec<ChatMessageRecord>,
    /// The conversation this one was branched out of, if any.
    #[serde(default)]
    pub parent_conversation_id: Option<String>,
    #[serde(default)]
    pub forked_from_message_id: Option<String>,
    /// A fork opens a *new* agent session, which knows nothing of the dialogue
    /// above the branch point. This says that dialogue still has to be handed
    /// over — see [`branch_history_text`] and
    /// [`crate::session::ChatSession::set_prelude`]. Cleared once the first
    /// turn has carried it.
    #[serde(default)]
    pub branch_history_pending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatConversationFile {
    version: u32,
    conversations: Vec<ChatConversationRecord>,
}

impl Default for ChatConversationFile {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            conversations: Vec::new(),
        }
    }
}

/// Every saved conversation, most recently touched first.
pub fn list_conversations(data_dir: &Path) -> anyhow::Result<Vec<ChatConversationRecord>> {
    let mut store = read_store(data_dir)?;
    store
        .conversations
        .sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(store.conversations)
}

pub fn get_conversation(
    data_dir: &Path,
    conversation_id: &str,
) -> anyhow::Result<ChatConversationRecord> {
    read_store(data_dir)?
        .conversations
        .into_iter()
        .find(|conversation| conversation.conversation_id == conversation_id)
        .ok_or_else(|| anyhow::anyhow!("chat conversation not found: {conversation_id}"))
}

/// Record a conversation for a session that has just started.
///
/// `Ok(None)` for a backend that cannot be resumed — not an error: the chat
/// works, it simply will not be in the history menu, and the caller carries on
/// without a conversation id.
pub fn create_conversation(
    data_dir: &Path,
    backend: AgentBackend,
    cwd: &Path,
    backend_session_id: String,
    config_options: &[ChatConfigOption],
) -> anyhow::Result<Option<ChatConversationRecord>> {
    if !is_resumable(backend) {
        return Ok(None);
    }

    let now = now_string();
    let record = ChatConversationRecord {
        conversation_id: uuid::Uuid::new_v4().to_string(),
        backend,
        backend_session_id,
        cwd: cwd.display().to_string(),
        title: format!("New {} chat", crate::backend::label(backend)),
        created_at: now.clone(),
        updated_at: now.clone(),
        last_opened_at: now,
        config_values: config_values_from_options(config_options),
        messages: Vec::new(),
        parent_conversation_id: None,
        forked_from_message_id: None,
        branch_history_pending: false,
    };

    mutate_store(data_dir, |store| store.conversations.push(record.clone()))?;
    Ok(Some(record))
}

/// Branch a conversation at one message into a new one.
///
/// The caller has already opened a *fresh* agent session for it — forking is
/// not `session/load`, because the point is to take the thread somewhere the
/// original did not go, and an agent resumed at its own last state has the
/// abandoned continuation still in its context.
///
/// `include_message` is what tells a fork from an edit. Forking *from* an
/// assistant answer keeps that answer and continues after it; re-asking a user
/// message drops it, so the new session's first turn is the rewritten question
/// with the same history behind it.
///
/// The new record carries `branch_history_pending`, because the fresh session
/// has none of the dialogue the user can still see above the branch point.
pub fn create_fork_conversation(
    data_dir: &Path,
    source_conversation_id: &str,
    forked_from_message_id: &str,
    include_message: bool,
    backend_session_id: String,
) -> anyhow::Result<ChatConversationRecord> {
    let source = get_conversation(data_dir, source_conversation_id)?;
    let index = source
        .messages
        .iter()
        .position(|message| message.message_id == forked_from_message_id)
        .ok_or_else(|| anyhow::anyhow!("chat message not found: {forked_from_message_id}"))?;
    let prefix_len = if include_message { index + 1 } else { index };
    let environment = environment_at_message(&source, forked_from_message_id);
    let now = now_string();

    let record = ChatConversationRecord {
        conversation_id: uuid::Uuid::new_v4().to_string(),
        backend: source.backend,
        backend_session_id,
        // The same directory, deliberately: a fork asks the same question
        // differently, and moving the agent's root would change the world it
        // is being asked about as well.
        cwd: source.cwd,
        title: format!("Fork of {}", source.title),
        created_at: now.clone(),
        updated_at: now.clone(),
        last_opened_at: now,
        config_values: environment.config_values,
        messages: source.messages[..prefix_len].to_vec(),
        parent_conversation_id: Some(source_conversation_id.to_string()),
        forked_from_message_id: Some(forked_from_message_id.to_string()),
        // Nothing above the branch point means nothing to hand over.
        branch_history_pending: prefix_len > 0,
    };
    mutate_store(data_dir, |store| store.conversations.push(record.clone()))?;
    Ok(record)
}

/// The conditions in force at a message: its own, or the most recent ones
/// before it.
///
/// Searching backwards rather than requiring the message to carry them,
/// because only the user message that opened a turn does — an assistant answer
/// was produced under whatever was in force when the question was asked, which
/// is the entry above it.
///
/// A conversation with no environment anywhere (one written before turns
/// recorded them) yields the default rather than an error: a fork of it opens
/// under the agent's own defaults, which is worse than exact and much better
/// than refusing to fork.
pub fn environment_at_message(
    conversation: &ChatConversationRecord,
    message_id: &str,
) -> ChatTurnEnvironment {
    let Some(index) = conversation
        .messages
        .iter()
        .position(|message| message.message_id == message_id)
    else {
        return ChatTurnEnvironment::default();
    };
    conversation.messages[..=index]
        .iter()
        .rev()
        .find_map(|message| message.environment.clone())
        .unwrap_or_default()
}

/// The dialogue above a branch point, rendered for the fresh session that did
/// not live through it.
///
/// Text only. Tool calls are left out because they are the *old* session's
/// work — a transcript that listed them would be telling the new agent it had
/// already read files it has not read.
pub fn branch_history_text(messages: &[ChatMessageRecord]) -> String {
    messages
        .iter()
        .filter_map(|message| {
            let text = message.text();
            if text.trim().is_empty() {
                return None;
            }
            let speaker = if message.role == "user" {
                "User"
            } else {
                "Assistant"
            };
            Some(format!("{speaker}: {text}"))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// The branch history has been handed over; stop handing it over.
pub fn mark_branch_history_seeded(data_dir: &Path, conversation_id: &str) -> anyhow::Result<()> {
    mutate_store(data_dir, |store| {
        if let Some(record) = store
            .conversations
            .iter_mut()
            .find(|record| record.conversation_id == conversation_id)
        {
            record.branch_history_pending = false;
            record.updated_at = now_string();
        }
    })
}

/// Mark a conversation as just used, and give it a name if it has not earned
/// one yet.
///
/// The name comes from the first thing the user actually said. A conversation
/// keeps the name it was given: renaming it on every turn would make the
/// history menu reshuffle under the reader's eyes.
pub fn touch_conversation(
    data_dir: &Path,
    conversation_id: &str,
    title_hint: Option<&str>,
) -> anyhow::Result<()> {
    mutate_store(data_dir, |store| {
        if let Some(record) = store
            .conversations
            .iter_mut()
            .find(|record| record.conversation_id == conversation_id)
        {
            let now = now_string();
            record.updated_at = now.clone();
            record.last_opened_at = now;
            if let Some(title_hint) = title_hint {
                if record.title.starts_with("New ") {
                    record.title = title_from_text(title_hint);
                }
            }
        }
    })
}

pub fn forget_conversation(data_dir: &Path, conversation_id: &str) -> anyhow::Result<()> {
    mutate_store(data_dir, |store| {
        store
            .conversations
            .retain(|record| record.conversation_id != conversation_id);
    })
}

pub fn update_conversation_config(
    data_dir: &Path,
    conversation_id: &str,
    config_options: &[ChatConfigOption],
) -> anyhow::Result<()> {
    mutate_store(data_dir, |store| {
        if let Some(record) = store
            .conversations
            .iter_mut()
            .find(|record| record.conversation_id == conversation_id)
        {
            record.updated_at = now_string();
            record.config_values = config_values_from_options(config_options);
        }
    })
}

pub fn replace_conversation_messages(
    data_dir: &Path,
    conversation_id: &str,
    messages: Vec<ChatMessageRecord>,
) -> anyhow::Result<()> {
    mutate_store(data_dir, |store| {
        if let Some(record) = store
            .conversations
            .iter_mut()
            .find(|record| record.conversation_id == conversation_id)
        {
            record.updated_at = now_string();
            record.messages = messages;
        }
    })
}

/// A replayed transcript, in the shape the store keeps.
///
/// The agent is the authority on what was said, so a resumed conversation is
/// rebuilt from its replay rather than from the file — the file's copy can be
/// short by whatever a crash cost it, and two accounts of one conversation is
/// exactly the state this avoids.
pub fn records_from_replay(messages: Vec<ChatReplayMessage>) -> Vec<ChatMessageRecord> {
    messages
        .into_iter()
        .map(|message| ChatMessageRecord {
            message_id: uuid::Uuid::new_v4().to_string(),
            turn_id: None,
            role: message.role,
            thought: message.thought,
            content: message.content,
            error: None,
            environment: None,
        })
        .collect()
}

fn conversation_path(data_dir: &Path) -> PathBuf {
    data_dir.join("chat-conversations.json")
}

fn read_store(data_dir: &Path) -> anyhow::Result<ChatConversationFile> {
    let path = conversation_path(data_dir);
    if !path.exists() {
        return Ok(ChatConversationFile::default());
    }
    let text = std::fs::read_to_string(&path)?;
    if text.trim().is_empty() {
        return Ok(ChatConversationFile::default());
    }
    let store: ChatConversationFile = serde_json::from_str(&text)?;
    anyhow::ensure!(
        (OLDEST_READABLE_VERSION..=STORE_VERSION).contains(&store.version),
        "unsupported chat conversation version: {} (this build reads {OLDEST_READABLE_VERSION}–{STORE_VERSION})",
        store.version
    );
    Ok(store)
}

/// Write through a temporary file and rename.
///
/// The rename is atomic, so a crash mid-write leaves the previous file whole
/// rather than a truncated one: the failure mode of writing in place is a
/// history file that no longer parses, which loses every conversation rather
/// than the one being written.
fn write_store(data_dir: &Path, store: &ChatConversationFile) -> anyhow::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    // Whatever version was read, what is written is this one: the fields an
    // older file lacked have taken their defaults by now, so calling it the
    // old version would be claiming it is still readable by a reader that
    // would not understand what is in it.
    let store = &ChatConversationFile {
        version: STORE_VERSION,
        conversations: store.conversations.clone(),
    };
    let path = conversation_path(data_dir);
    let tmp_path = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(store)?;
    std::fs::write(&tmp_path, text)?;
    std::fs::rename(tmp_path, path)?;
    Ok(())
}

fn mutate_store<F>(data_dir: &Path, f: F) -> anyhow::Result<()>
where
    F: FnOnce(&mut ChatConversationFile),
{
    let mut store = read_store(data_dir)?;
    f(&mut store);
    write_store(data_dir, &store)
}

fn now_string() -> String {
    Utc::now().to_rfc3339()
}

fn title_from_text(text: &str) -> String {
    let trimmed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = trimmed.chars().take(TITLE_CHAR_LIMIT).collect();
    if title.is_empty() {
        "Untitled chat".to_string()
    } else {
        title
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn options() -> Vec<ChatConfigOption> {
        vec![ChatConfigOption {
            id: "model".to_string(),
            name: "Model".to_string(),
            category: Some("model".to_string()),
            current_value: "sonnet".to_string(),
            choices: Vec::new(),
        }]
    }

    #[test]
    fn a_conversation_survives_a_round_trip_through_the_file() {
        let dir = tempdir().unwrap();
        let created = create_conversation(
            dir.path(),
            AgentBackend::ClaudeCode,
            Path::new("/tmp/work"),
            "backend-session-1".to_string(),
            &options(),
        )
        .unwrap()
        .expect("a resumable backend gets a record");

        let read = get_conversation(dir.path(), &created.conversation_id).unwrap();
        assert_eq!(read.backend_session_id, "backend-session-1");
        assert_eq!(read.cwd, "/tmp/work");
        assert_eq!(read.config_values[0].value, "sonnet");
    }

    #[test]
    fn a_backend_that_cannot_be_resumed_is_not_recorded() {
        // Storing it would put a conversation in the history menu that
        // reopening could only show, never continue.
        let dir = tempdir().unwrap();
        let created = create_conversation(
            dir.path(),
            AgentBackend::Nanocoder,
            Path::new("/tmp/work"),
            "backend-session-1".to_string(),
            &options(),
        )
        .unwrap();

        assert!(created.is_none());
        assert!(list_conversations(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn the_first_message_names_the_conversation_and_later_ones_do_not() {
        let dir = tempdir().unwrap();
        let created = create_conversation(
            dir.path(),
            AgentBackend::ClaudeCode,
            Path::new("/tmp/work"),
            "s1".to_string(),
            &[],
        )
        .unwrap()
        .unwrap();
        assert!(created.title.starts_with("New "));

        touch_conversation(dir.path(), &created.conversation_id, Some("What is a monad?")).unwrap();
        let named = get_conversation(dir.path(), &created.conversation_id).unwrap();
        assert_eq!(named.title, "What is a monad?");

        touch_conversation(dir.path(), &created.conversation_id, Some("and a functor?")).unwrap();
        let still = get_conversation(dir.path(), &created.conversation_id).unwrap();
        assert_eq!(
            still.title, "What is a monad?",
            "a named conversation kept its name"
        );
    }

    #[test]
    fn a_long_first_message_is_a_title_and_not_a_paragraph() {
        let long = "word ".repeat(60);
        let title = title_from_text(&long);
        assert_eq!(title.chars().count(), TITLE_CHAR_LIMIT);
    }

    #[test]
    fn a_message_of_only_whitespace_still_yields_a_name() {
        assert_eq!(title_from_text("   \n\t "), "Untitled chat");
    }

    #[test]
    fn a_missing_file_reads_as_an_empty_history_rather_than_an_error() {
        let dir = tempdir().unwrap();
        assert!(list_conversations(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn a_file_from_a_future_version_is_refused_rather_than_misread() {
        let dir = tempdir().unwrap();
        std::fs::write(
            conversation_path(dir.path()),
            r#"{"version":99,"conversations":[]}"#,
        )
        .unwrap();

        let err = list_conversations(dir.path()).unwrap_err().to_string();
        assert!(err.contains("99"), "{err}");
    }

    #[test]
    fn forgetting_removes_exactly_the_conversation_named() {
        let dir = tempdir().unwrap();
        let first = create_conversation(
            dir.path(),
            AgentBackend::ClaudeCode,
            Path::new("/tmp"),
            "s1".to_string(),
            &[],
        )
        .unwrap()
        .unwrap();
        let second = create_conversation(
            dir.path(),
            AgentBackend::ClaudeCode,
            Path::new("/tmp"),
            "s2".to_string(),
            &[],
        )
        .unwrap()
        .unwrap();

        forget_conversation(dir.path(), &first.conversation_id).unwrap();
        let left = list_conversations(dir.path()).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].conversation_id, second.conversation_id);
    }

    #[test]
    fn the_transcript_written_last_is_the_one_read_back() {
        let dir = tempdir().unwrap();
        let created = create_conversation(
            dir.path(),
            AgentBackend::ClaudeCode,
            Path::new("/tmp"),
            "s1".to_string(),
            &[],
        )
        .unwrap()
        .unwrap();

        replace_conversation_messages(
            dir.path(),
            &created.conversation_id,
            vec![ChatMessageRecord::user(
                "m1".to_string(),
                "t1".to_string(),
                "hello".to_string(),
            )],
        )
        .unwrap();

        let read = get_conversation(dir.path(), &created.conversation_id).unwrap();
        assert_eq!(read.messages.len(), 1);
        assert_eq!(read.messages[0].text(), "hello");
    }

    fn conversation_with(dir: &Path, messages: Vec<ChatMessageRecord>) -> ChatConversationRecord {
        let created = create_conversation(
            dir,
            AgentBackend::ClaudeCode,
            Path::new("/tmp/work"),
            "s1".to_string(),
            &[],
        )
        .unwrap()
        .unwrap();
        replace_conversation_messages(dir, &created.conversation_id, messages).unwrap();
        get_conversation(dir, &created.conversation_id).unwrap()
    }

    fn thread() -> Vec<ChatMessageRecord> {
        vec![
            ChatMessageRecord::user_in(
                "m1".to_string(),
                "t1".to_string(),
                "first question".to_string(),
                ChatTurnEnvironment {
                    config_values: vec![ChatConfigValue {
                        id: "model".to_string(),
                        value: "sonnet".to_string(),
                    }],
                    host: Some(serde_json::json!({ "root": "/books" })),
                },
            ),
            ChatMessageRecord {
                content: vec![ChatReplayContentBlock::Text {
                    text: "first answer".to_string(),
                }],
                ..ChatMessageRecord::assistant_placeholder("t1".to_string())
            },
            ChatMessageRecord::user_in(
                "m3".to_string(),
                "t2".to_string(),
                "second question".to_string(),
                ChatTurnEnvironment {
                    config_values: vec![ChatConfigValue {
                        id: "model".to_string(),
                        value: "opus".to_string(),
                    }],
                    host: None,
                },
            ),
        ]
    }

    #[test]
    fn forking_from_an_answer_keeps_it_and_drops_what_came_after() {
        let dir = tempdir().unwrap();
        let source = conversation_with(dir.path(), thread());

        let fork = create_fork_conversation(
            dir.path(),
            &source.conversation_id,
            "t1",
            true,
            "s2".to_string(),
        )
        .unwrap();

        assert_eq!(fork.messages.len(), 2);
        assert_eq!(fork.messages[1].text(), "first answer");
        assert_eq!(fork.parent_conversation_id.as_deref(), Some(source.conversation_id.as_str()));
        assert_eq!(fork.forked_from_message_id.as_deref(), Some("t1"));
        assert!(fork.branch_history_pending);
        assert_eq!(fork.backend_session_id, "s2", "a fork gets a fresh agent session");
    }

    #[test]
    fn re_asking_a_question_drops_it_so_the_new_one_takes_its_place() {
        let dir = tempdir().unwrap();
        let source = conversation_with(dir.path(), thread());

        let fork = create_fork_conversation(
            dir.path(),
            &source.conversation_id,
            "m3",
            false,
            "s2".to_string(),
        )
        .unwrap();

        assert_eq!(fork.messages.len(), 2);
        assert_eq!(fork.messages.last().unwrap().text(), "first answer");
    }

    #[test]
    fn a_fork_opens_under_the_conditions_that_message_was_sent_under() {
        // Not today's: the second question was asked on a different model, and
        // a fork of the first that quietly used it would be answering a
        // different question from the one being branched.
        let dir = tempdir().unwrap();
        let source = conversation_with(dir.path(), thread());

        let fork = create_fork_conversation(
            dir.path(),
            &source.conversation_id,
            "t1",
            true,
            "s2".to_string(),
        )
        .unwrap();

        assert_eq!(fork.config_values[0].value, "sonnet");
    }

    #[test]
    fn an_answer_inherits_the_conditions_of_the_question_above_it() {
        // Only a user message carries an environment; forking from an answer
        // has to look back to the turn that produced it.
        let dir = tempdir().unwrap();
        let source = conversation_with(dir.path(), thread());

        let at_answer = environment_at_message(&source, "t1");
        assert_eq!(at_answer.config_values[0].value, "sonnet");
        assert_eq!(at_answer.host, Some(serde_json::json!({ "root": "/books" })));
    }

    #[test]
    fn a_conversation_with_no_recorded_conditions_still_forks() {
        // Written before turns recorded them. Opening under the agent's own
        // defaults is worse than exact and much better than refusing.
        let dir = tempdir().unwrap();
        let source = conversation_with(
            dir.path(),
            vec![ChatMessageRecord::user(
                "m1".to_string(),
                "t1".to_string(),
                "hello".to_string(),
            )],
        );

        assert_eq!(environment_at_message(&source, "m1"), ChatTurnEnvironment::default());
        assert!(create_fork_conversation(
            dir.path(),
            &source.conversation_id,
            "m1",
            true,
            "s2".to_string()
        )
        .is_ok());
    }

    #[test]
    fn forking_from_the_first_message_hands_over_no_history() {
        let dir = tempdir().unwrap();
        let source = conversation_with(dir.path(), thread());

        let fork = create_fork_conversation(
            dir.path(),
            &source.conversation_id,
            "m1",
            false,
            "s2".to_string(),
        )
        .unwrap();

        assert!(fork.messages.is_empty());
        assert!(
            !fork.branch_history_pending,
            "there is nothing above the branch point to hand over"
        );
    }

    #[test]
    fn forking_at_a_message_that_is_not_there_is_an_error() {
        let dir = tempdir().unwrap();
        let source = conversation_with(dir.path(), thread());

        let err = create_fork_conversation(
            dir.path(),
            &source.conversation_id,
            "nope",
            true,
            "s2".to_string(),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("nope"), "{err}");
    }

    #[test]
    fn the_branch_history_reads_as_dialogue_and_omits_the_tools() {
        // The tool calls were the *old* session's work; listing them would
        // tell the new agent it had already read files it has not read.
        let messages = vec![
            ChatMessageRecord::user("m1".to_string(), "t1".to_string(), "hi".to_string()),
            ChatMessageRecord {
                content: vec![
                    ChatReplayContentBlock::Tool {
                        tool: crate::session::ChatReplayToolCall {
                            tool_call_id: "c1".to_string(),
                            title: "Read".to_string(),
                            status: "completed".to_string(),
                            locations: Vec::new(),
                            content: Vec::new(),
                            raw_input: None,
                            raw_output: None,
                        },
                    },
                    ChatReplayContentBlock::Text {
                        text: "hello".to_string(),
                    },
                ],
                ..ChatMessageRecord::assistant_placeholder("t1".to_string())
            },
        ];

        let history = branch_history_text(&messages);
        assert_eq!(history, "User: hi\n\nAssistant: hello");
        assert!(!history.contains("Read"));
    }

    #[test]
    fn seeding_the_branch_history_happens_once() {
        let dir = tempdir().unwrap();
        let source = conversation_with(dir.path(), thread());
        let fork = create_fork_conversation(
            dir.path(),
            &source.conversation_id,
            "t1",
            true,
            "s2".to_string(),
        )
        .unwrap();
        assert!(fork.branch_history_pending);

        mark_branch_history_seeded(dir.path(), &fork.conversation_id).unwrap();
        let after = get_conversation(dir.path(), &fork.conversation_id).unwrap();
        assert!(!after.branch_history_pending);
    }

    #[test]
    fn a_file_written_before_forking_existed_still_opens() {
        // Version 1 had no environment, no parent and no pending history. It
        // is read with those at their defaults and rewritten as version 2.
        let dir = tempdir().unwrap();
        std::fs::write(
            conversation_path(dir.path()),
            r#"{"version":1,"conversations":[{
                "conversation_id":"c1","backend":"ClaudeCode","backend_session_id":"s1",
                "cwd":"/tmp","title":"Old chat","created_at":"2026-09-02T00:00:00Z",
                "updated_at":"2026-09-02T00:00:00Z","last_opened_at":"2026-09-02T00:00:00Z",
                "config_values":[],"messages":[{"message_id":"m1","turn_id":null,"role":"user",
                "thought":"","content":[{"kind":"text","text":"hello"}],"error":null}]}]}"#,
        )
        .unwrap();

        let read = get_conversation(dir.path(), "c1").unwrap();
        assert_eq!(read.title, "Old chat");
        assert!(read.parent_conversation_id.is_none());
        assert!(read.messages[0].environment.is_none());

        touch_conversation(dir.path(), "c1", None).unwrap();
        let text = std::fs::read_to_string(conversation_path(dir.path())).unwrap();
        assert!(text.contains("\"version\": 2"), "rewritten at the current version");
    }

    #[test]
    fn a_replayed_transcript_becomes_records_with_ids_of_their_own() {
        // The agent's replay carries no message ids; the transcript needs them
        // to key React rows and to address a message later.
        let records = records_from_replay(vec![ChatReplayMessage {
            role: "assistant".to_string(),
            thought: String::new(),
            content: vec![ChatReplayContentBlock::Text {
                text: "hi".to_string(),
            }],
        }]);

        assert_eq!(records.len(), 1);
        assert!(!records[0].message_id.is_empty());
        assert!(records[0].turn_id.is_none());
    }
}
