import Foundation
import XCTest
@testable import codigo_editor

final class ConfigurationStoreTests: XCTestCase {
    private var temporaryDirectory: URL!
    private var configurationURL: URL!
    private var userDefaults: UserDefaults!
    private var defaultsSuiteName: String!
    private let fileManager = FileManager.default

    override func setUpWithError() throws {
        try super.setUpWithError()

        let baseDirectory = fileManager.temporaryDirectory
        let directory = baseDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        temporaryDirectory = directory
        configurationURL = directory.appendingPathComponent("config.json")

        let suiteName = "ConfigurationStoreTests." + UUID().uuidString
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            XCTFail("Failed to create user defaults suite")
            throw NSError(domain: "ConfigurationStoreTests", code: 1)
        }
        defaultsSuiteName = suiteName
        defaults.removePersistentDomain(forName: suiteName)
        userDefaults = defaults
    }

    override func tearDownWithError() throws {
        if let suiteName = defaultsSuiteName {
            userDefaults?.removePersistentDomain(forName: suiteName)
        }
        userDefaults = nil
        defaultsSuiteName = nil

        if let directory = temporaryDirectory {
            try? fileManager.removeItem(at: directory)
        }
        temporaryDirectory = nil
        configurationURL = nil

        try super.tearDownWithError()
    }

    func testDefaultConfigurationHasEmptyTerminalCommands() {
        let store = ConfigurationStore(
            fileURL: configurationURL,
            fileManager: fileManager,
            userDefaults: userDefaults
        )

        let configuration = store.loadOrCreateConfiguration()
        XCTAssertTrue(configuration.settings.terminalCommandsByPath.isEmpty)
        XCTAssertEqual(configuration.settings.conversationSummarySource, .off)
        XCTAssertEqual(configuration.settings.conversationSummaryCommand, "")
        XCTAssertTrue(configuration.tabs.isEmpty)
    }

    func testDefaultConfigurationMarksStarterPreferenceUnconfirmed() {
        let store = ConfigurationStore(
            fileURL: configurationURL,
            fileManager: fileManager,
            userDefaults: userDefaults
        )

        let configuration = store.loadOrCreateConfiguration()
        XCTAssertFalse(configuration.settings.starterCommandPreferenceConfirmed)
    }

    func testMigratesLegacyTerminalCommandDefaults() throws {
        let store = ConfigurationStore(
            fileURL: configurationURL,
            fileManager: fileManager,
            userDefaults: userDefaults
        )

        let legacySettings = AppSettings(
            starterCommand: "codigo",
            starterCommandPreferenceConfirmed: true,
            playIdleChime: true,
            notifyOnIdle: false,
            terminalCommandsByPath: ["": ["codigo run", "codigo test"]],
            paneCommandSelections: [:],
            terminalCloudAction: .sync,
            terminalEditorAction: .cursor,
            terminalEditorCommand: "",
            terminalCloudCustomScript: ""
        )
        let legacyConfiguration = AppConfiguration(
            settings: legacySettings,
            tabs: []
        )

        try store.saveConfiguration(legacyConfiguration)

        let migrated = store.loadOrCreateConfiguration()
        XCTAssertTrue(migrated.settings.terminalCommandsByPath.isEmpty)
        XCTAssertTrue(migrated.settings.paneCommandSelections.isEmpty)

        XCTAssertTrue(
            userDefaults.bool(forKey: ConfigurationStore.terminalCommandDefaultsMigrationKey)
        )

        let reloaded = store.loadOrCreateConfiguration()
        XCTAssertTrue(reloaded.settings.terminalCommandsByPath.isEmpty)
    }

    func testLoadingLegacyConfigurationDefaultsStarterPreferenceToConfirmed() throws {
        let store = ConfigurationStore(
            fileURL: configurationURL,
            fileManager: fileManager,
            userDefaults: userDefaults
        )

        let legacySettings: [String: Any] = [
            "starterCommand": "codex",
            "playIdleChime": true,
            "notifyOnIdle": false,
            "terminalCommands": [],
            "paneCommandSelections": [:],
            "terminalCloudAction": "sync",
            "terminalEditorAction": "cursor",
            "terminalEditorCommand": "",
            "terminalCloudCustomScript": ""
        ]
        let payload: [String: Any] = [
            "settings": legacySettings,
            "tabs": []
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted])
        try data.write(to: configurationURL)

        let configuration = store.loadOrCreateConfiguration()
        XCTAssertTrue(configuration.settings.starterCommandPreferenceConfirmed)
    }

    func testPersistsConversationSummarySettingsAndPaneSummaries() throws {
        let store = ConfigurationStore(
            fileURL: configurationURL,
            fileManager: fileManager,
            userDefaults: userDefaults
        )

        let settings = AppSettings(
            conversationSummarySource: .localCommand,
            conversationSummaryCommand: "ollama run qwen2.5:3b-instruct"
        )
        let pane = StoredPane(
            id: UUID(),
            title: "Terminal 1",
            workingDirectory: "/tmp/project",
            startupCommand: "codex",
            kind: .codex,
            conversationSummary: "Fix preview auth redirect",
            column: .primary
        )
        let configuration = AppConfiguration(
            settings: settings,
            tabs: [
                StoredTab(
                    id: UUID(),
                    title: "Tab 1",
                    panes: [pane],
                    previewURL: nil,
                    previewTabs: nil,
                    activePreviewTabId: nil
                )
            ]
        )

        try store.saveConfiguration(configuration)

        let loaded = store.loadOrCreateConfiguration()
        XCTAssertEqual(loaded.settings.conversationSummarySource, .localCommand)
        XCTAssertEqual(loaded.settings.conversationSummaryCommand, "ollama run qwen2.5:3b-instruct")
        XCTAssertEqual(loaded.tabs.first?.panes.first?.kind, .codex)
        XCTAssertEqual(loaded.tabs.first?.panes.first?.conversationSummary, "Fix preview auth redirect")
    }

    func testStoredPaneInfersKindFromLegacyStartupCommand() throws {
        let payload: [String: Any] = [
            "id": UUID().uuidString,
            "title": "Terminal 1",
            "workingDirectory": "/tmp/project",
            "startupCommand": "env FOO=bar codex",
            "column": "primary",
        ]

        let data = try JSONSerialization.data(withJSONObject: payload, options: [])
        let pane = try JSONDecoder().decode(StoredPane.self, from: data)

        XCTAssertEqual(pane.kind, .codex)
    }

}
