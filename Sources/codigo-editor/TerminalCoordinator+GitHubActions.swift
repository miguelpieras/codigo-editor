import Foundation

private func formatGitHubActionDate(_ date: Date?) -> String? {
    guard let date else {
        return nil
    }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

extension TerminalCoordinator {
    struct GitHubActionStepPayload: Encodable {
        let name: String?
        let status: String?
        let conclusion: String?
        let number: Int?
        let log: String?
    }

    struct GitHubActionJobPayload: Encodable {
        let id: Int?
        let name: String?
        let status: String?
        let conclusion: String?
        let htmlURL: String?
        let startedAt: String?
        let completedAt: String?
        let steps: [GitHubActionStepPayload]
    }

    struct GitHubActionStatusPayload: Encodable {
        let index: Int
        let state: String
        let runId: Int?
        let workflowName: String?
        let displayTitle: String?
        let status: String?
        let conclusion: String?
        let headBranch: String?
        let headSha: String?
        let htmlURL: String?
        let event: String?
        let createdAt: String?
        let updatedAt: String?
        let startedAt: String?
        let completedAt: String?
        let jobs: [GitHubActionJobPayload]?
        let error: String?
    }

    func configureGitHubActionsMonitor(for pane: PaneState, workingDirectory: String) {
        if pane.column != .stacked {
            pane.githubActionsMonitor?.invalidate()
            pane.githubActionsMonitor = nil
            pendingGitHubActionSnapshots.removeValue(forKey: pane.runtimeIndex)
            return
        }

        let trimmed = workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            pane.githubActionsMonitor?.invalidate()
            pane.githubActionsMonitor = nil
            pendingGitHubActionSnapshots.removeValue(forKey: pane.runtimeIndex)
            return
        }

        if let existing = pane.githubActionsMonitor {
            existing.updateWorkingDirectory(trimmed)
        } else {
            pane.githubActionsMonitor = GitHubActionsMonitor(
                paneIndex: pane.runtimeIndex,
                workingDirectory: trimmed,
                coordinator: self
            )
        }
    }

    func publishGitHubActionStatus(index: Int, snapshot: GitHubActionsMonitor.Snapshot) {
        guard sendGitHubActionStatusPayload(index: index, snapshot: snapshot) else {
            pendingGitHubActionSnapshots[index] = snapshot
            return
        }
        pendingGitHubActionSnapshots.removeValue(forKey: index)
    }

    func flushPendingGitHubActionSnapshots() {
        guard !pendingGitHubActionSnapshots.isEmpty else { return }
        let pending = pendingGitHubActionSnapshots
        for (index, snapshot) in pending {
            if sendGitHubActionStatusPayload(index: index, snapshot: snapshot) {
                pendingGitHubActionSnapshots.removeValue(forKey: index)
            }
        }
    }

    @discardableResult
    func sendGitHubActionStatusPayload(index: Int, snapshot: GitHubActionsMonitor.Snapshot) -> Bool {
        guard let webView = webView, bootstrapSent, sessionsStarted else {
            return false
        }

        let jobs = snapshot.run?.jobs.map { job in
            GitHubActionJobPayload(
                id: job.id,
                name: job.name,
                status: job.status,
                conclusion: job.conclusion,
                htmlURL: job.htmlURL,
                startedAt: formatGitHubActionDate(job.startedAt),
                completedAt: formatGitHubActionDate(job.completedAt),
                steps: job.steps.map { step in
                    GitHubActionStepPayload(
                        name: step.name,
                        status: step.status,
                        conclusion: step.conclusion,
                        number: step.number,
                        log: step.log
                    )
                }
            )
        }

        let payload = GitHubActionStatusPayload(
            index: index,
            state: snapshot.state.rawValue,
            runId: snapshot.run?.id,
            workflowName: snapshot.run?.workflowName,
            displayTitle: snapshot.run?.displayTitle,
            status: snapshot.run?.status,
            conclusion: snapshot.run?.conclusion,
            headBranch: snapshot.run?.headBranch,
            headSha: snapshot.run?.headSha,
            htmlURL: snapshot.run?.htmlURL,
            event: snapshot.run?.event,
            createdAt: formatGitHubActionDate(snapshot.run?.createdAt),
            updatedAt: formatGitHubActionDate(snapshot.run?.updatedAt),
            startedAt: formatGitHubActionDate(snapshot.run?.startedAt),
            completedAt: formatGitHubActionDate(snapshot.run?.completedAt),
            jobs: jobs,
            error: snapshot.error
        )

        guard let json = jsonString(from: payload) else {
            print("Failed to encode GitHubActionStatusPayload for index", index)
            return true
        }

        let script = "window.updateGitHubActionStatus(\(json));"
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                print("updateGitHubActionStatus error:", error)
            }
        }
        return true
    }
}

