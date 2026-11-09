---
name: understanding-map
description: Create, maintain, or reopen a source-linked understanding map for the current Codex desktop chat, with a local right-panel map and native chat navigation.
---

# Understanding Map

Resolve every script below relative to this SKILL.md directory, regardless of the user's working directory. This installed skill includes its local server and platform-specific helper. Personal state lives in `~/.understanding-map`, or the explicit `UNDERSTANDING_MAP_HOME` override. Respect the host's filesystem and network permissions when writing there or starting the server.

## Enable or reopen

When asked to enable a map, run `python scripts/portable.py init` with the current trusted `CODEX_THREAD_ID`. Use the Python executable available on that computer. The result identifies this chat's private tracking.json. Read that configuration to obtain the state and view paths. Keep its access token out of user-facing text.

When asked to reopen an existing map, run `python scripts/portable.py reopen`. A `ready`, `restored`, or `view_only` result identifies its configuration. Reuse that map. For `not_found`, explain that no saved map exists and create one only when the user requested creation or activation. Preserve existing state on errors or conflicts.

Check `python scripts/portable.py status`. If the service is unavailable, the user can double-click the package's `02-Start` entry. When the user has requested running the map and the host allows it, `python scripts/portable.py serve` starts the same local service. Keep that process running. An occupied port belonging to another installation requires stopping that installation first.

When a map view and service are ready, open the configuration's panel_url on the right with the desktop `open_in_codex` tool. `queued` means visibility remains unconfirmed. The panel itself handles explicit node clicks through the installed helper. Reopening a selection does not request navigation.

## Capture completed history

The user's main task takes priority. On first activation, use `read_thread` to collect all available completed history for the current trusted chat, respecting page limits and chronological order. On subsequent turns, read back only to the saved checkpoint. Capture user messages and final assistant messages. Exclude commentary, reasoning, tool calls, and agent items whose IDs begin with `call_`. Keep ambient UI metadata and access tokens out of summaries. Structured test-feedback envelopes represent the user's actual answer.

The current reply is still in progress and can be captured on a later turn. Skills run while the assistant follows this workflow, so describe updates only after the corresponding files were written.

Pass chronological read_thread-style turns as stdin JSON to `python scripts/map_state.py ingest --state <state_file> --threshold <interval>`.

```json
{"session_id":"trusted-chat-id","turns":[]}
```

An initial nonempty history is due immediately. Thereafter the default interval is five completed turns, using the saved positive interval. If `due` is false, keep the current view until the threshold or an explicit refresh request.

## Update the map

For every pending user and final assistant message, write one faithful concise summary with a stable node ID and its original message ID in source_ids. Reuse existing topics, add topics for distinct subjects, and leave uncertain topic or parent relationships unassigned. Resolve explicit references before linking nodes. Retain assistant nodes for the timeline. User turns appear under document-style topic headings in the outline.

Pass a patch as stdin JSON to `python scripts/map_state.py apply --state <state_file>`.

```json
{"session_id":"trusted-chat-id","turn_ids":["completed-turn-id"],"topics":[{"id":"topic-id","label":"主题","parent_id":null}],"nodes":[{"id":"node-message-id","turn_id":"completed-turn-id","message_id":"message-id","role":"user","summary":"忠实摘要","topic_id":"topic-id","parent_ids":[],"source_ids":["message-id"]}]}
```

Cover every captured message in the selected completed turns once. The initial patch covers all collected history. Preserve the helper's coverage, session, and cycle checks. After a successful patch, run `python scripts/publish_view.py --state <state_file> --view <view_file> --session-id <trusted-chat-id>`.

## Native navigation and verification

The service listens only on loopback and launches the helper only for an explicit map click. It operates the currently focused Codex window. macOS needs the user's Accessibility permission. The bundled Mac build targets Apple Silicon with macOS 15+. Windows uses the included .NET Framework UI Automation helper in native Windows, outside WSL.

Map generation and summaries use Codex. Node navigation runs local code. Short user messages use a unique fragment from their paired reply in the same turn. Missing or repeated evidence can leave the exact source unverified. Preserve distinctions between a requested search, a revealed turn, and verified source visibility. The Mac search path has been user-tested. Windows has compile and pure-protocol validation, with native UI behavior awaiting a Windows test.

Development-tool access restrictions on Codex itself still apply. Do not run the native navigation path from agent tools when that target is disallowed. Use the user's explicit map click to test and rely on their reported result.
