import SwiftUI

struct DropZoneView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "arrow.down.doc")
                .font(.system(size: 48, weight: .light))
                .foregroundStyle(.secondary)
            Text("Drop files here to share")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
