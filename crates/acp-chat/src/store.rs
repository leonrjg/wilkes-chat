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
const STORE_VERSION: u32 = 1;

/// The longest a derived title gets. Past this the history menu is showing a
/// paragraph, not a name.
const TITLE_CHAR_LIMIT: usize = 80;

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
    };

    mutate_store(data_dir, |store| store.conversations.push(record.clone()))?;
    Ok(Some(record))
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
        store.version == STORE_VERSION,
        "unsupported chat conversation version: {} (this build reads {STORE_VERSION})",
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
