import Foundation
import CryptoKit

actor FileShareManager {
    private var files: [String: SharedFile] = [:]
    private let storageURL: URL

    var allFiles: [SharedFile] { Array(files.values) }

    init() {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let tossDir = appSupport.appendingPathComponent("Toss", isDirectory: true)
        try? FileManager.default.createDirectory(at: tossDir, withIntermediateDirectories: true)
        let url = tossDir.appendingPathComponent("shared-files.json")
        storageURL = url

        // Load persisted files inline (non-isolated init)
        if let data = try? Data(contentsOf: url),
           let saved = try? JSONDecoder().decode([SharedFile].self, from: data) {
            let fm = FileManager.default
            for file in saved where fm.fileExists(atPath: file.filePath) {
                files[file.shareId] = file
            }
        }
    }

    func addFile(url: URL, password: String?) -> SharedFile {
        let shareId = generateShareId()
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let fileSize = (attrs?[.size] as? Int64) ?? 0
        let hash = password.map { sha256Hex($0) }

        let file = SharedFile(
            shareId: shareId,
            filePath: url.path,
            fileName: url.lastPathComponent,
            fileSize: fileSize,
            passwordHash: hash
        )
        files[shareId] = file
        saveToDisk()
        return file
    }

    func removeFile(shareId: String) {
        files.removeValue(forKey: shareId)
        saveToDisk()
    }

    func setPassword(shareId: String, password: String?) {
        guard var file = files[shareId] else { return }
        file.passwordHash = password.map { sha256Hex($0) }
        files[shareId] = file
        saveToDisk()
    }

    func file(for shareId: String) -> SharedFile? {
        files[shareId]
    }

    func verifyPassword(shareId: String, candidateHash: String) -> Bool {
        guard let file = files[shareId], let stored = file.passwordHash else { return false }
        // Constant-time compare
        let storedBytes = Array(stored.utf8)
        let candidateBytes = Array(candidateHash.utf8)
        guard storedBytes.count == candidateBytes.count else { return false }
        var result: UInt8 = 0
        for i in 0..<storedBytes.count {
            result |= storedBytes[i] ^ candidateBytes[i]
        }
        return result == 0
    }

    func fileExists(shareId: String) -> Bool {
        guard let file = files[shareId] else { return false }
        return FileManager.default.fileExists(atPath: file.filePath)
    }

    // MARK: - Private

    private func generateShareId() -> String {
        var bytes = [UInt8](repeating: 0, count: 12)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func sha256Hex(_ string: String) -> String {
        let data = Data(string.utf8)
        let hash = SHA256.hash(data: data)
        return hash.map { String(format: "%02x", $0) }.joined()
    }

    private func saveToDisk() {
        let data = Array(files.values)
        guard let json = try? JSONEncoder().encode(data) else { return }
        try? json.write(to: storageURL)
    }

    private func loadFromDisk() {
        guard let data = try? Data(contentsOf: storageURL),
              let saved = try? JSONDecoder().decode([SharedFile].self, from: data) else { return }
        let fm = FileManager.default
        for file in saved where fm.fileExists(atPath: file.filePath) {
            files[file.shareId] = file
        }
    }
}
