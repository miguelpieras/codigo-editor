import AppKit
import SwiftUI

@MainActor
final class AboutWindowController: NSWindowController {
    private let applicationName: String
    private let contactChannels: [AboutContactChannel]
    private let closingNote: String

    init(applicationName: String, contactChannels: [AboutContactChannel], closingNote: String) {
        self.applicationName = applicationName
        self.contactChannels = contactChannels
        self.closingNote = closingNote

        let bundle = Bundle.main
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        let icon = NSApp.applicationIconImage ?? NSImage()

        let view = AboutView(
            applicationName: applicationName,
            applicationVersion: version,
            buildNumber: build,
            applicationIcon: icon,
            contactChannels: contactChannels,
            closingNote: closingNote
        )

        let hostingController = NSHostingController(rootView: view)
        let window = NSWindow(contentViewController: hostingController)
        window.styleMask = [.titled, .closable]
        window.title = "About \(applicationName)"
        let size = NSSize(width: 520, height: 420)
        window.setContentSize(size)
        window.minSize = size
        window.center()
        window.isReleasedWhenClosed = false

        super.init(window: window)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func present() {
        refreshIfNeeded()
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func refreshIfNeeded() {
        guard let hostingController = window?.contentViewController as? NSHostingController<AboutView> else {
            return
        }

        let bundle = Bundle.main
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        let icon = NSApp.applicationIconImage ?? NSImage()

        hostingController.rootView = AboutView(
            applicationName: applicationName,
            applicationVersion: version,
            buildNumber: build,
            applicationIcon: icon,
            contactChannels: contactChannels,
            closingNote: closingNote
        )
    }
}
