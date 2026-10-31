import UIKit
import UserNotifications

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
    func register() {
        signedIn = true
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            guard signedIn else { return }
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func received(deviceToken: Data) {
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
        UIApplication.shared.unregisterForRemoteNotifications()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        setBadge(0)
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

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
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
        [.banner, .list, .sound, .badge]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let link = response.notification.request.content.userInfo["url"] as? String else { return }
        await MainActor.run { StaffAlerts.shared.open(link: link) }
    }
}
