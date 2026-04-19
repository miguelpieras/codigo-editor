import Foundation

@MainActor
extension TerminalCoordinator {
    final class GitRepositoryMonitor: @unchecked Sendable {
        struct Snapshot: Equatable {
            var isRepository: Bool
            var insertions: Int
            var deletions: Int
            var changedFiles: Int
            var syncing: Bool
            var error: String?
        }

        struct Detail {
            var path: String
            var previousPath: String?
            var status: String
            var insertions: Int
            var deletions: Int
            var diff: String
        }

        struct DetailsSnapshot {
            var files: [Detail]
            var error: String?
        }

        private struct GitCommandResult {
            let status: Int32
            let stdout: String
            let stderr: String
        }

        private final class PipeAccumulator: @unchecked Sendable {
            private var storage = Data()
            private let lock = NSLock()

            func replace(with data: Data) {
                lock.lock()
                storage = data
                lock.unlock()
            }

            func value() -> Data {
                lock.lock()
                defer { lock.unlock() }
                return storage
            }
        }

        private let paneIndex: Int
        private weak var coordinator: TerminalCoordinator?
        private let queue: DispatchQueue
        private var timer: DispatchSourceTimer?
        private var workingDirectory: URL
        private var lastSnapshot: Snapshot
        private var syncInProgress = false
        private var isInvalidated = false
        private let fileManager = FileManager.default
        private let refreshInterval: DispatchTimeInterval = .seconds(5)
        private lazy var dateFormatter: ISO8601DateFormatter = {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withFullDate, .withTime, .withDashSeparatorInDate, .withColonSeparatorInTime]
            formatter.timeZone = TimeZone.current
            return formatter
        }()

        init(paneIndex: Int, workingDirectory: String, coordinator: TerminalCoordinator) {
            self.paneIndex = paneIndex
            self.coordinator = coordinator
            self.queue = DispatchQueue(label: "codigo-editor.git-monitor.\(paneIndex)", qos: .utility)
            self.workingDirectory = URL(fileURLWithPath: workingDirectory, isDirectory: true).standardizedFileURL
            self.lastSnapshot = Snapshot(isRepository: false, insertions: 0, deletions: 0, changedFiles: 0, syncing: false, error: nil)
            startTimer()
            queue.async { [weak self] in
                self?.refreshGitStatus(immediate: true)
            }
        }

        func updateWorkingDirectory(_ path: String) {
            queue.async { [weak self] in
                guard let self, !self.isInvalidated else { return }
                self.workingDirectory = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
                self.refreshGitStatus(immediate: true)
            }
        }

        func requestImmediateRefresh() {
            queue.async { [weak self] in
                self?.refreshGitStatus(immediate: true)
            }
        }

        func performSync() {
            performCloudAction(.sync, script: nil)
        }

        func performCloudAction(_ action: TerminalCloudAction, script: String?) {
            queue.async { [weak self] in
                self?.performCloudActionLocked(action, script: script)
            }
        }

        func performUndo() {
            queue.async { [weak self] in
                self?.performUndoLocked()
            }
        }

        func requestDetails() {
            queue.async { [weak self] in
                guard let self, !self.isInvalidated else { return }
                let snapshot = self.computeDetailsSnapshot()
                self.publishDetailsSnapshot(snapshot)
            }
        }

        func invalidate() {
            queue.async { [weak self] in
                guard let self, !self.isInvalidated else { return }
                self.isInvalidated = true
                self.timer?.cancel()
                self.timer = nil
            }
        }

