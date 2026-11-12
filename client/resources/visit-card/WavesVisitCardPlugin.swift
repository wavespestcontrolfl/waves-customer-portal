import ActivityKit
import Capacitor
import Foundation

// The app side of the Lock Screen visit card (docs/mobile/live-activity.md). The server starts and updates
// the card with Apple pushes, so this plugin does only two things:
//   status()  tells the web app what the server needs to start a card on this iPhone: the ActivityKit
//             push-to-start token, the iOS version, and whether Live Activities are on for the app.
//             The web app posts them to POST /api/push/live-activity-token.
//   endAll()  ends this app's cards at once. The web app calls it on sign-out: a card listens on an Apple
//             channel, so the server cannot stop one phone.
// A "startToken" event fires when iOS hands the app a new token.
//
// Registered through packageClassList in the generated capacitor.config.json
// (scripts/mobile/ios_visit_card.rb), so the name in @objc(...) is the contract with that script.
@objc(WavesVisitCardPlugin)
public class WavesVisitCardPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WavesVisitCardPlugin"
    public let jsName = "WavesVisitCard"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endAll", returnType: CAPPluginReturnPromise)
    ]

    private let lock = NSLock()
    private var latestToken: String?
    private var tokenTask: Task<Void, Never>?

    private static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    private func remember(_ token: String) {
        lock.lock()
        latestToken = token
        lock.unlock()
    }

    private func rememberedToken() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return latestToken
    }

    override public func load() {
        // Push-to-start needs iOS 17.2. iOS hands over the current token, then each new one.
        guard #available(iOS 17.2, *) else { return }
        tokenTask = Task { [weak self] in
            for await data in Activity<WavesVisitAttributes>.pushToStartTokenUpdates {
                let token = WavesVisitCardPlugin.hex(data)
                self?.remember(token)
                self?.notifyListeners("startToken", data: ["startToken": token])
            }
        }
    }

    deinit {
        tokenTask?.cancel()
    }

    @objc func status(_ call: CAPPluginCall) {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        var result: [String: Any] = [
            "supported": false,
            "enabled": false,
            "osVersion": "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
        ]
        if #available(iOS 17.2, *) {
            result["supported"] = true
            result["enabled"] = ActivityAuthorizationInfo().areActivitiesEnabled
            // The token iOS already holds, when the update stream has not delivered one yet.
            let token = rememberedToken() ?? Activity<WavesVisitAttributes>.pushToStartToken.map(WavesVisitCardPlugin.hex)
            if let token = token {
                remember(token)
                result["startToken"] = token
            }
        }
        call.resolve(result)
    }

    @objc func endAll(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.resolve(["ended": 0])
            return
        }
        Task {
            var ended = 0
            for activity in Activity<WavesVisitAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
                ended += 1
            }
            call.resolve(["ended": ended])
        }
    }
}
