import XCTest
@testable import codigo_editor

final class ConversationSummaryTests: XCTestCase {
    func testSanitizeConversationSummaryOutputPrefersJSONSummary() {
        let output = #"{"summary":"Fix preview auth redirect"}"#

        let summary = TerminalCoordinator.sanitizeConversationSummaryOutput(output, previousSummary: nil)

        XCTAssertEqual(summary, "Fix preview auth redirect")
    }

    func testSanitizeConversationSummaryOutputRejectsJSONCodeFence() {
        let output = """
        ```json
        {"summary":"Improve agent switcher layout"}
        ```
        """

        let summary = TerminalCoordinator.sanitizeConversationSummaryOutput(output, previousSummary: nil)

        XCTAssertNil(summary)
    }

    func testSanitizeConversationSummaryOutputRejectsPlainText() {
        let output = "Fix preview auth redirect."

        let summary = TerminalCoordinator.sanitizeConversationSummaryOutput(output, previousSummary: nil)

        XCTAssertNil(summary)
    }

    func testSanitizeConversationSummaryOutputKeepsPreviousSummaryWhenJSONIsInvalid() {
        let output = "not json"

        let summary = TerminalCoordinator.sanitizeConversationSummaryOutput(
            output,
            previousSummary: "Fix preview auth redirect"
        )

        XCTAssertEqual(summary, "Fix preview auth redirect")
    }
}
