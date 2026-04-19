import Foundation
import OSLog

enum TerminalBridgeMessage {
    case data(Data)
    case text(String)
}

actor TerminalSessionBridge {
    struct Client {
        let id: UUID
        let send: @Sendable (TerminalBridgeMessage) -> Void
        let onClose: @Sendable () -> Void
    }

    private var clients: [UUID: Client] = [:]
    private let sendToProcess: @Sendable (Data) -> Void
    private let activityRecorder: @Sendable (Date) -> Void
    private var transcript: Transcript
    private let log = Logger(subsystem: "codigo-editor", category: "TerminalBridge")

    init(
        sendToProcess: @escaping @Sendable (Data) -> Void,
        activityRecorder: @escaping @Sendable (Date) -> Void,
        transcriptCapacity: Int? = 512 * 1024
    ) {
        self.sendToProcess = sendToProcess
        self.activityRecorder = activityRecorder
        self.transcript = Transcript(capacity: transcriptCapacity)
    }

    func attachClient(
        id: UUID = UUID(),
        send: @escaping @Sendable (TerminalBridgeMessage) -> Void,
        onClose: @escaping @Sendable () -> Void
    ) {
        let client = Client(id: id, send: send, onClose: onClose)
        clients[id] = client
        let backlog = transcript.snapshot()
        if backlog.isEmpty {
            log.debug("Client \(id, privacy: .public) attached without backlog")
            return
        }
        log.debug("Client \(id, privacy: .public) attached backlogChunks=\(backlog.count, privacy: .public) totalBytes=\(self.transcript.totalBytes, privacy: .public)")
        for chunk in backlog {
            client.send(.data(chunk))
        }
    }

    func detachClient(id: UUID) {
        guard let client = clients.removeValue(forKey: id) else { return }
        client.onClose()
    }

    func detachAll() {
        let currentClients = clients
        clients.removeAll()
        for client in currentClients.values {
            client.onClose()
        }
    }

    func hasClients() -> Bool {
        !clients.isEmpty
    }

    func broadcast(data: Data) {
        activityRecorder(Date())
        transcript.append(data)
        log.debug("Broadcasting data bytes=\(data.count, privacy: .public)")
        guard !clients.isEmpty else { return }
        for client in clients.values {
            client.send(.data(data))
        }
    }

    func broadcast(text: String) {
        activityRecorder(Date())
        guard !clients.isEmpty else { return }
        for client in clients.values {
            client.send(.text(text))
        }
    }

    func sendInput(_ data: Data) {
        activityRecorder(Date())
        log.debug("Forwarding input bytes=\(data.count, privacy: .public)")
        sendToProcess(data)
    }
}

private extension TerminalSessionBridge {
    struct Transcript {
        let capacity: Int?
        private(set) var totalBytes = 0
        private var chunks: [Data] = []

        init(capacity: Int?) {
            if let capacity {
                self.capacity = max(capacity, 0)
            } else {
                self.capacity = nil
            }
        }

        mutating func append(_ data: Data) {
            guard !data.isEmpty else { return }
            chunks.append(data)
            totalBytes += data.count
            trimIfNeeded()
        }

        func snapshot() -> [Data] {
            chunks
        }

        private mutating func trimIfNeeded() {
            guard let capacity, capacity > 0 else { return }
            while totalBytes > capacity, !chunks.isEmpty {
                totalBytes -= chunks.removeFirst().count
            }
        }
    }
}
