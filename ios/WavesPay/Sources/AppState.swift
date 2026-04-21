import Foundation
import Combine

@MainActor
final class AppState: ObservableObject {
    // Auth
    @Published var authToken: String? = Keychain.read(key: "authToken")
    @Published var techName: String? = Keychain.read(key: "techName")

    // Flow: .idle → (deep link) → .validating → .ready(handoff) → .collecting → .success/.failure
    @Published var flow: Flow = .idle

    var isLoggedIn: Bool { authToken != nil }

    enum Flow {
        case idle
        case validating
        case ready(API.ValidatedHandoff)
        case collecting
        case success(String)     // paymentIntentId
        case failure(String)     // human message
    }

    func signIn(token: String, techName: String) {
        Keychain.write(key: "authToken", value: token)
        Keychain.write(key: "techName", value: techName)
        self.authToken = token
        self.techName = techName
    }

    func signOut() {
        Keychain.delete(key: "authToken")
        Keychain.delete(key: "techName")
        self.authToken = nil
        self.techName = nil
        self.flow = .idle
    }

    // Called by onOpenURL. The only URL scheme we handle is
    // wavespay://collect?t=<jwt>. Anything else is ignored.
    func handleIncomingURL(_ url: URL) {
        guard url.scheme == "wavespay",
              url.host == "collect",
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let token = comps.queryItems?.first(where: { $0.name == "t" })?.value,
              !token.isEmpty
        else { return }

        // Deep link arrived but tech isn't logged in yet — stash the token, the
        // LoginView will consume it after successful auth.
        guard isLoggedIn else {
            PendingHandoff.token = token
            return
        }
        Task { await validate(token: token) }
    }

    func validate(token: String) async {
        flow = .validating
        do {
            let validated = try await API.validateHandoff(token: token)
            // Pull jti out of the JWT's claims so /payment-intent can use it.
            // Signature check happened server-side — client-side we only
            // need the claim value.
            PendingHandoff.jti = JWTDecoder.extractClaim(token: token, key: "jti")
            flow = .ready(validated)
        } catch {
            flow = .failure(error.localizedDescription)
        }
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
