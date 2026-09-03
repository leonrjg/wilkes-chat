//! What a [`ChatEvent`] looks like on its way to a webview.
//!
//! A host has to name its own channels — that is its IPC, not this crate's —
//! but the *payload* is not a host's to invent. It was, in the application
//! this crate came out of: the shell hand-rolled a `serde_json::json!` per
//! variant and the client hand-rolled a matching TypeScript union, with
//! nothing but care holding the two together. `raw_input` was `undefined` on
//! one side and absent on the other, and the difference decided whether a
//! tool chip kept its input or lost it.
//!
//! So the payload is defined here, once, and the TypeScript in this same
//! package is generated from nothing else: `ChatUpdate` in `src/types.ts` is
//! the mirror of [`ChatUpdate`], field for field.

use serde::{Deserialize, Serialize};

use crate::session::{
    ChatConfigOption, ChatEvent, ChatLocation, ChatPermissionOption, ChatToolContent,
};

/// One update within a turn, as the client receives it.
///
/// `Tool` carries `Option`s with patch semantics — a field the agent did not
/// touch is absent, and the client keeps what it had. This is why the variant
/// is not simply the tool call: half an update is the normal case.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatUpdate {
    Text {
        delta: String,
    },
    Thought {
        delta: String,
    },
    Tool {
        tool_call_id: String,
        title: Option<String>,
        status: Option<String>,
        locations: Option<Vec<ChatLocation>>,
        content: Option<Vec<ChatToolContent>>,
        raw_input: Option<serde_json::Value>,
        raw_output: Option<serde_json::Value>,
    },
    Permission {
        request_id: String,
        tool_call_id: String,
        title: Option<String>,
        options: Vec<ChatPermissionOption>,
    },
    /// The turn failed. Not produced by [`emission`] — a failure is `send`'s
    /// return value, not a streamed event — but part of the same union
    /// because it lands in the same message, and a client that had to handle
    /// it separately would be told about failure twice in two shapes.
    Error {
        message: String,
    },
}

/// Where an event goes: into a turn, or onto the session as a whole.
///
/// The split is the whole reason this exists. A host emits turn updates on a
/// per-turn channel (so a client subscribes for the life of one message) and
/// session events on a per-session channel (so a crash reaches a client that
/// is not mid-turn). Deciding which is which from the variant, at each host,
/// is how one of them ends up on the wrong channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ChatEmission {
    Turn {
        turn_id: String,
        update: ChatUpdate,
    },
    SessionError {
        message: String,
    },
    ConfigOptions {
        options: Vec<ChatConfigOption>,
    },
}

/// The wire form of one event.
pub fn emission(event: ChatEvent) -> ChatEmission {
    match event {
        ChatEvent::TextDelta { turn_id, delta } => ChatEmission::Turn {
            turn_id,
            update: ChatUpdate::Text { delta },
        },
        ChatEvent::ThoughtDelta { turn_id, delta } => ChatEmission::Turn {
            turn_id,
            update: ChatUpdate::Thought { delta },
        },
        ChatEvent::ToolCall {
            turn_id,
            tool_call_id,
            title,
            status,
            locations,
            content,
            raw_input,
            raw_output,
        } => ChatEmission::Turn {
            turn_id,
            update: ChatUpdate::Tool {
                tool_call_id,
                title,
                status,
                locations,
                content,
                raw_input,
                raw_output,
            },
        },
        ChatEvent::PermissionRequest {
            turn_id,
            request_id,
            tool_call_id,
            title,
            options,
        } => ChatEmission::Turn {
            turn_id,
            update: ChatUpdate::Permission {
                request_id,
                tool_call_id,
                title,
                options,
            },
        },
        ChatEvent::SessionError { message } => ChatEmission::SessionError { message },
        ChatEvent::ConfigOptionsUpdated { options } => ChatEmission::ConfigOptions { options },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_text_delta_goes_to_its_turn() {
        let emitted = emission(ChatEvent::TextDelta {
            turn_id: "t1".to_string(),
            delta: "hi".to_string(),
        });
        assert_eq!(
            emitted,
            ChatEmission::Turn {
                turn_id: "t1".to_string(),
                update: ChatUpdate::Text {
                    delta: "hi".to_string()
                },
            }
        );
    }

    #[test]
    fn a_crash_goes_to_the_session_and_not_to_a_turn() {
        // A subprocess can die when no turn is running, so this event has
        // nowhere to be routed and must not be given a turn to belong to.
        let emitted = emission(ChatEvent::SessionError {
            message: "exited".to_string(),
        });
        assert!(matches!(emitted, ChatEmission::SessionError { .. }));
    }

    #[test]
    fn the_client_reads_kind_to_tell_updates_apart() {
        // `src/types.ts` discriminates this union on `kind`; the tag is the
        // contract, not an implementation detail of the serializer.
        let json = serde_json::to_value(ChatUpdate::Thought {
            delta: "…".to_string(),
        })
        .unwrap();
        assert_eq!(json, json!({ "kind": "thought", "delta": "…" }));
    }

    #[test]
    fn a_tool_update_omits_the_fields_it_did_not_touch() {
        // Present-but-null and absent mean the same thing to the client
        // (`?? previous`), but the shape is pinned so a change to it is a
        // change someone had to make on purpose.
        let json = serde_json::to_value(ChatUpdate::Tool {
            tool_call_id: "c1".to_string(),
            title: None,
            status: Some("completed".to_string()),
            locations: None,
            content: None,
            raw_input: None,
            raw_output: None,
        })
        .unwrap();

        assert_eq!(json["kind"], "tool");
        assert_eq!(json["status"], "completed");
        assert!(json["title"].is_null());
    }

    #[test]
    fn the_permission_prompt_carries_the_agents_own_options() {
        let json = serde_json::to_value(ChatUpdate::Permission {
            request_id: "r1".to_string(),
            tool_call_id: "c1".to_string(),
            title: Some("Run tests".to_string()),
            options: vec![ChatPermissionOption {
                option_id: "allow".to_string(),
                name: "Allow".to_string(),
                kind: "allow_once".to_string(),
            }],
        })
        .unwrap();

        assert_eq!(json["kind"], "permission");
        assert_eq!(json["options"][0]["option_id"], "allow");
        assert_eq!(json["options"][0]["kind"], "allow_once");
    }
}
