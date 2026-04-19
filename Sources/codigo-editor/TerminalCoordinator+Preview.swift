import CoreGraphics
import Foundation
import WebKit

@MainActor
extension TerminalCoordinator {
    func cgValue(_ raw: Any?) -> CGFloat? {
        if let number = raw as? NSNumber {
            return CGFloat(truncating: number)
        }
        if let string = raw as? String, let value = Double(string) {
            return CGFloat(value)
        }
        return nil
    }

    func trackPreviewNavigation(_ navigation: WKNavigation?, context: PreviewContext?) {
        guard let context else {
            return
        }
        lastPreviewNavigationContext = context
        if let navigation {
            previewNavigationContexts[ObjectIdentifier(navigation)] = context
        }
    }

    func contextForCompletedPreviewNavigation(_ navigation: WKNavigation?) -> PreviewContext? {
        if let navigation {
            let identifier = ObjectIdentifier(navigation)
            if let context = previewNavigationContexts.removeValue(forKey: identifier) {
                lastPreviewNavigationContext = context
                return context
            }
        }
        return lastPreviewNavigationContext ?? currentPreviewContext
    }

    func discardPreviewNavigationContext(for navigation: WKNavigation?) {
        guard let navigation else {
            return
        }
        previewNavigationContexts.removeValue(forKey: ObjectIdentifier(navigation))
    }

    func updatePreviewFrame(left: CGFloat, top: CGFloat, width: CGFloat, height: CGFloat) {
        previewLeadingConstraint?.constant = left
        previewTopConstraint?.constant = top
        previewWidthConstraint?.constant = max(0, width)
        previewHeightConstraint?.constant = max(0, height)
        containerView?.layoutSubtreeIfNeeded()
        updatePreviewHiddenState()
    }

    func updatePreviewHiddenState() {
        guard let previewWebView else {
            return
        }
        let width = previewWidthConstraint?.constant ?? 0
        let height = previewHeightConstraint?.constant ?? 0
        let shouldShow = previewVisible && width > 1 && height > 1
        previewWebView.isHidden = !shouldShow
    }

    func loadPreview(urlString: String?, force: Bool, context: PreviewContext? = nil) {
        guard let previewWebView else {
            return
        }
        let activeContext = context ?? currentPreviewContext
        let trimmed = (urlString ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            if !lastPreviewURLString.isEmpty {
                lastPreviewURLString = ""
                let navigation = previewWebView.loadHTMLString("", baseURL: nil)
                trackPreviewNavigation(navigation, context: activeContext)
            } else {
                trackPreviewNavigation(nil, context: activeContext)
            }
            return
        }
        guard let candidateURL = URL(string: trimmed) else {
            if trimmed != lastPreviewURLString {
                lastPreviewURLString = trimmed
                let navigation = previewWebView.loadHTMLString("", baseURL: nil)
                trackPreviewNavigation(navigation, context: activeContext)
            } else {
                trackPreviewNavigation(nil, context: activeContext)
            }
            return
        }
        let destinationURL = PreviewProxy.destinationURL(for: candidateURL)
        if !force && lastPreviewURLString == destinationURL.absoluteString {
            trackPreviewNavigation(nil, context: activeContext)
            return
        }
        lastPreviewURLString = destinationURL.absoluteString
        let request = URLRequest(url: destinationURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        let navigation = previewWebView.load(request)
        trackPreviewNavigation(navigation, context: activeContext)
    }

    func refreshPreview(urlString: String?, context: PreviewContext? = nil) {
        guard let previewWebView else {
            return
        }
        let activeContext = context ?? currentPreviewContext
        let trimmed = (urlString ?? lastPreviewURLString).trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            let navigation = previewWebView.reload()
            trackPreviewNavigation(navigation, context: activeContext)
            return
        }
        guard let candidateURL = URL(string: trimmed) else {
            let navigation = previewWebView.reload()
            trackPreviewNavigation(navigation, context: activeContext)
            return
        }
        let destinationURL = PreviewProxy.destinationURL(for: candidateURL)
        if let currentURL = previewWebView.url, currentURL == destinationURL {
            let navigation = previewWebView.reload()
            trackPreviewNavigation(navigation, context: activeContext)
        } else {
            lastPreviewURLString = destinationURL.absoluteString
            let request = URLRequest(url: destinationURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
            let navigation = previewWebView.load(request)
            trackPreviewNavigation(navigation, context: activeContext)
        }
    }

    func previewState(for context: PreviewContext) -> (tab: TabState, previewTab: PreviewTabState)? {
        guard let tab = tabs.first(where: { $0.id == context.tabId }),
              let previewTab = tab.previewTabs.first(where: { $0.id == context.previewTabId }) else {
            return nil
        }
        return (tab, previewTab)
    }

    func displayURLString(from url: URL?) -> String {
        guard let url else {
            return ""
        }
        if let unproxied = PreviewProxy.unproxiedURL(from: url) {
            return unproxied.absoluteString
        }
        return url.absoluteString
    }

    func handlePreviewNavigationCompletion(webView: WKWebView, context: PreviewContext?) {
        guard let context else {
            return
        }
        let proxiedString = webView.url?.absoluteString ?? ""
        let displayString = displayURLString(from: webView.url)

        lastPreviewURLString = proxiedString

        if let (_, previewTab) = previewState(for: context) {
            if previewTab.url != displayString {
                previewTab.url = displayString
                persistConfiguration()
            }
        }

        sendPreviewNavigationState(
            urlString: displayString,
            canGoBack: webView.canGoBack,
            canGoForward: webView.canGoForward,
            context: context
        )
    }

    func sendPreviewNavigationState(urlString: String, canGoBack: Bool, canGoForward: Bool, context: PreviewContext) {
        guard let webView else {
            return
        }
        let payload = PreviewNavigationStatePayload(
            tabId: context.tabId.uuidString,
            previewTabId: context.previewTabId.uuidString,
            url: urlString,
            canGoBack: canGoBack,
            canGoForward: canGoForward
        )
        guard let json = jsonString(from: payload) else {
            return
        }
        let script = "window.updatePreviewNavigation?.(\(json));"
        webView.evaluateJavaScript(script) { [weak self] _, error in
            if let error {
                self?.previewLog.error("updatePreviewNavigation error: \(error.localizedDescription, privacy: .public)")
            }
        }
    }
}
