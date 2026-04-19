import Foundation

final class PromptHookCapture {
    private struct HookPromptRecord: Decodable {
        let prompt: String?
    }

    private struct WorkspaceHookInstallation {
        var referenceCount: Int
        let hooksURL: URL
        let configURL: URL
        let dotCodexURL: URL
        let createdDotCodexDirectory: Bool
        let originalHooksData: Data?
        let originalConfigData: Data?
    }

    private static let workspaceInstallationsLock = NSLock()
    nonisolated(unsafe) private static var workspaceInstallations: [String: WorkspaceHookInstallation] = [:]
    private static let statusMessage = "Codigo Editor prompt capture"

    let environmentOverrides: [String: String]

    private let rootURL: URL
    private let logURL: URL
    private let workspaceKey: String
    private let queue: DispatchQueue
    private let onPrompt: @Sendable (String) -> Void
    private var fileHandle: FileHandle?
    private var source: DispatchSourceFileSystemObject?
    private var readOffset: UInt64 = 0
    private var pendingBuffer = Data()
    private var isInvalidated = false

    init(
        workspaceURL: URL,
        rootURL: URL,
        logURL: URL,
        environmentOverrides: [String: String],
        onPrompt: @escaping @Sendable (String) -> Void
    ) throws {
        self.rootURL = rootURL
        self.logURL = logURL
        self.environmentOverrides = environmentOverrides
        self.workspaceKey = workspaceURL.standardizedFileURL.path
        self.queue = DispatchQueue(label: "codigo-editor.prompt-hook.\(UUID().uuidString)", qos: .utility)
        self.onPrompt = onPrompt

        try Self.acquireWorkspaceHook(for: workspaceURL)

        let handle = try FileHandle(forReadingFrom: logURL)
        self.fileHandle = handle

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: handle.fileDescriptor,
            eventMask: [.write, .extend, .delete, .rename, .revoke],
            queue: queue
        )
        source.setEventHandler { [weak self] in
            self?.handleSourceEvent()
        }
        source.setCancelHandler { [weak self] in
            try? self?.fileHandle?.close()
            self?.fileHandle = nil
        }
        self.source = source
        source.resume()
        readAvailablePrompts()
    }

    func invalidate() {
        guard !isInvalidated else {
            return
        }
        isInvalidated = true
        source?.cancel()
        source = nil
        try? fileHandle?.close()
        fileHandle = nil
        try? FileManager.default.removeItem(at: rootURL)
        Self.releaseWorkspaceHook(forKey: workspaceKey)
    }

    private func handleSourceEvent() {
        guard !isInvalidated else {
            return
        }
        let eventData = source?.data ?? []
        if eventData.contains(.delete) || eventData.contains(.rename) || eventData.contains(.revoke) {
            invalidate()
            return
        }
        readAvailablePrompts()
    }

    private func readAvailablePrompts() {
        guard !isInvalidated, let fileHandle else {
            return
        }

        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: logURL.path)
            let currentSize = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
            if currentSize < readOffset {
                readOffset = 0
                pendingBuffer.removeAll(keepingCapacity: true)
            }

            try fileHandle.seek(toOffset: readOffset)
            let data = try fileHandle.readToEnd() ?? Data()
            readOffset += UInt64(data.count)
            guard !data.isEmpty else {
                return
            }

            pendingBuffer.append(data)
            consumePendingLines()
        } catch {
            // Ignore hook read failures; they should not break the terminal session.
        }
    }

    private func consumePendingLines() {
        while let newlineIndex = pendingBuffer.firstIndex(of: 0x0A) {
            let lineData = pendingBuffer.prefix(upTo: newlineIndex)
            pendingBuffer.removeSubrange(...newlineIndex)
            guard !lineData.isEmpty else {
                continue
            }
            processLine(Data(lineData))
        }
    }

    private func processLine(_ lineData: Data) {
        guard let record = try? JSONDecoder().decode(HookPromptRecord.self, from: lineData),
              let prompt = record.prompt?.trimmingCharacters(in: .whitespacesAndNewlines),
              !prompt.isEmpty else {
            return
        }
        onPrompt(prompt)
    }

    private static func acquireWorkspaceHook(for workspaceURL: URL) throws {
        let workspaceKey = workspaceURL.standardizedFileURL.path

        workspaceInstallationsLock.lock()
        defer { workspaceInstallationsLock.unlock() }

        if var existing = workspaceInstallations[workspaceKey] {
            existing.referenceCount += 1
            workspaceInstallations[workspaceKey] = existing
            return
        }

        let fileManager = FileManager.default
        let dotCodexURL = workspaceURL.appendingPathComponent(".codex", isDirectory: true)
        let hooksURL = dotCodexURL.appendingPathComponent("hooks.json", isDirectory: false)
        let configURL = dotCodexURL.appendingPathComponent("config.toml", isDirectory: false)

        var isDirectory: ObjCBool = false
        let dotCodexExisted = fileManager.fileExists(atPath: dotCodexURL.path, isDirectory: &isDirectory)
        if dotCodexExisted && !isDirectory.boolValue {
            throw NSError(
                domain: "PromptHookCapture",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: ".codex exists but is not a directory"]
            )
        }
        if !dotCodexExisted {
            try fileManager.createDirectory(at: dotCodexURL, withIntermediateDirectories: true)
        }

        let originalHooksData = try? Data(contentsOf: hooksURL)
        let originalConfigData = try? Data(contentsOf: configURL)
        let helperScriptURL = try sharedHelperScriptURL()
        let hookCommand = "/usr/bin/python3 \(shellQuoted(helperScriptURL.path))"
        let mergedHooksData = try mergedHooksJSON(existingData: originalHooksData, hookCommand: hookCommand)
        let mergedConfigData = try mergedConfigTOML(existingData: originalConfigData)
        try mergedHooksData.write(to: hooksURL, options: [.atomic])
        try mergedConfigData.write(to: configURL, options: [.atomic])

        workspaceInstallations[workspaceKey] = WorkspaceHookInstallation(
            referenceCount: 1,
            hooksURL: hooksURL,
            configURL: configURL,
            dotCodexURL: dotCodexURL,
            createdDotCodexDirectory: !dotCodexExisted,
            originalHooksData: originalHooksData,
            originalConfigData: originalConfigData
        )
    }

    private static func releaseWorkspaceHook(forKey workspaceKey: String) {
        workspaceInstallationsLock.lock()
        defer { workspaceInstallationsLock.unlock() }

        guard var installation = workspaceInstallations[workspaceKey] else {
            return
        }

        installation.referenceCount -= 1
        if installation.referenceCount > 0 {
            workspaceInstallations[workspaceKey] = installation
            return
        }

        if let originalHooksData = installation.originalHooksData {
            try? originalHooksData.write(to: installation.hooksURL, options: [.atomic])
        } else {
            try? FileManager.default.removeItem(at: installation.hooksURL)
        }

        if let originalConfigData = installation.originalConfigData {
            try? originalConfigData.write(to: installation.configURL, options: [.atomic])
        } else {
            try? FileManager.default.removeItem(at: installation.configURL)
        }

        if installation.createdDotCodexDirectory,
           let contents = try? FileManager.default.contentsOfDirectory(at: installation.dotCodexURL, includingPropertiesForKeys: nil),
           contents.isEmpty {
            try? FileManager.default.removeItem(at: installation.dotCodexURL)
        }

        workspaceInstallations.removeValue(forKey: workspaceKey)
    }

    private static func sharedHelperScriptURL() throws -> URL {
        let fileManager = FileManager.default
        let rootURL = fileManager.temporaryDirectory
            .appendingPathComponent("codigo-editor", isDirectory: true)
            .appendingPathComponent("codex-hooks", isDirectory: true)
        try fileManager.createDirectory(at: rootURL, withIntermediateDirectories: true)

        let scriptURL = rootURL.appendingPathComponent("capture_user_prompt_submit.py", isDirectory: false)
        if !fileManager.fileExists(atPath: scriptURL.path) {
            let script = """
            #!/usr/bin/env python3
            import json
            import os
            import sys
            from pathlib import Path

            payload = json.load(sys.stdin)
            prompt = payload.get("prompt")
            if not isinstance(prompt, str) or not prompt.strip():
                raise SystemExit(0)

            log_path = os.environ.get("CODIGO_PROMPT_HOOK_LOG", "").strip()
            if not log_path:
                raise SystemExit(0)

            with Path(log_path).open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"prompt": prompt}, ensure_ascii=False) + "\\n")
            """
            try script.write(to: scriptURL, atomically: true, encoding: .utf8)
            try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)
        }
        return scriptURL
    }

    static func mergedHooksJSON(existingData: Data?, hookCommand: String) throws -> Data {
        var root: [String: Any] = [:]

        if let existingData,
           !existingData.isEmpty,
           let existingRoot = try JSONSerialization.jsonObject(with: existingData) as? [String: Any] {
            root = existingRoot
        }

        var hooks = root["hooks"] as? [String: Any] ?? [:]
        var userPromptGroups = hooks["UserPromptSubmit"] as? [[String: Any]] ?? []
        userPromptGroups.removeAll { group in
            guard let handlers = group["hooks"] as? [[String: Any]] else {
                return false
            }
            return handlers.contains { handler in
                (handler["statusMessage"] as? String) == statusMessage
            }
        }

        let captureGroup: [String: Any] = [
            "hooks": [[
                "type": "command",
                "command": hookCommand,
                "statusMessage": statusMessage,
            ]],
        ]
        userPromptGroups.insert(captureGroup, at: 0)
        hooks["UserPromptSubmit"] = userPromptGroups
        root["hooks"] = hooks

        return try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
    }

    static func mergedConfigTOML(existingData: Data?) throws -> Data {
        let normalizedText: String
        if let existingData, !existingData.isEmpty {
            guard let decoded = String(data: existingData, encoding: .utf8) else {
                throw NSError(
                    domain: "PromptHookCapture",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "config.toml is not valid UTF-8"]
                )
            }
            normalizedText = decoded.replacingOccurrences(of: "\r\n", with: "\n")
        } else {
            normalizedText = ""
        }

        let merged = mergedConfigText(existingText: normalizedText)
        guard let data = merged.data(using: .utf8) else {
            throw NSError(
                domain: "PromptHookCapture",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "Failed to encode merged config.toml"]
            )
        }
        return data
    }

    private static func mergedConfigText(existingText: String) -> String {
        var lines = existingText.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        if lines.last == "" {
            lines.removeLast()
        }

        let enableLine = "codex_hooks = true"

        if let featuresIndex = lines.firstIndex(where: { isTOMLSection($0, named: "features") }) {
            let sectionEnd = lines[(featuresIndex + 1)...]
                .firstIndex(where: { isAnyTOMLSection($0) }) ?? lines.endIndex

            if let keyIndex = lines[featuresIndex + 1..<sectionEnd].firstIndex(where: { isTOMLKey($0, named: "codex_hooks") }) {
                let indentation = leadingWhitespace(in: lines[keyIndex])
                let comment = inlineComment(in: lines[keyIndex])
                lines[keyIndex] = comment.isEmpty
                    ? "\(indentation)\(enableLine)"
                    : "\(indentation)\(enableLine) \(comment)"
            } else {
                var insertionIndex = sectionEnd
                while insertionIndex > featuresIndex + 1,
                      lines[insertionIndex - 1].trimmingCharacters(in: .whitespaces).isEmpty {
                    insertionIndex -= 1
                }
                lines.insert(enableLine, at: insertionIndex)
            }
        } else {
            if !lines.isEmpty, lines.last?.isEmpty == false {
                lines.append("")
            }
            lines.append("[features]")
            lines.append(enableLine)
        }

        return lines.joined(separator: "\n") + "\n"
    }

    private static func isTOMLSection(_ line: String, named sectionName: String) -> Bool {
        let trimmed = structuralTOMLLine(line)
        guard trimmed.hasPrefix("["),
              trimmed.hasSuffix("]"),
              !trimmed.hasPrefix("[["),
              !trimmed.hasSuffix("]]") else {
            return false
        }
        return String(trimmed.dropFirst().dropLast()) == sectionName
    }

    private static func isAnyTOMLSection(_ line: String) -> Bool {
        let trimmed = structuralTOMLLine(line)
        return trimmed.hasPrefix("[") && trimmed.hasSuffix("]")
    }

    private static func isTOMLKey(_ line: String, named key: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.hasPrefix("#") else {
            return false
        }
        guard trimmed.hasPrefix(key) else {
            return false
        }

        let remainder = trimmed.dropFirst(key.count).trimmingCharacters(in: .whitespaces)
        return remainder.hasPrefix("=")
    }

    private static func leadingWhitespace(in line: String) -> String {
        String(line.prefix { $0 == " " || $0 == "\t" })
    }

    private static func inlineComment(in line: String) -> String {
        guard let commentStart = line.firstIndex(of: "#") else {
            return ""
        }
        return String(line[commentStart...]).trimmingCharacters(in: .whitespaces)
    }

    private static func structuralTOMLLine(_ line: String) -> String {
        let content = line.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
        return content.trimmingCharacters(in: .whitespaces)
    }

    private static func shellQuoted(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
    }
}

