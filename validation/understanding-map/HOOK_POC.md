# Synthetic hook capture experiment

This is an **offline simulation**, not an installed Codex hook. It does not prove
that any hook fires in Codex desktop, that the desktop can host a persistent
panel, or that every message can be captured. No user configuration is read or
changed. The script rejects events without `synthetic_test_event: true`; this
field is a safety marker for this test and is not an official hook field. Do not
install this script as a real hook.

The input shape models documented fields: common `session_id` and
`hook_event_name`, `UserPromptSubmit`'s `turn_id` and `prompt`, and `Stop`'s
`turn_id` and nullable `last_assistant_message`. See the official
[hooks reference](https://learn.chatgpt.com/docs/hooks). Output is the empty
JSON object `{}` to avoid adding model context. No network or model call occurs.

Run from the workspace root:

```sh
python3 validation/understanding-map/test_hook_poc.py
```

The tests pass only synthetic payloads to the script via JSON on stdin, store
SQLite files in a temporary directory, and clean it up afterwards. No real chat
is ingested. Events are stored under `(session_id, turn_id, hook_event_name)`;
replaying identical events is idempotent, and `Stop` can arrive before the user
prompt and can have a null message. Different payloads for the same key are
rejected instead of silently overwritten. In a production design a repeated
`Stop` may represent legitimate continuation or revision: this simple key is
not sufficient to decide what to do, and the experiment deliberately reports a
conflict. Concurrent delivery and lifecycle cancellation are not tested here.

To run manually, create a temporary directory and pass its existing path as
`--test-data-dir`. The script rejects directories outside the system temporary
directory or `/private/tmp`. It stores only the synthetic marker-validated
fields required for the experiment and never follows a transcript path.
