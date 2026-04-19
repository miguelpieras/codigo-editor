import AppKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class SettingsWindowController: NSWindowController {
    private let viewModel: SettingsViewModel

    init(configurationStore: ConfigurationStore, coordinatorProvider: @escaping () -> TerminalCoordinator?) {
        let viewModel = SettingsViewModel(
            configurationStore: configurationStore,
            coordinatorProvider: coordinatorProvider
        )
        self.viewModel = viewModel

        let contentView = SettingsView(viewModel: viewModel)
        let hostingController = NSHostingController(rootView: contentView)
        let window = NSWindow(contentViewController: hostingController)
        window.title = "Settings"
        window.styleMask = [.titled, .closable, .miniaturizable]
        let contentSize = NSSize(width: 720, height: 560)
        window.setContentSize(contentSize)
        window.minSize = contentSize
        window.maxSize = contentSize
        window.isReleasedWhenClosed = false
        super.init(window: window)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func showWindow(_ sender: Any?) {
        let wasVisible = window?.isVisible ?? false
        super.showWindow(sender)
        viewModel.refreshConfiguration()
        guard !wasVisible else { return }
        DispatchQueue.main.async { [weak self] in
            self?.window?.makeFirstResponder(nil)
        }
    }
}

enum StarterPreset: String, CaseIterable, Identifiable {
    case codex
    case claudeCode
    case custom

    var id: String { rawValue }

    var title: String {
        switch self {
        case .codex:
            return "Codex"
        case .claudeCode:
            return "Claude Code"
        case .custom:
            return "Custom"
        }
    }

    var description: String {
        switch self {
        case .codex:
            return "Run Codex automatically."
        case .claudeCode:
            return "Use Claude Code as the default agent."
        case .custom:
            return "Specify your own starter command."
        }
    }

    var systemImage: String {
        switch self {
        case .codex:
            return "sparkles"
        case .claudeCode:
            return "brain"
        case .custom:
            return "slider.horizontal.3"
        }
    }

    var command: String? {
        switch self {
        case .codex:
            return "codex"
        case .claudeCode:
            return "claude"
        case .custom:
            return nil
        }
    }

    static func preset(for command: String) -> StarterPreset {
        let normalized = command.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch normalized {
        case "codex":
            return .codex
        case "claude":
            return .claudeCode
        default:
            return .custom
        }
    }
}

enum TerminalEditorPreset: String, CaseIterable, Identifiable {
    case cursor
    case visualStudioCode
    case custom

    var id: String { rawValue }

    var title: String {
        switch self {
        case .cursor:
            return "Cursor"
        case .visualStudioCode:
            return "VS Code"
        case .custom:
            return "Custom Command"
        }
    }

    var description: String {
        switch self {
        case .cursor:
            return "Open the working directory in Cursor."
        case .visualStudioCode:
            return "Open the working directory in Visual Studio Code."
        case .custom:
            return "Run your own shell command."
        }
    }

    var systemImage: String {
        switch self {
        case .cursor:
            return "cursorarrow.rays"
        case .visualStudioCode:
            return "chevron.left.slash.chevron.right"
        case .custom:
            return "slider.horizontal.3"
        }
    }

    var action: TerminalEditorAction? {
        switch self {
        case .cursor:
            return .cursor
        case .visualStudioCode:
            return .visualStudioCode
        case .custom:
            return nil
        }
    }

    static func preset(for action: TerminalEditorAction) -> TerminalEditorPreset {
        switch action {
        case .cursor:
            return .cursor
        case .visualStudioCode:
            return .visualStudioCode
        case .custom:
            return .custom
        }
    }
}

enum CloudActionPreset: String, CaseIterable, Identifiable {
    case sync
    case createPullRequest
    case custom

    var id: String { rawValue }

    var title: String {
        switch self {
        case .sync:
            return "Commit & Sync"
        case .createPullRequest:
            return "Create Pull Request"
        case .custom:
            return "Custom Script"
        }
    }

    var description: String {
        switch self {
        case .sync:
            return "Commit staged changes and push to the remote."
        case .createPullRequest:
            return "Commit, push, and open a pull request with GitHub CLI."
        case .custom:
            return "Execute your own script from the terminal's directory."
        }
    }

    var systemImage: String {
        switch self {
        case .sync:
            return "arrow.triangle.2.circlepath"
        case .createPullRequest:
            return "arrow.triangle.branch"
        case .custom:
            return "terminal"
        }
    }

    var action: TerminalCloudAction? {
        switch self {
        case .sync:
            return .sync
        case .createPullRequest:
            return .createPullRequest
        case .custom:
            return nil
        }
    }

    static func preset(for action: TerminalCloudAction) -> CloudActionPreset {
        switch action {
        case .sync:
            return .sync
        case .createPullRequest:
            return .createPullRequest
        case .customScript:
            return .custom
        }
    }
}

enum ConversationSummaryPreset: String, CaseIterable, Identifiable {
    case off
    case localCommand
    case terminalTitle

    var id: String { rawValue }

    var title: String {
        switch self {
        case .off:
            return "Off"
        case .localCommand:
            return "Local Command"
        case .terminalTitle:
            return "Terminal Title"
        }
    }

    var description: String {
        switch self {
        case .off:
            return "Keep agent rows on their pane title only."
        case .localCommand:
            return "Pipe each new prompt into a local summarizer command."
        case .terminalTitle:
            return "Use title updates emitted by the terminal or agent."
        }
    }

    var systemImage: String {
        switch self {
        case .off:
            return "nosign"
        case .localCommand:
            return "sparkles.rectangle.stack"
        case .terminalTitle:
            return "character.cursor.ibeam"
        }
    }

    var source: ConversationSummarySource {
        switch self {
        case .off:
            return .off
        case .localCommand:
            return .localCommand
        case .terminalTitle:
            return .terminalTitle
        }
    }

    static func preset(for source: ConversationSummarySource) -> ConversationSummaryPreset {
        switch source {
        case .off:
            return .off
        case .localCommand:
            return .localCommand
        case .terminalTitle:
            return .terminalTitle
        }
    }
}

@MainActor
final class SettingsViewModel: ObservableObject {
    @Published var configurationText: String = ""
    @Published var statusMessage: String?
    @Published var statusIsError = false
    @Published var starterCommand: String = "" {
        didSet {
            guard !isInitializing else { return }
            if starterPreset == .custom {
                customStarterCommand = starterCommand
            }
        }
    }
    @Published var starterPreset: StarterPreset = .custom
    @Published var editorCommand: String = "" {
        didSet {
            guard !isInitializing else { return }
            if editorPreset == .custom {
                customEditorCommand = editorCommand
            }
        }
    }
    @Published var editorPreset: TerminalEditorPreset = .cursor
    @Published var cloudPreset: CloudActionPreset = .sync
    @Published var cloudScript: String = "" {
        didSet {
            guard !isInitializing else { return }
            if cloudPreset == .custom {
                customCloudScript = cloudScript
            }
        }
    }
    @Published var conversationSummaryPreset: ConversationSummaryPreset = .off
    @Published var conversationSummaryCommand: String = ""
    @Published var playIdleChime: Bool
    @Published var notifyOnIdle: Bool

    let configurationPath: String

    private let configurationStore: ConfigurationStore
    private let coordinatorProvider: () -> TerminalCoordinator?
    private var customStarterCommand: String = ""
    private var customEditorCommand: String = ""
    private var customCloudScript: String = ""
    private var isInitializing = true

    init(configurationStore: ConfigurationStore, coordinatorProvider: @escaping () -> TerminalCoordinator?) {
        self.configurationStore = configurationStore
        self.coordinatorProvider = coordinatorProvider
        self.configurationPath = configurationStore.configurationFileLocation().path
        let configuration = configurationStore.loadOrCreateConfiguration()
        let initialCommand = configuration.settings.starterCommand
        let initialPreset = StarterPreset.preset(for: initialCommand)
        self.starterPreset = initialPreset
        self.starterCommand = initialCommand
        self.playIdleChime = configuration.settings.playIdleChime
        self.notifyOnIdle = configuration.settings.notifyOnIdle
        if initialPreset == .custom {
            self.customStarterCommand = initialCommand
        } else {
            self.customStarterCommand = ""
        }
        let initialEditorAction = configuration.settings.terminalEditorAction
        let initialEditorPreset = TerminalEditorPreset.preset(for: initialEditorAction)
        self.editorPreset = initialEditorPreset
        let initialEditorCommand = configuration.settings.terminalEditorCommand
        self.editorCommand = initialEditorCommand
        self.customEditorCommand = initialEditorCommand
        let initialCloudAction = configuration.settings.terminalCloudAction
        let initialCloudPreset = CloudActionPreset.preset(for: initialCloudAction)
        self.cloudPreset = initialCloudPreset
        let initialScript = configuration.settings.terminalCloudCustomScript
        self.cloudScript = initialScript
        self.customCloudScript = initialScript
        self.conversationSummaryPreset = ConversationSummaryPreset.preset(for: configuration.settings.conversationSummarySource)
        self.conversationSummaryCommand = configuration.settings.conversationSummaryCommand
        self.isInitializing = false
    }

    func refreshConfiguration() {
        isInitializing = true
        configurationText = configurationStore.configurationJSONString()
        starterCommand = resolvedStarterCommand()
        starterPreset = StarterPreset.preset(for: starterCommand)
        if starterPreset == .custom {
            customStarterCommand = starterCommand
        }
        playIdleChime = resolvedPlayIdleChime()
        notifyOnIdle = resolvedNotifyOnIdle()
        let editorAction = resolvedEditorAction()
        editorPreset = TerminalEditorPreset.preset(for: editorAction)
        let currentEditorCommand = resolvedEditorCommand()
        editorCommand = currentEditorCommand
        customEditorCommand = currentEditorCommand
        let cloudAction = resolvedCloudAction()
        cloudPreset = CloudActionPreset.preset(for: cloudAction)
        let script = resolvedCloudScript()
        cloudScript = script
        customCloudScript = script
        conversationSummaryPreset = ConversationSummaryPreset.preset(for: resolvedConversationSummarySource())
        conversationSummaryCommand = resolvedConversationSummaryCommand()
        isInitializing = false
        statusMessage = nil
    }

    private func resolvedStarterCommand() -> String {
        if let coordinator = coordinatorProvider() {
            return coordinator.currentStarterCommand()
        }
        let configuration = configurationStore.loadOrCreateConfiguration()
        return configuration.settings.starterCommand
    }

    private func resolvedPlayIdleChime() -> Bool {
        if let coordinator = coordinatorProvider() {
            return coordinator.currentIdleChimePreference()
        }
        let configuration = configurationStore.loadOrCreateConfiguration()
        return configuration.settings.playIdleChime
    }

    private func resolvedNotifyOnIdle() -> Bool {
        if let coordinator = coordinatorProvider() {
            return coordinator.currentIdleNotificationPreference()
        }
        let configuration = configurationStore.loadOrCreateConfiguration()
        return configuration.settings.notifyOnIdle
    }

    private func resolvedEditorAction() -> TerminalEditorAction {
        if let coordinator = coordinatorProvider() {
            return coordinator.currentTerminalEditorAction()
        }
        let configuration = configurationStore.loadOrCreateConfiguration()
        return configuration.settings.terminalEditorAction
    }

    private func resolvedEditorCommand() -> String {
        if let coordinator = coordinatorProvider() {
            return coordinator.currentTerminalEditorCommand()
        }
        let configuration = configurationStore.loadOrCreateConfiguration()
        return configuration.settings.terminalEditorCommand
    }

    private func resolvedCloudAction() -> TerminalCloudAction {
        if let coordinator = coordinatorProvider() {
            return coordinator.appSettings.terminalCloudAction
        }
        let configuration = configurationStore.loadOrCreateConfiguration()
        return configuration.settings.terminalCloudAction
    }

    private func resolvedCloudScript() -> String {
        if let coordinator = coordinatorProvider() {
            return coordinator.currentTerminalCloudCustomScript()
        }
        let configuration = configurationStore.loadOrCreateConfiguration()
        return configuration.settings.terminalCloudCustomScript
    }

    private func resolvedConversationSummarySource() -> ConversationSummarySource {
        if let coordinator = coordinatorProvider() {
            return coordinator.currentConversationSummarySource()
        }
        let configuration = configurationStore.loadOrCreateConfiguration()
        return configuration.settings.conversationSummarySource
    }

    private func resolvedConversationSummaryCommand() -> String {
        if let coordinator = coordinatorProvider() {
            return coordinator.currentConversationSummaryCommand()
        }
        let configuration = configurationStore.loadOrCreateConfiguration()
        return configuration.settings.conversationSummaryCommand
    }

    func saveStarterCommand() {
        let sanitizedValue = starterCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        let currentValue = resolvedStarterCommand()

        if sanitizedValue == currentValue {
            starterCommand = sanitizedValue
            statusMessage = "Starter command unchanged"
            statusIsError = false
            return
        }

        var encounteredError: Error?
        if let coordinator = coordinatorProvider() {
            coordinator.updateStarterCommand(to: sanitizedValue)
        } else {
            var configuration = configurationStore.loadOrCreateConfiguration()
            configuration.settings = configuration.settings.updating(
                starterCommand: sanitizedValue,
                starterCommandPreferenceConfirmed: true
            )
            do {
                try configurationStore.saveConfiguration(configuration)
            } catch {
                encounteredError = error
            }
        }

        if let encounteredError {
            statusMessage = "Save failed: \(encounteredError.localizedDescription)"
            statusIsError = true
            return
        }

        starterCommand = sanitizedValue
        starterPreset = StarterPreset.preset(for: sanitizedValue)
        if starterPreset == .custom {
            customStarterCommand = sanitizedValue
        }
        configurationText = configurationStore.configurationJSONString()
        statusMessage = sanitizedValue.isEmpty ? "Starter command cleared" : "Starter command updated"
        statusIsError = false
    }

    func selectStarterPreset(_ preset: StarterPreset) {
        guard starterPreset != preset else { return }
        starterPreset = preset
        switch preset {
        case .codex, .claudeCode:
            starterCommand = preset.command ?? ""
            saveStarterCommand()
        case .custom:
            starterCommand = customStarterCommand
            statusMessage = "Enter a command and tap Save."
            statusIsError = false
        }
    }

    func selectEditorPreset(_ preset: TerminalEditorPreset) {
        guard editorPreset != preset else { return }
        editorPreset = preset
        switch preset {
        case .cursor, .visualStudioCode:
            guard let action = preset.action else { return }
            if applyEditorAction(action) {
                switch action {
                case .cursor:
                    statusMessage = "Code icon set to open Cursor"
                case .visualStudioCode:
                    statusMessage = "Code icon set to open VS Code"
                case .custom:
                    break
                }
            }
        case .custom:
            editorCommand = customEditorCommand
            statusMessage = "Enter a command and tap Save."
            statusIsError = false
        }
    }

    func saveEditorCommand() {
        let trimmed = editorCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        editorCommand = trimmed
        editorPreset = .custom
        guard applyEditorCommand(trimmed) else {
            return
        }
        customEditorCommand = trimmed
        statusMessage = trimmed.isEmpty ? "Custom editor command cleared" : "Custom editor command saved"
        statusIsError = false
    }

    func selectCloudPreset(_ preset: CloudActionPreset) {
        guard cloudPreset != preset else { return }
        cloudPreset = preset
        switch preset {
        case .sync, .createPullRequest:
            guard let action = preset.action else { return }
            if applyCloudAction(action) {
                switch action {
                case .sync:
                    statusMessage = "Cloud action set to Commit & Sync"
                case .createPullRequest:
                    statusMessage = "Cloud action set to Create Pull Request"
                case .customScript:
                    break
                }
            }
        case .custom:
            cloudScript = customCloudScript
            statusMessage = "Enter a script and tap Save."
            statusIsError = false
        }
    }

    func saveCloudScript() {
        let normalised = cloudScript.replacingOccurrences(of: "\r\n", with: "\n")
        cloudScript = normalised
        cloudPreset = .custom
        guard applyCloudScript(normalised) else {
            return
        }
        customCloudScript = normalised
        let trimmed = normalised.trimmingCharacters(in: .whitespacesAndNewlines)
        statusMessage = trimmed.isEmpty ? "Custom cloud script cleared" : "Custom cloud script saved"
        statusIsError = false
    }

    func selectConversationSummaryPreset(_ preset: ConversationSummaryPreset) {
        guard conversationSummaryPreset != preset else { return }
        conversationSummaryPreset = preset
        guard applyConversationSummarySource(preset.source) else {
            return
        }

        switch preset {
        case .off:
            statusMessage = "Agent row summaries disabled"
        case .localCommand:
            statusMessage = "Set a local summary command and tap Save."
        case .terminalTitle:
            statusMessage = "Agent row summaries now follow terminal title updates"
        }
        statusIsError = false
    }

    func saveConversationSummaryCommand() {
        let trimmed = conversationSummaryCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        conversationSummaryCommand = trimmed
        if conversationSummaryPreset != .localCommand {
            conversationSummaryPreset = .localCommand
            guard applyConversationSummarySource(.localCommand) else {
                return
            }
        }
        guard applyConversationSummaryCommand(trimmed) else {
            return
        }
        statusMessage = trimmed.isEmpty
            ? "Local summary command cleared"
            : "Local summary command saved"
        statusIsError = false
    }

    func syncPresetWithCurrentCommand() {
        let detected = StarterPreset.preset(for: starterCommand)
        if detected != starterPreset {
            starterPreset = detected
            if detected != .custom {
                saveStarterCommand()
            } else {
                customStarterCommand = starterCommand
            }
        }
    }

    private func applyEditorAction(_ action: TerminalEditorAction) -> Bool {
        var encounteredError: Error?
        if let coordinator = coordinatorProvider() {
            coordinator.updateTerminalEditorAction(to: action)
        } else {
            var configuration = configurationStore.loadOrCreateConfiguration()
            configuration.settings = configuration.settings.updating(terminalEditorAction: action)
            do {
                try configurationStore.saveConfiguration(configuration)
            } catch {
                encounteredError = error
            }
        }

        if let encounteredError {
            statusMessage = "Save failed: \(encounteredError.localizedDescription)"
            statusIsError = true
            return false
        }

        configurationText = configurationStore.configurationJSONString()
        statusIsError = false
        return true
    }

    private func applyEditorCommand(_ command: String) -> Bool {
        var encounteredError: Error?
        if let coordinator = coordinatorProvider() {
            coordinator.updateTerminalEditorAction(to: .custom)
            coordinator.updateTerminalEditorCommand(to: command)
        } else {
            var configuration = configurationStore.loadOrCreateConfiguration()
            configuration.settings = configuration.settings.updating(
                terminalEditorAction: .custom,
                terminalEditorCommand: command
            )
            do {
                try configurationStore.saveConfiguration(configuration)
            } catch {
                encounteredError = error
            }
        }

        if let encounteredError {
            statusMessage = "Save failed: \(encounteredError.localizedDescription)"
            statusIsError = true
            return false
        }

        configurationText = configurationStore.configurationJSONString()
        statusIsError = false
        return true
    }

    private func applyCloudAction(_ action: TerminalCloudAction) -> Bool {
        var encounteredError: Error?
        if let coordinator = coordinatorProvider() {
            coordinator.updateTerminalCloudAction(to: action)
        } else {
            var configuration = configurationStore.loadOrCreateConfiguration()
            configuration.settings = configuration.settings.updating(terminalCloudAction: action)
            do {
                try configurationStore.saveConfiguration(configuration)
            } catch {
                encounteredError = error
            }
        }

        if let encounteredError {
            statusMessage = "Save failed: \(encounteredError.localizedDescription)"
            statusIsError = true
            return false
        }

        configurationText = configurationStore.configurationJSONString()
        statusIsError = false
        return true
    }

    private func applyCloudScript(_ script: String) -> Bool {
        var encounteredError: Error?
        if let coordinator = coordinatorProvider() {
            coordinator.updateTerminalCloudAction(to: .customScript)
            coordinator.updateTerminalCloudCustomScript(to: script)
        } else {
            var configuration = configurationStore.loadOrCreateConfiguration()
            configuration.settings = configuration.settings.updating(
                terminalCloudAction: .customScript,
                terminalCloudCustomScript: script
            )
            do {
                try configurationStore.saveConfiguration(configuration)
            } catch {
                encounteredError = error
            }
        }

        if let encounteredError {
            statusMessage = "Save failed: \(encounteredError.localizedDescription)"
            statusIsError = true
            return false
        }

        configurationText = configurationStore.configurationJSONString()
        statusIsError = false
        return true
    }

    private func applyConversationSummarySource(_ source: ConversationSummarySource) -> Bool {
        var encounteredError: Error?
        if let coordinator = coordinatorProvider() {
            coordinator.updateConversationSummarySource(to: source)
        } else {
            var configuration = configurationStore.loadOrCreateConfiguration()
            configuration.settings = configuration.settings.updating(conversationSummarySource: source)
            do {
                try configurationStore.saveConfiguration(configuration)
            } catch {
                encounteredError = error
            }
        }

        if let encounteredError {
            statusMessage = "Save failed: \(encounteredError.localizedDescription)"
            statusIsError = true
            return false
        }

        configurationText = configurationStore.configurationJSONString()
        statusIsError = false
        return true
    }

    private func applyConversationSummaryCommand(_ command: String) -> Bool {
        var encounteredError: Error?
        if let coordinator = coordinatorProvider() {
            coordinator.updateConversationSummaryCommand(to: command)
        } else {
            var configuration = configurationStore.loadOrCreateConfiguration()
            configuration.settings = configuration.settings.updating(conversationSummaryCommand: command)
            do {
                try configurationStore.saveConfiguration(configuration)
            } catch {
                encounteredError = error
            }
        }

        if let encounteredError {
            statusMessage = "Save failed: \(encounteredError.localizedDescription)"
            statusIsError = true
            return false
        }

        configurationText = configurationStore.configurationJSONString()
        statusIsError = false
        return true
    }

    func savePlayIdleChimePreference() {
        let desiredValue = playIdleChime
        var encounteredError: Error?

        if let coordinator = coordinatorProvider() {
            coordinator.updateIdleChimePreference(to: desiredValue)
        } else {
            var configuration = configurationStore.loadOrCreateConfiguration()
            let updatedSettings = configuration.settings.updating(playIdleChime: desiredValue)
            configuration.settings = updatedSettings
            do {
                try configurationStore.saveConfiguration(configuration)
            } catch {
                encounteredError = error
            }
        }

        if let encounteredError {
            statusMessage = "Save failed: \(encounteredError.localizedDescription)"
            statusIsError = true
            return
        }

        playIdleChime = desiredValue
        configurationText = configurationStore.configurationJSONString()
        statusMessage = desiredValue ? "Idle chime enabled" : "Idle chime disabled"
        statusIsError = false
    }

    func saveIdleNotificationPreference() {
        let desiredValue = notifyOnIdle
        var encounteredError: Error?

        if let coordinator = coordinatorProvider() {
            coordinator.updateIdleNotificationPreference(to: desiredValue)
        } else {
            var configuration = configurationStore.loadOrCreateConfiguration()
            let updatedSettings = configuration.settings.updating(notifyOnIdle: desiredValue)
            configuration.settings = updatedSettings
            do {
                try configurationStore.saveConfiguration(configuration)
            } catch {
                encounteredError = error
            }
        }

        if let encounteredError {
            statusMessage = "Save failed: \(encounteredError.localizedDescription)"
            statusIsError = true
            return
        }

        notifyOnIdle = desiredValue
        configurationText = configurationStore.configurationJSONString()
        statusMessage = desiredValue ? "Idle notifications enabled" : "Idle notifications disabled"
        statusIsError = false
    }

    @MainActor
    func exportConfiguration() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.json]
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        panel.nameFieldStringValue = "codigo-configuration.json"
        panel.directoryURL = configurationStore.configurationFileLocation().deletingLastPathComponent()

        let response = panel.runModal()
        guard response == .OK, let destinationURL = panel.url else {
            return
        }

        do {
            let json = configurationStore.configurationJSONString()
            guard let data = json.data(using: String.Encoding.utf8) else {
                throw CocoaError(.fileWriteUnknown)
            }
            try data.write(to: destinationURL, options: Data.WritingOptions.atomic)
            statusMessage = "Exported configuration to \(destinationURL.lastPathComponent)"
            statusIsError = false
        } catch {
            statusMessage = "Export failed: \(error.localizedDescription)"
            statusIsError = true
        }
    }

    @MainActor
    func importConfiguration() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowedContentTypes = [.json]
        panel.directoryURL = configurationStore.configurationFileLocation().deletingLastPathComponent()

        let response = panel.runModal()
        guard response == .OK, let sourceURL = panel.url else {
            return
        }

        do {
            let data = try Data(contentsOf: sourceURL)
            let configuration = try configurationStore.validateConfigurationJSON(data)
            try configurationStore.replaceConfiguration(with: configuration)
            coordinatorProvider()?.applyConfiguration(configuration)
            refreshConfiguration()
            statusMessage = "Imported configuration from \(sourceURL.lastPathComponent)"
            statusIsError = false
        } catch {
            statusMessage = "Import failed: \(error.localizedDescription)"
            statusIsError = true
        }
    }
}

