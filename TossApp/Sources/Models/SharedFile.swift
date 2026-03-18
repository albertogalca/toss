import Foundation

struct SharedFile: Codable, Identifiable {
    let shareId: String
    let filePath: String
    let fileName: String
    let fileSize: Int64
    var passwordHash: String?

    var id: String { shareId }
    var hasPassword: Bool { passwordHash != nil }

    var formattedSize: String {
        ByteCountFormatter.string(fromByteCount: fileSize, countStyle: .file)
    }
}
