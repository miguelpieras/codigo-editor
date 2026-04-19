# Repository Guidelines

## Project Structure & Module Organization
- `Package.swift` declares the single SwiftPM executable target `codigo-editor`; production sources sit in `Sources/codigo-editor` grouped by feature (Terminal, Remote Access, Updates, WebServer).
- Browser UI assets live in `Sources/codigo-editor/Web`; they compile into `Sources/codigo-editor/Resources` through the `WebAssetsPlugin` under `Plugins/WebAssetsPlugin`.
- XCTest suites mirror modules inside `Tests/codigo-editorTests`, while helper automation (asset sync, releases, preview snapshots) sits in `Scripts/`.
- Finished bundles and signed artifacts land in `Codigo Editor.app` and release payloads under `dist/`.

## Build, Test, and Development Commands
- `swift build --configuration debug|release` compiles the macOS executable into `.build/`.
- `./run-app.sh` regenerates web assets, assembles `Codigo Editor.app`, and (unless `RUN_APP_SKIP_OPEN=1`) launches it.
- `swift test --parallel [--filter ConfigurationStoreTests]` runs the XCTest suite; use filters for focused checks.
- `npm install` prepares TypeScript dependencies, and `npm run build` performs type-checking plus bundles `main.js`.
- `npm run lint` enforces ESLint rules and `npm run sync-assets` refreshes vendored xterm files before committing.

## Coding Style & Naming Conventions
- Swift code follows 4-space indentation, `UpperCamelCase` types, `camelCase` members, and organizes extensions with `// MARK:` blocks per feature.
- Prefer value types and `@MainActor` annotations for UI entry points; async work uses structured concurrency (`Task`, `AsyncStream`).
- TypeScript files use 2-space indentation, ES module syntax, and keep selectors or DOM hooks in kebab-case strings; lint fixes should be committed with the Swift changes they support.

## Testing Guidelines
- Add new XCTest files alongside their features (e.g. `Tests/codigo-editorTests/Terminal/TerminalServiceTests.swift`) and name methods `testScenarioOutcome`.
- Run `swift test` after Swift edits and `npm run typecheck` after UI changes; snapshot timing tweaks belong in `Scripts/test-preview-snapshot-feedback.mjs`.

## Commit & Pull Request Guidelines
- Automation generates `Codigo Sync YYYY-MM-DDThh:mm:ss` commits and release tags; preserve this scheme when running sync scripts or cutting a release.
- For manual commits use imperative subjects under 72 characters (`Add terminal reconnect backoff`) and include context in the body when touching multiple areas.
- Pull requests should summarize user impact, list validation steps (`swift test`, `npm run build`), link issues, and attach UI captures whenever the bundle changes.
