# Native conversation positioning experiment

Goal: clicking an Understanding Map node scrolls the existing Codex conversation
to its source message, as the native message navigation rail does.

`probe.html` is a real, read-only capability probe for the current panel surface.
It checks the documented `window.openai` compatibility methods without calling
them. It does not access chat text, session configuration, tokens, parent DOM,
private IPC, or an app debugger. No navigation method is invented or registered.

Run from the workspace root with a loopback-only static server, then open `probe.html`
in Codex's right browser panel. Recheck the interfaces in that actual surface.

```sh
python3 -m http.server 18769 --bind 127.0.0.1 --directory validation/understanding-map/native-navigation-probe
node validation/understanding-map/native-navigation-probe/test_probe.cjs
```

These commands assume the workspace root is the working directory.

Interpretation:

- An absent compatibility bridge says only that this particular page lacks
  `window.openai`; it does not rule out MCP Apps or every other integration.
- An available `openExternal` or `callTool` is not evidence of message positioning.
- `nativeNavigation: unverified` and `navigationAttempted: false` are intentional.
  This probe is not an implementation of native chat jumping.
- Native rail source inspection shows message lookup, virtualized-history reveal,
  and scrolling inside the application. The map still needs an authorized host
  adapter that exposes that behavior across the panel boundary. Raw map message
  IDs must also be verified against the host's content-unit IDs, including AI
  replies, rather than assumed identical.

The existing map and installed app are not modified by this experiment.

Live check on 2026-11-02: the probe loaded in the Codex in-app browser, and clicking
the recheck button produced `bridge: absent` for `window.openai`, with all 12
allow-listed methods absent. The page showed `navigationAttempted: false`.
Browser error/warning logs were empty. The standalone probe checks also passed.
This validates the diagnostic, not native conversation positioning.

Official interface references inspected on 2026-11-02:

- https://developers.openai.com/plugins/reference
- https://learn.chatgpt.com/docs/app/commands#deep-links
