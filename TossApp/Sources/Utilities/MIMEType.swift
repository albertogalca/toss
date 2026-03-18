import Foundation

enum MIMEType {
    private static let types: [String: String] = [
        "pdf": "application/pdf",
        "zip": "application/zip",
        "gz": "application/gzip",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "gif": "image/gif",
        "webp": "image/webp",
        "svg": "image/svg+xml",
        "mp4": "video/mp4",
        "webm": "video/webm",
        "mov": "video/quicktime",
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "ogg": "audio/ogg",
        "txt": "text/plain",
        "html": "text/html",
        "css": "text/css",
        "js": "text/javascript",
        "json": "application/json",
        "xml": "application/xml",
    ]

    static func mimeType(for fileName: String) -> String {
        let ext = (fileName as NSString).pathExtension.lowercased()
        return types[ext] ?? "application/octet-stream"
    }
}
