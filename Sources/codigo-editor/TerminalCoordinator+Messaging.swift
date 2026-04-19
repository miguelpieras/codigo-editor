import AppKit
import Foundation
import UserNotifications
import WebKit

@MainActor
extension TerminalCoordinator {
    func handleUIReady() {
        guard !sessionsStarted else { return }
        sessionsStarted = true
        startAllSessions()
        for tab in tabs {
            for pane in tab.panes {
                pane.gitMonitor?.requestImmediateRefresh()
                pane.githubActionsMonitor?.requestImmediateRefresh()
            }
        }
        flushPendingGitSnapshots()
        flushPendingGitHubActionSnapshots()
    }

    func handleSend(body: Any) {
        guard let payload = body as? [String: Any],
              let index = payload["index"] as? Int,
              let base64 = payload["payload"] as? String,
              let data = Data(base64Encoded: base64),
              let pane = panesByRuntimeIndex[index],
              let session = pane.session else {
            return
        }
        session.send(data: data)
        activePaneRuntimeIndex = index
    }

    func handleRenameTab(body: Any) {
        guard let payload = body as? [String: Any],
              let index = payload["index"] as? Int,
              let rawTitle = payload["title"] as? String,
              tabs.indices.contains(index) else {
            return
        }

        let trimmedTitle = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            return
        }

