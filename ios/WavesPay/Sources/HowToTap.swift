import UIKit
import ProximityReader

// Apple's "How to Tap" lesson (iOS 18+). Apple asks Tap to Pay apps to show it
// when Tap to Pay is first used and to keep it reachable afterwards.
enum HowToTap {
    @MainActor
    static func present() async {
        guard #available(iOS 18.0, *) else { return }
        guard let top = TopViewController.current() else { return }
        do {
            let discovery = ProximityReaderDiscovery()
            let content = try await discovery.content(for: .payment(.howToTap))
            try await discovery.presentContent(content, from: top)
        } catch {
            // Best effort: a missing lesson must never block a payment.
        }
    }
}