extension TerminalCoordinator {
    final class GitHubActionsMonitor: @unchecked Sendable {
        enum SnapshotState: String {
            case unknown
            case success
            case failure
            case inProgress
        }

        struct Snapshot: Equatable {
            var state: SnapshotState
            var run: RunSummary?
            var error: String?
        }

        struct RunSummary: Equatable {
            var id: Int?
            var workflowName: String?
            var displayTitle: String?
            var status: String?
            var conclusion: String?
            var headBranch: String?
            var headSha: String?
            var htmlURL: String?
            var event: String?
            var createdAt: Date?
            var updatedAt: Date?
            var startedAt: Date?
            var completedAt: Date?
            var jobs: [JobSummary]
        }

        struct JobSummary: Equatable {
            var id: Int?
            var name: String?
            var status: String?
            var conclusion: String?
            var htmlURL: String?
            var startedAt: Date?
            var completedAt: Date?
            var steps: [StepSummary]
        }

        struct StepSummary: Equatable {
            var name: String?
            var status: String?
            var conclusion: String?
            var number: Int?
            var log: String?
        }

        private struct LatestRunResult {
            var summary: RunSummary
            var state: SnapshotState
        }

        private struct GitHubCommandResult {
            let status: Int32
            let stdout: String
            let stderr: String
        }

        private struct GitHubBinaryCommandResult {
            let status: Int32
            let stdout: Data
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

        private struct RunListItem: Decodable {
            let id: Int?
            let databaseId: Int?
            let name: String?
            let workflowName: String?
            let displayTitle: String?
            let status: String?
            let conclusion: String?
            let headBranch: String?
            let headSha: String?
            let htmlURL: String?
            let url: String?
            let event: String?
            let createdAt: Date?
            let updatedAt: Date?
            let startedAt: Date?
            let completedAt: Date?
        }

        private struct RunViewResponse: Decodable {
            let databaseId: Int?
            let name: String?
            let workflowName: String?
            let displayTitle: String?
            let status: String?
            let conclusion: String?
            let headBranch: String?
            let headSha: String?
            let htmlURL: String?
            let url: String?
            let event: String?
            let createdAt: Date?
            let updatedAt: Date?
            let startedAt: Date?
            let completedAt: Date?
            let jobs: [RunJob]?
        }

        private struct RunJob: Decodable {
            let databaseId: Int?
            let name: String?
            let status: String?
            let conclusion: String?
            let htmlURL: String?
            let url: String?
            let startedAt: Date?
            let completedAt: Date?
            let steps: [RunJobStep]?
        }

        private struct RunJobStep: Decodable {
            let name: String?
            let status: String?
            let conclusion: String?
            let number: Int?
        }

        private struct RepositoryViewResponse: Decodable {
            let nameWithOwner: String
        }

        private struct RunDetails {
            var status: String?
            var conclusion: String?
            var workflowName: String?
            var displayTitle: String?
            var headBranch: String?
            var headSha: String?
            var htmlURL: String?
            var event: String?
            var createdAt: Date?
            var updatedAt: Date?
            var startedAt: Date?
            var completedAt: Date?
            var jobs: [JobSummary]
        }

        private let paneIndex: Int
        private weak var coordinator: TerminalCoordinator?
        private let queue: DispatchQueue
        private var timer: DispatchSourceTimer?
        private var followUpTasks: [DispatchWorkItem] = []
        private var workingDirectory: URL
        private var lastSnapshot = Snapshot(state: .unknown, run: nil, error: nil)
        private var awaitingNewRunIdentifier: String?
        private var awaitingNewRunDeadline: Date?
        private var lastPublishedRunIdentifier: String?
        private var lastPublishedRun: RunSummary?
        private var cachedRepository: String?
        private var cachedExecutableURL: URL?
        private var isInvalidated = false
        private let refreshInterval: DispatchTimeInterval = .seconds(30)
        private let environment: [String: String]
        private let fileManager = FileManager.default
        private lazy var decoder: JSONDecoder = {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return decoder
        }()
        private static let maxStepLogCharacters = 8000
        private static let maxStepLogBytes = 512_000
        private static let stepLogTruncationSuffix = "\n... log truncated ..."
        private static let newRunGraceInterval: TimeInterval = 180
        private static let ansiEscapeRegex: NSRegularExpression? = {
            let escape = "\u{001B}"
            return try? NSRegularExpression(
                pattern: "\(escape)\\[[0-9;?]*[ -/]*[@-~]",
                options: []
            )
        }()

