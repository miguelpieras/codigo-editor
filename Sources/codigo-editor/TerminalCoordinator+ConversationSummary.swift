import Foundation

@MainActor
extension TerminalCoordinator {
    struct ConversationSummaryResponse: Decodable {
        let summary: String?
    }

    func handleSummarizePanePrompt(body: Any) {
        guard appSettings.conversationSummarySource == .localCommand else {
            return
        }
        guard let payload = body as? [String: Any],
              let index = payload["index"] as? Int,
              let prompt = payload["prompt"] as? String,
              let pane = panesByRuntimeIndex[index],
              pane.column == .primary else {
            return
        }
        handleCapturedConversationPrompt(index: index, prompt: prompt)
    }

    func handleCapturedConversationPrompt(index: Int, prompt: String) {
        guard appSettings.conversationSummarySource == .localCommand,
              let pane = panesByRuntimeIndex[index],
              pane.column == .primary else {
            return
        }

        let normalizedPrompt = Self.normalizeConversationPrompt(prompt)
        guard !normalizedPrompt.isEmpty else {
            return
        }

        refreshConversationSummary(for: pane, userPrompt: normalizedPrompt)
    }

    func syncConversationSummaryFromTitleIfNeeded(_ title: String, for pane: PaneState) {
        guard appSettings.conversationSummarySource == .terminalTitle else {
            return
        }

        let sanitizedTitle = Self.sanitizeConversationSummaryText(title, previousSummary: pane.config.conversationSummary)
        updateConversationSummary(for: pane, to: sanitizedTitle)
    }

    func cancelConversationSummaryTask(for index: Int) {
        pendingConversationSummaryTasks[index]?.cancel()
        pendingConversationSummaryTasks.removeValue(forKey: index)
    }

    func updateConversationSummary(for pane: PaneState, to summary: String?) {
        let normalizedSummary = summary?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedSummary = normalizedSummary?.isEmpty == false ? normalizedSummary : nil
        guard resolvedSummary != pane.config.conversationSummary else {
            return
        }

        pane.config = TerminalConfig(
            title: pane.config.title,
            workingDirectory: pane.config.workingDirectory,
            startupCommand: pane.config.startupCommand,
            kind: pane.config.kind,
            conversationSummary: resolvedSummary
        )
        sendPaneConfigUpdate(for: pane)
        persistConfiguration()
    }

    private func refreshConversationSummary(for pane: PaneState, userPrompt: String) {
        let command = appSettings.conversationSummaryCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else {
            return
        }

        cancelConversationSummaryTask(for: pane.runtimeIndex)

        let runtimeIndex = pane.runtimeIndex
        let paneID = pane.id
        let previousSummary = pane.config.conversationSummary
        let task = Task { [weak self] in
            guard let self else {
                return
            }

            let summary = await self.runConversationSummaryCommand(
                command: command,
                prompt: userPrompt,
                previousSummary: previousSummary
            )
            guard !Task.isCancelled else {
                return
            }

            self.pendingConversationSummaryTasks.removeValue(forKey: runtimeIndex)
            guard let currentPane = self.panesByRuntimeIndex[runtimeIndex], currentPane.id == paneID else {
                return
            }
            self.updateConversationSummary(for: currentPane, to: summary)
        }

        pendingConversationSummaryTasks[runtimeIndex] = task
    }

    private nonisolated static func normalizeConversationPrompt(_ prompt: String) -> String {
        let trimmed = prompt
            .replacingOccurrences(of: "\r\n", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 6 else {
            return ""
        }
        guard trimmed.rangeOfCharacter(from: .letters) != nil else {
            return ""
        }
        let collapsedWhitespace = trimmed.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        if collapsedWhitespace.hasPrefix("/") && !collapsedWhitespace.contains(" ") {
            return ""
        }
        return collapsedWhitespace
    }

    private func runConversationSummaryCommand(
        command: String,
        prompt: String,
        previousSummary: String?
    ) async -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", command]

        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr

        let timeoutWorkItem = DispatchWorkItem {
            if process.isRunning {
                process.terminate()
            }
        }

        let summary = await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            process.terminationHandler = { _ in
                let outputData = stdout.fileHandleForReading.readDataToEndOfFile()
                _ = stderr.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: outputData, encoding: .utf8) ?? ""
                guard !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: Self.sanitizeConversationSummaryOutput(output, previousSummary: previousSummary))
            }

            do {
                try process.run()
            } catch {
                continuation.resume(returning: nil)
                return
            }

            let request = Self.makeConversationSummaryRequest(prompt: prompt, previousSummary: previousSummary)
            if let requestData = request.data(using: .utf8) {
                try? stdin.fileHandleForWriting.write(contentsOf: requestData)
            }
            try? stdin.fileHandleForWriting.close()
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 6, execute: timeoutWorkItem)
        }

        timeoutWorkItem.cancel()
        return summary
    }

    private nonisolated static func makeConversationSummaryRequest(
        prompt: String,
        previousSummary: String?
    ) -> String {
        var lines = [
            "Summarize the current coding task in 4 to 8 words.",
            "Return exact JSON only in this shape: {\"summary\":\"short task summary\"}.",
            "Do not return markdown, prose, explanations, or code fences."
        ]
        if let previousSummary,
           !previousSummary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            lines.append("Previous summary: \(previousSummary)")
        }
        lines.append("User request:")
        lines.append(prompt)
        return lines.joined(separator: "\n") + "\n"
    }

    nonisolated static func sanitizeConversationSummaryOutput(
        _ output: String,
        previousSummary: String?
    ) -> String? {
        guard let parsedJSONSummary = parseConversationSummaryJSON(output) else {
            return previousSummary
        }
        return sanitizeConversationSummaryText(parsedJSONSummary, previousSummary: previousSummary)
    }

    private nonisolated static func parseConversationSummaryJSON(_ output: String) -> String? {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }
        guard let data = trimmed.data(using: .utf8) else {
            return nil
        }
        if let decoded = try? JSONDecoder().decode(ConversationSummaryResponse.self, from: data),
           let summary = decoded.summary {
            return summary
        }
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let summary = object["summary"] as? String {
            return summary
        }
        return nil
    }

    private nonisolated static func sanitizeConversationSummaryText(
        _ text: String,
        previousSummary: String?
    ) -> String? {
        var normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            return previousSummary
        }

        if normalized.lowercased().hasPrefix("summary:") {
            normalized = String(normalized.dropFirst("summary:".count))
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }

        normalized = normalized
            .trimmingCharacters(in: CharacterSet(charactersIn: "\"'`-* \t"))
            .trimmingCharacters(in: CharacterSet(charactersIn: ".,:;!?"))
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)

        guard !normalized.isEmpty else {
            return previousSummary
        }

        let words = normalized.split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else {
            return previousSummary
        }

        return words.prefix(8).joined(separator: " ")
    }
}
