import SwiftUI
import ServiceManagement

struct SettingsView: View {
    @AppStorage("appearance") private var appearance: String = "system"
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled

    var body: some View {
        Form {
            Section {
                HStack {
                    Text("Appearance:")
                    Picker("", selection: $appearance) {
                        Text("System").tag("system")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .frame(width: 120)
                }
            }

            Section {
                Toggle(isOn: $launchAtLogin) {
                    VStack(alignment: .leading) {
                        Text("Start at login")
                            .font(.body.weight(.medium))
                        Text("Automatically launch Toss when you log in to your Mac")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .toggleStyle(.checkbox)
            }
        }
        .formStyle(.grouped)
        .frame(width: 380, height: 160)
        .onChange(of: appearance) { _, newValue in
            applyAppearance(newValue)
        }
        .onChange(of: launchAtLogin) { _, newValue in
            do {
                if newValue {
                    try SMAppService.mainApp.register()
                } else {
                    try SMAppService.mainApp.unregister()
                }
            } catch {
                launchAtLogin = SMAppService.mainApp.status == .enabled
            }
        }
        .onAppear {
            applyAppearance(appearance)
        }
    }

    private func applyAppearance(_ value: String) {
        switch value {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        default: NSApp.appearance = nil
        }
    }
}
