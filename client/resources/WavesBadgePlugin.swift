import Capacitor
import UIKit
import UserNotifications

@objc(WavesBadgePlugin)
public class WavesBadgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WavesBadgePlugin"
    public let jsName = "WavesBadge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setCount", returnType: CAPPluginReturnPromise)
    ]

    @objc func setCount(_ call: CAPPluginCall) {
        guard let count = call.getInt("count"), count >= 0, count <= Int32.max else {
            call.reject("A non-negative badge count is required")
            return
        }
        DispatchQueue.main.async {
            if #available(iOS 16.0, *) {
                UNUserNotificationCenter.current().setBadgeCount(count) { error in
                    if error != nil { call.reject("Badge update unavailable") }
                    else { call.resolve() }
                }
            } else {
                UIApplication.shared.applicationIconBadgeNumber = count
                call.resolve()
            }
        }
    }
}

class WavesBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(WavesBadgePlugin())
    }
}
