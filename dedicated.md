# Dedicated Agent Integration Tasks

## Shared Foundation

[ ] Add a first-class pane/session kind to the native model so panes are no longer treated as generic shells only. Update `Sources/codigo-editor/TerminalConfig.swift`, `Sources/codigo-editor/ConfigurationStore.swift`, `Sources/codigo-editor/TerminalCoordinator.swift`, and the web payload/types in `Sources/codigo-editor/Web/components/types.ts`, `Sources/codigo-editor/Web/components/dataTransforms.ts`, and `Sources/codigo-editor/Web/main.ts` so each pane can declare `shell`, `codex`, or `claude`.

[ ] Persist the pane/session kind in stored tabs and panes, including migration for older saved configurations that do not have the field yet. Default existing panes to `shell`, and default the primary starter-created pane to the currently selected starter preset when reconstructing tabs in `Sources/codigo-editor/TerminalCoordinator+Configuration.swift`.

[ ] Split session startup into strategy objects or dedicated code paths instead of hard-coding `zsh` for every pane. Refactor `Sources/codigo-editor/TerminalCoordinator+Sessions.swift` so `startSession(for:)` dispatches to a `ShellSession`, `CodexSession`, or `ClaudeSession` launcher based on pane kind.

[ ] Keep the existing terminal renderer reusable for all session kinds, but stop using terminal keystroke heuristics as the primary semantic source. Narrow `Sources/codigo-editor/Web/components/terminals.ts` so prompt tracking is either disabled by default or explicitly marked as fallback-only for `shell` panes.

[ ] Add a small agent-session event surface on the native side for semantic updates that do not come from terminal bytes. Create payloads for events like `conversationSummaryUpdated`, `agentReady`, `agentBusy`, `agentTurnStarted`, and `agentTurnCompleted`, and deliver them alongside the existing terminal byte stream through `Sources/codigo-editor/TerminalCoordinator+WebView.swift`.

[ ] Update the agent row UI in `Sources/codigo-editor/Web/components/panes.ts` so summary rendering prefers dedicated semantic metadata first, terminal title second only when explicitly enabled, and raw path/title last.

[ ] Rename the current summary-setting language so it reflects the new architecture. In `Sources/codigo-editor/SettingsWindowController.swift`, distinguish between `Dedicated Agent Metadata`, `Terminal Title`, and `Local Command (fallback)` rather than presenting the heuristic path as the primary implementation.

[ ] Add a clear per-pane capability flag in web/native state so the UI can show when summaries are authoritative versus heuristic. This should be visible in the switcher row logic and available for future badges/tooltips.

[ ] Add focused tests for persistence, pane migration, and payload serialization so adding pane kind does not silently reset user tabs. Extend `Tests/codigo-editorTests/ConfigurationStoreTests.swift` and add new tests around pane bootstrap payloads if needed.

## Codex via app-server

[ ] Introduce a dedicated `CodexSession` implementation that launches and manages `codex app-server` instead of spawning `zsh` with `codex` as a startup command. This should live in a new native file such as `Sources/codigo-editor/CodexSession.swift` and be owned by `TerminalCoordinator`.

[ ] Define the minimum app-server lifecycle needed for the first integration: process launch, initialize handshake, thread creation/resume, turn submission, event streaming, shutdown, and reconnect/error handling. Keep the first version strictly local `stdio` transport and do not add websocket support.

[ ] Create Codable request/response types for the subset of the Codex app-server protocol the app will actually use. Keep these types in a small dedicated file rather than mixing them into generic terminal code.

[ ] At session startup, initialize the app-server connection and either create a new thread or resume a saved thread associated with the pane. Store the resulting Codex thread id in pane state so the session can continue across subsequent turns and app reloads.

[ ] Add a native-side message path for “submit user turn” that sends the exact prompt to Codex app-server using structured turn submission rather than writing characters into a PTY. The web composer or command UI should call this path for Codex panes instead of `sendInput`.

[ ] Stream Codex events back into the existing terminal UI in a compatible way so the user still sees output in the console, but also capture semantic events separately. Treat terminal rendering as presentation, not as the source of truth for summary/state.

[ ] Populate `conversationSummary` from authoritative Codex data. First preference should be thread name if Codex explicitly provides one; second preference should be thread preview / first-user-message-derived metadata; only if neither exists should the app fall back to the existing local summarizer.

[ ] Update pane status from Codex turn state instead of terminal byte activity where possible. For example, map in-progress turn execution to `connected/working`, idle thread state to `connected/ready`, and transport/process failure to `disconnected`.

[ ] Decide and implement how approvals from Codex app-server should surface in the UI. Even if the first version does not support full inline approvals, the architecture should leave room for explicit approval prompts rather than pretending approvals are just terminal text.

[ ] Add persistence for Codex thread ids and any other minimal resume metadata needed to reopen a Codex pane after app restart. This belongs in the stored pane configuration, not in transient web state.

[ ] Add a dedicated “new Codex pane” launch path so the app can create a Codex-backed pane without going through `startupCommand`. Update pane creation in `Sources/codigo-editor/TerminalCoordinator+Messaging.swift` and any relevant web actions in `Sources/codigo-editor/Web/components/columnActions.ts`.

