import SwiftUI

@main
struct TossApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // No visible scene — we use NSStatusItem + NSPanel
        Settings { EmptyView() }
    }
}
