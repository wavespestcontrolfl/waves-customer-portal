import Foundation
import LocalAuthentication
import UserNotifications

// Hand-off mode: the owner hands his admin phone to a customer (to tap a card
// at the table). While it is on, an alert that arrives with the app open shows
// no banner and plays no sound, so the customer never reads a staff alert.
// The alert still goes to the notification list and the badge.
//
// The page starts it with { type: 'handoffStart' } and ends it with
// { type: 'handoffEnd' }, which asks for Face ID, Touch ID or the passcode.
// Only a successful check ends it. The flag is saved in UserDefaults, so a
// relaunch stays locked until an end succeeds. Sign-out clears it.
@MainActor
final class HandoffLock {
    static let shared = HandoffLock()
    static let defaultsKey = "handoffLockActive"
    static let reason = "Take the phone back"

    // What the device check said.
    enum AuthResult: Equatable { case success, denied, unavailable }

    // How an end request went. `ended(unavailable: false)` is a normal unlock.
    enum EndResult: Equatable {
        case ended(unavailable: Bool)
        case denied
    }

    private let defaults: UserDefaults
    private let authenticate: () async -> AuthResult
    private var checking = false

    init(defaults: UserDefaults = .standard,
         authenticate: @escaping () async -> AuthResult = HandoffLock.deviceOwnerCheck) {
        self.defaults = defaults
        self.authenticate = authenticate
    }

    var isActive: Bool { defaults.bool(forKey: Self.defaultsKey) }

    func start() {
        defaults.set(true, forKey: Self.defaultsKey)
    }

    // Sign-out: the next person on this iPhone is not locked out by the last
    // person's hand-off.
    func clear() {
        defaults.removeObject(forKey: Self.defaultsKey)
    }

    // Asks the device to confirm the owner. Success (or a device with no
    // passcode, which cannot ask) turns hand-off mode off. A cancel or a
    // failure leaves it on. A second request during a check is denied.
    func end() async -> EndResult {
        guard !checking else { return .denied }
        checking = true
        defer { checking = false }
        switch await authenticate() {
        case .success:
            clear()
            return .ended(unavailable: false)
        case .unavailable:
            clear()
            return .ended(unavailable: true)
        case .denied:
            return .denied
        }
    }

    // What a foreground alert shows. Hand-off mode: list and badge only.
    static func presentation(handoffActive: Bool) -> UNNotificationPresentationOptions {
        handoffActive ? [.list, .badge] : [.banner, .list, .sound, .badge]
    }

    // The real check: .deviceOwnerAuthentication is Face ID or Touch ID with
    // the passcode as the fallback. A phone with no passcode cannot be checked.
    nonisolated static func deviceOwnerCheck() async -> AuthResult {
        let context = LAContext()
        var policyError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
            return .unavailable
        }
        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            return ok ? .success : .denied
        } catch {
            return .denied
        }
    }
}