        tabs[index].title = trimmedTitle
        persistConfiguration()
    }

    func handleNewTabRequest() {
        guard let selectedPath = promptForWorkingDirectory() else {
            return
        }
        let directoryName = URL(fileURLWithPath: selectedPath, isDirectory: true).lastPathComponent
        let preferredTitle = directoryName.trimmingCharacters(in: .whitespacesAndNewlines)
        let tabTitle = makeUniqueTabTitle(from: preferredTitle)
        let newTab = makeTabState(title: tabTitle, workingDirectory: selectedPath)
        tabs.append(newTab)
        persistConfiguration()
        if sessionsStarted {
            startSessions(for: newTab)
            for pane in newTab.panes {
                pane.gitMonitor?.requestImmediateRefresh()
                pane.githubActionsMonitor?.requestImmediateRefresh()
            }
        }
        sendAddTab(newTab, activeIndex: tabs.count - 1)
    }

    private func promptForWorkingDirectory() -> String? {
        guard ensureStarterCommandPreferenceConfirmed() else {
            return nil
        }
        let panel = NSOpenPanel()
        panel.prompt = "Choose"
        panel.title = "Select Workspace"
        panel.message = "Choose the folder where Codex should run."
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.directoryURL = preferredDirectoryURL()

        let response = panel.runModal()
        guard response == .OK, let url = panel.url else {
            return nil
        }

        let standardised = url.standardizedFileURL
        lastSelectedDirectoryURL = standardised
        return standardised.path
    }

    private func preferredDirectoryURL() -> URL {
        if let lastSelectedDirectoryURL, directoryExists(at: lastSelectedDirectoryURL) {
            return lastSelectedDirectoryURL
        }

        if let recentPath = tabs.last?.panes.first?.config.workingDirectory, !recentPath.isEmpty {
            let recentURL = URL(fileURLWithPath: recentPath, isDirectory: true)
            if directoryExists(at: recentURL) {
                return recentURL
            }
        }

        return FileManager.default.homeDirectoryForCurrentUser
    }

    func handleCloseTab(body: Any) {
        guard let payload = body as? [String: Any] else {
            return
        }

        let idString = payload["id"] as? String
        let indexNumber = payload["index"] as? Int

        var targetIndex: Int?
        if let idString, let uuid = UUID(uuidString: idString),
           let found = tabs.firstIndex(where: { $0.id == uuid }) {
            targetIndex = found
        } else if let indexNumber, tabs.indices.contains(indexNumber) {
            targetIndex = indexNumber
        }

        guard let index = targetIndex else {
            return
        }

        let removedTab = tabs.remove(at: index)

        for pane in removedTab.panes {
            cancelConversationSummaryTask(for: pane.runtimeIndex)
            disposePromptHookCapture(for: pane)
            pane.session?.terminate()
            pane.session = nil
            pane.gitMonitor?.invalidate()
            pane.gitMonitor = nil
            pane.githubActionsMonitor?.invalidate()
            pane.githubActionsMonitor = nil
            pendingGitHubActionSnapshots.removeValue(forKey: pane.runtimeIndex)
            if let bridge = pane.bridge {
                Task { await bridge.detachAll() }
                pane.bridge = nil
            }
            panesByRuntimeIndex.removeValue(forKey: pane.runtimeIndex)
            panesByIdentifier.removeValue(forKey: pane.id)
            if activePaneRuntimeIndex == pane.runtimeIndex {
                activePaneRuntimeIndex = nil
            }
        }

        persistConfiguration()

        let nextActiveIndex: Int
        if tabs.isEmpty {
            nextActiveIndex = 0
        } else {
            nextActiveIndex = min(index, tabs.count - 1)
        }

        sendRemoveTab(id: removedTab.id, index: index, activeTabIndex: nextActiveIndex)

    }

    func handleClosePane(body: Any) {
        guard let payload = body as? [String: Any],
              let index = payload["index"] as? Int,
              let pane = panesByRuntimeIndex[index] else {
            return
        }
        cancelConversationSummaryTask(for: index)
        disposePromptHookCapture(for: pane)
        pane.session?.terminate()
        pane.session = nil
        updatePaneStatus(pane, status: .disconnected)
        if let bridge = pane.bridge {
            Task { await bridge.detachAll() }
            pane.bridge = nil
        }
        if activePaneRuntimeIndex == index {
            activePaneRuntimeIndex = nil
        }
    }

    func handleRemovePane(body: Any) {
        guard let payload = body as? [String: Any],
              let index = payload["index"] as? Int,
              let pane = panesByRuntimeIndex[index] else {
            return
        }

        guard let tabIndex = tabs.firstIndex(where: { tab in
            tab.panes.contains(where: { $0 === pane })
        }) else {
            return
        }

        let targetTab = tabs[tabIndex]

        cancelConversationSummaryTask(for: index)
        disposePromptHookCapture(for: pane)
        pane.session?.terminate()
        pane.session = nil
        pane.gitMonitor?.invalidate()
        pane.gitMonitor = nil
        pane.githubActionsMonitor?.invalidate()
        pane.githubActionsMonitor = nil
        pendingGitHubActionSnapshots.removeValue(forKey: index)
        if let bridge = pane.bridge {
            Task { await bridge.detachAll() }
            pane.bridge = nil
        }
        panesByRuntimeIndex.removeValue(forKey: index)
        panesByIdentifier.removeValue(forKey: pane.id)

        if activePaneRuntimeIndex == index {
            activePaneRuntimeIndex = nil
        }

        targetTab.panes.removeAll(where: { $0 === pane })

        persistConfiguration()

        sendRemovePane(index: index, tab: targetTab, tabIndex: tabIndex)
    }

    func handleTabActivity(body: Any) {
        guard let payload = body as? [String: Any],
              let rawActivity = payload["activity"] as? String else {
            return
        }

        let activity = rawActivity.lowercased()

        if activity == "reset" {
            clearIdleNotifications()
            return
        }

        guard let tabIdString = payload["tabId"] as? String,
              let tabId = UUID(uuidString: tabIdString) else {
            return
        }

        let title = payload["title"] as? String
        updateIdleNotificationState(for: tabId, activity: activity, title: title)
    }

    func handleFocusPane(body: Any) {
        guard let payload = body as? [String: Any],
              let index = payload["index"] as? Int,
              panesByRuntimeIndex[index] != nil else {
            return
        }
        activePaneRuntimeIndex = index
    }

    func refreshDockBadge() {
        guard TerminalCoordinator.canInteractWithDock else {
            return
        }

        guard appSettings.notifyOnIdle else {
            setDockBadgeLabel(nil)
            return
        }

        let count = idleNotificationTabIds.count
        setDockBadgeLabel(count > 0 ? String(count) : nil)
    }

    func clearIdleNotifications() {
        let identifiers = idleNotificationTabIds.map(idleNotificationIdentifier(for:))
        idleNotificationTabIds.removeAll()
        if !identifiers.isEmpty, let notificationCenter {
            notificationCenter.removeDeliveredNotifications(withIdentifiers: identifiers)
            notificationCenter.removePendingNotificationRequests(withIdentifiers: identifiers)
        }
        refreshDockBadge()
    }

    private func updateIdleNotificationState(for tabId: UUID, activity: String, title: String?) {
        switch activity {
        case "idle":
            guard appSettings.notifyOnIdle else {
                idleNotificationTabIds.remove(tabId)
                removeDeliveredIdleNotification(for: tabId)
                refreshDockBadge()
                return
            }

            let insertion = idleNotificationTabIds.insert(tabId)
            refreshDockBadge()
            guard insertion.inserted else {
                return
            }
            deliverIdleNotification(for: tabId, title: title)

        case "active", "loading":
            if idleNotificationTabIds.remove(tabId) != nil {
                refreshDockBadge()
            } else {
                refreshDockBadge()
            }
            removeDeliveredIdleNotification(for: tabId)

        case "removed":
            if idleNotificationTabIds.remove(tabId) != nil {
                refreshDockBadge()
            } else {
                refreshDockBadge()
            }
            removeDeliveredIdleNotification(for: tabId)

        default:
            break
        }
    }

    private func deliverIdleNotification(for tabId: UUID, title: String?) {
        let tabTitle = (title?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { !$0.isEmpty ? $0 : nil }
            ?? "Tab"

        ensureNotificationPermission { [weak self] granted in
            guard granted, let self else { return }

            let content = UNMutableNotificationContent()
            content.title = "Codex is idle"
            content.body = "\(tabTitle) finished running."
            content.sound = nil
            content.threadIdentifier = "codigo-editor.idle"
            content.userInfo = ["tabId": tabId.uuidString]

            let request = UNNotificationRequest(
                identifier: self.idleNotificationIdentifier(for: tabId),
                content: content,
                trigger: nil
            )

            guard let notificationCenter = self.notificationCenter else {
                return
            }

            notificationCenter.add(request) { [weak self] error in
                guard let self, let error else { return }
                self.notificationLog.error("Failed to deliver idle notification: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func ensureNotificationPermission(_ completion: @escaping @MainActor (Bool) -> Void) {
        guard let gateway = notificationPermissionGateway else {
            DispatchQueue.main.async {
                completion(false)
            }
            return
        }
        gateway.determinePermission(completion: completion)
    }

    private func idleNotificationIdentifier(for tabId: UUID) -> String {
        "codigo-editor.idle.\(tabId.uuidString.lowercased())"
    }

    private func removeDeliveredIdleNotification(for tabId: UUID) {
        let identifier = idleNotificationIdentifier(for: tabId)
        guard let notificationCenter else {
            return
        }
        notificationCenter.removeDeliveredNotifications(withIdentifiers: [identifier])
        notificationCenter.removePendingNotificationRequests(withIdentifiers: [identifier])
    }

    private func setDockBadgeLabel(_ label: String?) {
        guard TerminalCoordinator.canInteractWithDock else {
            return
        }
        NSApp.dockTile.badgeLabel = label
    }

    func handleAddPane(body: Any) {
        guard let payload = body as? [String: Any] else {
            return
        }

        let column = (payload["column"] as? String)?.lowercased() ?? "stacked"
        let tabIdString = payload["tabId"] as? String
        let tabIndexValue = payload["tabIndex"] as? Int

        var resolvedIndex: Int?
        if let tabIdString,
           let uuid = UUID(uuidString: tabIdString),
           let found = tabs.firstIndex(where: { $0.id == uuid }) {
            resolvedIndex = found
        } else if let tabIndexValue, tabs.indices.contains(tabIndexValue) {
            resolvedIndex = tabIndexValue
        }

        guard let tabIndex = resolvedIndex else {
            return
        }

        let tab = tabs[tabIndex]
        let resolvedColumn: PaneColumn = (column == "primary") ? .primary : .stacked
        let insertionIndex: Int
        if resolvedColumn == .primary {
            let firstStacked = tab.panes.firstIndex(where: { $0.column == .stacked }) ?? tab.panes.count
            insertionIndex = firstStacked
        } else {
            insertionIndex = tab.panes.count
        }
        let runtimeIndex = nextPaneIndex
        nextPaneIndex += 1

        let providedTitle = (payload["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let providedWorkingDirectory = (payload["workingDirectory"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let providedStartup = (payload["startupCommand"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let providedKind = (payload["kind"] as? String).flatMap { PaneKind(rawValue: $0.lowercased()) }
        let providedSummaryValue = (payload["conversationSummary"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let providedSummary = (providedSummaryValue?.isEmpty == false) ? providedSummaryValue : nil

        var workingDirectory = providedWorkingDirectory?.isEmpty == false
            ? providedWorkingDirectory!
            : (tab.panes.first?.config.workingDirectory ?? FileManager.default.homeDirectoryForCurrentUser.path)
        workingDirectory = workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        if workingDirectory.isEmpty {
            workingDirectory = FileManager.default.homeDirectoryForCurrentUser.path
        }

        let defaultStarter = appSettings.starterCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        let startupCommand: String?
        if let providedStartup, !providedStartup.isEmpty {
            startupCommand = providedStartup
        } else if resolvedColumn == .primary && !defaultStarter.isEmpty {
            startupCommand = defaultStarter
        } else {
            startupCommand = nil
        }
        let paneKind = providedKind ?? PaneKind.inferred(from: startupCommand)

        let provisionalConfig = TerminalConfig(
            title: "",
            workingDirectory: workingDirectory,
            startupCommand: startupCommand,
            kind: paneKind,
            conversationSummary: providedSummary
        )
        let paneState = PaneState(
            runtimeIndex: runtimeIndex,
            id: UUID(),
            config: provisionalConfig,
            column: resolvedColumn
        )
        let fallback = fallbackTitle(for: paneState, workingDirectory: workingDirectory)
        let resolvedTitle = (providedTitle?.isEmpty == false) ? providedTitle! : fallback
        paneState.config = TerminalConfig(
            title: resolvedTitle,
            workingDirectory: workingDirectory,
            startupCommand: startupCommand,
            kind: paneKind,
            conversationSummary: providedSummary
        )

        tab.panes.insert(paneState, at: insertionIndex)
        panesByRuntimeIndex[runtimeIndex] = paneState
        panesByIdentifier[paneState.id] = paneState

        configureGitMonitor(for: paneState)

        persistConfiguration()

        sendAddPane(pane: paneState, tab: tab, tabIndex: tabIndex, position: insertionIndex)

        if sessionsStarted {
            startSession(for: paneState)
            paneState.gitMonitor?.requestImmediateRefresh()
            paneState.githubActionsMonitor?.requestImmediateRefresh()
        }
    }

    func handleReconnectPane(body: Any) {
        guard let payload = body as? [String: Any],
              let index = payload["index"] as? Int,
              let pane = panesByRuntimeIndex[index],
              pane.session == nil else {
            return
        }
        if sessionsStarted {
            startSession(for: pane)
        } else {
            updatePaneStatus(pane, status: .connecting)
        }
    }

    func handleRespawnPane(body: Any) {
        guard let payload = body as? [String: Any],
              let index = payload["index"] as? Int,
              let pane = panesByRuntimeIndex[index] else {
            return
        }

        if let session = pane.session {
            disposePromptHookCapture(for: pane)
            session.terminate()
            pane.session = nil
        }

        if let bridge = pane.bridge {
            Task { await bridge.detachAll() }
            pane.bridge = nil
        }

        if sessionsStarted {
            startSession(for: pane)
        } else {
            updatePaneStatus(pane, status: .connecting)
        }
    }

    func handleCopy(body: Any) {
        guard let payload = body as? [String: Any],
              let text = payload["text"] as? String else {
            return
        }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    func handleRequestPaste(body: Any) {
        guard let payload = body as? [String: Any],
              let index = payload["index"] as? Int else {
            return
        }

        let pasteboard = NSPasteboard.general
        let text = pasteboard.string(forType: .string) ?? ""
        sendPasteResponse(index: index, text: text)
    }

    func handleUpdatePane(body: Any) {
        guard let payload = body as? [String: Any],
              let index = payload["index"] as? Int,
              let pane = panesByRuntimeIndex[index] else {
            return
        }

        let workingDirectory = (payload["workingDirectory"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let startupCommandValue = payload["startupCommand"]

        let startupCommand: String?
        if startupCommandValue is NSNull {
            startupCommand = nil
        } else if let raw = startupCommandValue as? String {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            startupCommand = trimmed.isEmpty ? nil : trimmed
        } else {
            startupCommand = pane.config.startupCommand
        }

        guard let directory = workingDirectory, !directory.isEmpty else {
            return
        }

        let sanitizedDirectory = PathSanitizer.sanitize(directory)
        guard !sanitizedDirectory.isEmpty else {
            return
        }

        let resolvedTitle = resolvePaneTitle(
            for: pane,
            proposed: payload["title"],
            workingDirectory: sanitizedDirectory
        )

        pane.config = TerminalConfig(
            title: resolvedTitle,
            workingDirectory: sanitizedDirectory,
            startupCommand: startupCommand,
            kind: PaneKind.inferred(from: startupCommand),
            conversationSummary: pane.config.conversationSummary
        )

        configureGitMonitor(for: pane)

        pane.session?.terminate()
        pane.session = nil
        updatePaneStatus(pane, status: .connecting)
        sendPaneConfigUpdate(for: pane)
        persistConfiguration()

        if sessionsStarted {
            startSession(for: pane)
        }
    }

    func handleResize(body: Any) {
        guard let payload = body as? [String: Any] else {
            return
        }

        let indexNumber = payload["index"] as? NSNumber
        let colsNumber = payload["cols"] as? NSNumber
        let rowsNumber = payload["rows"] as? NSNumber

        guard let index = indexNumber?.intValue,
              let cols = colsNumber?.intValue,
              let rows = rowsNumber?.intValue,
              let pane = panesByRuntimeIndex[index],
              let session = pane.session else {
            return
        }

        session.resize(cols: cols, rows: rows)
    }

    func handleRenamePane(body: Any) {
        guard let payload = body as? [String: Any],
              let index = payload["index"] as? Int,
              let pane = panesByRuntimeIndex[index] else {
            return
        }

        let resolvedTitle = resolvePaneTitle(
            for: pane,
            proposed: payload["title"],
            workingDirectory: pane.config.workingDirectory
        )

        if resolvedTitle == pane.config.title {
            syncConversationSummaryFromTitleIfNeeded(resolvedTitle, for: pane)
            return
        }

        pane.config = TerminalConfig(
            title: resolvedTitle,
            workingDirectory: pane.config.workingDirectory,
            startupCommand: pane.config.startupCommand,
            kind: pane.config.kind,
            conversationSummary: pane.config.conversationSummary
        )

        syncConversationSummaryFromTitleIfNeeded(resolvedTitle, for: pane)

        sendPaneConfigUpdate(for: pane)
        persistConfiguration()
    }

    func handleReorderTabs(body: Any) {
        guard let payload = body as? [String: Any],
              let order = payload["order"] as? [String] else {
            return
        }

        var reordered: [TabState] = []
        var remaining = tabs

        for idString in order {
            guard let uuid = UUID(uuidString: idString),
                  let index = remaining.firstIndex(where: { $0.id == uuid }) else {
                continue
            }
            reordered.append(remaining.remove(at: index))
        }

        reordered.append(contentsOf: remaining)
        tabs = reordered

        persistConfiguration()
    }

    func handleUpdateTabPreview(body: Any) {
        guard let payload = body as? [String: Any] else {
            return
        }

        let tabIdString = payload["id"] as? String
        let indexNumber = payload["index"] as? Int

        let targetTab: TabState?
        if let tabIdString, let uuid = UUID(uuidString: tabIdString),
           let found = tabs.first(where: { $0.id == uuid }) {
            targetTab = found
        } else if let indexNumber, tabs.indices.contains(indexNumber) {
            targetTab = tabs[indexNumber]
        } else {
            targetTab = nil
        }

        guard let tab = targetTab else {
            return
        }

        var previewStateChanged = false

        if let rawPreviewTabs = payload["previewTabs"] as? [Any] {
            let existingLookup = Dictionary(uniqueKeysWithValues: tab.previewTabs.map { ($0.id, $0) })
            var updatedTabs: [PreviewTabState] = []

            for (index, element) in rawPreviewTabs.enumerated() {
                guard let descriptor = element as? [String: Any],
                      let idString = descriptor["id"] as? String,
                      let uuid = UUID(uuidString: idString) else {
                    continue
                }
                let rawTitle = (descriptor["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let resolvedTitle = rawTitle.isEmpty ? "Preview \(index + 1)" : rawTitle
                let rawURL = (descriptor["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if let existing = existingLookup[uuid] {
                    if existing.title != resolvedTitle {
                        existing.title = resolvedTitle
                        previewStateChanged = true
                    }
                    if existing.url != rawURL {
                        existing.url = rawURL
                        previewStateChanged = true
                    }
                    updatedTabs.append(existing)
                } else {
                    let newPreview = PreviewTabState(id: uuid, title: resolvedTitle, url: rawURL)
                    updatedTabs.append(newPreview)
                    previewStateChanged = true
                }
            }

            if !updatedTabs.isEmpty {
                let previousIds = Set(tab.previewTabs.map { $0.id })
                let updatedIds = Set(updatedTabs.map { $0.id })
                if previousIds != updatedIds || updatedTabs.count != tab.previewTabs.count {
                    previewStateChanged = true
                }
                tab.previewTabs = updatedTabs
            }

            if let activeIdString = payload["activePreviewTabId"] as? String,
               let activeUUID = UUID(uuidString: activeIdString),
               tab.previewTabs.contains(where: { $0.id == activeUUID }) {
                if tab.activePreviewTabId != activeUUID {
                    tab.activePreviewTabId = activeUUID
                    previewStateChanged = true
                }
            } else if let firstId = tab.previewTabs.first?.id {
                if tab.activePreviewTabId != firstId {
                    tab.activePreviewTabId = firstId
                    previewStateChanged = true
                }
            } else {
                if tab.activePreviewTabId != nil {
                    tab.activePreviewTabId = nil
                    previewStateChanged = true
                }
            }
        }

        if let urlString = payload["url"] as? String {
            let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
            if let activeId = tab.activePreviewTabId,
               let activePreview = tab.previewTabs.first(where: { $0.id == activeId }) {
                if activePreview.url != trimmed {
                    activePreview.url = trimmed
                    previewStateChanged = true
                }
            } else if let firstPreview = tab.previewTabs.first {
                if firstPreview.url != trimmed {
                    firstPreview.url = trimmed
                    previewStateChanged = true
                }
                if tab.activePreviewTabId != firstPreview.id {
                    tab.activePreviewTabId = firstPreview.id
                    previewStateChanged = true
                }
            } else if !trimmed.isEmpty {
                let newPreview = PreviewTabState(id: UUID(), title: "Preview 1", url: trimmed)
                tab.previewTabs = [newPreview]
                tab.activePreviewTabId = newPreview.id
                previewStateChanged = true
            }
        }

        if previewStateChanged {
            persistConfiguration()
        }
    }

    func handleGitSync(body: Any) {
        guard let payload = body as? [String: Any],
              let index = payload["index"] as? Int,
              let pane = panesByRuntimeIndex[index] else {
            return
        }

        let action = appSettings.terminalCloudAction
        if action != .customScript && !githubAccountConnected {
            refreshGitHubAuthenticationStatus()
            NSSound.beep()
            return
        }

        configureGitMonitor(for: pane)
        let script = action == .customScript ? appSettings.terminalCloudCustomScript : nil
        pane.gitMonitor?.performCloudAction(action, script: script)
        pane.githubActionsMonitor?.notifySyncTriggered()
    }

    func handleGitUndo(body: Any) {
        guard let payload = body as? [String: Any],
              let index = payload["index"] as? Int,
              let pane = panesByRuntimeIndex[index] else {
            return
        }

        configureGitMonitor(for: pane)
        pane.gitMonitor?.performUndo()
    }

    func handleGitDetails(body: Any) {
        guard let payload = body as? [String: Any],
              let index = payload["index"] as? Int else {
            return
        }

        guard let pane = panesByRuntimeIndex[index] else {
            let snapshot = TerminalCoordinator.GitRepositoryMonitor.DetailsSnapshot(files: [], error: "Git status unavailable")
            publishGitDetails(index: index, details: snapshot)
            return
        }

        configureGitMonitor(for: pane)
        if let monitor = pane.gitMonitor {
            monitor.requestDetails()
        } else {
            let snapshot = TerminalCoordinator.GitRepositoryMonitor.DetailsSnapshot(files: [], error: "Git status unavailable")
            publishGitDetails(index: index, details: snapshot)
        }
    }

    func handleOpenInCursor(body: Any) {
        guard let directoryURL = resolveWorkingDirectoryURL(from: body) else {
            return
        }

        let editorAction = appSettings.terminalEditorAction
        let customCommand = appSettings.terminalEditorCommand
        let environment = ProcessInfo.processInfo.environment

        Task.detached(priority: .userInitiated) {
            switch editorAction {
            case .cursor:
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                process.arguments = ["open", "-a", "Cursor", directoryURL.path]
                process.environment = environment
                process.currentDirectoryURL = directoryURL

                do {
                    try process.run()
                } catch {
                    print("Failed to open directory in Cursor:", error)
                }
            case .visualStudioCode:
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                process.arguments = ["open", "-a", "Visual Studio Code", directoryURL.path]
                process.environment = environment
                process.currentDirectoryURL = directoryURL

                do {
                    try process.run()
                } catch {
                    print("Failed to open directory in Visual Studio Code:", error)
                }
            case .custom:
                let trimmedCommand = customCommand.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmedCommand.isEmpty else {
                    print("Custom editor command is empty; nothing to run")
                    return
                }

                let shellPath = environment["SHELL"] ?? "/bin/zsh"
                let process = Process()
                process.executableURL = URL(fileURLWithPath: shellPath)
                process.arguments = ["-lc", trimmedCommand]
                var shellEnvironment = environment
                shellEnvironment["PWD"] = directoryURL.path
                process.environment = shellEnvironment
                process.currentDirectoryURL = directoryURL
                let stderr = Pipe()
                process.standardOutput = nil
                process.standardError = stderr

                do {
                    try process.run()
                    process.waitUntilExit()
                } catch {
                    print("Failed to run custom editor command:", error)
                    return
                }

                if process.terminationStatus != 0 {
                    let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
                    let stderrString = String(data: stderrData, encoding: .utf8) ?? ""
                    print("Custom editor command exited with status \(process.terminationStatus):", stderrString)
                }
            }
        }
    }

    func handleOpenInFinder(body: Any) {
        guard let directoryURL = resolveWorkingDirectoryURL(from: body) else {
            return
        }

        NSWorkspace.shared.activateFileViewerSelecting([directoryURL])
    }

    func handleUpdateTerminalCommandList(body: Any) {
        guard let payload = body as? [String: Any],
              let rawCommands = payload["commands"] as? [Any] else {
            return
        }

        let extracted = rawCommands.compactMap { item -> String? in
            guard let text = item as? String else { return nil }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }

        let directory = (payload["workingDirectory"] as? String) ?? ""
        let commands = sanitizeCommands(extracted)

        updateTerminalCommands(forWorkingDirectory: directory, commands: commands)
    }

    func handleUpdateTerminalLinkList(body: Any) {
        guard let payload = body as? [String: Any],
              let rawLinks = payload["links"] as? [Any] else {
            return
        }

        let extracted = rawLinks.compactMap { item -> String? in
            guard let text = item as? String else { return nil }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }

        let directory = (payload["workingDirectory"] as? String) ?? ""
        let links = sanitizeLinks(extracted)

        updateTerminalLinks(forWorkingDirectory: directory, links: links)
    }

    func handleUpdatePaneCommandSelection(body: Any) {
        guard let payload = body as? [String: Any],
              let idString = payload["paneId"] as? String,
              let uuid = UUID(uuidString: idString) else {
            return
        }

        let command = (payload["command"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        updatePaneCommandPreference(for: uuid, command: command)
    }

    func handleUpdatePaneLinkSelection(body: Any) {
        guard let payload = body as? [String: Any],
              let idString = payload["paneId"] as? String,
              let uuid = UUID(uuidString: idString) else {
            return
        }

        let link = (payload["link"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        updatePaneLinkPreference(for: uuid, link: link)
    }


    func handleCreateFolder(body: Any) {
        guard let payload = body as? [String: Any],
              let rawName = payload["name"] as? String else {
            return
        }

        let trimmedName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            return
        }

        if trimmedName.contains("/") || trimmedName.contains(":") || trimmedName.contains("\\") {
            return
        }

        let basePathCandidate = (payload["baseDirectory"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let basePath = basePathCandidate.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !basePath.isEmpty else {
            return
        }

        let baseURL = URL(fileURLWithPath: basePath, isDirectory: true).standardizedFileURL
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: baseURL.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            return
        }

        let sanitizedBaseName = trimmedName
        var uniqueName = sanitizedBaseName
        var candidateURL = baseURL.appendingPathComponent(uniqueName, isDirectory: true)
        var suffix = 2
        while FileManager.default.fileExists(atPath: candidateURL.path) {
            uniqueName = "\(sanitizedBaseName) \(suffix)"
            candidateURL = baseURL.appendingPathComponent(uniqueName, isDirectory: true)
            suffix += 1
        }

        do {
            try FileManager.default.createDirectory(at: candidateURL, withIntermediateDirectories: false, attributes: nil)
        } catch {
            print("Failed to create folder", candidateURL.path, "error:", error)
            return
        }

        let tabIndex: Int?
        if let tabIdString = payload["tabId"] as? String, let uuid = UUID(uuidString: tabIdString), let found = tabs.firstIndex(where: { $0.id == uuid }) {
            tabIndex = found
        } else if let providedTabIndex = payload["tabIndex"] as? Int, tabs.indices.contains(providedTabIndex) {
            tabIndex = providedTabIndex
        } else {
            tabIndex = nil
        }

        if let tabIndex {
            let columnValue = (payload["column"] as? String)?.lowercased() ?? "stacked"
            let resolvedColumn: PaneColumn = columnValue == "primary" ? .primary : .stacked
            addPaneForNewFolder(in: tabIndex, workingDirectory: candidateURL.path, column: resolvedColumn)
        }

        for candidate in panesByRuntimeIndex.values where candidate.config.workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines) == basePath {
            candidate.gitMonitor?.requestImmediateRefresh()
            candidate.githubActionsMonitor?.requestImmediateRefresh()
        }
    }

    private func resolveWorkingDirectoryURL(from body: Any) -> URL? {
        guard let payload = body as? [String: Any],
              let index = payload["index"] as? Int,
              let pane = panesByRuntimeIndex[index] else {
            return nil
        }

        return resolveWorkingDirectoryURL(for: pane)
    }

    private func resolveWorkingDirectoryURL(for pane: PaneState) -> URL? {
        let trimmed = pane.config.workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        let url = URL(fileURLWithPath: trimmed, isDirectory: true).standardizedFileURL
        guard directoryExists(at: url) else {
            return nil
        }

        return url
    }

    private func addPaneForNewFolder(in tabIndex: Int, workingDirectory: String, column: PaneColumn) {
        guard tabs.indices.contains(tabIndex) else { return }
        let tab = tabs[tabIndex]
        let insertionIndex: Int
        if column == .primary {
            let firstStacked = tab.panes.firstIndex(where: { $0.column == .stacked }) ?? tab.panes.count
            insertionIndex = firstStacked
        } else {
            insertionIndex = tab.panes.count
        }

        let runtimeIndex = nextPaneIndex
        nextPaneIndex += 1

        let startupCommand: String? = nil
        let paneState = PaneState(
            runtimeIndex: runtimeIndex,
            id: UUID(),
            config: TerminalConfig(
                title: "",
                workingDirectory: workingDirectory,
                startupCommand: startupCommand,
                kind: .shell,
                conversationSummary: nil
            ),
            column: column
        )

        let fallback = fallbackTitle(for: paneState, workingDirectory: workingDirectory)
        paneState.config = TerminalConfig(
            title: fallback,
            workingDirectory: workingDirectory,
            startupCommand: startupCommand,
            kind: .shell,
            conversationSummary: nil
        )

        tab.panes.insert(paneState, at: insertionIndex)
        panesByRuntimeIndex[runtimeIndex] = paneState
        panesByIdentifier[paneState.id] = paneState

        configureGitMonitor(for: paneState)
        persistConfiguration()

        sendAddPane(pane: paneState, tab: tab, tabIndex: tabIndex, position: insertionIndex)

        if sessionsStarted {
            startSession(for: paneState)
            paneState.gitMonitor?.requestImmediateRefresh()
            paneState.githubActionsMonitor?.requestImmediateRefresh()
        }
    }

    @discardableResult
    func updatePreviewContext(from payload: [String: Any]) -> PreviewContext? {
        guard let tabIdString = payload["tabId"] as? String,
              let tabId = UUID(uuidString: tabIdString),
              let previewIdString = payload["previewTabId"] as? String,
              let previewTabId = UUID(uuidString: previewIdString) else {
            return nil
        }
        let context = PreviewContext(tabId: tabId, previewTabId: previewTabId)
        currentPreviewContext = context
        if let (tab, _) = previewState(for: context) {
            tab.activePreviewTabId = previewTabId
        }
        return context
    }

    func handlePreviewLayout(body: Any) {
        guard let payload = body as? [String: Any],
              let left = cgValue(payload["left"]),
              let top = cgValue(payload["top"]),
              let width = cgValue(payload["width"]),
              let height = cgValue(payload["height"]) else {
            return
        }
        updatePreviewFrame(left: left, top: top, width: width, height: height)
    }

    func handlePreviewNavigate(body: Any) {
        guard let payload = body as? [String: Any] else {
            return
        }
        let context = updatePreviewContext(from: payload)
        let urlString = payload["url"] as? String
        loadPreview(urlString: urlString, force: false, context: context)
    }

    func handlePreviewOpenExternal(body: Any) {
        guard let payload = body as? [String: Any],
              let urlString = payload["url"] as? String,
              let url = URL(string: urlString),
              let scheme = url.scheme,
              !scheme.isEmpty else {
            return
        }

        _ = updatePreviewContext(from: payload)

        NSWorkspace.shared.open(url)
    }

    func handlePreviewRefresh(body: Any) {
        guard let payload = body as? [String: Any] else {
            return
        }
        let context = updatePreviewContext(from: payload)
        let urlString = payload["url"] as? String
        refreshPreview(urlString: urlString, context: context)
    }

    func handlePreviewGoBack(body: Any) {
        guard let payload = body as? [String: Any] else {
            return
        }
        let context = updatePreviewContext(from: payload)
        let resolvedContext = context ?? currentPreviewContext
        guard let previewWebView else {
            return
        }
        if previewWebView.canGoBack {
            let navigation = previewWebView.goBack()
            trackPreviewNavigation(navigation, context: resolvedContext)
        } else {
            let effectiveURL: URL?
            if let currentURL = previewWebView.url {
                effectiveURL = currentURL
            } else if let fallbackURL = URL(string: lastPreviewURLString) {
                effectiveURL = fallbackURL
            } else {
                effectiveURL = nil
            }
            let displayString = displayURLString(from: effectiveURL)
            if let resolvedContext {
                sendPreviewNavigationState(
                    urlString: displayString,
                    canGoBack: false,
                    canGoForward: previewWebView.canGoForward,
                    context: resolvedContext
                )
            }
        }
    }

    func handlePreviewSnapshot(body: Any) {
        guard let payload = body as? [String: Any] else {
            sendPreviewSnapshotResult(success: false)
            return
        }

        _ = updatePreviewContext(from: payload)

        guard previewVisible, let previewWebView else {
            sendPreviewSnapshotResult(success: false)
            return
        }

        let bounds = previewWebView.bounds
        guard bounds.width > 1, bounds.height > 1 else {
            sendPreviewSnapshotResult(success: false)
            return
        }

        let configuration = WKSnapshotConfiguration()
        configuration.rect = bounds
        configuration.afterScreenUpdates = true

        previewWebView.takeSnapshot(with: configuration) { [weak self] image, error in
            guard let self else { return }

            if let error {
                self.previewLog.error("Snapshot failed: \(error.localizedDescription, privacy: .public)")
                self.sendPreviewSnapshotResult(success: false)
                return
            }

            guard let image, let pngData = self.pngData(from: image) else {
                self.sendPreviewSnapshotResult(success: false)
                return
            }

            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            let wrotePNG = pasteboard.setData(pngData, forType: .png)
            let wroteImage = pasteboard.writeObjects([image])
            self.sendPreviewSnapshotResult(success: wrotePNG || wroteImage)
        }
    }

    func handlePreviewVisibility(body: Any) {
        guard let payload = body as? [String: Any],
              let visible = payload["visible"] as? Bool else {
            return
        }
        previewVisible = visible
        updatePreviewHiddenState()
        if visible {
            let context = currentPreviewContext ?? lastPreviewNavigationContext
            loadPreview(urlString: lastPreviewURLString, force: false, context: context)
        }
    }

    private func sendPreviewSnapshotResult(success: Bool) {
        guard let webView else { return }
        let script = "window.handlePreviewSnapshotResult?.(\(success ? "true" : "false"));"
        webView.evaluateJavaScript(script) { [weak self] _, error in
            if let error {
                self?.previewLog.error("previewSnapshotResult js error: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func pngData(from image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff) else {
            return nil
        }
        return bitmap.representation(using: .png, properties: [:])
    }
}
