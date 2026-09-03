//! Folding a stream of [`ChatEvent`]s back into a transcript.
//!
//! The same fold happens twice in every application: once in the window, so
//! the reader watches an answer arrive, and once behind it, so the answer is
//! still there tomorrow. Those two are the same operation on the same shapes,
//! and this is the one that decides it — the client's copy renders it, and
//! this is what gets stored.

use crate::session::{ChatEvent, ChatReplayContentBlock, ChatReplayToolCall};
use crate::store::ChatMessageRecord;

/// Fold one event into the transcript it belongs to.
///
/// Events that name no turn (a session error, a config change) are not part of
/// any message and are ignored here; a host surfaces those on the session, not
/// in the thread. An event for a turn with no message waiting — a late delta
/// from a conversation that has been replaced — is dropped rather than
/// inventing a message to hold it.
pub fn apply_chat_event(messages: &mut [ChatMessageRecord], event: &ChatEvent) {
    let turn_id = match event {
        ChatEvent::TextDelta { turn_id, .. }
        | ChatEvent::ThoughtDelta { turn_id, .. }
        | ChatEvent::ToolCall { turn_id, .. } => turn_id,
        _ => return,
    };
    let Some(message) = messages
        .iter_mut()
        .rev()
        .find(|message| message.role == "assistant" && message.turn_id.as_deref() == Some(turn_id))
    else {
        return;
    };

    match event {
        ChatEvent::TextDelta { delta, .. } => {
            if let Some(ChatReplayContentBlock::Text { text }) = message.content.last_mut() {
                text.push_str(delta);
            } else {
                message.content.push(ChatReplayContentBlock::Text {
                    text: delta.clone(),
                });
            }
        }
        ChatEvent::ThoughtDelta { delta, .. } => message.thought.push_str(delta),
        ChatEvent::ToolCall {
            tool_call_id,
            title,
            status,
            locations,
            content,
            raw_input,
            raw_output,
            ..
        } => {
            let existing = message.content.iter_mut().find_map(|block| match block {
                ChatReplayContentBlock::Tool { tool } if tool.tool_call_id == *tool_call_id => {
                    Some(tool)
                }
                _ => None,
            });
            if let Some(tool) = existing {
                // Patch semantics: a field the update did not carry keeps what
                // it had. An update reports only what changed, so overwriting
                // with `None` would blank a title mid-call.
                if let Some(title) = title {
                    tool.title = title.clone();
                }
                if let Some(status) = status {
                    tool.status = status.clone();
                }
                if let Some(locations) = locations {
                    tool.locations = locations.clone();
                }
                if let Some(content) = content {
                    tool.content = content.clone();
                }
                if raw_input.is_some() {
                    tool.raw_input = raw_input.clone();
                }
                if raw_output.is_some() {
                    tool.raw_output = raw_output.clone();
                }
            } else {
                message.content.push(ChatReplayContentBlock::Tool {
                    tool: ChatReplayToolCall {
                        tool_call_id: tool_call_id.clone(),
                        title: title.clone().unwrap_or_else(|| "Tool call".to_string()),
                        status: status.clone().unwrap_or_else(|| "pending".to_string()),
                        locations: locations.clone().unwrap_or_default(),
                        content: content.clone().unwrap_or_default(),
                        raw_input: raw_input.clone(),
                        raw_output: raw_output.clone(),
                    },
                });
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread() -> Vec<ChatMessageRecord> {
        vec![
            ChatMessageRecord::user("m1".to_string(), "t1".to_string(), "hello".to_string()),
            ChatMessageRecord::assistant_placeholder("t1".to_string()),
        ]
    }

    fn text_delta(turn: &str, delta: &str) -> ChatEvent {
        ChatEvent::TextDelta {
            turn_id: turn.to_string(),
            delta: delta.to_string(),
        }
    }

    #[test]
    fn deltas_accumulate_into_one_text_block() {
        let mut messages = thread();
        apply_chat_event(&mut messages, &text_delta("t1", "Hel"));
        apply_chat_event(&mut messages, &text_delta("t1", "lo"));

        assert_eq!(messages[1].content.len(), 1);
        assert_eq!(messages[1].text(), "Hello");
    }

    #[test]
    fn a_delta_for_an_unknown_turn_is_dropped() {
        // A late chunk from a conversation the user has already left must not
        // land in whatever message happens to be last.
        let mut messages = thread();
        apply_chat_event(&mut messages, &text_delta("t9", "stray"));
        assert_eq!(messages[1].text(), "");
    }

    #[test]
    fn a_delta_never_lands_in_the_user_message() {
        let mut messages = vec![ChatMessageRecord::user(
            "m1".to_string(),
            "t1".to_string(),
            "hello".to_string(),
        )];
        apply_chat_event(&mut messages, &text_delta("t1", "answer"));
        assert_eq!(messages[0].text(), "hello");
    }

    #[test]
    fn a_tool_call_is_created_once_and_then_patched() {
        let mut messages = thread();
        apply_chat_event(
            &mut messages,
            &ChatEvent::ToolCall {
                turn_id: "t1".to_string(),
                tool_call_id: "c1".to_string(),
                title: Some("Read".to_string()),
                status: Some("pending".to_string()),
                locations: None,
                content: None,
                raw_input: None,
                raw_output: None,
            },
        );
        apply_chat_event(
            &mut messages,
            &ChatEvent::ToolCall {
                turn_id: "t1".to_string(),
                tool_call_id: "c1".to_string(),
                title: None,
                status: Some("completed".to_string()),
                locations: None,
                content: None,
                raw_input: None,
                raw_output: None,
            },
        );

        assert_eq!(messages[1].content.len(), 1);
        let ChatReplayContentBlock::Tool { tool } = &messages[1].content[0] else {
            panic!("the tool call became a text block");
        };
        assert_eq!(tool.status, "completed");
        assert_eq!(tool.title, "Read", "a field the update omitted was kept");
    }

    #[test]
    fn text_after_a_tool_call_starts_a_new_block_rather_than_reopening_the_old_one() {
        // Otherwise a reply reads out of order: everything the agent said
        // after the tool ran would be appended to what it said before.
        let mut messages = thread();
        apply_chat_event(&mut messages, &text_delta("t1", "Looking…"));
        apply_chat_event(
            &mut messages,
            &ChatEvent::ToolCall {
                turn_id: "t1".to_string(),
                tool_call_id: "c1".to_string(),
                title: Some("Read".to_string()),
                status: Some("completed".to_string()),
                locations: None,
                content: None,
                raw_input: None,
                raw_output: None,
            },
        );
        apply_chat_event(&mut messages, &text_delta("t1", "Found it."));

        assert_eq!(messages[1].content.len(), 3);
        assert_eq!(messages[1].text(), "Looking…\n\nFound it.");
    }

    #[test]
    fn thoughts_accumulate_outside_the_content_blocks() {
        let mut messages = thread();
        apply_chat_event(
            &mut messages,
            &ChatEvent::ThoughtDelta {
                turn_id: "t1".to_string(),
                delta: "hmm".to_string(),
            },
        );
        assert_eq!(messages[1].thought, "hmm");
        assert!(messages[1].content.is_empty());
    }

    #[test]
    fn an_event_that_belongs_to_no_turn_changes_nothing() {
        let mut messages = thread();
        apply_chat_event(
            &mut messages,
            &ChatEvent::SessionError {
                message: "died".to_string(),
            },
        );
        assert_eq!(messages[1].text(), "");
        assert!(messages[1].error.is_none());
    }
}
