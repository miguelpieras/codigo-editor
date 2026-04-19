import Foundation

enum PaneColumn: String, Codable, Hashable {
    case primary
    case stacked
}

enum PaneKind: String, Codable, Hashable {
    case shell
    case codex
    case claude

    static func inferred(from startupCommand: String?) -> PaneKind {
        let resolved = inferredExecutable(from: startupCommand)
            .split(separator: "/")
            .last?
            .lowercased()

        switch resolved {
        case "codex":
            return .codex
        case "claude":
            return .claude
        default:
            return .shell
        }
    }

    private static func inferredExecutable(from startupCommand: String?) -> String {
        guard let startupCommand else {
            return ""
        }

        let trimmed = startupCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return ""
        }

        let tokens = trimmed.split(whereSeparator: \.isWhitespace).map(String.init)
        var index = 0

        while index < tokens.count {
            let rawToken = tokens[index]
            let token = rawToken.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            guard !token.isEmpty else {
                index += 1
                continue
            }

            if token == "env" || token.hasSuffix("/env") {
                index += 1
                while index < tokens.count {
                    let candidate = tokens[index].trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
                    guard !candidate.isEmpty else {
                        index += 1
                        continue
                    }
                    if candidate == "--" {
                        index += 1
                        break
                    }
                    if candidate.hasPrefix("-") || looksLikeEnvAssignment(candidate) {
                        index += 1
                        continue
                    }
                    return candidate
                }
                continue
            }

            if looksLikeEnvAssignment(token) {
                index += 1
                continue
            }

            return token
        }

        return ""
    }

    private static func looksLikeEnvAssignment(_ token: String) -> Bool {
        guard let equalsIndex = token.firstIndex(of: "="),
              equalsIndex != token.startIndex else {
            return false
        }
        let key = token[..<equalsIndex]
        return key.allSatisfy { character in
            character == "_" || character.isLetter || character.isNumber
        }
    }
}

enum TerminalCloudAction: String, Codable, Hashable {
    case sync
    case createPullRequest
    case customScript
}

enum TerminalEditorAction: String, Codable, Hashable {
    case cursor
    case visualStudioCode = "vscode"
    case custom
}

enum ConversationSummarySource: String, Codable, Hashable {
    case off
    case localCommand
    case terminalTitle
}

struct StoredPane: Codable, Hashable {
    var id: UUID
    var title: String
    var workingDirectory: String
    var startupCommand: String?
    var kind: PaneKind
    var conversationSummary: String?
    var column: PaneColumn

    init(
        id: UUID,
        title: String,
        workingDirectory: String,
        startupCommand: String?,
        kind: PaneKind? = nil,
        conversationSummary: String? = nil,
        column: PaneColumn = .stacked
    ) {
        self.id = id
        self.title = title
        self.workingDirectory = workingDirectory
        self.startupCommand = startupCommand
        self.kind = kind ?? PaneKind.inferred(from: startupCommand)
        let trimmedSummary = conversationSummary?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.conversationSummary = (trimmedSummary?.isEmpty == false) ? trimmedSummary : nil
        self.column = column
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case title
        case workingDirectory
        case startupCommand
        case kind
        case conversationSummary
        case column
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        workingDirectory = try container.decode(String.self, forKey: .workingDirectory)
        startupCommand = try container.decodeIfPresent(String.self, forKey: .startupCommand)
        kind = try container.decodeIfPresent(PaneKind.self, forKey: .kind) ?? PaneKind.inferred(from: startupCommand)
        let decodedSummary = try container.decodeIfPresent(String.self, forKey: .conversationSummary)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        conversationSummary = (decodedSummary?.isEmpty == false) ? decodedSummary : nil
        column = try container.decodeIfPresent(PaneColumn.self, forKey: .column) ?? .stacked
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(title, forKey: .title)
        try container.encode(workingDirectory, forKey: .workingDirectory)
        try container.encodeIfPresent(startupCommand, forKey: .startupCommand)
        try container.encode(kind, forKey: .kind)
        try container.encodeIfPresent(conversationSummary, forKey: .conversationSummary)
        try container.encode(column, forKey: .column)
    }
}

