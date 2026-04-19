import AppKit
import Foundation

@MainActor
extension TerminalCoordinator {
    func applyInitialDefaultsIfNeeded() {
        var requiresPersist = false

        for tab in tabs {
            var previewMutated = false
            if tab.previewTabs.isEmpty {
                let fallbackPreview = PreviewTabState(id: UUID(), title: "Preview 1", url: "")
                tab.previewTabs = [fallbackPreview]
                tab.activePreviewTabId = fallbackPreview.id
                previewMutated = true
            } else {
                for (index, previewTab) in tab.previewTabs.enumerated() {
                    let trimmedURL = previewTab.url.trimmingCharacters(in: .whitespacesAndNewlines)
                    if trimmedURL != previewTab.url {
                        previewTab.url = trimmedURL
                        previewMutated = true
                    }
                    let trimmedTitle = previewTab.title.trimmingCharacters(in: .whitespacesAndNewlines)
                    let fallbackTitle = "Preview \(index + 1)"
                    let resolvedTitle = trimmedTitle.isEmpty ? fallbackTitle : trimmedTitle
                    if resolvedTitle != previewTab.title {
                        previewTab.title = resolvedTitle
                        previewMutated = true
                    }
                }
            }

            if let activeId = tab.activePreviewTabId, !tab.previewTabs.contains(where: { $0.id == activeId }) {
                tab.activePreviewTabId = tab.previewTabs.first?.id
                previewMutated = true
            }
            if tab.activePreviewTabId == nil {
                tab.activePreviewTabId = tab.previewTabs.first?.id
                previewMutated = true
            }
            if previewMutated {
                requiresPersist = true
            }

            if let primaryPane = tab.panes.first {
                let trimmedExisting = primaryPane.config.startupCommand?.trimmingCharacters(in: .whitespacesAndNewlines)
                let sanitizedExisting = (trimmedExisting?.isEmpty == false) ? trimmedExisting : nil
                let defaultCommand = appSettings.starterCommand.trimmingCharacters(in: .whitespacesAndNewlines)
                let resolvedDefault = defaultCommand.isEmpty ? nil : defaultCommand
                let resolvedStartup = sanitizedExisting ?? resolvedDefault

                if resolvedStartup != primaryPane.config.startupCommand {
                    primaryPane.config = TerminalConfig(
                        title: primaryPane.config.title,
                        workingDirectory: primaryPane.config.workingDirectory,
                        startupCommand: resolvedStartup,
                        kind: PaneKind.inferred(from: resolvedStartup),
                        conversationSummary: primaryPane.config.conversationSummary
                    )
                    requiresPersist = true
                }
            }
        }

        if requiresPersist {
            persistConfiguration()
        }
    }

    func persistConfiguration() {
        let storedTabs = tabs.map { tab in
            let panes = tab.panes.map { pane in
                StoredPane(
                    id: pane.id,
                    title: pane.config.title,
                    workingDirectory: pane.config.workingDirectory,
                    startupCommand: pane.config.startupCommand,
                    kind: pane.config.kind,
                    conversationSummary: pane.config.conversationSummary,
                    column: pane.column
                )
            }
            let storedPreviewTabs = tab.previewTabs.map { previewTab in
                StoredPreviewTab(id: previewTab.id, title: previewTab.title, url: previewTab.url)
            }
            let activePreviewURL = tab.previewTabs.first(where: { $0.id == tab.activePreviewTabId })?.url
            let resolvedPreviewURL = activePreviewURL?.trimmingCharacters(in: .whitespacesAndNewlines)
            return StoredTab(
                id: tab.id,
                title: tab.title,
                panes: panes,
                previewURL: resolvedPreviewURL?.isEmpty == false ? resolvedPreviewURL : nil,
                previewTabs: storedPreviewTabs,
                activePreviewTabId: tab.activePreviewTabId
            )
        }
        let sanitizedSettings = appSettings.updating()
        appSettings = sanitizedSettings
        let configuration = AppConfiguration(
            settings: sanitizedSettings,
            tabs: storedTabs
        )
        do {
            try configurationStore.saveConfiguration(configuration)
        } catch {
            print("Failed to save configuration:", error)
        }
    }

    func makeTabState(title: String, workingDirectory: String) -> TabState {
        let stored = configurationStore.makeDefaultTab(
            title: title,
            workingDirectory: workingDirectory,
            starterCommand: appSettings.starterCommand
        )
        return buildTabState(from: stored)
    }

