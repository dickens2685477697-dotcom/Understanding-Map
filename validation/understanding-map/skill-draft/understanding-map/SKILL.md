---
name: understanding-map
description: Track an enabled Codex desktop conversation as an Understanding Map, initialize prior history on first use, and refresh incrementally; also use when asked to open or configure the map.
---

# Understanding Map

The user's main task takes priority. When conversation tracking is enabled for the current Codex desktop chat, maintain one source-linked map node for each user message and final assistant message. On first activation in a chat with existing completed history, initialize the map on the next assistant turn without waiting for the interval. After successful initialization, default to five new completed user turns per update unless the user specifies another positive interval. Keep all branches visible by default. The outline view is a document-style topic hierarchy with user turns as numbered entries; retain assistant nodes and show them in the timeline rather than nesting every user message beneath another message.

A Skill is not a background listener or a scheduling guarantee: these checks happen only while the assistant is running and follows this workflow. The current reply is not complete until after the assistant finishes, so the latest turn can normally be collected on a later turn. Do not claim an update happened unless its checkpoint and view were actually written.

## Reopen a previously enabled map

When the user asks to reopen the map, for example “打开理解地图” or `$understanding-map 打开地图`, run `scripts/reopen_map.py --directory validation/understanding-map-private` from the workspace. It uses the trusted `CODEX_THREAD_ID` and the existing session configuration. Reopening must not reset or initialize a tracker, discard nodes, or silently replace conflicting saved data. If the derived view is missing or behind the saved state, it restores it only after checking existing nodes agree.

For `ready` or `restored`, reuse the panel URL in the returned configuration and open it on the right with `open_in_codex`. If the local preview is not running, start the bundled `scripts/preview_server.py --config <config-path>` when permitted, then open the same URL; do not create a new token or print it. For `view_only`, open the surviving view and explain that the saved state is unavailable for further updates. For `not_found`, report that this chat has no saved map; do not create an empty one while reopening. On any conflict or service error, preserve the existing files and report what prevented recovery. An `open_in_codex` response of `queued` is not proof that the panel is visible.

Map content is saved separately from the panel. The panel also attempts to restore its selected view, manually collapsed groups, selection, and scroll position using local browser storage, which may be unavailable or cleared. This Skill supplies a conversational way to reopen the map; it does not install a persistent native toolbar button.

## Session and checkpoint

For the current experiment, run `scripts/init_tracker.py --directory validation/understanding-map-private` from the workspace. It identifies the chat using `CODEX_THREAD_ID`, reuses its existing configuration, or creates a separate private one when tracking has been enabled for this chat. The configuration contains a session ID, interval, private state path, summary-only view path, and token-scoped panel URL. Require the current trusted session ID to match. Never inspect or update a different chat on the basis of a guessed ID, or overwrite another session's configuration or map. Skill activation and reliable tools are not guaranteed on every turn.

While handling a turn for an enabled session, use the desktop `read_thread` tool if available. On first initialization, page through all available completed history; on later checks, page only until reaching the processed checkpoint. Convert newest-first responses to chronological order and respect pagination limits. Collect completed turns only; ignore tool output, commentary, and non-final reasoning. Do not mistake ambient UI metadata for user-authored requests or copy access tokens into summaries. An incomplete or unavailable response is not evidence that a completed round has been captured. If the host tool is unavailable, report the limitation instead of inventing history.

Run `scripts/map_state.py ingest --state <state-file> --threshold <interval>` with stdin JSON `{ "session_id": "...", "turns": [...] }`. Feed chronological `read_thread`-style turns. The helper persists original user and final assistant text, so keep its state file outside any HTTP-served directory. `due_reason: initial` means initialize immediately, even below the threshold, and cover every collected completed turn; an empty history is not due. After initialization, `due_reason: threshold` indicates the normal interval. If neither applies, keep existing map nodes unchanged unless the user explicitly requests a refresh. A failed check must not interfere with the user's primary task.

## Incremental update

When initialization is due or the threshold is reached, summarize every captured message in the pending turns, not just one summary for the batch. On first initialization, collect all available completed history before submitting the first batch; it must cover every collected turn and must not replace existing nodes. Organize user-turn entries under concise topic headings, with nested subtopics where supported by the discussion. Reuse existing topic IDs and add a new topic only for a distinct subject; if uncertain, leave `topic_id` null so the entry remains visible under 待归类. Thereafter, use only new messages, recent context, and a small set of relevant existing map nodes; retrieve older source text when needed. Resolve explicit references before relying on topical similarity. When a relationship is unsupported or uncertain, leave `parent_ids` empty instead of inventing one.

Pass `scripts/map_state.py apply --state <state-file>` JSON on stdin:

```json
{"session_id":"session-id","turn_ids":["turn-id"],"topics":[{"id":"topic-id","label":"主题名称","parent_id":null}],"nodes":[{"id":"node-id","turn_id":"turn-id","message_id":"message-id","role":"user","summary":"简短忠实的摘要","topic_id":"topic-id","parent_ids":[],"source_ids":["message-id"]}]}
```

Cover each captured user and final assistant message once with stable unique IDs. Include only newly created topics in `topics`; reference existing topics without re-adding them. Cite the original `message_id` in `source_ids` and other source IDs when needed. The helper checks coverage, known IDs, and cycles; it cannot check semantic truth. Review failure instead of guessing or silently dropping messages.

Once the patch succeeds, publish only the allow-listed summary view with `scripts/publish_view.py --state <state-file> --view <view-file> --session-id <session-id>`. It atomically replaces the view. The experiment's panel polls that file through its token-scoped local preview server, so it can refresh without exposing the raw state. Summaries may still be sensitive. Keep access limited to the current session and don't send data to an external service without authorization.

If the current host provides `open_in_codex` and the configured preview service is running, open the configured panel URL on the right when needed. The bundled `scripts/preview_server.py --config <config-path>` can provide a token-scoped local preview using `scripts/live-panel.html`; it listens only on loopback. A user can select a node to request its captured message and copy a short excerpt to find it in chat; the current panel does not automatically scroll the native chat. Do not claim message-level jumping works without a verified host capability. Start the server only when needed and permitted, and do not expose or print the access token. It may not survive a restart and is not a native plugin sidebar. If a required tool or service is unavailable, preserve the checkpoint and report the limitation. Never say the map is automatically updating in the background unless a separate trigger has actually been verified.