struct StoredPreviewTab: Codable, Hashable {
    var id: UUID
    var title: String
    var url: String
}

struct StoredTab: Codable, Hashable {
    var id: UUID
    var title: String
    var panes: [StoredPane]
    var previewURL: String?
    var previewTabs: [StoredPreviewTab]?
    var activePreviewTabId: UUID?
}

struct AppSettings: Codable, Hashable {
    var starterCommand: String
    var starterCommandPreferenceConfirmed: Bool
    var playIdleChime: Bool
    var notifyOnIdle: Bool
    var terminalCommandsByPath: [String: [String]]
    var paneCommandSelections: [UUID: String]
    var terminalLinksByPath: [String: [String]]
    var paneLinkSelections: [UUID: String]
    var terminalCloudAction: TerminalCloudAction
    var terminalEditorAction: TerminalEditorAction
    var terminalEditorCommand: String
    var terminalCloudCustomScript: String
    var conversationSummarySource: ConversationSummarySource
    var conversationSummaryCommand: String

    init(
        starterCommand: String = "codex",
        starterCommandPreferenceConfirmed: Bool = false,
        playIdleChime: Bool = true,
        notifyOnIdle: Bool = false,
        terminalCommandsByPath: [String: [String]] = [:],
        paneCommandSelections: [UUID: String] = [:],
        terminalLinksByPath: [String: [String]] = [:],
        paneLinkSelections: [UUID: String] = [:],
        terminalCloudAction: TerminalCloudAction = .sync,
        terminalEditorAction: TerminalEditorAction = .cursor,
        terminalEditorCommand: String = "",
        terminalCloudCustomScript: String = "",
        conversationSummarySource: ConversationSummarySource = .off,
        conversationSummaryCommand: String = ""
    ) {
        let trimmed = starterCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        self.starterCommand = trimmed
        self.starterCommandPreferenceConfirmed = starterCommandPreferenceConfirmed
        self.playIdleChime = playIdleChime
        self.notifyOnIdle = notifyOnIdle
        let sanitizedCommands = sanitizeCommandsByPath(terminalCommandsByPath)
        self.terminalCommandsByPath = sanitizedCommands
        self.paneCommandSelections = paneCommandSelections
        let sanitizedLinks = sanitizeLinksByPath(terminalLinksByPath)
        self.terminalLinksByPath = sanitizedLinks
        self.paneLinkSelections = paneLinkSelections
        self.terminalCloudAction = terminalCloudAction
        self.terminalEditorAction = terminalEditorAction
        self.terminalEditorCommand = terminalEditorCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalisedScript = terminalCloudCustomScript.replacingOccurrences(of: "\r\n", with: "\n")
        self.terminalCloudCustomScript = normalisedScript
        self.conversationSummarySource = conversationSummarySource
        self.conversationSummaryCommand = conversationSummaryCommand.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private enum CodingKeys: String, CodingKey {
        case starterCommand
        case starterCommandPreferenceConfirmed
        case playIdleChime
        case notifyOnIdle
        case terminalCommandsByPath
        case terminalCommands
        case paneCommandSelections
        case terminalLinksByPath
        case paneLinkSelections
        case terminalCloudAction
        case terminalEditorAction
        case terminalEditorCommand
        case terminalCloudCustomScript
        case conversationSummarySource
        case conversationSummaryCommand
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawStarter = try container.decodeIfPresent(String.self, forKey: .starterCommand) ?? "codex"
        let resolvedStarter = rawStarter.trimmingCharacters(in: .whitespacesAndNewlines)
        let confirmed = try container.decodeIfPresent(Bool.self, forKey: .starterCommandPreferenceConfirmed) ?? true
        let resolvedChime = try container.decodeIfPresent(Bool.self, forKey: .playIdleChime) ?? true
        let resolvedNotify = try container.decodeIfPresent(Bool.self, forKey: .notifyOnIdle) ?? false
        var commandsByPath: [String: [String]] = [:]
        if let decodedMap = try container.decodeIfPresent([String: [String]].self, forKey: .terminalCommandsByPath) {
            commandsByPath = sanitizeCommandsByPath(decodedMap)
        } else if let decodedLegacyMap = try? container.decodeIfPresent([String: [String]].self, forKey: .terminalCommands) {
            commandsByPath = sanitizeCommandsByPath(decodedLegacyMap)
        } else {
            let decodedLegacyCommands = try container.decodeIfPresent([String].self, forKey: .terminalCommands) ?? []
            let sanitizedLegacy = sanitizeCommands(decodedLegacyCommands)
            if !sanitizedLegacy.isEmpty {
                commandsByPath[""] = sanitizedLegacy
            }
        }
        var linksByPath: [String: [String]] = [:]
        if let decodedLinks = try container.decodeIfPresent([String: [String]].self, forKey: .terminalLinksByPath) {
            linksByPath = sanitizeLinksByPath(decodedLinks)
        }
        let decodedSelections = try container.decodeIfPresent([String: String].self, forKey: .paneCommandSelections) ?? [:]
        var selections: [UUID: String] = [:]
        decodedSelections.forEach { key, value in
            if let uuid = UUID(uuidString: key) {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    selections[uuid] = trimmed
                }
            }
        }
        let decodedLinkSelections = try container.decodeIfPresent([String: String].self, forKey: .paneLinkSelections) ?? [:]
        var linkSelections: [UUID: String] = [:]
        decodedLinkSelections.forEach { key, value in
            if let uuid = UUID(uuidString: key) {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    linkSelections[uuid] = trimmed
                }
            }
        }
        let rawCloudAction = try container.decodeIfPresent(String.self, forKey: .terminalCloudAction)
        let resolvedCloudAction = rawCloudAction.flatMap(TerminalCloudAction.init(rawValue:)) ?? .sync
        let rawEditorAction = try container.decodeIfPresent(String.self, forKey: .terminalEditorAction)
        let resolvedEditorAction = rawEditorAction.flatMap(TerminalEditorAction.init(rawValue:)) ?? .cursor
        let editorCommand = try container.decodeIfPresent(String.self, forKey: .terminalEditorCommand) ?? ""
        let customScript = try container.decodeIfPresent(String.self, forKey: .terminalCloudCustomScript) ?? ""
        let rawConversationSummarySource = try container.decodeIfPresent(String.self, forKey: .conversationSummarySource)
        let resolvedConversationSummarySource = rawConversationSummarySource
            .flatMap(ConversationSummarySource.init(rawValue:)) ?? .off
        let conversationSummaryCommand = try container.decodeIfPresent(String.self, forKey: .conversationSummaryCommand) ?? ""
        self.init(
            starterCommand: resolvedStarter,
            starterCommandPreferenceConfirmed: confirmed,
            playIdleChime: resolvedChime,
            notifyOnIdle: resolvedNotify,
            terminalCommandsByPath: commandsByPath,
            paneCommandSelections: selections,
            terminalLinksByPath: linksByPath,
            paneLinkSelections: linkSelections,
            terminalCloudAction: resolvedCloudAction,
            terminalEditorAction: resolvedEditorAction,
            terminalEditorCommand: editorCommand,
            terminalCloudCustomScript: customScript,
            conversationSummarySource: resolvedConversationSummarySource,
            conversationSummaryCommand: conversationSummaryCommand
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(starterCommand, forKey: .starterCommand)
        try container.encode(starterCommandPreferenceConfirmed, forKey: .starterCommandPreferenceConfirmed)
        try container.encode(playIdleChime, forKey: .playIdleChime)
        try container.encode(notifyOnIdle, forKey: .notifyOnIdle)
        try container.encode(terminalCommandsByPath, forKey: .terminalCommandsByPath)
        let encodedSelections = Dictionary(uniqueKeysWithValues: paneCommandSelections.map { ($0.key.uuidString, $0.value) })
        try container.encode(encodedSelections, forKey: .paneCommandSelections)
        try container.encode(terminalLinksByPath, forKey: .terminalLinksByPath)
        let encodedLinkSelections = Dictionary(uniqueKeysWithValues: paneLinkSelections.map { ($0.key.uuidString, $0.value) })
        try container.encode(encodedLinkSelections, forKey: .paneLinkSelections)
        try container.encode(terminalCloudAction.rawValue, forKey: .terminalCloudAction)
        try container.encode(terminalEditorAction.rawValue, forKey: .terminalEditorAction)
        try container.encode(terminalEditorCommand, forKey: .terminalEditorCommand)
        try container.encode(terminalCloudCustomScript, forKey: .terminalCloudCustomScript)
        try container.encode(conversationSummarySource.rawValue, forKey: .conversationSummarySource)
        try container.encode(conversationSummaryCommand, forKey: .conversationSummaryCommand)
    }

