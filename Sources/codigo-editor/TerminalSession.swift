import AppKit
import Darwin
import Foundation

@MainActor
final class TerminalSession {
    struct LaunchPlan: Equatable {
        let arguments: [String]
        let environment: [String: String]
    }

    private let index: Int
    private unowned let coordinator: TerminalCoordinator
    private let process = Process()
    private let masterFD: Int32
    private var readSource: DispatchSourceRead?
    private var workingDirectoryMonitor: DispatchSourceTimer?
    private var lastReportedWorkingDirectory: String
    private var processGroupID: pid_t?
    private var hasTerminatedProcess = false
    private var hasReportedTermination = false

    nonisolated private static let startupCommandEnvironmentKey = "CODIGO_STARTUP_COMMAND"
    nonisolated private static let startupNoticeEnvironmentKey = "CODIGO_STARTUP_NOTICE"

    init(
        index: Int,
        config: TerminalConfig,
        environmentOverrides: [String: String] = [:],
        coordinator: TerminalCoordinator
    ) throws {
        self.index = index
        self.coordinator = coordinator

        var master: Int32 = -1
        var slave: Int32 = -1
        var win = winsize(ws_row: 40, ws_col: 120, ws_xpixel: 0, ws_ypixel: 0)

        guard openpty(&master, &slave, nil, nil, &win) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: nil)
        }

        masterFD = master

        let slaveHandle = FileHandle(fileDescriptor: slave, closeOnDealloc: true)

        let requestedDirectory = URL(fileURLWithPath: config.workingDirectory)
        let fileManager = FileManager.default
        let directoryExists = fileManager.fileExists(atPath: requestedDirectory.path)
        let resolvedDirectory = directoryExists ? requestedDirectory : fileManager.homeDirectoryForCurrentUser
        lastReportedWorkingDirectory = resolvedDirectory.path

        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.currentDirectoryURL = resolvedDirectory

        var environment = ProcessInfo.processInfo.environment
        environment["TERM"] = environment["TERM"] ?? "xterm-256color"
        environment["COLORTERM"] = environment["COLORTERM"] ?? "truecolor"
        environment["PWD"] = resolvedDirectory.path
        environment["OLDPWD"] = resolvedDirectory.path
        environmentOverrides.forEach { key, value in
            environment[key] = value
        }
        environment = Self.bootstrapEnvironment(environment)
        let initialNotice: String?
        if directoryExists {
            initialNotice = nil
        } else {
            initialNotice = "Directory \(config.workingDirectory) not found. Using \(resolvedDirectory.path)."
        }
        let startupCommand = config.startupCommand?.trimmingCharacters(in: .whitespacesAndNewlines)
        let launchPlan = Self.makeLaunchPlan(
            startupCommand: startupCommand?.isEmpty == false ? startupCommand : nil,
            initialNotice: initialNotice,
            environment: environment
        )
        process.arguments = launchPlan.arguments
        process.environment = launchPlan.environment

        process.standardInput = slaveHandle
        process.standardOutput = slaveHandle
        process.standardError = slaveHandle

        try process.run()
        processGroupID = resolvedProcessGroupID(for: process.processIdentifier)
        slaveHandle.closeFile()

        let source = DispatchSource.makeReadSource(fileDescriptor: masterFD, queue: .main)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            var buffer = [UInt8](repeating: 0, count: 4096)
            let bytesRead = read(self.masterFD, &buffer, buffer.count)
            if bytesRead > 0 {
                let data = Data(bytes: buffer, count: bytesRead)
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    self.coordinator.sendToWebView(index: self.index, data: data)
                }
            } else if bytesRead == 0 {
                self.finishSessionMonitoring()
            } else {
                switch errno {
                case EINTR, EAGAIN, EWOULDBLOCK:
                    return
                default:
                    self.finishSessionMonitoring()
                }
            }
        }
        source.setCancelHandler { close(master) }
        source.resume()
        readSource = source
        startMonitoringWorkingDirectory()
    }

    func send(command: String) {
        if let data = command.data(using: .utf8) {
            send(data: data)
        }
    }

    private func resolvedProcessGroupID(for pid: pid_t) -> pid_t? {
        guard pid > 0 else { return nil }
        let group = getpgid(pid)
        if group != -1 {
            return group
        }
        let errorCode = errno
        if errorCode == ESRCH {
            return nil
        }
        return pid
    }

    func send(data: Data) {
        let payload = filterControlSignals(from: data)
        guard !payload.isEmpty else { return }
        payload.withUnsafeBytes { ptr in
            guard let base = ptr.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            var bytesWritten = 0
            while bytesWritten < payload.count {
                let result = write(masterFD, base + bytesWritten, payload.count - bytesWritten)
                if result > 0 {
                    bytesWritten += result
                    continue
                }
                if result == -1 {
                    switch errno {
                    case EINTR:
                        continue
                    case EAGAIN, EWOULDBLOCK:
                        continue
                    default:
                        return
                    }
                } else {
                    return
                }
            }
        }
    }

    enum ControlCharacter: UInt8, CaseIterable {
        case interrupt = 0x03 // Ctrl-C
        case suspend = 0x1A   // Ctrl-Z
        case quit = 0x1C      // Ctrl-\\

        var signalValue: Int32 {
            switch self {
            case .interrupt:
                return SIGINT
            case .suspend:
                return SIGTSTP
            case .quit:
                return SIGQUIT
            }
        }
    }

    func sendControlCharacter(_ control: ControlCharacter) {
        send(data: Data([control.rawValue]))
    }

    private func filterControlSignals(from data: Data) -> Data {
        guard !data.isEmpty else { return data }

        let shouldGenerateSignals = shouldGenerateSignal()
        var filtered: Data?

        for (index, byte) in data.enumerated() {
            guard let control = ControlCharacter(rawValue: byte) else {
                filtered?.append(byte)
                continue
            }

            if shouldGenerateSignals {
                if filtered == nil {
                    filtered = Data(data[..<index])
                }
                sendSignal(control.signalValue)
                continue
            }
            filtered?.append(byte)
        }

        return filtered ?? data
    }

    private func shouldGenerateSignal() -> Bool {
        var attributes = termios()
        if tcgetattr(masterFD, &attributes) == 0 {
            return (attributes.c_lflag & tcflag_t(ISIG)) != 0
        }
        return true
    }

    private func foregroundProcessGroupID() -> pid_t? {
        let groupID = tcgetpgrp(masterFD)
        if groupID != -1 {
            return groupID
        }
        return nil
    }

    private func sendSignal(_ signal: Int32) {
        var attemptedGroups = Set<pid_t>()

        if let foregroundGroup = foregroundProcessGroupID(), foregroundGroup > 0 {
            attemptedGroups.insert(foregroundGroup)
            if killpg(foregroundGroup, signal) == 0 {
                return
            }
        }

        if let groupID = processGroupID, groupID > 0, !attemptedGroups.contains(groupID) {
            attemptedGroups.insert(groupID)
            if killpg(groupID, signal) == 0 {
                return
            }
        }

        let pid = process.processIdentifier
        if pid > 0, !attemptedGroups.contains(pid) {
            _ = Darwin.kill(pid, signal)
        }
    }

    func resize(cols: Int, rows: Int) {
        let clampedCols = max(cols, 1)
        let clampedRows = max(rows, 1)
        var size = winsize(
            ws_row: UInt16(clampedRows),
            ws_col: UInt16(clampedCols),
            ws_xpixel: 0,
            ws_ypixel: 0
        )
        _ = ioctl(masterFD, TIOCSWINSZ, &size)
        if process.isRunning {
            kill(process.processIdentifier, SIGWINCH)
        }
    }

    func terminate() {
        guard !hasTerminatedProcess else { return }
        hasTerminatedProcess = true

        readSource?.cancel()
        readSource = nil
        workingDirectoryMonitor?.cancel()
        workingDirectoryMonitor = nil

        let groupID = processGroupID
        let pid = process.processIdentifier

        if let groupID, groupID > 0 {
            _ = killpg(groupID, SIGTERM)
        }

        if process.isRunning {
            process.terminate()
        }

        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(500)) {
            if let groupID, groupID > 0 {
                _ = killpg(groupID, SIGKILL)
            }
            if pid > 0 {
                _ = Darwin.kill(pid, SIGKILL)
            }
        }
    }

    private func startMonitoringWorkingDirectory() {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            guard self.process.isRunning else {
                self.stopMonitoringWorkingDirectory()
                return
            }
            guard let path = self.currentWorkingDirectoryPath(), path != self.lastReportedWorkingDirectory else {
                return
            }
            self.lastReportedWorkingDirectory = path
            self.coordinator.paneWorkingDirectoryDidChange(index: self.index, path: path)
        }
        timer.resume()
        workingDirectoryMonitor = timer
    }

    private func stopMonitoringWorkingDirectory() {
        workingDirectoryMonitor?.cancel()
        workingDirectoryMonitor = nil
    }

    private func finishSessionMonitoring() {
        stopMonitoringWorkingDirectory()
        readSource?.cancel()
        readSource = nil
        reportSessionDidEndIfNeeded()
    }

    private func reportSessionDidEndIfNeeded() {
        guard !hasReportedTermination else {
            return
        }
        hasReportedTermination = true
        coordinator.sessionDidEnd(self, at: index)
    }

    private func currentWorkingDirectoryPath() -> String? {
        var info = proc_vnodepathinfo()
        let size = MemoryLayout<proc_vnodepathinfo>.size
        let result = withUnsafeMutablePointer(to: &info) { pointer -> Int32 in
            pointer.withMemoryRebound(to: UInt8.self, capacity: size) { rawPointer in
                proc_pidinfo(self.process.processIdentifier, PROC_PIDVNODEPATHINFO, 0, rawPointer, Int32(size))
            }
        }

        guard result == Int32(size) else {
            return nil
        }

        return withUnsafePointer(to: &info.pvi_cdir.vip_path.0) { ptr -> String in
            ptr.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { cStringPtr in
                String(cString: cStringPtr)
            }
        }
    }

    nonisolated static func makeLaunchPlan(
        startupCommand: String?,
        initialNotice: String?,
        environment: [String: String]
    ) -> LaunchPlan {
        var updatedEnvironment = environment
        updatedEnvironment["PROMPT_EOL_MARK"] = ""
        updatedEnvironment.removeValue(forKey: startupCommandEnvironmentKey)
        updatedEnvironment.removeValue(forKey: startupNoticeEnvironmentKey)

        guard startupCommand != nil || initialNotice != nil else {
            return LaunchPlan(arguments: ["-f", "-i"], environment: updatedEnvironment)
        }

        if let startupCommand {
            updatedEnvironment[startupCommandEnvironmentKey] = startupCommand
        }
        if let initialNotice {
            updatedEnvironment[startupNoticeEnvironmentKey] = initialNotice
        }

        let startupScript = """
        if [[ -n "${\(startupNoticeEnvironmentKey):-}" ]]; then
          print -r -- "${\(startupNoticeEnvironmentKey)}"
        fi
        if [[ -n "${\(startupCommandEnvironmentKey):-}" ]]; then
          eval "${\(startupCommandEnvironmentKey)}"
        fi
        exec /bin/zsh -f -i
        """
        return LaunchPlan(arguments: ["-f", "-c", startupScript], environment: updatedEnvironment)
    }

    nonisolated static func bootstrapEnvironment(_ environment: [String: String]) -> [String: String] {
        var updatedEnvironment = environment
        let trimmedHomeDirectory = updatedEnvironment["HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let homeDirectory = (trimmedHomeDirectory?.isEmpty == false)
            ? trimmedHomeDirectory!
            : FileManager.default.homeDirectoryForCurrentUser.path

        var candidates = [
            "/Applications/Codex.app/Contents/Resources",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]

        if !homeDirectory.isEmpty {
            candidates.append(contentsOf: [
                "\(homeDirectory)/.local/bin",
                "\(homeDirectory)/.pyenv/shims",
                "\(homeDirectory)/Library/pnpm",
                "\(homeDirectory)/.cargo/bin",
                "\(homeDirectory)/.foundry/bin",
                "\(homeDirectory)/.lmstudio/bin",
                "\(homeDirectory)/.antigravity/antigravity/bin",
            ])
        }

        var seen = Set<String>()
        let existingPathEntries = (updatedEnvironment["PATH"] ?? "")
            .split(separator: ":")
            .map(String.init)
        let mergedEntries = (candidates + existingPathEntries).filter { entry in
            guard !entry.isEmpty else {
                return false
            }
            if seen.contains(entry) {
                return false
            }
            seen.insert(entry)
            return true
        }

        updatedEnvironment["PATH"] = mergedEntries.joined(separator: ":")
        updatedEnvironment["SHELL"] = updatedEnvironment["SHELL"] ?? "/bin/zsh"
        return updatedEnvironment
    }
}
