import AppKit
import Foundation

@MainActor
extension TerminalCoordinator {
    func startAllSessions() {
        for tab in tabs {
            startSessions(for: tab)
        }
    }

    func startSessions(for tab: TabState) {
        for pane in tab.panes where pane.session == nil {
            startSession(for: pane)
        }
    }

    func startSession(for pane: PaneState) {
        updatePaneStatus(pane, status: .connecting)
        disposePromptHookCapture(for: pane)
        if let existingBridge = pane.bridge {
            Task { await existingBridge.detachAll() }
            pane.bridge = nil
        }
        let environmentOverrides = preparePromptHookCapture(for: pane)?.environmentOverrides ?? [:]
        do {
            let session = try TerminalSession(
                index: pane.runtimeIndex,
                config: pane.config,
                environmentOverrides: environmentOverrides,
                coordinator: self
            )
            pane.session = session
            pane.lastActivity = Date()
            pane.bridge = makeBridge(for: pane)
            updatePaneStatus(pane, status: .connected)
            pane.gitMonitor?.requestImmediateRefresh()
            pane.githubActionsMonitor?.requestImmediateRefresh()
        } catch {
            disposePromptHookCapture(for: pane)
            updatePaneStatus(pane, status: .disconnected)
            pane.bridge = nil
            print("Failed to start terminal session for index", pane.runtimeIndex, "error:", error)
        }
    }

    func terminateAllSessions() {
        for tab in tabs {
            for pane in tab.panes where pane.session != nil {
                disposePromptHookCapture(for: pane)
                pane.session?.terminate()
                pane.session = nil
                if let bridge = pane.bridge {
                    Task { await bridge.detachAll() }
                    pane.bridge = nil
                }
            }
        }
    }

    func paneWorkingDirectoryDidChange(index: Int, path: String) {
        guard let pane = panesByRuntimeIndex[index] else {
            return
        }

        let sanitizedPath = PathSanitizer.sanitize(path)
        guard !sanitizedPath.isEmpty else {
            return
        }

        if pane.config.workingDirectory == sanitizedPath {
            return
        }

        let previousDirectory = pane.config.workingDirectory
        let previousFallback = fallbackTitle(for: pane, workingDirectory: previousDirectory)
        let hasCustomTitle = !pane.config.title.isEmpty && pane.config.title != previousFallback
        let newTitle: String
        if hasCustomTitle {
            newTitle = pane.config.title
        } else {
            newTitle = fallbackTitle(for: pane, workingDirectory: sanitizedPath)
        }

        pane.config = TerminalConfig(
            title: newTitle,
            workingDirectory: sanitizedPath,
            startupCommand: pane.config.startupCommand,
            kind: pane.config.kind,
            conversationSummary: pane.config.conversationSummary
        )

        configureGitMonitor(for: pane)

        sendPaneConfigUpdate(for: pane)
        persistConfiguration()
    }

    func fallbackTitle(for pane: PaneState, workingDirectory override: String?) -> String {
        let trimmedOverride = override?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let baseDirectory = trimmedOverride.isEmpty
            ? pane.config.workingDirectory
            : trimmedOverride
        let trimmedDirectory = baseDirectory.trimmingCharacters(in: .whitespacesAndNewlines)

        if !trimmedDirectory.isEmpty {
            let lastComponent = URL(fileURLWithPath: trimmedDirectory).lastPathComponent
            if !lastComponent.isEmpty {
                return lastComponent
            }
        }

        return "Terminal \(pane.runtimeIndex + 1)"
    }

    func resolvePaneTitle(for pane: PaneState, proposed: Any?, workingDirectory: String?) -> String {
        if let string = proposed as? String {
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
            return fallbackTitle(for: pane, workingDirectory: workingDirectory)
        }

        if proposed is NSNull {
            return fallbackTitle(for: pane, workingDirectory: workingDirectory)
        }

        let existing = pane.config.title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !existing.isEmpty {
            return existing
        }

        return fallbackTitle(for: pane, workingDirectory: workingDirectory)
    }

    func makeBridge(for pane: PaneState) -> TerminalSessionBridge {
        TerminalSessionBridge(
            sendToProcess: { [weak pane] data in
                Task { @MainActor in
                    guard let pane else { return }
                    pane.session?.send(data: data)
                }
            },
            activityRecorder: { [weak pane] timestamp in
                Task { @MainActor in
                    guard let pane else { return }
                    pane.lastActivity = timestamp
                }
            },
            transcriptCapacity: nil
        )
    }

    func sessionDidEnd(_ session: TerminalSession, at index: Int) {
        guard let pane = panesByRuntimeIndex[index], pane.session === session else {
            return
        }

        pane.session = nil
        disposePromptHookCapture(for: pane)
        if let bridge = pane.bridge {
            Task { await bridge.detachAll() }
            pane.bridge = nil
        }
        if activePaneRuntimeIndex == index {
            activePaneRuntimeIndex = nil
        }
        updatePaneStatus(pane, status: .disconnected)
    }

    func sendControlCharacter(_ control: TerminalSession.ControlCharacter) {
        guard
            let index = activePaneRuntimeIndex,
            let pane = panesByRuntimeIndex[index],
            let session = pane.session
        else {
            NSSound.beep()
            return
        }
        session.sendControlCharacter(control)
    }
}
