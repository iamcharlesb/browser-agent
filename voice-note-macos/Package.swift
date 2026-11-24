// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "VoiceNoteMac",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "VoiceNoteMac", targets: ["VoiceNoteMacApp"])
    ],
    targets: [
        .executableTarget(name: "VoiceNoteMacApp")
    ]
)