        init(paneIndex: Int, workingDirectory: String, coordinator: TerminalCoordinator) {
            self.paneIndex = paneIndex
            self.coordinator = coordinator
            self.queue = DispatchQueue(label: "codigo-editor.github-actions.\(paneIndex)", qos: .utility)
            self.environment = TerminalCoordinator.makeGitHubEnvironment()
            self.workingDirectory = URL(fileURLWithPath: workingDirectory, isDirectory: true).standardizedFileURL
            startTimer()
            queue.async { [weak self] in
                self?.refresh(immediate: true)
            }
        }

        func updateWorkingDirectory(_ path: String) {
            let directory = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
            queue.async { [weak self] in
                guard let self, !self.isInvalidated else { return }
                self.workingDirectory = directory
                self.cachedRepository = nil
                self.refresh(immediate: true)
            }
        }

        func requestImmediateRefresh() {
            queue.async { [weak self] in
                self?.refresh(immediate: true)
            }
        }

        func notifySyncTriggered() {
            queue.async { [weak self] in
                guard let self, !self.isInvalidated else { return }
                let previousIdentifier = self.lastPublishedRunIdentifier
                    ?? self.deriveRunIdentifier(from: self.lastSnapshot.run ?? self.lastPublishedRun)
                self.awaitingNewRunIdentifier = previousIdentifier ?? "unknown-run"
                self.awaitingNewRunDeadline = Date().addingTimeInterval(Self.newRunGraceInterval)

                let resetSnapshot = Snapshot(state: .unknown, run: nil, error: nil)
                self.lastSnapshot = resetSnapshot

                Task { @MainActor [weak self] in
                    guard let self, let coordinator = self.coordinator else { return }
                    coordinator.publishGitHubActionStatus(index: self.paneIndex, snapshot: resetSnapshot)
                }

                self.refresh(immediate: true)
                self.scheduleFollowUpRefreshes()
            }
        }

        func invalidate() {
            queue.async { [weak self] in
                guard let self, !self.isInvalidated else { return }
                self.isInvalidated = true
                self.timer?.cancel()
                self.timer = nil
                self.followUpTasks.forEach { $0.cancel() }
                self.followUpTasks.removeAll()
            }
        }

        private func scheduleFollowUpRefreshes() {
            followUpTasks.forEach { $0.cancel() }
            followUpTasks.removeAll()
            let intervals: [DispatchTimeInterval] = [.seconds(15), .seconds(45), .seconds(120)]
            for interval in intervals {
                let work = DispatchWorkItem { [weak self] in
                    self?.refresh(immediate: true)
                }
                followUpTasks.append(work)
                queue.asyncAfter(deadline: .now() + interval, execute: work)
            }
        }

        private func deriveRunIdentifier(from summary: RunSummary?) -> String? {
            guard let summary else { return nil }
            if let id = summary.id {
                return "id:\(id)"
            }
            if let headSha = summary.headSha?.trimmingCharacters(in: .whitespacesAndNewlines), !headSha.isEmpty {
                return "sha:\(headSha)"
            }
            if let completedAt = summary.completedAt {
                return "completed:\(completedAt.timeIntervalSince1970)"
            }
            if let startedAt = summary.startedAt {
                return "started:\(startedAt.timeIntervalSince1970)"
            }
            if let htmlURL = summary.htmlURL?.trimmingCharacters(in: .whitespacesAndNewlines), !htmlURL.isEmpty {
                return "url:\(htmlURL)"
            }
            return "unknown-run"
        }

        private func startTimer() {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + refreshInterval, repeating: refreshInterval)
            timer.setEventHandler { [weak self] in
                self?.refresh(immediate: false)
            }
            timer.resume()
            self.timer = timer
        }

