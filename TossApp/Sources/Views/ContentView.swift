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
                Button {
                    openFilePicker()
                } label: {
                    Text("Add")
                        .font(.callout)
                }
                .controlSize(.small)

                Circle()
                    .fill(viewModel.isConnected ? .green : .red)
                    .frame(width: 8, height: 8)
                Text(viewModel.isConnected ? "Connected" : "Disconnected")
                    .font(.callout)
                    .foregroundStyle(.secondary)

                Spacer()

                Text("\(viewModel.files.count) file\(viewModel.files.count == 1 ? "" : "s")")
                    .font(.callout)
                    .foregroundStyle(.secondary)

                Button {
                    NotificationCenter.default.post(name: .openSettings, object: nil)
                } label: {
                    Image(systemName: "gearshape.fill")
                        .font(.callout)
                }
                .buttonStyle(.borderless)
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
        .frame(width: 400, height: 500)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func openFilePicker() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.resolvesAliases = true
        panel.treatsFilePackagesAsDirectories = false
        panel.allowedContentTypes = []
        guard panel.runModal() == .OK else { return }
        Task { @MainActor in
            await viewModel.addFiles(urls: panel.urls)
        }
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
