import Foundation
import XCTest
@testable import codigo_editor

final class PromptHookCaptureTests: XCTestCase {
    private let fileManager = FileManager.default
    private var temporaryDirectories: [URL] = []

    override func tearDownWithError() throws {
        for directory in temporaryDirectories {
            try? fileManager.removeItem(at: directory)
        }
        temporaryDirectories.removeAll()
        try super.tearDownWithError()
    }

    func testMergedHooksJSONPreservesExistingHooks() throws {
        let originalRoot: [String: Any] = [
            "hooks": [
                "AgentTurnEnd": [[
                    "hooks": [[
                        "type": "command",
                        "command": "echo existing",
                    ]],
                ]],
            ],
        ]
        let originalData = try JSONSerialization.data(withJSONObject: originalRoot, options: [.sortedKeys])

        let mergedData = try PromptHookCapture.mergedHooksJSON(
            existingData: originalData,
            hookCommand: "/usr/bin/python3 /tmp/capture.py"
        )
        let mergedRoot = try XCTUnwrap(
            JSONSerialization.jsonObject(with: mergedData) as? [String: Any]
        )
        let hooks = try XCTUnwrap(mergedRoot["hooks"] as? [String: Any])

        XCTAssertNotNil(hooks["AgentTurnEnd"])

        let userPromptGroups = try XCTUnwrap(hooks["UserPromptSubmit"] as? [[String: Any]])
        let captureGroup = try XCTUnwrap(userPromptGroups.first)
        let captureHooks = try XCTUnwrap(captureGroup["hooks"] as? [[String: Any]])
        let captureHook = try XCTUnwrap(captureHooks.first)
        XCTAssertEqual(captureHook["command"] as? String, "/usr/bin/python3 /tmp/capture.py")
        XCTAssertEqual(captureHook["statusMessage"] as? String, "Codigo Editor prompt capture")
    }

    func testMergedConfigTOMLEnablesHooksInsideExistingFeaturesSection() throws {
        let original = """
        model = "gpt-5"

        [features]
        codex_hooks = false # keep this note
        keep_history = true
        """

        let mergedData = try PromptHookCapture.mergedConfigTOML(existingData: Data(original.utf8))
        let merged = try XCTUnwrap(String(data: mergedData, encoding: .utf8))

        XCTAssertTrue(merged.contains("model = \"gpt-5\""))
        XCTAssertTrue(merged.contains("[features]"))
        XCTAssertTrue(merged.contains("codex_hooks = true # keep this note"))
        XCTAssertTrue(merged.contains("keep_history = true"))
        XCTAssertFalse(merged.contains("codex_hooks = false"))
    }

    func testMergedConfigTOMLStopsAtNextArrayTableSection() throws {
        let original = """
        [features] # existing feature flags
        keep_history = true

        [[profiles]]
        name = "default"
        """

        let mergedData = try PromptHookCapture.mergedConfigTOML(existingData: Data(original.utf8))
        let merged = try XCTUnwrap(String(data: mergedData, encoding: .utf8))

        XCTAssertTrue(merged.contains("[features] # existing feature flags"))
        XCTAssertTrue(merged.contains("codex_hooks = true\n\n[[profiles]]"))
        XCTAssertTrue(merged.contains("name = \"default\""))
    }

    func testPromptHookCaptureCreatesAndCleansWorkspaceFiles() throws {
        let workspaceURL = try makeTemporaryDirectory()
        let capture = try makeCapture(workspaceURL: workspaceURL)
        let dotCodexURL = workspaceURL.appendingPathComponent(".codex", isDirectory: true)
        let hooksURL = dotCodexURL.appendingPathComponent("hooks.json", isDirectory: false)
        let configURL = dotCodexURL.appendingPathComponent("config.toml", isDirectory: false)

        let hooksText = try XCTUnwrap(String(data: Data(contentsOf: hooksURL), encoding: .utf8))
        let configText = try XCTUnwrap(String(data: Data(contentsOf: configURL), encoding: .utf8))

        XCTAssertTrue(hooksText.contains("\"UserPromptSubmit\""))
        XCTAssertTrue(hooksText.contains("Codigo Editor prompt capture"))
        XCTAssertTrue(configText.contains("[features]"))
        XCTAssertTrue(configText.contains("codex_hooks = true"))

        capture.invalidate()

        XCTAssertFalse(fileManager.fileExists(atPath: dotCodexURL.path))
    }

    func testPromptHookCaptureRestoresExistingWorkspaceFiles() throws {
        let workspaceURL = try makeTemporaryDirectory()
        let dotCodexURL = workspaceURL.appendingPathComponent(".codex", isDirectory: true)
        try fileManager.createDirectory(at: dotCodexURL, withIntermediateDirectories: true)

        let hooksURL = dotCodexURL.appendingPathComponent("hooks.json", isDirectory: false)
        let configURL = dotCodexURL.appendingPathComponent("config.toml", isDirectory: false)

        let originalHooks = """
        {
          "hooks": {
            "AgentTurnEnd": [
              {
                "hooks": [
                  {
                    "command": "echo existing",
                    "type": "command"
                  }
                ]
              }
            ]
          }
        }
        """
        let originalConfig = """
        editor = "vim"

        [features]
        codex_hooks = false
        verbose = true
        """

        try Data(originalHooks.utf8).write(to: hooksURL)
        try Data(originalConfig.utf8).write(to: configURL)

        let capture = try makeCapture(workspaceURL: workspaceURL)

        let mergedConfig = try XCTUnwrap(String(data: Data(contentsOf: configURL), encoding: .utf8))
        XCTAssertTrue(mergedConfig.contains("codex_hooks = true"))
        XCTAssertTrue(mergedConfig.contains("verbose = true"))

        capture.invalidate()

        XCTAssertEqual(try Data(contentsOf: hooksURL), Data(originalHooks.utf8))
        XCTAssertEqual(try Data(contentsOf: configURL), Data(originalConfig.utf8))
    }

    func testPromptHookCaptureWaitsForLastReferenceBeforeRestoringWorkspaceFiles() throws {
        let workspaceURL = try makeTemporaryDirectory()
        let captureOne = try makeCapture(workspaceURL: workspaceURL)
        let captureTwo = try makeCapture(workspaceURL: workspaceURL)
        let dotCodexURL = workspaceURL.appendingPathComponent(".codex", isDirectory: true)
        let configURL = dotCodexURL.appendingPathComponent("config.toml", isDirectory: false)

        captureOne.invalidate()

        XCTAssertTrue(fileManager.fileExists(atPath: dotCodexURL.path))
        let activeConfig = try XCTUnwrap(String(data: Data(contentsOf: configURL), encoding: .utf8))
        XCTAssertTrue(activeConfig.contains("codex_hooks = true"))

        captureTwo.invalidate()

        XCTAssertFalse(fileManager.fileExists(atPath: dotCodexURL.path))
    }

    private func makeTemporaryDirectory() throws -> URL {
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("PromptHookCaptureTests", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        temporaryDirectories.append(directory)
        return directory
    }

    private func makeCapture(workspaceURL: URL) throws -> PromptHookCapture {
        let rootURL = try makeTemporaryDirectory()
        let logURL = rootURL.appendingPathComponent("user-prompt-submit-log.jsonl", isDirectory: false)
        fileManager.createFile(atPath: logURL.path, contents: Data())

        return try PromptHookCapture(
            workspaceURL: workspaceURL,
            rootURL: rootURL,
            logURL: logURL,
            environmentOverrides: [:],
            onPrompt: { _ in }
        )
    }
}