private struct SettingsView: View {
    @ObservedObject var viewModel: SettingsViewModel
    @State private var generalExpanded = true
    @State private var notificationsExpanded = true
    @State private var configurationExpanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    DisclosureGroup(isExpanded: $generalExpanded) {
                        generalSection
                    } label: {
                        sectionLabel("General", systemImage: "slider.horizontal.3")
                    }

                    DisclosureGroup(isExpanded: $notificationsExpanded) {
                        notificationsSection
                    } label: {
                        sectionLabel("Notifications", systemImage: "bell")
                    }

                    DisclosureGroup(isExpanded: $configurationExpanded) {
                        configurationSection
                    } label: {
                        sectionLabel("Configuration", systemImage: "tray.and.arrow.up.fill")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if let status = viewModel.statusMessage {
                HStack {
                    Spacer()
                    Text(status)
                        .foregroundColor(viewModel.statusIsError ? .red : .secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.trailing)
                }
            }
        }
        .padding(20)
    }

    private var generalSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Starter Command")
                .font(.headline)

            Text("Choose which agent runs automatically when new panes open.")
                .font(.subheadline)
                .foregroundColor(.secondary)

            HStack(spacing: 12) {
                ForEach(StarterPreset.allCases) { preset in
                    SettingsPresetCard(
                        systemImage: preset.systemImage,
                        title: preset.title,
                        description: preset.description,
                        isSelected: viewModel.starterPreset == preset,
                        action: { viewModel.selectStarterPreset(preset) }
                    )
                }
            }

            if viewModel.starterPreset == .custom {
                HStack(spacing: 12) {
                    TextField("Starter command", text: $viewModel.starterCommand)
                        .textFieldStyle(.roundedBorder)
                        .frame(minWidth: 280)
                        .onSubmit {
                            viewModel.saveStarterCommand()
                        }
                    Button("Save") {
                        viewModel.saveStarterCommand()
                    }
                }

                Text("Leave blank to disable automatic startup when new panes launch.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            } else if let command = viewModel.starterPreset.command {
                Text("Runs \"\(command)\" whenever a new terminal pane starts.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }

            Divider()
                .padding(.vertical, 4)

            Text("Code Icon Action")
                .font(.headline)

            Text("Choose what happens when you click the code icon in terminal headers.")
                .font(.subheadline)
                .foregroundColor(.secondary)

            HStack(spacing: 12) {
                ForEach(TerminalEditorPreset.allCases) { preset in
                    SettingsPresetCard(
                        systemImage: preset.systemImage,
                        title: preset.title,
                        description: preset.description,
                        isSelected: viewModel.editorPreset == preset,
                        action: { viewModel.selectEditorPreset(preset) }
                    )
                }
            }

            if viewModel.editorPreset == .custom {
                HStack(spacing: 12) {
                    TextField("Custom command", text: $viewModel.editorCommand)
                        .textFieldStyle(.roundedBorder)
                        .frame(minWidth: 280)
                        .onSubmit {
                            viewModel.saveEditorCommand()
                        }
                    Button("Save") {
                        viewModel.saveEditorCommand()
                    }
                }

                Text("The command runs inside the terminal's working directory.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            } else {
                Text(viewModel.editorPreset.description)
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }

            Divider()
                .padding(.vertical, 4)

            Text("Cloud Action")
                .font(.headline)

            Text("Pick the default action for the cloud button in terminal headers.")
                .font(.subheadline)
                .foregroundColor(.secondary)

            HStack(spacing: 12) {
                ForEach(CloudActionPreset.allCases) { preset in
                    SettingsPresetCard(
                        systemImage: preset.systemImage,
                        title: preset.title,
                        description: preset.description,
                        isSelected: viewModel.cloudPreset == preset,
                        action: { viewModel.selectCloudPreset(preset) }
                    )
                }
            }

            if viewModel.cloudPreset == .custom {
                VStack(alignment: .leading, spacing: 8) {
                    TextEditor(text: $viewModel.cloudScript)
                        .font(.body.monospaced())
                        .frame(minHeight: 120)
                        .overlay(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .stroke(Color.secondary.opacity(0.25), lineWidth: 1)
                        )
                    HStack {
                        Spacer()
                        Button("Save Script") {
                            viewModel.saveCloudScript()
                        }
                    }
                    Text("Script runs in the terminal working directory. Use multiline commands if needed.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            } else {
                Text(viewModel.cloudPreset.description)
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }

            Divider()
                .padding(.vertical, 4)

            Text("Agent Row Summary")
                .font(.headline)

            Text("Choose what stacked agent rows show when several agents are running.")
                .font(.subheadline)
                .foregroundColor(.secondary)

            HStack(spacing: 12) {
                ForEach(ConversationSummaryPreset.allCases) { preset in
                    SettingsPresetCard(
                        systemImage: preset.systemImage,
                        title: preset.title,
                        description: preset.description,
                        isSelected: viewModel.conversationSummaryPreset == preset,
                        action: { viewModel.selectConversationSummaryPreset(preset) }
                    )
                }
            }

            if viewModel.conversationSummaryPreset == .localCommand {
                HStack(spacing: 12) {
                    TextField("Local summary command", text: $viewModel.conversationSummaryCommand)
                        .textFieldStyle(.roundedBorder)
                        .frame(minWidth: 280)
                        .onSubmit {
                            viewModel.saveConversationSummaryCommand()
                        }
                    Button("Save") {
                        viewModel.saveConversationSummaryCommand()
                    }
                }

                Text("The command receives an instruction on stdin and must print strict JSON on stdout, for example {\"summary\":\"Fix preview auth redirect\"}. Any non-JSON output is ignored. Existing Codex panes may need reconnecting after you change this setting.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            } else {
                Text("Rows fall back to the pane title until a summary is available.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }
        }
        .onChange(of: viewModel.starterCommand) { _ in
            viewModel.syncPresetWithCurrentCommand()
        }
    }

    private var notificationsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle(isOn: $viewModel.playIdleChime) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Play chime when Codex becomes idle")
                    Text("Hear a gentle alert whenever terminal automation finishes.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            }
            .onChange(of: viewModel.playIdleChime) { _ in
                viewModel.savePlayIdleChimePreference()
            }

            Toggle(isOn: $viewModel.notifyOnIdle) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Show notification when Codex becomes idle")
                    Text("Display a macOS banner and Dock badge after automation completes.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            }
            .onChange(of: viewModel.notifyOnIdle) { _ in
                viewModel.saveIdleNotificationPreference()
            }
        }
    }

    private var configurationSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Button("Import…") {
                    viewModel.importConfiguration()
                }
                Button("Export…") {
                    viewModel.exportConfiguration()
                }
                Spacer()
            }
        }
    }

    private func sectionLabel(_ title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(.headline)
    }

    private struct SettingsPresetCard: View {
        let systemImage: String
        let title: String
        let description: String
        let isSelected: Bool
        let action: () -> Void

        private var fillColor: Color {
            if isSelected {
                return Color.accentColor.opacity(0.15)
            }
            return Color(nsColor: .controlBackgroundColor)
        }

        var body: some View {
            Button(action: action) {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: systemImage)
                        .font(.title2)
                        .foregroundColor(isSelected ? .accentColor : .secondary)
                    Text(title)
                        .font(.headline)
                    Text(description)
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 110, alignment: .leading)
                .padding()
                .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(fillColor)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(isSelected ? Color.accentColor : Color.clear, lineWidth: 2)
                )
            }
            .buttonStyle(.plain)
        }
    }

}