@MainActor
extension TerminalCoordinator {
    func shouldInstallPromptHookCapture(for pane: PaneState) -> Bool {
        let summaryCommand = appSettings.conversationSummaryCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        return pane.column == .primary
            && pane.config.kind == .codex
            && appSettings.conversationSummarySource == .localCommand
            && !summaryCommand.isEmpty
    }

    func syncPromptHookCapturesWithSettings() {
        for tab in tabs {
            for pane in tab.panes where pane.promptHookCapture != nil && !shouldInstallPromptHookCapture(for: pane) {
                disposePromptHookCapture(for: pane)
            }
        }
    }

    func preparePromptHookCapture(for pane: PaneState) -> PromptHookCapture? {
        disposePromptHookCapture(for: pane)

        guard shouldInstallPromptHookCapture(for: pane) else {
            return nil
        }

        let paneID = pane.id
        let runtimeIndex = pane.runtimeIndex
        do {
            let capture = try makeCodexPromptHookCapture(
                for: paneID,
                runtimeIndex: runtimeIndex,
                workingDirectory: pane.config.workingDirectory
            )
            pane.promptHookCapture = capture
            return capture
        } catch {
            print("Failed to prepare Codex prompt hook capture for pane", runtimeIndex, "error:", error)
            pane.promptHookCapture = nil
            return nil
        }
    }