    func updating(
        starterCommand: String? = nil,
        starterCommandPreferenceConfirmed: Bool? = nil,
        playIdleChime: Bool? = nil,
        notifyOnIdle: Bool? = nil,
        terminalCommandsByPath: [String: [String]]? = nil,
        paneCommandSelections: [UUID: String]? = nil,
        terminalLinksByPath: [String: [String]]? = nil,
        paneLinkSelections: [UUID: String]? = nil,
        terminalCloudAction: TerminalCloudAction? = nil,
        terminalEditorAction: TerminalEditorAction? = nil,
        terminalEditorCommand: String? = nil,
        terminalCloudCustomScript: String? = nil,
        conversationSummarySource: ConversationSummarySource? = nil,
        conversationSummaryCommand: String? = nil
    ) -> AppSettings {
        AppSettings(
            starterCommand: starterCommand ?? self.starterCommand,
            starterCommandPreferenceConfirmed: starterCommandPreferenceConfirmed ?? self.starterCommandPreferenceConfirmed,
            playIdleChime: playIdleChime ?? self.playIdleChime,
            notifyOnIdle: notifyOnIdle ?? self.notifyOnIdle,
            terminalCommandsByPath: terminalCommandsByPath ?? self.terminalCommandsByPath,
            paneCommandSelections: paneCommandSelections ?? self.paneCommandSelections,
            terminalLinksByPath: terminalLinksByPath ?? self.terminalLinksByPath,
            paneLinkSelections: paneLinkSelections ?? self.paneLinkSelections,
            terminalCloudAction: terminalCloudAction ?? self.terminalCloudAction,
            terminalEditorAction: terminalEditorAction ?? self.terminalEditorAction,
            terminalEditorCommand: terminalEditorCommand ?? self.terminalEditorCommand,
            terminalCloudCustomScript: terminalCloudCustomScript ?? self.terminalCloudCustomScript,
            conversationSummarySource: conversationSummarySource ?? self.conversationSummarySource,
            conversationSummaryCommand: conversationSummaryCommand ?? self.conversationSummaryCommand
        )
    }
}

