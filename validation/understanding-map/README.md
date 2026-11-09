# Incremental retrieval experiment

The opt-in native navigation prototype is separate from this retrieval experiment.
Its user-run setup is documented in [native-helper/使用说明.txt](native-helper/使用说明.txt).
On 2026-11-09 the user confirmed that clicking a map node jumps to its source
in the native Codex chat. The request, input validation, and dry-run checks pass.
The user also confirmed that the previously failing short-message node reaches
the corresponding turn with the short source visible, using its paired reply as context.
Normal preview mode does not
launch the helper; native mode requires manually starting
`start-native-navigation.command`. No model is called for a navigation request.

Run with `python3 validation/understanding-map/evaluate.py`. This is a standalone, offline feasibility experiment; no model or API is used, no global configuration is changed, and no network calls are made.

The fixture is a manually authored, shortened set of 12 nodes based on the conversation. Six hand-picked queries exercise references to earlier nodes, multiple themes, a correction, turn information, resuming a topic, and an unknown explicit ID. The code demonstrates candidate selection and structural evidence-ID validation. It does **not** generate summaries or relationships, check semantic truth, operate on the actual conversation feed, or prove that a model can infer relationships using the candidates.

The script reports characters in retrieved node summaries compared to the characters in all node summaries across the same queries. It excludes the new message, prompts, structured output, metadata, retransmission, retries, and every other model cost. Characters are not tokens; this is not a cost estimate. Only six hand-picked cases are evaluated, so do not generalize the results.

Important observed limitations:

- `09 继承到 03` retrieves both 09 and 03: simple regex cannot distinguish the new message identifier from its intended parent.
- A valid evidence ID proves only that an identifier exists, not that it supports the proposed conclusion.
- Bigram matching cannot reliably resolve paraphrases, implicit references, or corrections. Candidate retrieval can miss older relevant information.
- A missing explicit reference is returned as unresolved. Production systems must not quietly use an unrelated recent node in its place.

The fixture does not require credentials, optional packages, or network access.
