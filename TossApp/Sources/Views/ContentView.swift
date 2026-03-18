import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    let viewModel: AppViewModel
    @State private var isTargeted = false

    var body: some View {
        VStack(spacing: 0) {
            if viewModel.files.isEmpty {
                DropZoneView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(viewModel.files) { file in
                        FileRowView(file: file, viewModel: viewModel)
                    }
                }
                .listStyle(.inset)
            }

            // Bottom bar
            HStack {
                Circle()
                    .fill(viewModel.isConnected ? .green : .red)
                    .frame(width: 8, height: 8)
                Text(viewModel.isConnected ? "Connected" : "Disconnected")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Spacer()

                Text("\(viewModel.files.count) file\(viewModel.files.count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.bar)
        }
        .onDrop(of: [.fileURL], isTargeted: $isTargeted) { providers in
            handleDrop(providers)
            return true
        }
        .overlay {
            if isTargeted {
                RoundedRectangle(cornerRadius: 8)
                    .stroke(.blue, lineWidth: 3)
                    .background(.blue.opacity(0.1))
                    .padding(4)
            }
        }
        .frame(minWidth: 320, minHeight: 400)
    }

    private func handleDrop(_ providers: [NSItemProvider]) {
        for provider in providers {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                guard let data = item as? Data,
                      let url = URL(dataRepresentation: data, relativeTo: nil) else { return }
                // Only share regular files, not directories
                var isDir: ObjCBool = false
                guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue else { return }
                Task { @MainActor in
                    await viewModel.addFiles(urls: [url])
                }
            }
        }
    }
}