struct AppConfiguration: Codable, Hashable {
    var settings: AppSettings
    var tabs: [StoredTab]

    init(
        settings: AppSettings = AppSettings(),
        tabs: [StoredTab]
    ) {
        self.settings = settings
        self.tabs = tabs
    }

    private enum CodingKeys: String, CodingKey {
        case settings
        case tabs
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedTabs = try container.decode([StoredTab].self, forKey: .tabs)
        let decodedSettings = try container.decodeIfPresent(AppSettings.self, forKey: .settings) ?? AppSettings()
        self.init(settings: decodedSettings, tabs: decodedTabs)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(settings, forKey: .settings)
        try container.encode(tabs, forKey: .tabs)
    }
}

final class ConfigurationStore {
    static let terminalCommandDefaultsMigrationKey = "codigo.editor.migrations.clearedDefaultTerminalCommands"
    private static let legacyTerminalCommandDefaults: Set<String> = [
        "codigo run",
        "codigo test"
    ]

    private let fileURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let fileManager: FileManager
    private let userDefaults: UserDefaults

    init(fileURL: URL? = nil, fileManager: FileManager = .default, userDefaults: UserDefaults = .standard) {
        self.fileManager = fileManager
        self.userDefaults = userDefaults
        self.encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        self.decoder = JSONDecoder()

        if let explicitURL = fileURL {
            self.fileURL = explicitURL
        } else {
            let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            let directory = base?.appendingPathComponent("CodigoEditor", isDirectory: true)
            let fallback = fileManager.homeDirectoryForCurrentUser.appendingPathComponent(".codigo-editor", isDirectory: true)
            if let directory {
                self.fileURL = directory.appendingPathComponent("config.json", isDirectory: false)
            } else {
                self.fileURL = fallback.appendingPathComponent("config.json", isDirectory: false)
            }
        }
    }

