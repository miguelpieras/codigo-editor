import AppKit
import Foundation
import OSLog
import SwiftUI
import UserNotifications
import WebKit

@MainActor
final class TerminalCoordinator: NSObject {
    let previewLog = Logger(subsystem: "codigo-editor", category: "Preview")
    let notificationLog = Logger(subsystem: "codigo-editor", category: "Notifications")

    let previewProxyHandler = PreviewProxySchemeHandler()

    static let githubStatusDidChangeNotification = Notification.Name("TerminalCoordinatorGitHubStatusDidChange")
    static let githubCloudActionDidChangeNotification = Notification.Name("TerminalCoordinatorGitHubCloudActionDidChange")

    enum PaneStatus: String, Encodable {
        case connecting
        case connected
        case disconnected
    }

    struct BootstrapPayload: Encodable {
        let tabs: [TabDescriptor]
        let activeTabIndex: Int
        let settings: SettingsPayload
    }

    struct SettingsPayload: Encodable {
        let playIdleChime: Bool
        let notifyOnIdle: Bool
        let terminalCommandsByPath: [String: [String]]
        let paneCommandSelections: [String: String]
        let terminalLinksByPath: [String: [String]]
        let paneLinkSelections: [String: String]
        let terminalCloudAction: String
        let terminalEditorAction: String
        let terminalEditorCommand: String
        let terminalCloudCustomScript: String
        let conversationSummarySource: String
        let conversationSummaryCommand: String
        let githubAccountConnected: Bool
    }

    struct TabDescriptor: Encodable {
        struct PaneDescriptor: Encodable {
            let id: String
            let index: Int
            let title: String
            let status: String
            let workingDirectory: String
            let startupCommand: String?
            let kind: String
            let conversationSummary: String?
            let column: String
        }

        struct PreviewTabDescriptor: Encodable {
            let id: String
            let title: String
            let url: String
        }

        let id: String
        let title: String
        let panes: [PaneDescriptor]
        let previewTabs: [PreviewTabDescriptor]
        let activePreviewTabId: String?
        let previewURL: String?
    }

    struct AddTabPayload: Encodable {
        let tab: TabDescriptor
        let activeTabIndex: Int
    }

    struct PaneStatusPayload: Encodable {
        let index: Int
        let status: String
    }

    struct PasteResponsePayload: Encodable {
        let index: Int
        let text: String
    }

    struct PaneConfigPayload: Encodable {
        let index: Int
        let title: String
        let workingDirectory: String
        let startupCommand: String?
        let kind: String
        let conversationSummary: String?
    }

    struct PanePromptSubmittedPayload: Encodable {
        let index: Int
    }

    struct PaneFitPayload: Encodable {
        let index: Int
    }

    struct PaneDimensionsPayload: Encodable {
        let index: Int
        let cols: Int
        let rows: Int
    }

    struct RemoveTabPayload: Encodable {
        let id: String
        let index: Int
        let activeTabIndex: Int
    }

    struct RemovePanePayload: Encodable {
        let index: Int
        let tabId: String
        let tabIndex: Int
    }

    struct AddPanePayload: Encodable {
        let tabId: String
        let tabIndex: Int
        let pane: TabDescriptor.PaneDescriptor
        let position: Int
    }

    struct GitStatusPayload: Encodable {
        let index: Int
        let isRepository: Bool
        let insertions: Int
        let deletions: Int
        let changedFiles: Int
        let syncing: Bool
        let error: String?
    }

    struct GitFileDetailPayload: Encodable {
        let path: String
        let previousPath: String?
        let status: String
        let insertions: Int
        let deletions: Int
        let diff: String
    }

    struct GitDetailsPayload: Encodable {
        let index: Int
        let files: [GitFileDetailPayload]
        let error: String?
    }

    struct PreviewNavigationStatePayload: Encodable {
        let tabId: String
        let previewTabId: String
        let url: String
        let canGoBack: Bool
        let canGoForward: Bool
    }

    final class PaneState: @unchecked Sendable {
        let runtimeIndex: Int
        let id: UUID
        var config: TerminalConfig
        var status: PaneStatus
        var session: TerminalSession?
        var promptHookCapture: PromptHookCapture?
        var gitMonitor: GitRepositoryMonitor?
        var githubActionsMonitor: GitHubActionsMonitor?
        let column: PaneColumn
        var bridge: TerminalSessionBridge?
        var lastActivity: Date

        init(
            runtimeIndex: Int,
            id: UUID,
            config: TerminalConfig,
            column: PaneColumn,
            status: PaneStatus = .connecting
        ) {
            self.runtimeIndex = runtimeIndex
            self.id = id
            self.config = config
            self.column = column
            self.status = status
            self.lastActivity = Date()
        }
    }