    func buildTabState(from storedTab: StoredTab) -> TabState {
        var panes: [PaneState] = []
        for (index, pane) in storedTab.panes.enumerated() {
            let sanitizedDirectory = PathSanitizer.sanitize(pane.workingDirectory)
            let workingDirectory = sanitizedDirectory.isEmpty ? pane.workingDirectory : sanitizedDirectory
            let config = TerminalConfig(
                title: pane.title,
                workingDirectory: workingDirectory,
                startupCommand: pane.startupCommand,
                kind: pane.kind,
                conversationSummary: pane.conversationSummary
            )
            let storedColumn = pane.column
            let resolvedColumn: PaneColumn = (index == 0 && storedColumn == .stacked) ? .primary : storedColumn
            let paneState = PaneState(runtimeIndex: nextPaneIndex, id: pane.id, config: config, column: resolvedColumn)
            panes.append(paneState)
            panesByRuntimeIndex[nextPaneIndex] = paneState
            panesByIdentifier[paneState.id] = paneState
            configureGitMonitor(for: paneState)
            nextPaneIndex += 1
        }

        var previewTabs: [PreviewTabState] = []
        if let storedPreviewTabs = storedTab.previewTabs, !storedPreviewTabs.isEmpty {
            previewTabs = storedPreviewTabs.enumerated().map { index, storedPreview in
                let trimmedTitle = storedPreview.title.trimmingCharacters(in: .whitespacesAndNewlines)
                let resolvedTitle = trimmedTitle.isEmpty ? "Preview \(index + 1)" : trimmedTitle
                let trimmedURL = storedPreview.url.trimmingCharacters(in: .whitespacesAndNewlines)
                return PreviewTabState(id: storedPreview.id, title: resolvedTitle, url: trimmedURL)
            }
        } else if let legacy = storedTab.previewURL?.trimmingCharacters(in: .whitespacesAndNewlines), !legacy.isEmpty {
            let legacyId = storedTab.activePreviewTabId ?? UUID()
            previewTabs = [PreviewTabState(id: legacyId, title: "Preview 1", url: legacy)]
        }

        if previewTabs.isEmpty {
            let fallbackPreview = PreviewTabState(id: UUID(), title: "Preview 1", url: "")
            previewTabs = [fallbackPreview]
        }

        var activePreviewId = storedTab.activePreviewTabId
        if let candidate = activePreviewId, !previewTabs.contains(where: { $0.id == candidate }) {
            activePreviewId = previewTabs.first?.id
        }
        if activePreviewId == nil {
            activePreviewId = previewTabs.first?.id
        }

        return TabState(
            id: storedTab.id,
            title: storedTab.title,
            panes: panes,
            previewTabs: previewTabs,
            activePreviewTabId: activePreviewId
        )
    }

    func defaultTabTitle() -> String {
        let base = "Tab"
        let existingTitles = Set(tabs.map { $0.title })
        var counter = tabs.count + 1
        var candidate = "\(base) \(counter)"
        while existingTitles.contains(candidate) {
            counter += 1
            candidate = "\(base) \(counter)"
        }
        return candidate
    }