        private func refresh(immediate: Bool) {
            guard !isInvalidated else { return }
            let snapshot = computeSnapshot()
            guard snapshot != lastSnapshot || immediate else { return }
            lastSnapshot = snapshot
            if let run = snapshot.run {
                lastPublishedRun = run
                lastPublishedRunIdentifier = deriveRunIdentifier(from: run)
            }
            Task { @MainActor [weak self] in
                guard let self, let coordinator = self.coordinator else { return }
                coordinator.publishGitHubActionStatus(index: self.paneIndex, snapshot: snapshot)
            }
        }

        private func computeSnapshot() -> Snapshot {
            guard let directory = resolvedWorkingDirectory() else {
                return Snapshot(state: .unknown, run: nil, error: "Working directory unavailable")
            }

            guard resolveExecutable() != nil else {
                return Snapshot(state: .unknown, run: nil, error: "GitHub CLI not available")
            }

            guard let repository = resolveRepositorySlug(in: directory) else {
                return Snapshot(state: .unknown, run: nil, error: "GitHub repository not detected")
            }

            let (latestResult, latestError) = fetchLatestRun(for: repository)
            if let latestError, !latestError.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let trimmed = latestError.trimmingCharacters(in: .whitespacesAndNewlines)
                return Snapshot(state: .unknown, run: nil, error: trimmed)
            }

            if let deadline = awaitingNewRunDeadline, Date() > deadline {
                awaitingNewRunIdentifier = nil
                awaitingNewRunDeadline = nil
            }

            if let awaitingIdentifier = awaitingNewRunIdentifier {
                if let latestResult {
                    let latestIdentifier = deriveRunIdentifier(from: latestResult.summary)
                    if latestIdentifier == awaitingIdentifier {
                        return Snapshot(state: .unknown, run: nil, error: nil)
                    }
                    awaitingNewRunIdentifier = nil
                    awaitingNewRunDeadline = nil
                } else {
                    return Snapshot(state: .unknown, run: nil, error: nil)
                }
            }

            guard let latest = latestResult else {
                return Snapshot(state: .unknown, run: nil, error: nil)
            }

            var summary = latest.summary
            let state = latest.state

            if state == .failure, let runId = summary.id {
                let (details, _) = fetchRunDetails(runId: runId, repository: repository)
                if let details {
                    summary.status = details.status ?? summary.status
                    summary.conclusion = details.conclusion ?? summary.conclusion
                    summary.workflowName = details.workflowName ?? summary.workflowName
                    summary.displayTitle = details.displayTitle ?? summary.displayTitle
                    summary.headBranch = details.headBranch ?? summary.headBranch
                    summary.headSha = details.headSha ?? summary.headSha
                    summary.htmlURL = details.htmlURL ?? summary.htmlURL
                    summary.event = details.event ?? summary.event
                    summary.createdAt = details.createdAt ?? summary.createdAt
                    summary.updatedAt = details.updatedAt ?? summary.updatedAt
                    summary.startedAt = details.startedAt ?? summary.startedAt
                    summary.completedAt = details.completedAt ?? summary.completedAt
                    summary.jobs = details.jobs
                }
            }

            return Snapshot(state: state, run: summary, error: nil)
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

        private func resolveExecutable() -> URL? {
            if let cachedExecutableURL {
                return cachedExecutableURL
            }
            guard let url = TerminalCoordinator.resolveGitHubExecutable(using: environment) else {
                return nil
            }
            cachedExecutableURL = url
            return url
        }

        private func resolveRepositorySlug(in directory: URL) -> String? {
            if let cachedRepository {
                return cachedRepository
            }
            guard let result = runGitHub(arguments: ["repo", "view", "--json", "nameWithOwner"]) else {
                return nil
            }
            guard result.status == 0, let data = result.stdout.data(using: .utf8) else {
                return nil
            }
            guard let response = try? decoder.decode(RepositoryViewResponse.self, from: data) else {
                return nil
            }
            cachedRepository = response.nameWithOwner
            return response.nameWithOwner
        }