    final class PreviewTabState {
        let id: UUID
        var title: String
        var url: String

        init(id: UUID, title: String, url: String) {
            self.id = id
            self.title = title
            self.url = url
        }
    }

    final class TabState {
        let id: UUID
        var title: String
        var panes: [PaneState]
        var previewTabs: [PreviewTabState]
        var activePreviewTabId: UUID?

        init(id: UUID, title: String, panes: [PaneState], previewTabs: [PreviewTabState], activePreviewTabId: UUID?) {
            self.id = id
            self.title = title
            self.panes = panes
            self.previewTabs = previewTabs
            self.activePreviewTabId = activePreviewTabId
        }
    }

    struct PreviewContext {
        let tabId: UUID
        let previewTabId: UUID
    }

    private struct TerminationObserverToken: @unchecked Sendable {
        let token: NSObjectProtocol
    }

    var tabs: [TabState]
    var appSettings: AppSettings
    let configurationStore: ConfigurationStore
    var panesByRuntimeIndex: [Int: PaneState] = [:]
    var panesByIdentifier: [UUID: PaneState] = [:]
    var bootstrapSent = false
    var sessionsStarted = false
    var nextPaneIndex: Int
    let jsonEncoder = JSONEncoder()
    var lastSelectedDirectoryURL: URL?
    weak var webView: WKWebView?
    weak var previewWebView: WKWebView?
    weak var containerView: NSView?
    var previewLeadingConstraint: NSLayoutConstraint?
    var previewTopConstraint: NSLayoutConstraint?
    var previewWidthConstraint: NSLayoutConstraint?
    var previewHeightConstraint: NSLayoutConstraint?
    var previewVisible = false
    var lastPreviewURLString: String = ""
    var currentPreviewContext: PreviewContext?
    var previewNavigationContexts: [ObjectIdentifier: PreviewContext] = [:]
    var lastPreviewNavigationContext: PreviewContext?
    private var terminationObserver: TerminationObserverToken?
    var pendingGitSnapshots: [Int: GitRepositoryMonitor.Snapshot] = [:]
    var pendingGitHubActionSnapshots: [Int: GitHubActionsMonitor.Snapshot] = [:]
    var idleNotificationTabIds: Set<UUID> = []
    var activePaneRuntimeIndex: Int?
    var pendingConversationSummaryTasks: [Int: Task<Void, Never>] = [:]
    let notificationCenter: UNUserNotificationCenter? = TerminalCoordinator.resolveNotificationCenter()
    let notificationPermissionGateway: NotificationPermissionGateway?
    var githubAccountConnected = false {
        didSet {
            guard oldValue != githubAccountConnected else {
                return
            }
            NotificationCenter.default.post(
                name: TerminalCoordinator.githubStatusDidChangeNotification,
                object: self,
                userInfo: ["connected": githubAccountConnected]
            )
            sendSettingsUpdate()
        }
    }
    init(configuration: AppConfiguration, store: ConfigurationStore) {
        self.configurationStore = store
        self.appSettings = configuration.settings.updating()
        self.tabs = []
        self.nextPaneIndex = 0
        self.notificationPermissionGateway = notificationCenter.map(NotificationPermissionGateway.init)

        super.init()
        panesByRuntimeIndex = [:]
        panesByIdentifier = [:]

        var assembledTabs: [TabState] = []
        for storedTab in configuration.tabs {
            let tabState = buildTabState(from: storedTab)
            assembledTabs.append(tabState)
        }
        tabs = assembledTabs

        applyInitialDefaultsIfNeeded()

        if let rememberedPath = tabs.last?.panes.first?.config.workingDirectory, !rememberedPath.isEmpty {
            let candidateURL = URL(fileURLWithPath: rememberedPath, isDirectory: true)
            if directoryExists(at: candidateURL) {
                lastSelectedDirectoryURL = candidateURL
            }
        }
        let token = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.terminateAllSessions()
            }
        }
        terminationObserver = TerminationObserverToken(token: token)

        refreshGitHubAuthenticationStatus()
    }

    deinit {
        if let token = terminationObserver?.token {
            NotificationCenter.default.removeObserver(token)
        }
    }
}

extension TerminalCoordinator: @unchecked Sendable {}

private extension TerminalCoordinator {
    static func resolveNotificationCenter() -> UNUserNotificationCenter? {
        guard Bundle.main.bundleIdentifier != nil else {
            return nil
        }
        return UNUserNotificationCenter.current()
    }
}

extension TerminalCoordinator {
    static var canInteractWithDock: Bool {
        guard Bundle.main.bundleURL.pathExtension == "app" else {
            return false
        }
        return NSApp.activationPolicy() == .regular
    }
}
