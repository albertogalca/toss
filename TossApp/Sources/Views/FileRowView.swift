import SwiftUI

struct FileRowView: View {
    let file: SharedFile
    let viewModel: AppViewModel
    @State private var showPasswordField = false
    @State private var passwordText = ""
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                FilePreviewView(filePath: file.filePath, fileName: file.fileName)
                    .frame(width: 36, height: 36)
                    .clipShape(RoundedRectangle(cornerRadius: 6))

                VStack(alignment: .leading, spacing: 2) {
                    Text(file.fileName)
                        .font(.body)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(file.formattedSize)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }

                Spacer()

                // Copy link
                Button {
                    viewModel.copyLink(shareId: file.shareId)
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                        copied = false
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help("Copy share link")

                // Lock/unlock
                Button {
                    if file.hasPassword {
                        Task { await viewModel.setPassword(shareId: file.shareId, password: nil) }
                        showPasswordField = false
                    } else {
                        showPasswordField.toggle()
                    }
                } label: {
                    Image(systemName: file.hasPassword ? "lock.fill" : "lock.open")
                }
                .buttonStyle(.borderless)
                .help(file.hasPassword ? "Remove password" : "Set password")

                // Remove
                Button {
                    Task { await viewModel.removeFile(shareId: file.shareId) }
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .help("Stop sharing")
            }

            if showPasswordField {
                HStack {
                    SecureField("Password", text: $passwordText)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit {
                            guard !passwordText.isEmpty else { return }
                            Task { await viewModel.setPassword(shareId: file.shareId, password: passwordText) }
                            passwordText = ""
                            showPasswordField = false
                        }
                    Button("Set") {
                        guard !passwordText.isEmpty else { return }
                        Task { await viewModel.setPassword(shareId: file.shareId, password: passwordText) }
                        passwordText = ""
                        showPasswordField = false
                    }
                    .disabled(passwordText.isEmpty)
                }
            }
        }
        .padding(.vertical, 4)
    }
}
