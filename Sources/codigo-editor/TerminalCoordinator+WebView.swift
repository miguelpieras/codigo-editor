import Foundation
import Security
import WebKit

extension TerminalCoordinator {
    enum ScriptMessageName: String, CaseIterable {
        case ready
        case uiReady
        case send
        case log
        case renameTab
        case newTab
        case closeTab
        case closePane
        case removePane
        case respawnPane
        case addPane
        case reconnectPane
        case copy
        case requestPaste
        case updatePane
        case resize
        case renamePane
        case summarizePanePrompt
        case reorderTabs
        case updateTabPreview
        case gitSync
        case gitUndo
        case gitDetails
        case openInCursor
        case openInFinder
        case previewLayout
        case previewNavigate
        case previewOpenExternal
        case previewRefresh
        case previewGoBack
        case previewSnapshot
        case previewVisibility
        case createFolder
        case tabActivity
        case focusPane
        case updateTerminalCommandList
        case updateTerminalLinkList
        case updatePaneCommandSelection
        case updatePaneLinkSelection
    }
}

@MainActor
extension TerminalCoordinator: WKScriptMessageHandler, WKNavigationDelegate {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let name = ScriptMessageName(rawValue: message.name) else {
            return
        }

        switch name {
        case .ready:
            sendBootstrapConfigurationIfNeeded()
        case .uiReady:
            handleUIReady()
        case .send:
            handleSend(body: message.body)
        case .log:
            print("JS:", message.body)
        case .renameTab:
            handleRenameTab(body: message.body)
        case .newTab:
            handleNewTabRequest()
        case .closeTab:
            handleCloseTab(body: message.body)
        case .closePane:
            handleClosePane(body: message.body)
        case .removePane:
            handleRemovePane(body: message.body)
        case .respawnPane:
            handleRespawnPane(body: message.body)
        case .addPane:
            handleAddPane(body: message.body)
        case .reconnectPane:
            handleReconnectPane(body: message.body)
        case .copy:
            handleCopy(body: message.body)
        case .requestPaste:
            handleRequestPaste(body: message.body)
        case .updatePane:
            handleUpdatePane(body: message.body)
        case .resize:
            handleResize(body: message.body)
        case .renamePane:
            handleRenamePane(body: message.body)
        case .summarizePanePrompt:
            handleSummarizePanePrompt(body: message.body)
        case .reorderTabs:
            handleReorderTabs(body: message.body)
        case .updateTabPreview:
            handleUpdateTabPreview(body: message.body)
        case .gitSync:
            handleGitSync(body: message.body)
        case .gitUndo:
            handleGitUndo(body: message.body)
        case .gitDetails:
            handleGitDetails(body: message.body)
        case .openInCursor:
            handleOpenInCursor(body: message.body)
        case .openInFinder:
            handleOpenInFinder(body: message.body)
        case .previewLayout:
            handlePreviewLayout(body: message.body)
        case .previewNavigate:
            handlePreviewNavigate(body: message.body)
        case .previewOpenExternal:
            handlePreviewOpenExternal(body: message.body)
        case .previewRefresh:
            handlePreviewRefresh(body: message.body)
        case .previewGoBack:
            handlePreviewGoBack(body: message.body)
        case .previewSnapshot:
            handlePreviewSnapshot(body: message.body)
        case .previewVisibility:
            handlePreviewVisibility(body: message.body)
        case .createFolder:
            handleCreateFolder(body: message.body)
        case .tabActivity:
            handleTabActivity(body: message.body)
        case .focusPane:
            handleFocusPane(body: message.body)
        case .updateTerminalCommandList:
            handleUpdateTerminalCommandList(body: message.body)
        case .updateTerminalLinkList:
            handleUpdateTerminalLinkList(body: message.body)
        case .updatePaneCommandSelection:
            handleUpdatePaneCommandSelection(body: message.body)
        case .updatePaneLinkSelection:
            handleUpdatePaneLinkSelection(body: message.body)
        }
    }

    func webView(
        _ webView: WKWebView,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let method = challenge.protectionSpace.authenticationMethod
        let host = challenge.protectionSpace.host
        previewLog.debug("TLS challenge host=\(host, privacy: .public) method=\(method, privacy: .public) previousFailures=\(challenge.previousFailureCount)")

        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        if SecTrustEvaluateWithError(trust, nil) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        discardPreviewNavigationContext(for: navigation)
        previewLog.error("Provisional navigation failed: \(error.localizedDescription, privacy: .public)")
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        discardPreviewNavigationContext(for: navigation)
        previewLog.error("Navigation failed: \(error.localizedDescription, privacy: .public)")
    }

    func webView(
        _ webView: WKWebView,
        didFinish navigation: WKNavigation!
    ) {
        guard let previewWebView, webView === previewWebView else {
            return
        }
        let context = contextForCompletedPreviewNavigation(navigation)
        handlePreviewNavigationCompletion(webView: previewWebView, context: context)
    }
}

@MainActor
extension TerminalCoordinator {
    func sendBootstrapConfigurationIfNeeded() {
        guard !bootstrapSent, let webView else { return }
        bootstrapSent = true

        let payload = BootstrapPayload(
            tabs: tabs.map(makeTabDescriptor(from:)),
            activeTabIndex: 0,
            settings: makeSettingsPayload()
        )

        guard let json = jsonString(from: payload) else {
            print("Failed to encode bootstrap payload")
            bootstrapSent = false
            return
        }

        let script = "window.initializeCodigoEditor(\(json));"
        webView.evaluateJavaScript(script) { [weak self] _, error in
            if let error {
                self?.bootstrapSent = false
                print("Bootstrap evaluateJavaScript error:", error)
            }
        }
    }

