// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "TossApp",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.65.0"),
        .package(url: "https://github.com/stasel/WebRTC.git", .upToNextMajor(from: "125.0.0")),
    ],
    targets: [
        .executableTarget(
            name: "TossApp",
            dependencies: [
                .product(name: "NIO", package: "swift-nio"),
                .product(name: "NIOHTTP1", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
                .product(name: "WebRTC", package: "WebRTC"),
            ],
            path: "Sources",
            resources: [
                .copy("../Resources/Assets.xcassets"),
            ]
        ),
    ]
)