    func disposePromptHookCapture(for pane: PaneState) {
        pane.promptHookCapture?.invalidate()
        pane.promptHookCapture = nil
    }

    private func makeCodexPromptHookCapture(
        for paneID: UUID,
        runtimeIndex: Int,
        workingDirectory: String
    ) throws -> PromptHookCapture {
        let fileManager = FileManager.default
        let rootURL = fileManager.temporaryDirectory
            .appendingPathComponent("codigo-editor", isDirectory: true)
            .appendingPathComponent("pane-prompt-hooks", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let workspaceURL = URL(fileURLWithPath: workingDirectory, isDirectory: true).standardizedFileURL
        let logURL = rootURL.appendingPathComponent("user-prompt-submit-log.jsonl", isDirectory: false)

        try fileManager.createDirectory(at: rootURL, withIntermediateDirectories: true)
        fileManager.createFile(atPath: logURL.path, contents: Data())

        let capture = try PromptHookCapture(
            workspaceURL: workspaceURL,
            rootURL: rootURL,
            logURL: logURL,
            environmentOverrides: [
                "CODIGO_PROMPT_HOOK_LOG": logURL.path,
            ],
            onPrompt: { [weak self] prompt in
                Task { @MainActor [weak self] in
                    guard let self,
                          let pane = self.panesByRuntimeIndex[runtimeIndex],
                          pane.id == paneID else {
                        return
                    }
                    self.sendPanePromptSubmitted(index: runtimeIndex)
                    self.handleCapturedConversationPrompt(index: runtimeIndex, prompt: prompt)
                }
            }
        )
        return capture
    }
}
