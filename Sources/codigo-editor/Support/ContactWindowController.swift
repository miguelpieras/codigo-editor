import AppKit
import SwiftUI

final class ContactWindowController: NSWindowController {
    init() {
        let viewController = NSHostingController(rootView: ContactInfoView())
        let window = NSWindow(contentViewController: viewController)
        window.title = "Contact"
        window.styleMask = [.titled, .closable]
        window.center()
        window.isReleasedWhenClosed = false
        super.init(window: window)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func present() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
