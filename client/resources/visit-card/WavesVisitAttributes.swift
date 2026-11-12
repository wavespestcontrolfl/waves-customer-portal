import ActivityKit
import Foundation

// The data of one Lock Screen visit card. Compiled into the app (the plugin names the type to read its
// start token) and into the widget extension (which draws the card).
//
// CONTRACT with the server (docs/mobile/live-activity.md). Apple matches this type's NAME as text against
// the push's "attributes-type" (ATTRIBUTES_TYPE in server/services/apns-live-activity.js) and decodes
// "attributes" and "content-state" with the default JSON coding. A rename of the type or of a key needs
// the same change on the server and a new app version.
@available(iOS 16.1, *)
struct WavesVisitAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// "en_route", "on_property" or "complete". An unknown value still shows `title` and `detail`.
        var phase: String
        /// The main line. The server writes it.
        var title: String
        /// The second line: the service name. The server writes it.
        var detail: String
        /// 1, 2 or 3.
        var step: Int
    }

    /// An opaque id for this card. Not a customer or visit id.
    var visitRef: String
}