        private func fetchLatestRun(for repository: String) -> (LatestRunResult?, String?) {
            let fields = "databaseId,name,workflowName,displayTitle,status,conclusion,headBranch,headSha,url,event,createdAt,updatedAt,startedAt"
            guard let result = runGitHub(arguments: [
                "run", "list",
                "--limit", "1",
                "--json", fields,
                "--repo", repository
            ]) else {
                return (nil, "GitHub CLI not available")
            }

            if result.status != 0 {
                let message = result.stderr.isEmpty ? "Failed to read GitHub Actions runs" : result.stderr
                return (nil, message)
            }

            guard let data = result.stdout.data(using: .utf8) else {
                return (nil, nil)
            }

            guard let runs = try? decoder.decode([RunListItem].self, from: data), let first = runs.first else {
                return (nil, nil)
            }

            let summary = RunSummary(
                id: first.databaseId ?? first.id,
                workflowName: first.workflowName ?? first.name,
                displayTitle: first.displayTitle ?? first.name,
                status: first.status,
                conclusion: first.conclusion,
                headBranch: first.headBranch,
                headSha: first.headSha,
                htmlURL: first.htmlURL ?? first.url,
                event: first.event,
                createdAt: first.createdAt,
                updatedAt: first.updatedAt,
                startedAt: first.startedAt,
                completedAt: first.completedAt,
                jobs: []
            )

            let state = determineState(status: first.status, conclusion: first.conclusion)
            return (LatestRunResult(summary: summary, state: state), nil)
        }

        private func fetchRunDetails(runId: Int, repository: String) -> (RunDetails?, String?) {
            let fields = "databaseId,name,workflowName,displayTitle,status,conclusion,headBranch,headSha,url,event,createdAt,updatedAt,startedAt,jobs"
            guard let result = runGitHub(arguments: [
                "run", "view", String(runId),
                "--json", fields,
                "--repo", repository
            ]) else {
                return (nil, "GitHub CLI not available")
            }

            if result.status != 0 {
                let message = result.stderr.isEmpty ? "Failed to load run details" : result.stderr
                return (nil, message)
            }

            guard let data = result.stdout.data(using: .utf8) else {
                return (nil, nil)
            }

            guard let response = try? decoder.decode(RunViewResponse.self, from: data) else {
                return (nil, nil)
            }

            var jobs = (response.jobs ?? []).map { job in
                JobSummary(
                    id: job.databaseId,
                    name: job.name,
                    status: job.status,
                    conclusion: job.conclusion,
                    htmlURL: job.htmlURL ?? job.url,
                    startedAt: job.startedAt,
                    completedAt: job.completedAt,
                    steps: (job.steps ?? []).map { step in
                        StepSummary(name: step.name, status: step.status, conclusion: step.conclusion, number: step.number, log: nil)
                    }
                )
            }

            if !jobs.isEmpty {
                let jobLogs = fetchFailedStepLogs(for: jobs, repository: repository)
                if !jobLogs.isEmpty {
                    jobs = jobs.map { job in
                        guard let jobId = job.id, let stepLogs = jobLogs[jobId] else {
                            return job
                        }
                        var mutableJob = job
                        mutableJob.steps = job.steps.map { step in
                            var mutableStep = step
                            if let number = step.number, let log = stepLogs[number] {
                                mutableStep.log = log
                            }
                            return mutableStep
                        }
                        return mutableJob
                    }
                }
            }

            let details = RunDetails(
                status: response.status,
                conclusion: response.conclusion,
                workflowName: response.workflowName ?? response.name,
                displayTitle: response.displayTitle ?? response.name,
                headBranch: response.headBranch,
                headSha: response.headSha,
                htmlURL: response.htmlURL ?? response.url,
                event: response.event,
                createdAt: response.createdAt,
                updatedAt: response.updatedAt,
                startedAt: response.startedAt,
                completedAt: response.completedAt,
                jobs: jobs
            )

            return (details, nil)
        }

        private func runGitHubBinary(arguments: [String]) -> GitHubBinaryCommandResult? {
            guard let executable = resolveExecutable() else {
                return GitHubBinaryCommandResult(status: -1, stdout: Data(), stderr: "GitHub CLI not available")
            }

            let process = Process()
            process.executableURL = executable
            process.arguments = arguments
            process.environment = environment
            process.currentDirectoryURL = workingDirectory
            process.standardInput = nil

            return runProcess(process)
        }