    func sendSettingsUpdate() {
        guard let webView else { return }
        let payload = makeSettingsPayload()
        guard let json = jsonString(from: payload) else { return }
        let script = "window.updateCodigoSettings(\(json));"
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                print("updateCodigoSettings error:", error)
            }
        }
    }

    func sendToWebView(index: Int, data: Data) {
        guard let webView else { return }
        let base64 = data.base64EncodedString()
        let script = "window.receiveData({ index: \(index), payload: \"\(base64)\" });"
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                print("evaluateJavaScript error:", error)
            }
        }
        if let pane = panesByRuntimeIndex[index] {
            pane.lastActivity = Date()
            if let bridge = pane.bridge {
                Task { await bridge.broadcast(data: data) }
            }
        }
    }

    func sendAddTab(_ tab: TabState, activeIndex: Int) {
        guard let webView else { return }
        let payload = AddTabPayload(tab: makeTabDescriptor(from: tab), activeTabIndex: activeIndex)
        guard let json = jsonString(from: payload) else { return }
        let script = "window.addCodigoTab(\(json));"
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                print("addCodigoTab error:", error)
            }
        }
    }

    func sendAddPane(pane: PaneState, tab: TabState, tabIndex: Int, position: Int) {
        guard let webView else { return }
        let descriptor = TabDescriptor.PaneDescriptor(
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
        let payload = AddPanePayload(
            tabId: tab.id.uuidString,
            tabIndex: tabIndex,
            pane: descriptor,
            position: position
        )
        guard let json = jsonString(from: payload) else { return }
        let script = "window.addCodigoPane(\(json));"
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                print("addCodigoPane error:", error)
            }
        }
    }

    func sendRemoveTab(id: UUID, index: Int, activeTabIndex: Int) {
        guard let webView else { return }
        let payload = RemoveTabPayload(id: id.uuidString, index: index, activeTabIndex: activeTabIndex)
        guard let json = jsonString(from: payload) else { return }
        let script = "window.removeCodigoTab(\(json));"
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                print("removeCodigoTab error:", error)
            }
        }
    }

    func sendRemovePane(index: Int, tab: TabState, tabIndex: Int) {
        guard let webView else { return }
        let payload = RemovePanePayload(index: index, tabId: tab.id.uuidString, tabIndex: tabIndex)
        guard let json = jsonString(from: payload) else { return }
        let script = "window.removeCodigoPane(\(json));"
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                print("removeCodigoPane error:", error)
            }
        }
    }

    func updatePaneStatus(_ pane: PaneState, status: PaneStatus) {
        pane.status = status
        guard let webView else { return }
        let payload = PaneStatusPayload(index: pane.runtimeIndex, status: status.rawValue)
        guard let json = jsonString(from: payload) else { return }
        let script = "window.updatePaneStatus(\(json));"
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                print("updatePaneStatus error:", error)
            }
        }
    }

    func sendPasteResponse(index: Int, text: String) {
        guard let webView else { return }
        let payload = PasteResponsePayload(index: index, text: text)
        guard let json = jsonString(from: payload) else { return }
        let script = "window.receivePaste(\(json));"
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                print("receivePaste error:", error)
            }
        }
    }

    func sendPaneConfigUpdate(for pane: PaneState) {
        guard let webView else { return }
        let payload = PaneConfigPayload(
            index: pane.runtimeIndex,
            title: pane.config.title,
            workingDirectory: pane.config.workingDirectory,
            startupCommand: pane.config.startupCommand ?? "",
            kind: pane.config.kind.rawValue,
            conversationSummary: pane.config.conversationSummary
        )
        guard let json = jsonString(from: payload) else { return }
        let script = "window.updatePaneConfig(\(json));"
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                print("updatePaneConfig error:", error)
            }
        }
    }

    func sendPanePromptSubmitted(index: Int) {
        guard let webView else { return }
        let payload = PanePromptSubmittedPayload(index: index)
        guard let json = jsonString(from: payload) else { return }
        let script = "window.notePanePromptSubmitted(\(json));"
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                print("notePanePromptSubmitted error:", error)
            }
        }
    }

    func requestPaneFit(at index: Int) {
        guard let webView else { return }
        let payload = PaneFitPayload(index: index)
        guard let json = jsonString(from: payload) else { return }
        let script = "window.requestPaneFit(\(json));"
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                print("requestPaneFit error:", error)
            }
        }
    }

    func applyPaneDimensions(index: Int, columns: Int, rows: Int) {
        guard let webView else { return }
        let payload = PaneDimensionsPayload(index: index, cols: columns, rows: rows)
        guard let json = jsonString(from: payload) else { return }
        let script = "window.applyPaneDimensions(\(json));"
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                print("applyPaneDimensions error:", error)
            }
        }
    }

    func applyPaneDimensions(for pane: PaneState, columns: Int, rows: Int) {
        applyPaneDimensions(index: pane.runtimeIndex, columns: columns, rows: rows)
    }
}