    func makeUniqueTabTitle(from preferred: String) -> String {
        let trimmed = preferred.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return defaultTabTitle()
        }
        var candidate = trimmed
        var suffix = 2
        let existing = Set(tabs.map { $0.title })
        while existing.contains(candidate) {
            candidate = "\(trimmed) \(suffix)"
            suffix += 1
        }
        return candidate
    }

    func makeTabDescriptor(from tab: TabState) -> TabDescriptor {
        let panes: [TabDescriptor.PaneDescriptor] = tab.panes.map { pane in
            TabDescriptor.PaneDescriptor(
                id: pane.id.uuidString,
                index: pane.runtimeIndex,
                title: pane.config.title,
                status: pane.status.rawValue,
                workingDirectory: pane.config.workingDirectory,
                startupCommand: pane.config.startupCommand,
                kind: pane.config.kind.rawValue,
                conversationSummary: pane.config.conversationSummary,
                column: pane.column.rawValue
            )
        }
        let previewTabs = tab.previewTabs.map { previewTab in
            TabDescriptor.PreviewTabDescriptor(
                id: previewTab.id.uuidString,
                title: previewTab.title,
                url: previewTab.url
            )
        }
        let activePreview = tab.previewTabs.first(where: { $0.id == tab.activePreviewTabId })
        return TabDescriptor(
            id: tab.id.uuidString,
            title: tab.title,
            panes: panes,
            previewTabs: previewTabs,
            activePreviewTabId: tab.activePreviewTabId?.uuidString,
            previewURL: activePreview?.url
        )
    }

    func currentStarterCommand() -> String {
        appSettings.starterCommand
    }

    func currentIdleChimePreference() -> Bool {
        appSettings.playIdleChime
    }

    func currentIdleNotificationPreference() -> Bool {
        appSettings.notifyOnIdle
    }

    func currentTerminalEditorAction() -> TerminalEditorAction {
        appSettings.terminalEditorAction
    }

    func currentTerminalEditorCommand() -> String {
        appSettings.terminalEditorCommand
    }

    func currentTerminalCloudCustomScript() -> String {
        appSettings.terminalCloudCustomScript
    }

    func currentConversationSummarySource() -> ConversationSummarySource {
        appSettings.conversationSummarySource
    }

    func currentConversationSummaryCommand() -> String {
        appSettings.conversationSummaryCommand
    }

    func updateStarterCommand(to command: String) {
        let sanitizedSettings = appSettings.updating(
            starterCommand: command,
            starterCommandPreferenceConfirmed: true
        )
        let previousSettings = appSettings
        guard sanitizedSettings != previousSettings else {
            appSettings = sanitizedSettings
            return
        }

        appSettings = sanitizedSettings

        let previousValue = previousSettings.starterCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedPrevious = previousValue.isEmpty ? nil : previousValue
        let newValue = sanitizedSettings.starterCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedNew = newValue.isEmpty ? nil : newValue

        if resolvedPrevious != resolvedNew {
            for tab in tabs {
                guard let primaryPane = tab.panes.first(where: { $0.column == .primary }) ?? tab.panes.first else {
                    continue
                }
                let trimmedExisting = primaryPane.config.startupCommand?.trimmingCharacters(in: .whitespacesAndNewlines)
                let resolvedExisting = (trimmedExisting?.isEmpty == false) ? trimmedExisting : nil
                if resolvedExisting == resolvedPrevious {
                    primaryPane.config = TerminalConfig(
                        title: primaryPane.config.title,
                        workingDirectory: primaryPane.config.workingDirectory,
                        startupCommand: resolvedNew,
                        kind: PaneKind.inferred(from: resolvedNew),
                        conversationSummary: primaryPane.config.conversationSummary
                    )
                    sendPaneConfigUpdate(for: primaryPane)
                }
            }
        }

        persistConfiguration()
    }

    func ensureStarterCommandPreferenceConfirmed() -> Bool {
        guard !appSettings.starterCommandPreferenceConfirmed else {
            return true
        }

        let prompt = StarterCommandPrompt()
        guard let result = prompt.run(currentCommand: appSettings.starterCommand) else {
            return false
        }

        updateStarterCommand(to: result.command)
        return true
    }

    func updateIdleChimePreference(to isEnabled: Bool) {
        guard appSettings.playIdleChime != isEnabled else {
            return
        }

        appSettings = appSettings.updating(playIdleChime: isEnabled)

        persistConfiguration()
        sendSettingsUpdate()
    }

    func updateIdleNotificationPreference(to isEnabled: Bool) {
        guard appSettings.notifyOnIdle != isEnabled else {
            return
        }

        appSettings = appSettings.updating(notifyOnIdle: isEnabled)

        if !isEnabled {
            clearIdleNotifications()
        } else {
            refreshDockBadge()
        }

        persistConfiguration()
        sendSettingsUpdate()
    }

    func updateTerminalCloudAction(to action: TerminalCloudAction) {
        guard appSettings.terminalCloudAction != action else {
            return
        }

        appSettings = appSettings.updating(terminalCloudAction: action)

        persistConfiguration()
        sendSettingsUpdate()

        NotificationCenter.default.post(
            name: TerminalCoordinator.githubCloudActionDidChangeNotification,
            object: self,
            userInfo: ["action": action.rawValue]
        )
    }

    func updateTerminalEditorAction(to action: TerminalEditorAction) {
        guard appSettings.terminalEditorAction != action else {
            return
        }

        appSettings = appSettings.updating(terminalEditorAction: action)

        persistConfiguration()
        sendSettingsUpdate()
    }

    func updateTerminalEditorCommand(to command: String) {
        let sanitized = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard sanitized != appSettings.terminalEditorCommand else {
            return
        }

        appSettings = appSettings.updating(terminalEditorCommand: sanitized)

        persistConfiguration()
        sendSettingsUpdate()
    }

    func updateTerminalCloudCustomScript(to script: String) {
        let normalised = script.replacingOccurrences(of: "\r\n", with: "\n")
        guard normalised != appSettings.terminalCloudCustomScript else {
            return
        }

        appSettings = appSettings.updating(terminalCloudCustomScript: normalised)

        persistConfiguration()
        sendSettingsUpdate()
    }

    func updateConversationSummarySource(to source: ConversationSummarySource) {
        guard appSettings.conversationSummarySource != source else {
            return
        }

        if source != .localCommand {
            Array(pendingConversationSummaryTasks.keys).forEach(cancelConversationSummaryTask)
        }
        appSettings = appSettings.updating(conversationSummarySource: source)
        if source == .localCommand || source == .terminalTitle {
            clearConversationSummaries()
        }
        syncPromptHookCapturesWithSettings()

        persistConfiguration()
        sendSettingsUpdate()
    }

    func updateConversationSummaryCommand(to command: String) {
        let sanitized = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard sanitized != appSettings.conversationSummaryCommand else {
            return
        }

        appSettings = appSettings.updating(conversationSummaryCommand: sanitized)
        syncPromptHookCapturesWithSettings()

        persistConfiguration()
        sendSettingsUpdate()
    }

    func makeSettingsPayload() -> SettingsPayload {
        SettingsPayload(
            playIdleChime: appSettings.playIdleChime,
            notifyOnIdle: appSettings.notifyOnIdle,
            terminalCommandsByPath: appSettings.terminalCommandsByPath,
            paneCommandSelections: Dictionary(uniqueKeysWithValues: appSettings.paneCommandSelections.map { ($0.key.uuidString, $0.value) }),
            terminalLinksByPath: appSettings.terminalLinksByPath,
            paneLinkSelections: Dictionary(uniqueKeysWithValues: appSettings.paneLinkSelections.map { ($0.key.uuidString, $0.value) }),
            terminalCloudAction: appSettings.terminalCloudAction.rawValue,
            terminalEditorAction: appSettings.terminalEditorAction.rawValue,
            terminalEditorCommand: appSettings.terminalEditorCommand,
            terminalCloudCustomScript: appSettings.terminalCloudCustomScript,
            conversationSummarySource: appSettings.conversationSummarySource.rawValue,
            conversationSummaryCommand: appSettings.conversationSummaryCommand,
            githubAccountConnected: githubAccountConnected
        )
    }

    private func clearConversationSummaries() {
        var changed = false
        for tab in tabs {
            for pane in tab.panes where pane.config.conversationSummary != nil {
                pane.config = TerminalConfig(
                    title: pane.config.title,
                    workingDirectory: pane.config.workingDirectory,
                    startupCommand: pane.config.startupCommand,
                    kind: pane.config.kind,
                    conversationSummary: nil
                )
                sendPaneConfigUpdate(for: pane)
                changed = true
            }
        }
        if changed {
            persistConfiguration()
        }
    }

    func updateTerminalCommands(forWorkingDirectory directory: String, commands: [String]) {
        let key = normaliseDirectoryKey(directory)
        let sanitized = sanitizeCommands(commands)
        let current = appSettings.terminalCommandsByPath[key] ?? []
        guard sanitized != current else {
            return
        }

        var updatedCommands = appSettings.terminalCommandsByPath
        updatedCommands[key] = sanitized

        var selections = appSettings.paneCommandSelections
        if sanitized.isEmpty {
            for tab in tabs {
                for pane in tab.panes where normaliseDirectoryKey(pane.config.workingDirectory) == key {
                    selections.removeValue(forKey: pane.id)
                }
            }
        } else {
            let allowed = Set(sanitized)
            for tab in tabs {
                for pane in tab.panes where normaliseDirectoryKey(pane.config.workingDirectory) == key {
                    if let command = selections[pane.id], !allowed.contains(command) {
                        selections.removeValue(forKey: pane.id)
                    }
                }
            }
        }

        appSettings = appSettings.updating(
            terminalCommandsByPath: updatedCommands,
            paneCommandSelections: selections
        )

        persistConfiguration()
        sendSettingsUpdate()
    }

    func updatePaneCommandPreference(for paneId: UUID, command: String?) {
        var selections = appSettings.paneCommandSelections
        let trimmed = command?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            selections.removeValue(forKey: paneId)
        } else {
            selections[paneId] = trimmed
        }

        guard selections != appSettings.paneCommandSelections else {
            return
        }

        appSettings = appSettings.updating(paneCommandSelections: selections)

        persistConfiguration()
        sendSettingsUpdate()
    }

    func updateTerminalLinks(forWorkingDirectory directory: String, links: [String]) {
        let key = normaliseDirectoryKey(directory)
        let sanitized = sanitizeLinks(links)
        let current = appSettings.terminalLinksByPath[key] ?? []
        guard sanitized != current else {
            return
        }

        var updatedLinks = appSettings.terminalLinksByPath
        updatedLinks[key] = sanitized

        var selections = appSettings.paneLinkSelections
        if sanitized.isEmpty {
            for tab in tabs {
                for pane in tab.panes where normaliseDirectoryKey(pane.config.workingDirectory) == key {
                    selections.removeValue(forKey: pane.id)
                }
            }
        } else {
            let allowed = Set(sanitized)
            for tab in tabs {
                for pane in tab.panes where normaliseDirectoryKey(pane.config.workingDirectory) == key {
                    if let link = selections[pane.id], !allowed.contains(link) {
                        selections.removeValue(forKey: pane.id)
                    }
                }
            }
        }

        appSettings = appSettings.updating(
            terminalLinksByPath: updatedLinks,
            paneLinkSelections: selections
        )

        persistConfiguration()
        sendSettingsUpdate()
    }

    func updatePaneLinkPreference(for paneId: UUID, link: String?) {
        var selections = appSettings.paneLinkSelections
        let trimmed = link?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            selections.removeValue(forKey: paneId)
        } else {
            selections[paneId] = trimmed
        }

        guard selections != appSettings.paneLinkSelections else {
            return
        }

        appSettings = appSettings.updating(paneLinkSelections: selections)

        persistConfiguration()
        sendSettingsUpdate()
    }

    func jsonString<T: Encodable>(from value: T) -> String? {
        guard let data = try? jsonEncoder.encode(value) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func applyConfiguration(_ configuration: AppConfiguration) {
        let newSettings = configuration.settings.updating()
        terminateAllSessions()
        pendingConversationSummaryTasks.values.forEach { $0.cancel() }
        pendingConversationSummaryTasks.removeAll()

        for tab in tabs {
            for pane in tab.panes {
                pane.gitMonitor?.invalidate()
                pane.gitMonitor = nil
                pane.githubActionsMonitor?.invalidate()
                pane.githubActionsMonitor = nil
            }
        }

        tabs.removeAll()
        panesByRuntimeIndex.removeAll()
        panesByIdentifier.removeAll()
        nextPaneIndex = 0
        pendingGitSnapshots.removeAll()
        pendingGitHubActionSnapshots.removeAll()
        bootstrapSent = false
        sessionsStarted = false

        previewVisible = false
        previewWebView?.isHidden = true
        previewWebView?.loadHTMLString("", baseURL: nil)
        previewWidthConstraint?.constant = 0
        previewHeightConstraint?.constant = 0
        previewLeadingConstraint?.constant = 0
        previewTopConstraint?.constant = 0
        lastPreviewURLString = ""

        appSettings = newSettings
        if appSettings.notifyOnIdle {
            refreshDockBadge()
        } else {
            clearIdleNotifications()
        }

        var rebuiltTabs: [TabState] = []
        for storedTab in configuration.tabs {
            let tabState = buildTabState(from: storedTab)
            rebuiltTabs.append(tabState)
        }
        tabs = rebuiltTabs

        applyInitialDefaultsIfNeeded()

        if let rememberedPath = tabs.last?.panes.first?.config.workingDirectory, !rememberedPath.isEmpty {
            let candidateURL = URL(fileURLWithPath: rememberedPath, isDirectory: true)
            lastSelectedDirectoryURL = directoryExists(at: candidateURL) ? candidateURL : nil
        } else {
            lastSelectedDirectoryURL = nil
        }

        if let webView {
            bootstrapSent = false
            webView.reload()
        }
    }

    func directoryExists(at url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) && isDirectory.boolValue
    }
}
