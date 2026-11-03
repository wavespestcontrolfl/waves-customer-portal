import UIKit
import UserNotifications

// The bell's Call on an alert notification (server alert-call-button.js): the server sends this category with a
// callAction "<alert id>.<version>" for an alert that has a Call button. The action hands it to the portal, whose
// bell runs that alert's Call (NotificationBell.jsx): the owner's phone rings, press 1 connects.
private let alertCallCategory = "WAVES_CALL"
private let alertCallAction = "CALL"

// The push's callAction when it is "<alert id>.<version>", else nil.
func alertCallValue(_ value: Any?) -> String? {
    guard let value = value as? String,
          value.range(of: "^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\\.[0-9a-fA-F]{32}$", options: .regularExpression) != nil
    else { return nil }
    return value
}

// Staff alerts as iPhone notifications. The home-screen web app got them by
// web push, which a WKWebView cannot run. A signed-in staff page asks for the
// APNs device token over the bridge (PortalCoordinator) and registers it under
// its own staff sign-in (POST /api/admin/push/native-subscribe), so the app
// never holds the staff token. A tap on an alert opens its portal page.
@MainActor
final class StaffAlerts {
    static let shared = StaffAlerts()

    // The APNs host this install's token belongs to, which the server sends
    // to: the signing profile's aps-environment, whatever the build
    // configuration. App Store and TestFlight installs carry no profile and
    // use production; the simulator uses the sandbox.
    static let environment: String = {
        #if targetEnvironment(simulator)
        return "sandbox"
        #else
        return provisionedEnvironment() == "development" ? "sandbox" : "production"
        #endif
    }()

    // aps-environment from embedded.mobileprovision (a signed plist), if any.
    private static func provisionedEnvironment() -> String? {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
              let profile = try? PropertyListSerialization.propertyList(
                  from: data.subdata(in: start.lowerBound..<end.upperBound), format: nil
              ) as? [String: Any],
              let entitlements = profile["Entitlements"] as? [String: Any]
        else { return nil }
        return entitlements["aps-environment"] as? String
    }

    // Set by PortalCoordinator: hands a new token to the page that asked.
    var onToken: ((String) -> Void)?
    // Set by PortalCoordinator: opens a portal page. A tap that launched the
    // app waits until the portal is ready.
    var openPage: ((URL) -> Void)? {
        didSet { flushPendingPage() }
    }
    private var pendingPage: URL?
    // False after sign-out, so a permission answer that comes later does not
    // register the install again.
    private var signedIn = false

    // iOS asks for permission once and remembers the answer. The token is
    // registered either way (iOS issues it without permission and only hides
    // the alerts), so alerts start as soon as the staff member allows them,
    // even later in iPhone Settings. Every later call refreshes the token.
    // Never during a hand-off (the covered admin page can ask again after a
    // reload, or this task can still be waiting): the hand-back registers.
    func register() {
        signedIn = true
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            guard signedIn, !HandoffLock.persistedActive else { return }
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func received(deviceToken: Data) {
        // A registration that finished after a hand-off began: off again, and
        // the page gets no token, until the hand-back registers.
        if HandoffLock.persistedActive {
            UIApplication.shared.unregisterForRemoteNotifications()
            return
        }
        onToken?(deviceToken.map { String(format: "%02x", $0) }.joined())
    }

    func setBadge(_ count: Int) {
        UNUserNotificationCenter.current().setBadgeCount(max(0, count)) { _ in }
    }

    // Sign-out: the next person on this iPhone sees none of these alerts. The
    // install stops getting notifications at once, even when the page cannot
    // reach the server to release the token (APNs then answers Unregistered
    // and the server deactivates the row); the next sign-in registers again.
    func signOut() {
        signedIn = false
        HandoffLock.shared.clear()
        UIApplication.shared.unregisterForRemoteNotifications()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        setBadge(0)
    }

    // Hand-off mode (HandoffLock.start): a customer holds the phone. The alerts
    // already shown leave Notification Center and the install stops getting
    // notifications, so none shows in the list, on the lock screen or with the
    // app in the background. A push sent meanwhile gets APNs Unregistered and
    // the server deactivates the row; the portal's alert list still has it.
    func pauseForHandoff() {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        UIApplication.shared.unregisterForRemoteNotifications()
    }

    // A successful hand-back: register again. The token event re-sends
    // native-subscribe, which turns the row active again. After a relaunch
    // nothing has registered yet (signedIn is false): the portal page asks for
    // the token when it loads behind the unlocked lock screen.
    func resumeAfterHandoff() {
        guard signedIn else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    // Set by PortalCoordinator: runs the push's Call on the open page, else loads its link.
    var runCall: ((String, URL) -> Void)?

    // The push's Call. The open staff page runs it itself; before the portal is ready, its link waits like a
    // tapped alert's, and the page runs it when it loads (?alertCall=). The dashboard, not /admin: /admin
    // redirects there and drops the query.
    func call(value: String) {
        guard let url = URL(string: "/admin/dashboard?alertCall=\(value)", relativeTo: Portal.origin)?.absoluteURL else { return }
        if let runCall {
            runCall(value, url)
        } else {
            pendingPage = url
            flushPendingPage()
        }
    }

    // Only portal pages open here; any other link is ignored.
    func open(link: String) {
        guard let url = URL(string: link, relativeTo: Portal.origin)?.absoluteURL, Portal.isPortal(url) else { return }
        if let openPage {
            openPage(url)
        } else {
            pendingPage = url
        }
    }

    private func flushPendingPage() {
        guard let url = pendingPage, let openPage else { return }
        pendingPage = nil
        openPage(url)
    }
}

extension HandoffLock {
    // The app's lock: a hand-off pauses the staff alerts and a successful
    // hand-back turns them on again. Built here so HandoffLock.swift compiles
    // alone for its logic check (Tests/main.swift).
    static let shared = HandoffLock(
        pauseAlerts: { StaffAlerts.shared.pauseForHandoff() },
        resumeAlerts: { StaffAlerts.shared.resumeAfterHandoff() }
    )
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // Call shows when the alert is pressed or pulled down; .foreground opens the app (unlocked) to run it.
        let call = UNNotificationAction(identifier: alertCallAction, title: "Call", options: [.foreground])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: alertCallCategory, actions: [call], intentIdentifiers: [], options: []),
        ])
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in StaffAlerts.shared.received(deviceToken: deviceToken) }
    }

    // No token, no alerts on this device; nothing else depends on it.
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}

    // Alerts show while the app is open too, as they did in the web app.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // Hand-off mode (a customer holds the phone): the badge only, nothing
        // in the list (one can still arrive before the pause takes effect).
        // presentation(handoffActive:) is a pure nonisolated helper; the flag
        // is read from the persisted value, so nothing here needs the main actor.
        HandoffLock.presentation(handoffActive: HandoffLock.persistedActive)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        // Call: the portal runs the alert's own Call. Any other tap opens the alert's page.
        if response.actionIdentifier == alertCallAction, let value = alertCallValue(info["callAction"]) {
            await MainActor.run { StaffAlerts.shared.call(value: value) }
            return
        }
        guard let link = info["url"] as? String else { return }
        await MainActor.run { StaffAlerts.shared.open(link: link) }
    }
}
