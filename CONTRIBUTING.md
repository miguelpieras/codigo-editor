# Contributing to Codigo Editor

Thanks for contributing.

Codigo Editor is a macOS desktop app built with Swift, AppKit, SwiftUI, WebKit, and a bundled TypeScript frontend. The project moves across both native and web layers, so contributions are easiest to review when they stay focused and come with clear validation steps.

## Before You Start

- Open an issue or discussion first for larger features, architectural changes, or behavior changes that could affect the product direction.
- Keep pull requests scoped to one logical change when possible.
- If you are changing UI behavior, plan to attach screenshots or a short recording to the PR.

## Development Setup

```bash
git clone https://github.com/miguelpieras/codigo-editor.git
cd codigo-editor
npm install
./run-app.sh
```

Useful commands:

```bash
swift build --configuration debug
swift build --configuration release
swift test --parallel
npm run build
npm run lint
npm run sync-assets
RUN_APP_SKIP_OPEN=1 ./run-app.sh
```

## Project Layout

- `Sources/codigo-editor`: native macOS application code
- `Sources/codigo-editor/Web`: TypeScript UI for terminals and preview surfaces
- `Sources/codigo-editor/Resources`: bundled web assets and app resources
- `Plugins/WebAssetsPlugin`: SwiftPM build plugin for the web bundle
- `Tests/codigo-editorTests`: XCTest coverage
- `Scripts/`: build, release, asset-sync, and utility scripts

## Coding Guidelines

### Swift

- Use 4-space indentation.
- Prefer `UpperCamelCase` for types and `camelCase` for methods and properties.
- Keep UI entry points on `@MainActor` where appropriate.
- Use structured concurrency (`Task`, `AsyncStream`, async/await) instead of ad hoc threading.
- Group related extensions with `// MARK:` sections.

### TypeScript

- Use 2-space indentation.
- Keep ES module syntax.
- Prefer descriptive DOM hook names and kebab-case selector strings.
- Commit lint-compatible changes alongside the Swift work they support.

## Testing Expectations

Run the checks that match your changes before opening a pull request.

- Swift changes: `swift test --parallel`
- Web/UI changes: `npm run build`
- Lint-sensitive frontend changes: `npm run lint`

When adding tests:

- Put new XCTest files alongside the feature they cover inside `Tests/codigo-editorTests`.
- Name tests in the `testScenarioOutcome` style.

## Pull Requests

PRs should include:

- a short summary of the user-visible change
- the validation steps you ran
- linked issues or discussions when relevant
- screenshots or recordings for UI changes

For manual commits, prefer imperative commit subjects under 72 characters, for example `Add terminal reconnect backoff`.

The repo also contains automation-generated commit and release flows. If you are using those scripts, preserve the existing generated naming conventions rather than inventing a parallel format.

## Release and Asset Notes

- `./run-app.sh` is the primary local packaging entry point. It rebuilds web assets, compiles the app, assembles `Codigo Editor.app`, and launches it by default.
- Public release builds should set `CODIGO_BUNDLE_IDENTIFIER` and any Apple signing or notarization environment variables explicitly rather than relying on repo defaults.
- `npm run sync-assets` refreshes vendored xterm assets and should be committed together with the UI changes that require it.
- Release packaging helpers live under `Scripts/` and `dist/`.

## Questions

If anything is unclear, open a discussion or draft PR with the proposed direction. Early alignment is cheaper than reworking a finished patch.
