# Codigo Editor

Codigo Editor is a native macOS workspace for terminal-first coding workflows. It combines a multi-pane terminal UI, local web previews, and Git/GitHub helpers into a single desktop app aimed at agent-driven development with tools like Codex, Claude Code, or your own custom shell setup.

## Status

Codigo Editor is actively developed and already usable, but it should still be treated as an evolving project. Expect the UI, settings, and integration points to keep changing as the app is opened up and hardened for broader use.

## Features

- Native macOS app built with AppKit, SwiftUI, and WebKit
- Multi-tab, multi-pane terminal layout for parallel agent or shell sessions
- Configurable starter command for new panes (`codex`, `claude`, or any custom command)
- Built-in preview column for local web apps and dev servers
- Per-project command shortcuts and link shortcuts inside terminal panes
- Git status summaries and change inspection in the app UI
- GitHub-focused cloud actions for syncing changes or creating pull requests
- Editor hand-off actions for Cursor, VS Code, or a custom command
- Optional idle chime and macOS notifications when automation finishes
- JSON-backed local configuration with XCTest coverage around persistence and terminal bootstrapping

## Requirements

- macOS 13 or newer

If you are building from source, you will also need:

- A Swift 6.1-compatible toolchain (`swift --version`)
- `npm` for the bundled web UI asset pipeline

Optional tools:

- `gh` for GitHub sign-in, sync, and pull request flows
- `cursor` or `code` on your `PATH` if you want one-click editor hand-off

## Installation

### Install the packaged app

For most users, the recommended install path is the latest GitHub Release rather than cloning the repository:

1. Open the [GitHub Releases page](https://github.com/miguelpieras/codigo-editor/releases).
2. Download the latest `CodigoEditor-<version>.dmg` or `.zip`.
3. Move `Codigo Editor.app` into `/Applications`.
4. Launch the app from Finder or Spotlight.

The repository is the source code for the app. End users should install from Releases; cloning the repo is mainly for contributors or people who want to run development builds.

### Build from source

```bash
git clone https://github.com/miguelpieras/codigo-editor.git
cd codigo-editor
./run-app.sh
```

`./run-app.sh` is the main setup path. It will:

- install JavaScript dependencies on first run if needed
- build the TypeScript/web assets
- compile the Swift executable
- assemble `Codigo Editor.app`
- launch the app unless `RUN_APP_SKIP_OPEN=1`

By default, local packaging uses a neutral bundle identifier. If you are preparing a distributable build, set `CODIGO_BUNDLE_IDENTIFIER` to your own reverse-DNS identifier before running the packaging or release scripts.

If you want the lower-level development steps instead of the packaging helper:

```bash
npm install
npm run build
npm run sync-assets
swift build --configuration debug
swift test --parallel
```

Use `./run-app.sh` when you want the packaged `.app`. Use `swift build` and `swift test` when you are working closer to the underlying executable and test suite.

## Updates

Codigo Editor does not currently include an in-app auto-updater.

The recommended update flow is:

- maintainers publish each new version as a GitHub Release
- release artifacts are generated with `./Scripts/release.sh <version> [build]`
- users download the newest release and replace the existing `Codigo Editor.app` in `/Applications`

For signed or notarized releases, provide your own Apple-specific values via environment variables such as `CODIGO_BUNDLE_IDENTIFIER`, `CODIGO_CODESIGN_IDENTITY`, `CODIGO_NOTARY_TEAM_ID`, `CODIGO_NOTARY_PROFILE`, `CODIGO_NOTARY_APPLE_ID`, and `CODIGO_NOTARY_PASSWORD`.

If you installed from source instead of a release build, update by pulling the latest code and rebuilding:

```bash
git pull
./run-app.sh
```

GitHub should be treated as the source host and release distribution channel, not the update mechanism by itself. The repository hosts the code, while GitHub Releases should host the signed or notarized `.dmg` and `.zip` artifacts produced by `Scripts/release.sh`.

If you want automatic updates later, the next step is to integrate a macOS updater such as Sparkle and publish an appcast feed. GitHub Releases can host those assets, but GitHub alone does not make the installed app self-updating.

## Quick Start

1. Launch the app with `./run-app.sh` or open `Codigo Editor.app`.
2. Choose a workspace folder when prompted.
3. Open `Codigo Editor > Settings...` and confirm your starter command.
4. Add terminal panes for the tasks you want to run in parallel.
5. If you are working on a local web app, use the preview column alongside the terminal panes.
6. Use the pane actions to open the workspace in your editor, run saved commands, inspect Git changes, or trigger GitHub-oriented actions.

## Common Workflows

### Agent-first terminal workspace

- Set the starter command to `codex`, `claude`, or a custom launcher.
- New panes automatically boot into that workflow.
- Use multiple panes to run implementation, tests, and review loops side by side.

### Local web development

- Start your app server inside a terminal pane.
- Keep the built-in preview visible while you work.
- Use preview tabs when you need to compare multiple routes or surfaces.

### Git and GitHub flow

- Review repository changes from the pane header.
- Choose a default cloud action: sync changes, create a pull request, or run a custom script.
- Sign in with GitHub CLI (`gh auth login`) to enable GitHub-driven flows.

## Development

### Build

```bash
swift build --configuration debug
swift build --configuration release
```

### Run tests

```bash
swift test --parallel
```

### Build and verify the web UI

```bash
npm run build
npm run lint
```

### Launch the packaged app without opening it

```bash
RUN_APP_SKIP_OPEN=1 ./run-app.sh
```

## Project Layout

- `Sources/codigo-editor`: Swift application code
- `Sources/codigo-editor/Web`: TypeScript frontend for the terminal and preview UI
- `Sources/codigo-editor/Resources`: bundled assets shipped inside the app
- `Plugins/WebAssetsPlugin`: SwiftPM plugin for web asset generation
- `Tests/codigo-editorTests`: XCTest suite
- `Scripts/`: build, sync, release, and utility scripts

## Architecture

Codigo Editor is split into two main layers:

- A native macOS shell written in Swift/AppKit that manages windows, terminals, settings, persistence, notifications, and system integrations.
- A bundled TypeScript frontend rendered inside `WKWebView`, powered by `xterm.js`, that handles the pane-based terminal UI and preview experience.

This split keeps the app native where macOS integration matters, while allowing the terminal surface and layout logic to move quickly.

## Contributing

Issues and pull requests are welcome.

If you want to contribute, start with [CONTRIBUTING.md](CONTRIBUTING.md).

The short version:

1. Open an issue or discussion for larger changes.
2. Keep Swift and web changes validated with the relevant commands:
   - `swift test --parallel`
   - `npm run build`
   - `npm run lint`
3. Include UI screenshots or recordings when changing the app surface.

## License

[MIT](LICENSE)

Bundled third-party runtime notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
