import Foundation
import LocalAuthentication
import UserNotifications

// Hand-off mode: the owner hands his admin phone to a customer (to tap a card
// at the table). Starting it pauses the staff alerts, so the customer never
// reads one: the alerts already in Notification Center are cleared and this
// install stops getting notifications, so none shows in the list, on the lock
// screen or with the app in the background. One that still arrives with the
// app open shows only the badge. A successful hand-back turns the alerts on
// again; the portal's own alert list keeps what came in meanwhile.
//
// CustomerHandoff starts it when the customer view opens and ends it when the
// owner hands back, which asks for Face ID, Touch ID or the passcode. Only a
// successful check ends it. The flag is saved in UserDefaults, so a relaunch
// finds it still on and RootView shows a lock screen instead of the portal until
// the same check passes. Sign-out clears it. The app's instance
// (HandoffLock.shared) is built in StaffAlerts.swift, which owns the alerts.
@MainActor
final class HandoffLock {
    nonisolated static let defaultsKey = "handoffLockActive"
    // The saved flag, readable before any lock object exists (RootView).
    nonisolated static var persistedActive: Bool { UserDefaults.standard.bool(forKey: defaultsKey) }
    static let reason = "Take the phone back"

    // What the device check said.
    enum AuthResult: Equatable { case success, denied }

    // How an end request went.
    enum EndResult: Equatable { case ended, denied }

    private let defaults: UserDefaults
    private let authenticate: () async -> AuthResult
    private let pauseAlerts: @MainActor () -> Void
    private let resumeAlerts: @MainActor () -> Void
    private var checking = false

    init(defaults: UserDefaults = .standard,
         authenticate: @escaping () async -> AuthResult = HandoffLock.deviceOwnerCheck,
         pauseAlerts: @escaping @MainActor () -> Void = {},
         resumeAlerts: @escaping @MainActor () -> Void = {}) {
        self.defaults = defaults
        self.authenticate = authenticate
        self.pauseAlerts = pauseAlerts
        self.resumeAlerts = resumeAlerts
    }

    var isActive: Bool { defaults.bool(forKey: Self.defaultsKey) }

    func start() {
        defaults.set(true, forKey: Self.defaultsKey)
        pauseAlerts()
    }

    // Sign-out: the next person on this iPhone is not locked out by the last
    // person's hand-off. It never turns the alerts back on (sign-out stops them).
    func clear() {
        defaults.removeObject(forKey: Self.defaultsKey)
    }

    // Asks the device to confirm the owner. Only a passed check turns hand-off
    // mode off. A cancel, a failure or a phone with no passcode (the app does
    // not start a hand-off there: ownerCheckAvailable) leaves it on. A second
    // request during a check is denied.
    func end() async -> EndResult {
        guard !checking else { return .denied }
        checking = true
        defer { checking = false }
        guard await authenticate() == .success else { return .denied }
        clear()
        resumeAlerts()
        return .ended
    }

    // False when this iPhone cannot ask for Face ID, Touch ID or the passcode
    // (above all, no passcode is set): nothing could prove the owner at
    // hand-back, so NativeBridge neither offers nor opens a hand-off.
    nonisolated static func ownerCheckAvailable() -> Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    // What a foreground alert shows. Hand-off mode: the badge only (no banner,
    // no sound, nothing added to the notification list).
    nonisolated static func presentation(handoffActive: Bool) -> UNNotificationPresentationOptions {
        handoffActive ? [.badge] : [.banner, .list, .sound, .badge]
    }

    // The real check: .deviceOwnerAuthentication is Face ID or Touch ID with
    // the passcode as the fallback. Anything but a passed check (no passcode,
    // lockout, a busy or missing sensor, a cancel) is not proof of the owner,
    // so the lock stays on.
    nonisolated static func deviceOwnerCheck() async -> AuthResult {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { return .denied }
        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            return ok ? .success : .denied
        } catch {
            return .denied
        }
    }
}