        private func runGitHub(arguments: [String]) -> GitHubCommandResult? {
            guard let executable = resolveExecutable() else {
                return GitHubCommandResult(status: -1, stdout: "", stderr: "GitHub CLI not available")
            }

            let process = Process()
            process.executableURL = executable
            process.arguments = arguments
            process.environment = environment
            process.currentDirectoryURL = workingDirectory
            process.standardInput = nil

            let result = runProcess(process)
            let stdoutString = String(data: result.stdout, encoding: .utf8) ?? ""
            return GitHubCommandResult(status: result.status, stdout: stdoutString, stderr: result.stderr)
        }

        // Drain stdout/stderr concurrently so large `gh api` responses cannot block on pipe buffers.
        private func runProcess(_ process: Process) -> GitHubBinaryCommandResult {
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
                return GitHubBinaryCommandResult(status: -1, stdout: Data(), stderr: String(describing: error))
            }

            process.waitUntilExit()
            stdoutPipe.fileHandleForWriting.closeFile()
            stderrPipe.fileHandleForWriting.closeFile()
            group.wait()
            stdoutPipe.fileHandleForReading.closeFile()
            stderrPipe.fileHandleForReading.closeFile()

            let stdoutData = stdoutAccumulator.value()
            let stderrString = String(data: stderrAccumulator.value(), encoding: .utf8) ?? ""
            return GitHubBinaryCommandResult(status: process.terminationStatus, stdout: stdoutData, stderr: stderrString)
        }

        private func fetchFailedStepLogs(for jobs: [JobSummary], repository: String) -> [Int: [Int: String]] {
            let jobIdentifiers = jobs.compactMap { job -> Int? in
                guard let id = job.id else { return nil }
                let jobState = determineState(status: job.status, conclusion: job.conclusion)
                if jobState == .failure {
                    return id
                }
                let hasFailingStep = job.steps.contains { step in
                    determineState(status: step.status, conclusion: step.conclusion) == .failure
                }
                return hasFailingStep ? id : nil
            }

            guard !jobIdentifiers.isEmpty else {
                return [:]
            }

            var logsByJob: [Int: [Int: String]] = [:]
            for jobId in jobIdentifiers {
                guard let archiveData = fetchJobLogArchive(jobId: jobId, repository: repository) else {
                    continue
                }
                let stepLogs = extractStepLogs(from: archiveData)
                if !stepLogs.isEmpty {
                    logsByJob[jobId] = stepLogs
                }
            }
            return logsByJob
        }

        private func fetchJobLogArchive(jobId: Int, repository: String) -> Data? {
            let path = "repos/\(repository)/actions/jobs/\(jobId)/logs"
            guard let result = runGitHubBinary(arguments: ["api", path]) else {
                return nil
            }
            guard result.status == 0 else {
                return nil
            }
            return result.stdout
        }

        private func extractStepLogs(from archiveData: Data) -> [Int: String] {
            guard !archiveData.isEmpty else {
                return [:]
            }

            let baseDirectory = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            let container = baseDirectory.appendingPathComponent("codigo-editor-gh-logs-\(UUID().uuidString)", isDirectory: true)
            let archiveURL = container.appendingPathComponent("logs.zip", isDirectory: false)
            let extractionURL = container.appendingPathComponent("contents", isDirectory: true)

            do {
                try fileManager.createDirectory(at: container, withIntermediateDirectories: true)
                try archiveData.write(to: archiveURL, options: [.atomic])
            } catch {
                try? fileManager.removeItem(at: container)
                return [:]
            }

            defer {
                try? fileManager.removeItem(at: container)
            }

            guard unzipArchive(zipURL: archiveURL, destinationURL: extractionURL) else {
                return [:]
            }

            guard let enumerator = fileManager.enumerator(
                at: extractionURL,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            ) else {
                return [:]
            }

            var logs: [Int: String] = [:]

            for case let fileURL as URL in enumerator {
                do {
                    let resourceValues = try fileURL.resourceValues(forKeys: [.isDirectoryKey])
                    if resourceValues.isDirectory == true {
                        continue
                    }
                } catch {
                    continue
                }

                let relativePath = fileURL.path
                guard let stepNumber = parseStepNumber(fromArchivePath: relativePath) else {
                    continue
                }

                let truncatedByBytes: Bool
                do {
                    let resourceValues = try fileURL.resourceValues(forKeys: [.fileSizeKey])
                    let fileSize = resourceValues.fileSize ?? 0
                    truncatedByBytes = fileSize > Self.maxStepLogBytes
                } catch {
                    truncatedByBytes = false
                }

                let data: Data
                do {
                    let handle = try FileHandle(forReadingFrom: fileURL)
                    defer { try? handle.close() }
                    data = try handle.read(upToCount: Self.maxStepLogBytes) ?? Data()
                } catch {
                    continue
                }

                guard !data.isEmpty else {
                    continue
                }

                var logText = String(decoding: data, as: UTF8.self)
                logText = sanitiseLogText(logText, truncatedBySource: truncatedByBytes)

                guard !logText.isEmpty else {
                    continue
                }

                if let existing = logs[stepNumber] {
                    if existing.hasSuffix(Self.stepLogTruncationSuffix) {
                        continue
                    }
                    let combined = existing + "\n\n" + logText
                    logs[stepNumber] = truncateCombinedLog(combined)
                } else {
                    logs[stepNumber] = logText
                }
            }

            return logs
        }

