// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "codigo-editor",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(
            name: "codigo-editor",
            targets: ["codigo-editor"]
        )
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "codigo-editor",
            dependencies: [],
            path: "Sources/codigo-editor",
            exclude: ["Web"],
            resources: [
                .process("Resources")
            ],
            linkerSettings: [
                .linkedFramework("Security")
            ],
            plugins: [
                .plugin(name: "WebAssetsPlugin")
            ]
        ),
        .plugin(
            name: "WebAssetsPlugin",
            capability: .buildTool(),
            path: "Plugins/WebAssetsPlugin"
        ),
        .testTarget(
            name: "codigo-editorTests",
            dependencies: ["codigo-editor"],
            path: "Tests/codigo-editorTests"
        )
    ]
)