    func loadOrCreateConfiguration() -> AppConfiguration {
        ensureDirectoryExists()

        if let data = try? Data(contentsOf: fileURL),
           let decoded = try? decoder.decode(AppConfiguration.self, from: data) {
            var configuration = decoded
            let migration = migrateLegacyTerminalCommands(in: configuration)
            if migration.didMigrate {
                configuration = migration.configuration
            }
            if migration.didMigrate {
                do {
                    try saveConfiguration(configuration)
                    userDefaults.set(true, forKey: Self.terminalCommandDefaultsMigrationKey)
                } catch {
                    print("Failed to persist migrated configuration:", error)
                }
            }
            return configuration
        }

        let defaultConfiguration = makeDefaultConfiguration()
        do {
            try saveConfiguration(defaultConfiguration)
        } catch {
            print("Failed to persist default configuration:", error)
        }
        return defaultConfiguration
    }

    func saveConfiguration(_ configuration: AppConfiguration) throws {
        ensureDirectoryExists()
        let data = try encoder.encode(configuration)
        try data.write(to: fileURL, options: [.atomic])
    }

    func makeDefaultTab(title: String, workingDirectory: String? = nil, starterCommand: String) -> StoredTab {
        let trimmed = workingDirectory?.trimmingCharacters(in: .whitespacesAndNewlines)
        var resolvedDirectory: String
        if let trimmed, !trimmed.isEmpty {
            let sanitized = PathSanitizer.sanitize(trimmed)
            if sanitized.isEmpty {
                resolvedDirectory = fileManager.homeDirectoryForCurrentUser.path
            } else {
                resolvedDirectory = URL(fileURLWithPath: sanitized).standardizedFileURL.path
            }
        } else {
            resolvedDirectory = fileManager.homeDirectoryForCurrentUser.path
        }

        var isDirectory: ObjCBool = false
        if !fileManager.fileExists(atPath: resolvedDirectory, isDirectory: &isDirectory) || !isDirectory.boolValue {
            resolvedDirectory = fileManager.homeDirectoryForCurrentUser.path
        }

        let baseComponent = URL(fileURLWithPath: resolvedDirectory).lastPathComponent

        var panes: [StoredPane] = []

        let primaryTitle: String
        if baseComponent.isEmpty {
            primaryTitle = "Terminal 1"
        } else {
            primaryTitle = baseComponent
        }

        let trimmedStarter = starterCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        let defaultStartupCommand = trimmedStarter.isEmpty ? nil : trimmedStarter

        let primaryPane = StoredPane(
            id: UUID(),
            title: primaryTitle,
            workingDirectory: resolvedDirectory,
            startupCommand: defaultStartupCommand,
            kind: PaneKind.inferred(from: defaultStartupCommand),
            column: .primary
        )
        panes.append(primaryPane)

        let subdirectories = repositorySubdirectories(of: resolvedDirectory)
        for (offset, directoryURL) in subdirectories.enumerated() {
            let standardised = directoryURL.standardizedFileURL.path
            let component = directoryURL.lastPathComponent
            let paneTitle = component.isEmpty ? "Terminal \(offset + 2)" : component
            panes.append(
                StoredPane(
                    id: UUID(),
                    title: paneTitle,
                    workingDirectory: standardised,
                    startupCommand: nil,
                    kind: .shell,
                    column: .stacked
                )
            )
        }

        let previewTab = StoredPreviewTab(id: UUID(), title: "Preview 1", url: "")
        return StoredTab(
            id: UUID(),
            title: title,
            panes: panes,
            previewURL: nil,
            previewTabs: [previewTab],
            activePreviewTabId: previewTab.id
        )
    }

