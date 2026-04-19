import Foundation

struct TerminalConfig: Identifiable, Hashable {
    let id = UUID()
    let title: String
    let workingDirectory: String
    let startupCommand: String?
    let kind: PaneKind
    let conversationSummary: String?
}
