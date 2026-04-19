import AppKit
import CoreGraphics
import SwiftUI
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let appDisplayName = "Codigo Editor"
    private var window: NSWindow?
    private let configurationStore = ConfigurationStore()
    private var settingsWindowController: SettingsWindowController?
    private lazy var aboutWindowController = AboutWindowController(
        applicationName: appDisplayName,
        contactChannels: contactChannels,
        closingNote: aboutClosingNote
    )
    private weak var terminalCoordinator: TerminalCoordinator?
    private var githubMenuItem: NSMenuItem?
    private var githubSignInItem: NSMenuItem?
    private var githubRefreshStatusItem: NSMenuItem?
    private var githubCloudSyncItem: NSMenuItem?
    private var githubCloudPullRequestItem: NSMenuItem?
    private var githubStatusObserver: NSObjectProtocol?
    private var githubActionObserver: NSObjectProtocol?
    private let contactChannels: [AboutContactChannel] = []
    private let aboutClosingNote = "Community links and contribution guidelines should be published with the repository."

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureApplicationIdentity()
        installMenus()
        configureNotificationCenterIfAvailable()
        presentMainInterfaceIfNeeded()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        closeAuxiliaryWindows()
        terminalCoordinator?.terminateAllSessions()
        if let token = githubStatusObserver {
            NotificationCenter.default.removeObserver(token)
            githubStatusObserver = nil
        }
        if let token = githubActionObserver {
            NotificationCenter.default.removeObserver(token)
            githubActionObserver = nil
        }
    }

    private func closeAuxiliaryWindows() {
        settingsWindowController?.close()
    }

    @MainActor
    private func configureNotificationCenterIfAvailable() {
        guard Bundle.main.bundleIdentifier != nil else {
            return
        }
        UNUserNotificationCenter.current().delegate = self
    }

    @MainActor
    private func installMenus() {
        let mainMenu = NSMenu(title: "MainMenu")

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appName = appDisplayName
        let appMenu = NSMenu(title: appName)
        let aboutItem = appMenu.addItem(withTitle: "About \(appName)", action: #selector(openAbout(_:)), keyEquivalent: "")
        aboutItem.target = self
        appMenu.addItem(NSMenuItem.separator())
        let settingsItem = appMenu.addItem(withTitle: "Settings…", action: #selector(openSettings(_:)), keyEquivalent: ",")
        settingsItem.target = self
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        let undo = editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        undo.target = nil
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        redo.target = nil
        editMenu.addItem(NSMenuItem.separator())
        let cut = editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        cut.target = nil
        let copy = editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        copy.target = nil
        let paste = editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        paste.target = nil
        let selectAll = editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        selectAll.target = nil
        editItem.submenu = editMenu

        let terminalItem = NSMenuItem()
        mainMenu.addItem(terminalItem)
        let terminalMenu = NSMenu(title: "Terminal")
        let interrupt = terminalMenu.addItem(withTitle: "Send Interrupt", action: #selector(sendInterrupt(_:)), keyEquivalent: "")
        interrupt.target = self
        let suspend = terminalMenu.addItem(withTitle: "Send Stop", action: #selector(sendSuspend(_:)), keyEquivalent: "")
        suspend.target = self
        let quit = terminalMenu.addItem(withTitle: "Send Quit", action: #selector(sendQuit(_:)), keyEquivalent: "")
        quit.target = self
        terminalItem.submenu = terminalMenu

        let githubItem = NSMenuItem()
        mainMenu.addItem(githubItem)
        let githubMenu = NSMenu(title: "GitHub")
        githubMenu.autoenablesItems = false

        let signInItem = NSMenuItem(title: "Sign In to GitHub…", action: #selector(promptGitHubSignIn(_:)), keyEquivalent: "")
        signInItem.target = self
        githubMenu.addItem(signInItem)

        let refreshItem = NSMenuItem(title: "Refresh GitHub Status", action: #selector(refreshGitHubStatus(_:)), keyEquivalent: "")
        refreshItem.target = self
        githubMenu.addItem(refreshItem)

        githubMenu.addItem(NSMenuItem.separator())

        let syncItem = NSMenuItem(title: "Cloud Button: Sync Changes", action: #selector(selectGitHubCloudSync(_:)), keyEquivalent: "")
        syncItem.target = self
        githubMenu.addItem(syncItem)

        let pullRequestItem = NSMenuItem(title: "Cloud Button: Create Pull Request", action: #selector(selectGitHubCloudPullRequest(_:)), keyEquivalent: "")
        pullRequestItem.target = self
        githubMenu.addItem(pullRequestItem)

        githubItem.submenu = githubMenu

        githubMenuItem = githubItem
        githubSignInItem = signInItem
        githubRefreshStatusItem = refreshItem
        githubCloudSyncItem = syncItem
        githubCloudPullRequestItem = pullRequestItem

        NSApp.mainMenu = mainMenu

        if githubStatusObserver == nil {
            githubStatusObserver = NotificationCenter.default.addObserver(
                forName: TerminalCoordinator.githubStatusDidChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.updateGitHubMenuState()
                }
            }
        }

        if githubActionObserver == nil {
            githubActionObserver = NotificationCenter.default.addObserver(
                forName: TerminalCoordinator.githubCloudActionDidChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.updateGitHubMenuState()
                }
            }
        }

        updateGitHubMenuState()
    }

    @MainActor
    @objc private func openSettings(_ sender: Any?) {
        if settingsWindowController == nil {
            settingsWindowController = SettingsWindowController(
                configurationStore: configurationStore,
                coordinatorProvider: { [weak self] in
                    self?.terminalCoordinator
                }
            )
        }
        settingsWindowController?.showWindow(nil)
        settingsWindowController?.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @MainActor
    @objc private func openAbout(_ sender: Any?) {
        aboutWindowController.present()
    }

    @MainActor
    @objc private func sendInterrupt(_ sender: Any?) {
        terminalCoordinator?.sendControlCharacter(.interrupt)
    }

    @MainActor
    @objc private func sendSuspend(_ sender: Any?) {
        terminalCoordinator?.sendControlCharacter(.suspend)
    }

    @MainActor
    @objc private func sendQuit(_ sender: Any?) {
        terminalCoordinator?.sendControlCharacter(.quit)
    }

    @MainActor
    private func updateGitHubMenuState() {
        let coordinator = terminalCoordinator
        let isCoordinatorAvailable = coordinator != nil
        let connected = coordinator?.githubAccountConnected ?? false
        let action = coordinator?.appSettings.terminalCloudAction ?? .sync

        let signInTitle = connected ? "Manage GitHub CLI Sign-In…" : "Sign In to GitHub…"
        githubSignInItem?.title = signInTitle
        githubSignInItem?.isEnabled = true

        githubRefreshStatusItem?.isEnabled = isCoordinatorAvailable

        githubCloudSyncItem?.isEnabled = isCoordinatorAvailable
        githubCloudSyncItem?.state = action == .sync ? .on : .off

        githubCloudPullRequestItem?.isEnabled = isCoordinatorAvailable
        githubCloudPullRequestItem?.state = action == .createPullRequest ? .on : .off
    }

    @MainActor
    @objc private func promptGitHubSignIn(_ sender: Any?) {
        let alert = NSAlert()
        alert.messageText = "Connect to GitHub"
        alert.informativeText = "Open a terminal and run `gh auth login` to sign in with the GitHub CLI. If you do not have the CLI installed, visit cli.github.com to download it."
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    @MainActor
    @objc private func refreshGitHubStatus(_ sender: Any?) {
        guard let coordinator = terminalCoordinator else {
            NSSound.beep()
            return
        }
        coordinator.refreshGitHubAuthenticationStatus()
    }

    @MainActor
    @objc private func selectGitHubCloudSync(_ sender: Any?) {
        guard let coordinator = terminalCoordinator else {
            NSSound.beep()
            return
        }
        coordinator.updateTerminalCloudAction(to: .sync)
        updateGitHubMenuState()
    }

    @MainActor
    @objc private func selectGitHubCloudPullRequest(_ sender: Any?) {
        guard let coordinator = terminalCoordinator else {
            NSSound.beep()
            return
        }
        coordinator.updateTerminalCloudAction(to: .createPullRequest)
        updateGitHubMenuState()
    }

    private func presentMainInterfaceIfNeeded() {
        guard window == nil else {
            return
        }
        let configuration = configurationStore.loadOrCreateConfiguration()
        let hosting = NSHostingController(
            rootView: TerminalContainerView(
                configuration: configuration,
                configurationStore: configurationStore,
                onCoordinatorReady: { [weak self] coordinator in
                    guard let self else { return }
                    self.terminalCoordinator = coordinator
                    coordinator.refreshGitHubAuthenticationStatus()
                    self.updateGitHubMenuState()
                }
            )
        )
        let window = NSWindow(contentViewController: hosting)
        window.delegate = self
        window.title = appDisplayName
        if let screen = NSScreen.main {
            window.setFrame(screen.visibleFrame, display: true)
        } else {
            window.setContentSize(NSSize(width: 1100, height: 700))
            window.center()
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    @MainActor
    private func configureApplicationIdentity() {
        if let appIcon = NSImage(named: "AppIcon") {
            NSApp.applicationIconImage = appIcon
        }
    }

}

extension AppDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list])
    }
}

extension AppDelegate: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        guard
            let closingWindow = notification.object as? NSWindow,
            let mainWindow = window,
            closingWindow == mainWindow
        else {
            return
        }
        closeAuxiliaryWindows()
    }
}

struct TerminalContainerView: View {
    let configuration: AppConfiguration
    let configurationStore: ConfigurationStore
    let onCoordinatorReady: (TerminalCoordinator) -> Void

    init(
        configuration: AppConfiguration,
        configurationStore: ConfigurationStore,
        onCoordinatorReady: @escaping (TerminalCoordinator) -> Void = { _ in }
    ) {
        self.configuration = configuration
        self.configurationStore = configurationStore
        self.onCoordinatorReady = onCoordinatorReady
    }

    var body: some View {
        TerminalGridView(
            configuration: configuration,
            configurationStore: configurationStore,
            onCoordinatorReady: onCoordinatorReady
        )
            .frame(minWidth: 1100, minHeight: 700)
    }
}