[ ] Keep the current PTY-based Codex starter path behind a fallback or migration path only. Existing panes with `startupCommand: "codex"` should either migrate to `paneKind: codex` or continue to work with a clear compatibility branch until migration is complete.

[ ] Add failure handling for cases where `codex` is installed but `codex app-server` is unavailable or returns an incompatible schema/version. The pane should degrade gracefully and expose a clear error in the UI rather than silently falling back to terminal heuristics.

[ ] Add tests for Codex session startup, handshake failure, summary updates from thread metadata, and persisted resume behavior. These can be mostly unit tests around the protocol layer plus a few coordinator integration tests.

## Claude via dedicated structured integration

[ ] Introduce a dedicated `ClaudeSession` implementation instead of treating Claude as `zsh` plus `claude` startup text. Keep the architecture parallel to `CodexSession`, but do not assume the protocol is the same.

[ ] Choose one official Claude integration surface for v1 and encode that choice in the implementation plan. Preferred order: Anthropic Agent SDK if it fits the app architecture cleanly, otherwise `claude -p --input-format stream-json --output-format stream-json` as the structured local CLI path.

[ ] Define the minimal Claude session contract the app needs: start session, submit prompt, stream structured output, detect turn completion, and extract a stable task summary or equivalent thread/session metadata when available.

[ ] Build a native adapter that converts Claude’s structured events into the app’s shared semantic event surface (`conversationSummaryUpdated`, ready/busy, turn started/completed). Do not route those through the generic terminal prompt tracker.

[ ] Decide how Claude panes render transcript output in the existing console area. If the chosen Claude integration already provides formatted text chunks, translate them into terminal-compatible display output while keeping the structured stream available separately for UI state.

[ ] Populate `conversationSummary` for Claude panes from authoritative structured input first. If Claude’s official structured surface does not expose a stable thread preview/title, summarize the exact submitted user turn natively with the existing strict-JSON local summarizer rather than scraping PTY input.

[ ] Add explicit version/capability checks so the app can tell whether the installed Claude tool supports the chosen structured mode. If not, surface a clear unsupported-state message and optionally allow the user to opt into the legacy shell fallback.

[ ] Add a dedicated “new Claude pane” launch path parallel to the Codex pane path. Update starter selection and pane creation so a Claude preset creates `paneKind: claude`, not `shell` with a `claude` command string.

[ ] Keep the current terminal-only Claude path as temporary compatibility only. If the user explicitly launches an arbitrary `claude` shell command in a shell pane, do not pretend the app has authoritative Claude semantics for that pane.

[ ] Add tests for Claude structured-session startup, summary updates, and unsupported-version handling.

## Generic Shell / Fallback Path

[ ] Re-scope the current local summary command so it is explicitly a fallback for plain shell panes only. Update `Sources/codigo-editor/TerminalCoordinator+ConversationSummary.swift` and `Sources/codigo-editor/Web/components/terminals.ts` to reflect that dedicated sessions should bypass this path entirely.

[ ] Remove any current assumptions that `startupCommand == codex` or `startupCommand == claude` implies a semantic integration. Starter command text should not be used as the long-term source of pane behavior once pane kind exists.

[ ] Tighten the fallback shell summarizer so it only runs when the user explicitly enables it in settings. The app should not silently guess conversation topics for arbitrary shell panes by default.

[ ] Keep `Terminal Title` mode available for advanced users, but document it as best-effort display metadata, not as a semantic integration. This should remain a user-controlled fallback rather than the recommended default.

[ ] Add UI copy that makes the distinction obvious: dedicated integrations provide authoritative summaries, while shell summaries are approximate and may be wrong.

## Migration and Rollout

[ ] Add a migration path for current users who already have primary panes with `startupCommand` values like `codex` or `claude`. On first load after the feature lands, map known starter commands to `paneKind` when the pane still matches the default starter behavior.

[ ] Avoid destructive migration for custom shell commands. If a pane uses a custom command string or additional shell syntax, keep it as `shell` and do not infer a dedicated agent type automatically.

[ ] Add a hidden or experimental feature flag for dedicated agent sessions so the Codex path can be exercised before making it the default for all users.

[ ] Ship the first rollout with Codex dedicated integration first, because it has the clearest upstream structured surface. Keep Claude structured integration behind the same architecture but as a second phase if needed.

[ ] After Codex dedicated integration is stable, remove or significantly de-emphasize the current Codex-specific prompt heuristic in `Sources/codigo-editor/Web/components/terminals.ts` so the app is not maintaining two conflicting summary sources for the same agent.

[ ] Document the expected local dependencies and version requirements for each dedicated agent type so users know what must be installed for `codex` and `claude` panes to work in dedicated mode.

## Validation

[ ] Add end-to-end validation for all three pane kinds: shell pane startup, Codex dedicated pane startup and turn submission, and Claude dedicated pane startup and turn submission.

[ ] Verify that stacked agent rows always show the correct summary source after pane creation, tab switching, pane removal, session reconnect, and app restart.

[ ] Verify that unread counts, focused-pane switching, and summary updates remain correct when multiple dedicated agents are running simultaneously in the same project tab.

[ ] Verify that no dedicated agent path blocks the UI thread during startup, streaming, or reconnect, and keep local summary fallback work off the main actor except for final state application.
