import XCTest
@testable import codigo_editor

final class TerminalCoordinatorWebViewTests: XCTestCase {
    func testScriptMessageNamesIncludeCommandAndLinkPersistenceHandlers() {
        let names = Set(TerminalCoordinator.ScriptMessageName.allCases.map(\.rawValue))

        XCTAssertTrue(names.contains("updateTerminalCommandList"))
        XCTAssertTrue(names.contains("updateTerminalLinkList"))
        XCTAssertTrue(names.contains("updatePaneCommandSelection"))
        XCTAssertTrue(names.contains("updatePaneLinkSelection"))
    }
}
