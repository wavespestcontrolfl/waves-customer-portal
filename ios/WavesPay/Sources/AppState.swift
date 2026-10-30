import Foundation
import Combine

@MainActor
final class AppState: ObservableObject {
    // Flow: .idle → (Tap to Pay on a staff page, or a wavespay:// link) →
    // .validating → .ready(handoff) → .collecting → .success/.failure → .idle
    @Published var flow: Flow = .idle

    // Hands each payment's result back to the staff page (set by PortalView).
    weak var portal: PortalCoordinator?

    // The request the open payment answers. It gets exactly one result, then
    // clears; a later close() reports nothing.
    private var pendingResult: PendingResult?

    enum Flow {
        case idle
        case validating
        case ready(API.ValidatedHandoff)
        case collecting
        case success(String)     // paymentIntentId
        case failure(String)     // human message

        var isActive: Bool {
            if case .idle = self { return false }
            return true
        }

        // A server check or a card tap is in flight: the sheet must stay up.
        var isBusy: Bool {
            switch self {
            case .validating, .collecting: return true
            default: return false
            }
        }
    }

    private struct PendingResult {
        let requestId: String?
        var invoiceId: String?
    }

    init() {
        // Waves Admin has no sign-in of its own: staff sign in on the portal
        // page, and /validate-handoff returns the 15-minute terminal token each
        // payment uses. Drop the staff token an older WavesPay build saved.
        Keychain.delete(key: "authToken")
        Keychain.delete(key: "techName")
    }

    // Used only by LoginView, which no screen shows any more.
    func signIn(token: String, techName: String) {
        Keychain.write(key: "authToken", value: token)
        Keychain.write(key: "techName", value: techName)
    }

    // A wavespay:// link opened the app (Safari's Tap to Pay button).
    func handleIncomingURL(_ url: URL) {
        guard Self.handoffToken(from: url) != nil else { return }
        startCollect(from: url, requestId: nil)
    }

    // Starts a payment from wavespay://collect?t=<handoff jwt>. The page's
    // bridge message passes its requestId; a link from Safari has none.
    func startCollect(from url: URL, requestId: String?) {
        guard !flow.isActive else {
            // One payment at a time: answer the new request, keep the open one.
            portal?.deliver(TapToPayResult(
                requestId: requestId, status: .failed,
                message: "Another payment is already open in Waves Admin."
            ))
            return
        }
        guard let token = Self.handoffToken(from: url) else {
            portal?.deliver(TapToPayResult(
                requestId: requestId, status: .failed,
                message: "This payment link is not valid. Tap Tap to Pay again."
            ))
            return
        }
        pendingResult = PendingResult(requestId: requestId, invoiceId: nil)
        Task { await validate(token: token) }
    }

    func validate(token: String) async {
        if pendingResult == nil { pendingResult = PendingResult(requestId: nil, invoiceId: nil) }
        flow = .validating
        do {
            let validated = try await API.validateHandoff(token: token)
            if let fresh = validated.authToken {
                Keychain.write(key: "authToken", value: fresh)
            }
            PendingHandoff.jti = JWTDecoder.extractClaim(token: token, key: "jti")
            pendingResult?.invoiceId = validated.invoice_id
            flow = .ready(validated)
        } catch {
            fail(error.localizedDescription)
        }
    }

    func beginCollecting() {
        flow = .collecting
    }

    func collected(paymentIntentId: String) {
        flow = .success(paymentIntentId)
        report(.succeeded, paymentIntentId: paymentIntentId)
    }

    func fail(_ message: String) {
        flow = .failure(message)
        report(.failed, message: message)
    }

    // Cancel on the amount screen, Done/Back after a result, or the sheet
    // swiped away. Reports "canceled" only when no result went out yet.
    func close() {
        report(.canceled)
        PendingHandoff.jti = nil
        flow = .idle
    }

    private func report(_ status: TapToPayResult.Status, paymentIntentId: String? = nil, message: String? = nil) {
        guard let pending = pendingResult else { return }
        pendingResult = nil
        portal?.deliver(TapToPayResult(
            requestId: pending.requestId,
            status: status,
            invoiceId: pending.invoiceId,
            paymentIntentId: paymentIntentId,
            message: message
        ))
    }

    static func handoffToken(from url: URL) -> String? {
        guard url.scheme == "wavespay",
              url.host == "collect",
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let token = comps.queryItems?.first(where: { $0.name == "t" })?.value,
              !token.isEmpty
        else { return nil }
        return token
    }
}

// One-shot holders for values that need to survive across views during a
// single handoff. Cleared after consumption.
enum PendingHandoff {
    static var token: String?
    static var jti: String?
}

// Minimal JWT payload reader. Does NOT verify signature — that's the server's
// job. We only need to read claims for local routing.
enum JWTDecoder {
    static func extractClaim(token: String, key: String) -> String? {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        let payloadPart = String(parts[1])
        guard let data = base64UrlDecode(payloadPart),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return json[key] as? String
    }

    private static func base64UrlDecode(_ s: String) -> Data? {
        var padded = s.replacingOccurrences(of: "-", with: "+")
                      .replacingOccurrences(of: "_", with: "/")
        while padded.count % 4 != 0 { padded += "=" }
        return Data(base64Encoded: padded)
    }
}