        private func startTimer() {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + refreshInterval, repeating: refreshInterval)
            timer.setEventHandler { [weak self] in
                self?.refreshGitStatus(immediate: false)
            }
            timer.resume()
            self.timer = timer
        }

        private func refreshGitStatus(immediate: Bool) {
            guard !isInvalidated else { return }
            if syncInProgress && !immediate {
                return
            }
            let snapshot = computeSnapshot()
            updateSnapshot(snapshot)
        }

        private func computeSnapshot() -> Snapshot {
            var snapshot = Snapshot(
                isRepository: false,
                insertions: 0,
                deletions: 0,
                changedFiles: 0,
                syncing: syncInProgress,
                error: syncInProgress ? nil : lastSnapshot.error
            )

            guard let directory = resolvedWorkingDirectory() else {
                snapshot.error = nil
                return snapshot
            }

            let revParse = runGit(in: directory, arguments: ["rev-parse", "--is-inside-work-tree"])
            guard revParse.status == 0, trimmed(revParse.stdout).lowercased() == "true" else {
                snapshot.error = nil
                return snapshot
            }

            snapshot.isRepository = true
            snapshot.error = nil

            var changedPaths = Set<String>()

            let workingDiff = runGit(in: directory, arguments: ["diff", "--numstat"])
            if workingDiff.status == 0 {
                let result = parseNumstat(workingDiff.stdout)
                snapshot.insertions += result.insertions
                snapshot.deletions += result.deletions
                changedPaths.formUnion(result.paths)
            }

            let stagedDiff = runGit(in: directory, arguments: ["diff", "--numstat", "--cached"])
            if stagedDiff.status == 0 {
                let result = parseNumstat(stagedDiff.stdout)
                snapshot.insertions += result.insertions
                snapshot.deletions += result.deletions
                changedPaths.formUnion(result.paths)
            }

            let porcelain = runGit(in: directory, arguments: ["status", "--porcelain", "-z"])
            if porcelain.status == 0 {
                let statusPaths = parsePorcelainPaths(porcelain.stdout)
                changedPaths.formUnion(statusPaths)
            }

            snapshot.changedFiles = changedPaths.count

            return snapshot
        }

        private func performCloudActionLocked(_ action: TerminalCloudAction, script: String?) {
            guard !isInvalidated else { return }
            guard let directory = resolvedWorkingDirectory() else {
                var snapshot = lastSnapshot
                snapshot.isRepository = false
                snapshot.insertions = 0
                snapshot.deletions = 0
                snapshot.changedFiles = 0
                snapshot.syncing = false
                snapshot.error = "Working directory unavailable"
                updateSnapshot(snapshot)
                return
            }

            let repoCheck = runGit(in: directory, arguments: ["rev-parse", "--is-inside-work-tree"])
            guard repoCheck.status == 0, trimmed(repoCheck.stdout).lowercased() == "true" else {
                var snapshot = lastSnapshot
                snapshot.isRepository = false
                snapshot.insertions = 0
                snapshot.deletions = 0
                snapshot.changedFiles = 0
                snapshot.syncing = false
                snapshot.error = "Not a Git repository"
                updateSnapshot(snapshot)
                return
            }

            syncInProgress = true
            var syncingSnapshot = lastSnapshot
            syncingSnapshot.syncing = true
            syncingSnapshot.error = nil
            updateSnapshot(syncingSnapshot)

            switch action {
            case .sync, .createPullRequest:
                if let syncError = runGitSyncSequence(in: directory) {
                    syncInProgress = false
                    var snapshot = lastSnapshot
                    snapshot.syncing = false
                    snapshot.error = fallbackError(from: syncError)
                    updateSnapshot(snapshot)
                    return
                }

                if action == .createPullRequest {
                    let prResult = runGitHub(in: directory, arguments: ["pr", "create", "--fill"])
                    if prResult.status != 0 {
                        syncInProgress = false
                        var snapshot = lastSnapshot
                        snapshot.syncing = false
                        snapshot.error = fallbackError(from: prResult)
                        updateSnapshot(snapshot)
                        return
                    }
                }

                syncInProgress = false
                var finishedSnapshot = lastSnapshot
                finishedSnapshot.syncing = false
                finishedSnapshot.error = nil
                updateSnapshot(finishedSnapshot)
                refreshGitStatus(immediate: true)

            case .customScript:
                let resolvedScript = script ?? ""
                let trimmedScript = trimmed(resolvedScript)
                guard !trimmedScript.isEmpty else {
                    syncInProgress = false
                    var snapshot = lastSnapshot
                    snapshot.syncing = false
                    snapshot.error = "Custom script is empty"
                    updateSnapshot(snapshot)
                    return
                }

                let result = runCustomScript(resolvedScript, in: directory)
                syncInProgress = false
                var snapshot = lastSnapshot
                snapshot.syncing = false
                if result.status == 0 {
                    snapshot.error = nil
                    updateSnapshot(snapshot)
                    refreshGitStatus(immediate: true)
                } else {
                    snapshot.error = fallbackError(from: result)
                    updateSnapshot(snapshot)
                }
            }
        }

        private func performUndoLocked() {
            guard !isInvalidated else { return }
            guard let directory = resolvedWorkingDirectory() else {
                var snapshot = lastSnapshot
                snapshot.isRepository = false
                snapshot.insertions = 0
                snapshot.deletions = 0
                snapshot.changedFiles = 0
                snapshot.syncing = false
                snapshot.error = "Working directory unavailable"
                updateSnapshot(snapshot)
                return
            }

            let repoCheck = runGit(in: directory, arguments: ["rev-parse", "--is-inside-work-tree"])
            guard repoCheck.status == 0, trimmed(repoCheck.stdout).lowercased() == "true" else {
                var snapshot = lastSnapshot
                snapshot.isRepository = false
                snapshot.insertions = 0
                snapshot.deletions = 0
                snapshot.changedFiles = 0
                snapshot.syncing = false
                snapshot.error = "Not a Git repository"
                updateSnapshot(snapshot)
                return
            }

            syncInProgress = true
            var syncingSnapshot = lastSnapshot
            syncingSnapshot.syncing = true
            syncingSnapshot.error = nil
            updateSnapshot(syncingSnapshot)

            // This intentionally mirrors a hard reset of the repository and removes
            // untracked files and directories, so the UI must treat it as destructive.
            let resetResult = runGit(in: directory, arguments: ["reset", "--hard"])
            guard resetResult.status == 0 else {
                syncInProgress = false
                var snapshot = lastSnapshot
                snapshot.syncing = false
                snapshot.error = fallbackError(from: resetResult)
                updateSnapshot(snapshot)
                return
            }

            let cleanResult = runGit(in: directory, arguments: ["clean", "-fd"])
            syncInProgress = false
            guard cleanResult.status == 0 else {
                var snapshot = lastSnapshot
                snapshot.syncing = false
                snapshot.error = fallbackError(from: cleanResult)
                updateSnapshot(snapshot)
                return
            }

            var finishedSnapshot = lastSnapshot
            finishedSnapshot.syncing = false
            finishedSnapshot.error = nil
            updateSnapshot(finishedSnapshot)
            refreshGitStatus(immediate: true)
        }

        private func publishDetailsSnapshot(_ snapshot: DetailsSnapshot) {
            Task { @MainActor [weak self] in
                guard let self, let coordinator = self.coordinator else { return }
                coordinator.publishGitDetails(index: self.paneIndex, details: snapshot)
            }
        }

        private func resolvedWorkingDirectory() -> URL? {
            let path = workingDirectory.path
            guard !path.isEmpty else { return nil }
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
                return nil
            }
            return workingDirectory
        }

        private func runGit(in directory: URL, arguments: [String]) -> GitCommandResult {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["git"] + arguments
            process.currentDirectoryURL = directory
            process.environment = ProcessInfo.processInfo.environment
            process.standardInput = nil
            return runProcess(process)
        }

        private func runCustomScript(_ script: String, in directory: URL) -> GitCommandResult {
            let shellPath = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
            let process = Process()
            process.executableURL = URL(fileURLWithPath: shellPath)
            process.arguments = ["-lc", script]
            var environment = ProcessInfo.processInfo.environment
            environment["PWD"] = directory.path
            process.environment = environment
            process.currentDirectoryURL = directory
            process.standardInput = nil
            return runProcess(process)
        }

        private func runGitSyncSequence(in directory: URL) -> GitCommandResult? {
            let statusResult = runGit(in: directory, arguments: ["status", "--porcelain"])
            guard statusResult.status == 0 else {
                return statusResult
            }

            let hasChanges = !trimmed(statusResult.stdout).isEmpty
            if hasChanges {
                let addResult = runGit(in: directory, arguments: ["add", "--all"])
                if addResult.status != 0 {
                    return addResult
                }

                let commitResult = runGit(in: directory, arguments: ["commit", "-m", commitMessage()])
                if commitResult.status != 0 {
                    return commitResult
                }
            }

            let pushResult = runGit(in: directory, arguments: ["push"])
            return pushResult.status == 0 ? nil : pushResult
        }

        private func runGitHub(in directory: URL, arguments: [String]) -> GitCommandResult {
            let environment = TerminalCoordinator.makeGitHubEnvironment()
            guard let executableURL = TerminalCoordinator.resolveGitHubExecutable(using: environment) else {
                return GitCommandResult(
                    status: 127,
                    stdout: "",
                    stderr: "GitHub CLI ('gh') not found. Install it via https://cli.github.com/ and ensure it is available on PATH."
                )
            }

            let process = Process()
            process.executableURL = executableURL
            process.arguments = arguments
            process.currentDirectoryURL = directory
            process.environment = environment
            process.standardInput = Pipe()
            return runProcess(process)
        }

        // Capture stdout/stderr concurrently to avoid blocking when commands emit large output.
        private func runProcess(_ process: Process) -> GitCommandResult {
            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe

            let group = DispatchGroup()
            let stdoutAccumulator = PipeAccumulator()
            let stderrAccumulator = PipeAccumulator()

            group.enter()
            DispatchQueue.global(qos: .utility).async {
                defer { group.leave() }
                let data = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
                stdoutAccumulator.replace(with: data)
            }

            group.enter()
            DispatchQueue.global(qos: .utility).async {
                defer { group.leave() }
                let data = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                stderrAccumulator.replace(with: data)
            }

            do {
                try process.run()
            } catch {
                stdoutPipe.fileHandleForWriting.closeFile()
                stderrPipe.fileHandleForWriting.closeFile()
                group.wait()
                stdoutPipe.fileHandleForReading.closeFile()
                stderrPipe.fileHandleForReading.closeFile()
                return GitCommandResult(status: -1, stdout: "", stderr: String(describing: error))
            }

            process.waitUntilExit()
            stdoutPipe.fileHandleForWriting.closeFile()
            stderrPipe.fileHandleForWriting.closeFile()
            group.wait()
            stdoutPipe.fileHandleForReading.closeFile()
            stderrPipe.fileHandleForReading.closeFile()

            let stdoutString = String(data: stdoutAccumulator.value(), encoding: .utf8) ?? ""
            let stderrString = String(data: stderrAccumulator.value(), encoding: .utf8) ?? ""

            return GitCommandResult(status: process.terminationStatus, stdout: stdoutString, stderr: stderrString)
        }

        private struct NumstatResult {
            var insertions: Int
            var deletions: Int
            var paths: Set<String>
        }

        private func parseNumstat(_ output: String) -> NumstatResult {
            var insertions = 0
            var deletions = 0
            var paths: Set<String> = []

            output.enumerateLines { line, _ in
                let trimmedLine = line.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmedLine.isEmpty else { return }

                let columns = trimmedLine.split(separator: "\t", omittingEmptySubsequences: false)
                guard columns.count >= 3 else { return }

                if let value = Int(columns[0]) {
                    insertions += max(0, value)
                }
                if let value = Int(columns[1]) {
                    deletions += max(0, value)
                }

                let pathComponents = columns[2...].joined(separator: "\t")
                if !pathComponents.isEmpty {
                    paths.insert(pathComponents)
                }
            }

            return NumstatResult(insertions: insertions, deletions: deletions, paths: paths)
        }

        private func parsePorcelainPaths(_ output: String) -> Set<String> {
            guard !output.isEmpty else { return [] }

            let entries = output.split(separator: "\0", omittingEmptySubsequences: true)
            var index = 0
            var paths: Set<String> = []

            while index < entries.count {
                let entry = entries[index]
                defer { index += 1 }

                guard !entry.isEmpty else { continue }

                if let spaceIndex = entry.firstIndex(of: " ") {
                    let pathStart = entry.index(after: spaceIndex)
                    if pathStart < entry.endIndex {
                        let path = String(entry[pathStart...])
                        if !path.isEmpty {
                            paths.insert(path)
                        }
                    }

                    if let firstChar = entry.first, firstChar == "R" || firstChar == "C" {
                        if index + 1 < entries.count {
                            let newPath = entries[index + 1]
                            if !newPath.isEmpty {
                                paths.insert(String(newPath))
                            }
                            index += 1
                        }
                    }
                } else {
                    let path = String(entry)
                    if !path.isEmpty {
                        paths.insert(path)
                    }
                }
            }

            return paths
        }

        private struct ChangeEntry {
            var indexStatus: Character
            var worktreeStatus: Character
            var path: String
            var previousPath: String?
        }

        private func computeDetailsSnapshot() -> DetailsSnapshot {
            var snapshot = DetailsSnapshot(files: [], error: nil)

            guard let directory = resolvedWorkingDirectory() else {
                snapshot.error = "Working directory unavailable"
                return snapshot
            }

            let repoCheck = runGit(in: directory, arguments: ["rev-parse", "--is-inside-work-tree"])
            guard repoCheck.status == 0, trimmed(repoCheck.stdout).lowercased() == "true" else {
                snapshot.error = "Not a Git repository"
                return snapshot
            }

            let statusResult = runGit(in: directory, arguments: ["status", "--porcelain", "-z", "--untracked-files=all"])
            guard statusResult.status == 0 else {
                snapshot.error = fallbackError(from: statusResult)
                return snapshot
            }

            let entries = parsePorcelainEntries(statusResult.stdout)
            guard !entries.isEmpty else {
                snapshot.files = []
                snapshot.error = nil
                return snapshot
            }

            var details: [Detail] = []
            for entry in entries {
                if let detail = makeDetail(for: entry, in: directory) {
                    details.append(detail)
                }
            }

            snapshot.files = details.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
            snapshot.error = nil
            return snapshot
        }

        private func parsePorcelainEntries(_ output: String) -> [ChangeEntry] {
            guard !output.isEmpty else { return [] }

            let components = output.split(separator: "\0", omittingEmptySubsequences: true)
            var entries: [ChangeEntry] = []
            var index = 0

            while index < components.count {
                let part = components[index]
                guard part.count >= 3 else {
                    index += 1
                    continue
                }

                let indexStatus = part[part.startIndex]
                let worktreeStatusIndex = part.index(after: part.startIndex)
                let worktreeStatus = part[worktreeStatusIndex]
                let pathStartIndex = part.index(part.startIndex, offsetBy: 3)
                let rawPath = pathStartIndex <= part.endIndex ? String(part[pathStartIndex...]) : ""

                var previousPath: String?
                if indexStatus == "R" || indexStatus == "C" || worktreeStatus == "R" || worktreeStatus == "C" {
                    if index + 1 < components.count {
                        previousPath = String(components[index + 1])
                        index += 1
                    }
                }

                entries.append(ChangeEntry(
                    indexStatus: indexStatus,
                    worktreeStatus: worktreeStatus,
                    path: rawPath,
                    previousPath: previousPath
                ))

                index += 1
            }

            return entries
        }

        private func makeDetail(for entry: ChangeEntry, in directory: URL) -> Detail? {
            let statusText = statusDescription(for: entry)
            let diffResult = diffForEntry(entry, in: directory)
            return Detail(
                path: entry.path,
                previousPath: entry.previousPath,
                status: statusText,
                insertions: diffResult.insertions,
                deletions: diffResult.deletions,
                diff: diffResult.diff
            )
        }

        private func statusDescription(for entry: ChangeEntry) -> String {
            let statuses: [Character] = [entry.indexStatus, entry.worktreeStatus]
            if statuses.contains("?") {
                return "untracked"
            }
            if statuses.contains("R") {
                return "renamed"
            }
            if statuses.contains("C") {
                return "copied"
            }
            if statuses.contains("A") {
                return "added"
            }
            if statuses.contains("D") {
                return "deleted"
            }
            return "modified"
        }

        private func diffForEntry(_ entry: ChangeEntry, in directory: URL) -> (diff: String, insertions: Int, deletions: Int) {
            let isUntracked = entry.indexStatus == "?" || entry.worktreeStatus == "?"
            let arguments: [String]
            if isUntracked {
                arguments = ["diff", "--no-index", "--color=never", "/dev/null", entry.path]
            } else {
                arguments = ["diff", "--no-ext-diff", "--color=never", "HEAD", "--", entry.path]
            }

            let result = runGit(in: directory, arguments: arguments)
            let diffOutput = result.stdout
            let stats = parseDiffStats(diffOutput)
            return (diffOutput, stats.insertions, stats.deletions)
        }

        private func parseDiffStats(_ diff: String) -> (insertions: Int, deletions: Int) {
            var insertions = 0
            var deletions = 0

            diff.enumerateLines { line, _ in
                if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("diff --") || line.hasPrefix("index ") {
                    return
                }
                if line.hasPrefix("+") {
                    insertions += 1
                } else if line.hasPrefix("-") {
                    deletions += 1
                }
            }

            return (insertions, deletions)
        }

        private func trimmed(_ string: String) -> String {
            string.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        private func fallbackError(from result: GitCommandResult) -> String {
            let preferred = trimmed(result.stderr)
            if !preferred.isEmpty {
                return preferred
            }
            let fallback = trimmed(result.stdout)
            if !fallback.isEmpty {
                return fallback
            }
            return "Git command failed"
        }

        private func commitMessage() -> String {
            let timestamp = dateFormatter.string(from: Date())
            return "Codigo Sync " + timestamp
        }

        private func updateSnapshot(_ snapshot: Snapshot) {
            guard !isInvalidated else { return }
            if snapshot == lastSnapshot {
                return
            }
            lastSnapshot = snapshot
            Task { @MainActor [weak self] in
                guard let self, let coordinator = self.coordinator else { return }
                coordinator.publishGitStatus(index: self.paneIndex, snapshot: snapshot)
            }
        }
    }

    func publishGitStatus(index: Int, snapshot: GitRepositoryMonitor.Snapshot) {
        guard sendGitStatusPayload(index: index, snapshot: snapshot) else {
            pendingGitSnapshots[index] = snapshot
            return
        }
        pendingGitSnapshots.removeValue(forKey: index)
    }

    func publishGitDetails(index: Int, details: GitRepositoryMonitor.DetailsSnapshot) {
        _ = sendGitDetailsPayload(index: index, details: details)
    }

    func refreshGitHubAuthenticationStatus() {
        Task.detached(priority: .utility) { [weak coordinator = self] in
            let connected = Self.resolveGitHubAuthenticationStatus()
            guard let coordinator else { return }
            await MainActor.run {
                coordinator.githubAccountConnected = connected
            }
        }
    }

    nonisolated static func resolveGitHubAuthenticationStatus() -> Bool {
        let environment = makeGitHubEnvironment()
        guard let executableURL = resolveGitHubExecutable(using: environment) else {
            return false
        }

        let process = Process()
        process.executableURL = executableURL
        process.arguments = ["auth", "status", "--hostname", "github.com"]
        process.environment = environment
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        process.standardInput = Pipe()

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return false
        }

        return process.terminationStatus == 0
    }

    func flushPendingGitSnapshots() {
        guard !pendingGitSnapshots.isEmpty else { return }
        let snapshots = pendingGitSnapshots
        for (index, snapshot) in snapshots {
            if sendGitStatusPayload(index: index, snapshot: snapshot) {
                pendingGitSnapshots.removeValue(forKey: index)
            }
        }
    }

    @discardableResult
    func sendGitStatusPayload(index: Int, snapshot: GitRepositoryMonitor.Snapshot) -> Bool {
        guard let webView = webView, bootstrapSent, sessionsStarted else {
            return false
        }
        let errorValue: String?
        if let error = snapshot.error {
            let trimmed = error.trimmingCharacters(in: .whitespacesAndNewlines)
            errorValue = trimmed.isEmpty ? nil : trimmed
        } else {
            errorValue = nil
        }
        let payload = GitStatusPayload(
            index: index,
            isRepository: snapshot.isRepository,
            insertions: snapshot.insertions,
            deletions: snapshot.deletions,
            changedFiles: snapshot.changedFiles,
            syncing: snapshot.syncing,
            error: errorValue
        )
        guard let json = jsonString(from: payload) else {
            print("Failed to encode GitStatusPayload for index", index)
            return true
        }
        let script = "window.updateGitStatus(\(json));"
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                print("updateGitStatus error:", error)
            }
        }
        return true
    }

    @discardableResult
    func sendGitDetailsPayload(index: Int, details: GitRepositoryMonitor.DetailsSnapshot) -> Bool {
        guard let webView = webView, bootstrapSent, sessionsStarted else {
            return false
        }

        let files = details.files.map { detail in
            GitFileDetailPayload(
                path: detail.path,
                previousPath: detail.previousPath,
                status: detail.status,
                insertions: detail.insertions,
                deletions: detail.deletions,
                diff: detail.diff
            )
        }

        let errorValue: String?
        if let error = details.error {
            let trimmed = error.trimmingCharacters(in: .whitespacesAndNewlines)
            errorValue = trimmed.isEmpty ? nil : trimmed
        } else {
            errorValue = nil
        }

        let payload = GitDetailsPayload(index: index, files: files, error: errorValue)
        guard let json = jsonString(from: payload) else {
            print("Failed to encode GitDetailsPayload for index", index)
            return true
        }

        let script = "window.showGitDetails(\(json));"
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                print("showGitDetails error:", error)
            }
        }

        return true
    }

    func configureGitMonitor(for pane: PaneState) {
        let directory = pane.config.workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !directory.isEmpty else {
            pane.gitMonitor?.invalidate()
            pane.gitMonitor = nil
            pane.githubActionsMonitor?.invalidate()
            pane.githubActionsMonitor = nil
            pendingGitHubActionSnapshots.removeValue(forKey: pane.runtimeIndex)
            return
        }

        if let existing = pane.gitMonitor {
            existing.updateWorkingDirectory(directory)
        } else {
            pane.gitMonitor = GitRepositoryMonitor(
                paneIndex: pane.runtimeIndex,
                workingDirectory: directory,
                coordinator: self
            )
        }

        configureGitHubActionsMonitor(for: pane, workingDirectory: directory)
    }
}

extension TerminalCoordinator {
    nonisolated static func makeGitHubEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["GH_PROMPT_DISABLED"] = "1"

        let preferredPaths = [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
        ]

        let existingPath = environment["PATH"] ?? ""
        var components = existingPath.split(separator: ":").map(String.init)
        var seen = Set(components)

        for path in preferredPaths.reversed() {
            if !seen.contains(path) {
                components.insert(path, at: 0)
                seen.insert(path)
            }
        }

        environment["PATH"] = components.joined(separator: ":")
        return environment
    }

    nonisolated static func resolveGitHubExecutable(using environment: [String: String]) -> URL? {
        let fileManager = FileManager.default

        if let override = environment["GH_CLI_PATH"], fileManager.isExecutableFile(atPath: override) {
            return URL(fileURLWithPath: override)
        }

        let pathValue = environment["PATH"] ?? ""
        for component in pathValue.split(separator: ":") {
            guard !component.isEmpty else { continue }
            let candidate = URL(fileURLWithPath: String(component)).appendingPathComponent("gh")
            if fileManager.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }

        return nil
    }
}