    private func repositorySubdirectories(of path: String) -> [URL] {
        let directoryURL = URL(fileURLWithPath: path, isDirectory: true)
        let resourceKeys: Set<URLResourceKey> = [.isDirectoryKey, .isRegularFileKey]
        let options: FileManager.DirectoryEnumerationOptions = [.skipsHiddenFiles]
        do {
            let contents = try fileManager.contentsOfDirectory(at: directoryURL, includingPropertiesForKeys: Array(resourceKeys), options: options)
            let directories = contents.compactMap { url -> URL? in
                do {
                    let values = try url.resourceValues(forKeys: resourceKeys)
                    if values.isDirectory == true {
                        var isGitDirectory: ObjCBool = false
                        let gitURL = url.appendingPathComponent(".git", isDirectory: true)
                        if fileManager.fileExists(atPath: gitURL.path, isDirectory: &isGitDirectory), isGitDirectory.boolValue {
                            return url
                        }
                    }
                } catch {
                    print("Failed to inspect directory entry", url.path, "error:", error)
                }
                return nil
            }
            return directories.sorted { lhs, rhs in
                lhs.lastPathComponent.localizedCaseInsensitiveCompare(rhs.lastPathComponent) == .orderedAscending
            }
        } catch {
            print("Failed to enumerate subdirectories for", path, "error:", error)
            return []
        }
    }

    func configurationFileLocation() -> URL {
        fileURL
    }

    func configurationJSONString() -> String {
        ensureDirectoryExists()
        if let data = try? Data(contentsOf: fileURL),
           let string = String(data: data, encoding: .utf8),
           !string.isEmpty {
            return string
        }

        let configuration = makeDefaultConfiguration()
        if let data = try? encoder.encode(configuration),
           let string = String(data: data, encoding: .utf8) {
            return string
        }

        return "{}"
    }

    func validateConfigurationJSON(_ data: Data) throws -> AppConfiguration {
        try decoder.decode(AppConfiguration.self, from: data)
    }

    func replaceConfiguration(with configuration: AppConfiguration) throws {
        try saveConfiguration(configuration)
    }

    private func migrateLegacyTerminalCommands(in configuration: AppConfiguration) -> (configuration: AppConfiguration, didMigrate: Bool) {
        guard !userDefaults.bool(forKey: Self.terminalCommandDefaultsMigrationKey) else {
            return (configuration, false)
        }

        let flattenedCommands = configuration.settings.terminalCommandsByPath.values.flatMap { $0 }
        let normalized = flattenedCommands
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

        guard normalized.count == Self.legacyTerminalCommandDefaults.count else {
            return (configuration, false)
        }

        let normalizedSet = Set(normalized)
        guard normalizedSet == Self.legacyTerminalCommandDefaults else {
            return (configuration, false)
        }

        var updated = configuration
        let sanitizedSettings = configuration.settings.updating(
            terminalCommandsByPath: [:],
            paneCommandSelections: [:]
        )
        updated.settings = sanitizedSettings
        return (updated, true)
    }

    private func makeDefaultConfiguration() -> AppConfiguration {
        let defaultSettings = AppSettings()
        return AppConfiguration(settings: defaultSettings, tabs: [])
    }

    private func ensureDirectoryExists() {
        let directoryURL = fileURL.deletingLastPathComponent()
        if !fileManager.fileExists(atPath: directoryURL.path) {
            do {
                try fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
            } catch {
                print("Failed to create configuration directory:", error)
            }
        }
    }
}
