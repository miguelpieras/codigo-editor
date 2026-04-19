import Foundation
import PackagePlugin

@main
struct WebAssetsPlugin: BuildToolPlugin {
    func createBuildCommands(context: PluginContext, target: Target) throws -> [Command] {
        let scriptURL = context.package.directoryURL
            .appending(component: "Scripts", directoryHint: .isDirectory)
            .appending(component: "build-web-assets.sh", directoryHint: .notDirectory)
        let outputDirectoryURL = context.pluginWorkDirectoryURL
            .appending(component: "WebAssetsOutput", directoryHint: .isDirectory)

        let command: Command = .prebuildCommand(
            displayName: "Build web assets",
            executable: scriptURL,
            arguments: [outputDirectoryURL.path(percentEncoded: false)],
            environment: [:],
            outputFilesDirectory: outputDirectoryURL
        )

        return [command]
    }
}
