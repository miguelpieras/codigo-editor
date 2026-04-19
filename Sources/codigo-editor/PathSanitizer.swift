import Foundation

enum PathSanitizer {
    static func sanitize(_ rawPath: String) -> String {
        let trimmed = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return trimmed
        }
        let expanded = (trimmed as NSString).expandingTildeInPath
        let standardised = (expanded as NSString).standardizingPath
        return standardised
    }
}
