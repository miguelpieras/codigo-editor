import XCTest
@testable import codigo_editor

final class TerminalSessionTests: XCTestCase {
    func testLaunchPlanUsesInteractiveShellWithoutInitialCommand() {
        let plan = TerminalSession.makeLaunchPlan(
            startupCommand: nil,
            initialNotice: nil,
            environment: ["TERM": "xterm-256color"]
        )

        XCTAssertEqual(plan.arguments, ["-f", "-i"])
        XCTAssertEqual(plan.environment["TERM"], "xterm-256color")
        XCTAssertEqual(plan.environment["PROMPT_EOL_MARK"], "")
        XCTAssertNil(plan.environment["CODIGO_STARTUP_COMMAND"])
        XCTAssertNil(plan.environment["CODIGO_STARTUP_NOTICE"])
    }

    func testLaunchPlanUsesShellCommandWhenStartupCommandExists() {
        let plan = TerminalSession.makeLaunchPlan(
            startupCommand: "codex",
            initialNotice: "Directory fallback",
            environment: [:]
        )

        XCTAssertEqual(Array(plan.arguments.prefix(2)), ["-f", "-c"])
        XCTAssertEqual(plan.environment["CODIGO_STARTUP_COMMAND"], "codex")
        XCTAssertEqual(plan.environment["CODIGO_STARTUP_NOTICE"], "Directory fallback")
        XCTAssertTrue(plan.arguments.last?.contains("eval") == true)
        XCTAssertTrue(plan.arguments.last?.contains("exec /bin/zsh -f -i") == true)
    }

    func testBootstrapEnvironmentPrependsCommonExecutableLocations() {
        let environment = TerminalSession.bootstrapEnvironment([
            "HOME": "/Users/tester",
            "PATH": "/usr/bin:/bin:/custom/bin"
        ])

        XCTAssertEqual(
            environment["PATH"],
            [
                "/Applications/Codex.app/Contents/Resources",
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
                "/Users/tester/.local/bin",
                "/Users/tester/.pyenv/shims",
                "/Users/tester/Library/pnpm",
                "/Users/tester/.cargo/bin",
                "/Users/tester/.foundry/bin",
                "/Users/tester/.lmstudio/bin",
                "/Users/tester/.antigravity/antigravity/bin",
                "/custom/bin",
            ].joined(separator: ":")
        )
        XCTAssertEqual(environment["SHELL"], "/bin/zsh")
    }
}
