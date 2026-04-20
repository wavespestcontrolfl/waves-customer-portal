import SwiftUI

@main
struct WavesPayApp: App {
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
