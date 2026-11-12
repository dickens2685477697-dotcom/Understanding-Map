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

When the configuration and service are ready, open the configuration's panel_url on the right with the desktop `open_in_codex` tool. `queued` means visibility remains unconfirmed. The panel itself handles explicit node clicks through the installed helper. Reopening a selection does not request navigation.

## Refresh-driven updates

Opening or reloading the map panel, or clicking its 更新地图 button, sends a same-origin POST to its token-scoped `refresh` endpoint. The local service resolves the source chat from that token, reads only that chat through the official Codex app-server history APIs, and runs a bounded, ephemeral Codex JSON-summary task when new user messages exist. This worker uses local Codex authentication and the configured model. An available, authenticated Codex CLI is required. macOS prefers the desktop app's bundled CLI. Other installations use `codex` on PATH, or the binary explicitly named by `UNDERSTANDING_MAP_CODEX`.

Treat refresh as the update trigger. Do not collect or summarize chats automatically after a turn count or on unrelated assistant turns. The legacy interval field is retained for old saved data and is not a scheduling trigger. The first panel load can generate a missing map view once the configuration has been created.

The service records sent user messages even while an assistant reply is in progress. It retains final assistant text privately for context and native short-message positioning, and displays one summary per user message. Repeated checks reuse message IDs. Concurrent refreshes for one chat share an active job; status polling reads results without starting new jobs. Check the panel status before describing an update as complete. Preserve the last map on source/model/validation errors and report the actual status.

For an explicit map update request, reopen the saved panel and use its update control, or request the same token-scoped POST with the required Origin, Content-Type, and X-Understanding-Map-Action headers. Keep the token out of user-facing text. Independent source reads must match the saved source chat ID. Ephemeral summary jobs are separate from the source chat. Direct map_state.py ingest/apply remains a legacy recovery path for explicit repair, and must not run concurrently with a refresh job.

Topic parent_id defines conceptual hierarchy. Message parent_ids describe evidence-backed continuation. Timeline indentation and blue lightness encode topic hierarchy, with top-level topics on the left in dark blue and deeper topics farther right in lighter blue. Dashed links show time order. Reuse existing topics and leave uncertain relationships empty.

## Native navigation and verification

The service listens only on loopback and launches the helper only for an explicit map click. It operates the currently focused Codex window. macOS needs the user's Accessibility permission. The bundled Mac build targets Apple Silicon with macOS 15+. Windows uses the included .NET Framework UI Automation helper in native Windows, outside WSL.

Map generation and summaries use Codex. Node navigation runs local code. Short user messages use a unique fragment from their paired reply in the same turn. Missing or repeated evidence can leave the exact source unverified. Preserve distinctions between a requested search, a revealed turn, and verified source visibility. The Mac search path has been user-tested. Windows has compile and pure-protocol validation, with native UI behavior awaiting a Windows test.

Development-tool access restrictions on Codex itself still apply. Do not run the native navigation path from agent tools when that target is disallowed. Use the user's explicit map click to test and rely on their reported result.