        private func unzipArchive(zipURL: URL, destinationURL: URL) -> Bool {
            do {
                if !fileManager.fileExists(atPath: destinationURL.path) {
                    try fileManager.createDirectory(at: destinationURL, withIntermediateDirectories: true)
                }
            } catch {
                return false
            }

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
            process.arguments = ["-qq", zipURL.path, "-d", destinationURL.path]
            process.standardOutput = Pipe()
            process.standardError = Pipe()

            do {
                try process.run()
                process.waitUntilExit()
            } catch {
                return false
            }

            return process.terminationStatus == 0
        }

        private func parseStepNumber(fromArchivePath path: String) -> Int? {
            for component in path.split(separator: "/").reversed() {
                if let value = extractStepNumber(from: component) {
                    return value
                }
            }
            return nil
        }

        private func extractStepNumber(from component: Substring) -> Int? {
            var digits = ""
            var foundDigits = false
            for character in component {
                if character.isWholeNumber {
                    digits.append(character)
                    foundDigits = true
                } else if foundDigits {
                    break
                }
            }

            guard foundDigits, let value = Int(digits), (0..<10_000).contains(value) else {
                return nil
            }
            return value
        }

        private func sanitiseLogText(_ text: String, truncatedBySource: Bool) -> String {
            var cleaned = text.replacingOccurrences(of: "\r\n", with: "\n")
            cleaned = cleaned.replacingOccurrences(of: "\r", with: "\n")
            cleaned = cleaned.replacingOccurrences(of: "\u{0000}", with: "")
            cleaned = stripANSIEscapeSequences(from: cleaned)
            cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)

            guard !cleaned.isEmpty else {
                return ""
            }

            var truncated = truncatedBySource
            if cleaned.count > Self.maxStepLogCharacters {
                let index = cleaned.index(cleaned.startIndex, offsetBy: Self.maxStepLogCharacters)
                cleaned = String(cleaned[..<index])
                truncated = true
            }

            if truncated && !cleaned.hasSuffix(Self.stepLogTruncationSuffix) {
                cleaned += Self.stepLogTruncationSuffix
            }

            return cleaned
        }

        private func truncateCombinedLog(_ text: String) -> String {
            guard text.count > Self.maxStepLogCharacters else {
                return text
            }
            let index = text.index(text.startIndex, offsetBy: Self.maxStepLogCharacters)
            var truncated = String(text[..<index])
            if !truncated.hasSuffix(Self.stepLogTruncationSuffix) {
                truncated += Self.stepLogTruncationSuffix
            }
            return truncated
        }

        private func stripANSIEscapeSequences(from text: String) -> String {
            guard let regex = Self.ansiEscapeRegex else {
                return text
            }
            let range = NSRange(text.startIndex..<text.endIndex, in: text)
            return regex.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: "")
        }

        private func determineState(status: String?, conclusion: String?) -> SnapshotState {
            let normalizedStatus = status?.lowercased() ?? ""
            let normalizedConclusion = conclusion?.lowercased() ?? ""

            switch normalizedStatus {
            case "queued", "in_progress", "waiting":
                return .inProgress
            case "completed":
                if normalizedConclusion == "success" {
                    return .success
                }
                if normalizedConclusion.isEmpty {
                    return .unknown
                }
                return .failure
            default:
                if normalizedConclusion == "success" {
                    return .success
                }
                if normalizedConclusion.isEmpty {
                    return .unknown
                }
                return .failure
            }
        }
    }
}
