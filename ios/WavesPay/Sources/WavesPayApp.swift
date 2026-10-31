import SwiftUI

@main
struct WavesPayApp: App {
    // Staff alerts: push registration and notification taps (StaffAlerts.swift).
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var app = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .onOpenURL { url in
                    app.handleIncomingURL(url)
                }
        }
    }
}
