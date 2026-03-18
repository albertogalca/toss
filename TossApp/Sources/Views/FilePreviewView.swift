import SwiftUI
import AppKit

struct FilePreviewView: View {
    let filePath: String
    let fileName: String

    var body: some View {
        if let image = thumbnail {
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fill)
        } else {
            fileIcon
        }
    }

    private var thumbnail: NSImage? {
        let imageExts: Set<String> = ["jpg", "jpeg", "png", "gif", "bmp", "tiff", "webp", "heic"]
        let ext = (fileName as NSString).pathExtension.lowercased()
        guard imageExts.contains(ext) else { return nil }
        return NSImage(contentsOfFile: filePath)
    }

    private var fileIcon: some View {
        let ext = (fileName as NSString).pathExtension.uppercased()
        return ZStack {
            RoundedRectangle(cornerRadius: 6)
                .fill(.quaternary)
            Text(ext.isEmpty ? "FILE" : ext)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}
