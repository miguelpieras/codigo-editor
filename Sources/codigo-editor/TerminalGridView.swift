import SwiftUI
import WebKit

struct TerminalGridView: NSViewRepresentable {
    typealias Coordinator = TerminalCoordinator

    let configuration: AppConfiguration
    let configurationStore: ConfigurationStore
    let onCoordinatorReady: (TerminalCoordinator) -> Void

    private var webInspectorEnabled: Bool {
#if DEBUG
        true
#else
        ProcessInfo.processInfo.environment["CODIGO_ENABLE_WEB_INSPECTOR"] == "1"
#endif
    }

    init(
        configuration: AppConfiguration,
        configurationStore: ConfigurationStore,
        onCoordinatorReady: @escaping (TerminalCoordinator) -> Void = { _ in }
    ) {
        self.configuration = configuration
        self.configurationStore = configurationStore
        self.onCoordinatorReady = onCoordinatorReady
    }

    func makeCoordinator() -> TerminalCoordinator {
        let coordinator = TerminalCoordinator(configuration: configuration, store: configurationStore)
        onCoordinatorReady(coordinator)
        return coordinator
    }

    func makeNSView(context: Context) -> NSView {
        let container = NSView()

        let configuration = WKWebViewConfiguration()
        if webInspectorEnabled {
            configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        }
        TerminalCoordinator.ScriptMessageName.allCases.forEach { name in
            configuration.userContentController.add(context.coordinator, name: name.rawValue)
        }

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView

        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])

        let previewConfiguration = WKWebViewConfiguration()
        if webInspectorEnabled {
            previewConfiguration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        }
        previewConfiguration.setURLSchemeHandler(context.coordinator.previewProxyHandler, forURLScheme: PreviewProxy.proxyScheme)
        PreviewProxy.userScripts().forEach { script in
            previewConfiguration.userContentController.addUserScript(script)
        }
        let previewWebView = WKWebView(frame: .zero, configuration: previewConfiguration)
        previewWebView.translatesAutoresizingMaskIntoConstraints = false
        previewWebView.navigationDelegate = context.coordinator
        previewWebView.isHidden = true
        previewWebView.allowsBackForwardNavigationGestures = true
        previewWebView.wantsLayer = true
        previewWebView.layer?.cornerRadius = 10
        previewWebView.layer?.masksToBounds = true

        container.addSubview(previewWebView)

        let previewLeading = previewWebView.leadingAnchor.constraint(equalTo: container.leadingAnchor)
        let previewTop = previewWebView.topAnchor.constraint(equalTo: container.topAnchor)
        let previewWidth = previewWebView.widthAnchor.constraint(equalToConstant: 0)
        let previewHeight = previewWebView.heightAnchor.constraint(equalToConstant: 0)

        NSLayoutConstraint.activate([
            previewLeading,
            previewTop,
            previewWidth,
            previewHeight,
        ])

        context.coordinator.containerView = container
        context.coordinator.previewWebView = previewWebView
        context.coordinator.previewLeadingConstraint = previewLeading
        context.coordinator.previewTopConstraint = previewTop
        context.coordinator.previewWidthConstraint = previewWidth
        context.coordinator.previewHeightConstraint = previewHeight

        if let url = TerminalWebResources.indexHTML() {
            let directoryURL = url.deletingLastPathComponent()
            webView.loadFileURL(url, allowingReadAccessTo: directoryURL)
        } else {
            assertionFailure("Unable to locate bundled web resources")
        }

        return container
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

private enum TerminalWebResources {
    static func indexHTML() -> URL? {
#if SWIFT_PACKAGE
        return Bundle.module.url(forResource: "index", withExtension: "html")
#else
        return resolveResourceURL(named: "index", fileExtension: "html")
#endif
    }

#if !SWIFT_PACKAGE
    private static func resolveResourceURL(named name: String, fileExtension: String) -> URL? {
        if let directURL = Bundle.main.url(forResource: name, withExtension: fileExtension) {
            return directURL
        }

        if let packagedBundleURL = Bundle.main.url(forResource: "codigo-editor_codigo-editor", withExtension: "bundle"),
           let packagedBundle = Bundle(url: packagedBundleURL),
           let packagedResourceURL = packagedBundle.url(forResource: name, withExtension: fileExtension) {
            return packagedResourceURL
        }

        let candidateBundles = (Bundle.main.urls(forResourcesWithExtension: "bundle", subdirectory: nil) ?? [])

        for bundleURL in candidateBundles {
            guard let bundle = Bundle(url: bundleURL) else {
                continue
            }

            if let resourceURL = bundle.url(forResource: name, withExtension: fileExtension) {
                return resourceURL
            }
        }

        return nil
    }
#endif
}
