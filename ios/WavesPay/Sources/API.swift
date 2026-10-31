import Foundation

// HTTP client for the portal's terminal routes.
//
// Base URL ships as portal.wavespestcontrol.com. Override with a build setting
// named WAVESPAY_API_BASE (plumbed into Info.plist) for dev/staging.

enum API {
    private static var base: URL {
        let override = Bundle.main.object(forInfoDictionaryKey: "WAVESPAY_API_BASE") as? String
        let s = override?.isEmpty == false ? override! : "https://portal.wavespestcontrol.com/api"
        return URL(string: s)!
    }

    // The portal the staff pages load from: the API base without its path
    // (https://portal.wavespestcontrol.com/api → https://portal.wavespestcontrol.com).
    static var portalOrigin: URL {
        var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        comps.path = ""
        comps.query = nil
        return comps.url!
    }

    struct ValidatedHandoff: Decodable {
        let invoice_id: String
        let customer_name: String?
        let amount_cents: Int
        let currency: String
        let authToken: String?
        // True only when GATE_TERMINAL_SURCHARGE is on server-side. Optional so
        // older server responses (pre-feature) decode to nil → treated as off.
        let surcharge_enabled: Bool?
        // Server-calculated, so the pre-tap credit total shown matches the charge.
        // Present only when surcharge is enabled; the credit total includes 2.9%.
        let surcharge_cents: Int?
        let credit_total_cents: Int?
        // What the customer pays for: the invoice's service lines and the
        // totals rows down to the amount due. Older servers send neither.
        let invoice_number: String?
        let items: [Item]?
        let adjustments: [Adjustment]?

        struct Item: Decodable {
            let description: String
            // Nil when the rows do not add up to the charge: names only.
            let amount_cents: Int?
        }

        struct Adjustment: Decodable {
            let label: String        // "Account credit applied"
            let amount_cents: Int    // negative for a deduction
        }
    }

    struct PaymentIntentResponse: Decodable {
        let clientSecret: String
        let paymentIntentId: String
        let amount: Int
    }

    // Result of the post-tap surcharge step. `applied` is true only when the
    // card read as credit and the PI was raised to base + 2.9%. Amounts are in
    // cents. A no-op (gate off, debit/unknown, or recoverable failure) returns
    // applied:false and the device confirms at base.
    struct ApplySurchargeResponse: Decodable {
        let applied: Bool
        let funding: String?
        let base: Int?
        let surcharge: Int?
        let total: Int?
        let rateBps: Int?
        let reason: String?
    }

    enum APIError: LocalizedError {
        case http(Int, String)
        case network(Error)
        case decoding(Error)
        case unauthorized

        var errorDescription: String? {
            switch self {
            case .http(let code, let body): return Self.message(status: code, body: body)
            case .network(let e): return "Network error: \(e.localizedDescription)"
            case .decoding(let e): return "Decoding error: \(e.localizedDescription)"
            case .unauthorized: return "This payment timed out. Close this and tap Tap to Pay again."
            }
        }

        // The terminal routes answer { error, code }. The common codes get a
        // next step; any other shows the server's own text, not raw JSON.
        private static func message(status: Int, body: String) -> String {
            struct ServerError: Decodable { let error: String?; let code: String? }
            let parsed = body.data(using: .utf8).flatMap { try? JSONDecoder().decode(ServerError.self, from: $0) }
            switch parsed?.code {
            case "expired", "handoff_reissue_required", "signature_invalid":
                return "This payment link expired. Close this and tap Tap to Pay again."
            case "invoice_amount_changed":
                return "The invoice total changed. Close this and tap Tap to Pay again."
            case "TOKEN_EXPIRED":
                return "This payment timed out. Close this and tap Tap to Pay again."
            case "staff_session_revoked", "TOKEN_REVOKED":
                return "Your sign-in ended. Sign in again on the portal page, then tap Tap to Pay again."
            default:
                if let text = parsed?.error, !text.isEmpty { return text }
                return "HTTP \(status): \(body)"
            }
        }
    }

    static func validateHandoff(token: String) async throws -> ValidatedHandoff {
        // Unauthenticated — the signed JWT IS the auth for this call.
        let body = ["token": token]
        return try await request("/stripe/terminal/validate-handoff", body: body, auth: false)
    }

    static func createPaymentIntent(jti: String) async throws -> PaymentIntentResponse {
        // surcharge_capable tells the server this build can run the post-tap
        // surcharge step. When the gate is on, the server refuses to mint a PI
        // without it (so an old build can't settle a credit card base-only).
        struct Body: Encodable { let jti: String; let surcharge_capable: Bool }
        return try await request(
            "/stripe/terminal/payment-intent",
            body: Body(jti: jti, surcharge_capable: true),
            auth: true,
        )
    }

    // Called between collectPaymentMethod and confirmPaymentIntent. The server
    // reads the now-known card funding and raises the PI to base + 2.9% for
    // credit cards (no-op otherwise). Safe to call even when the feature is off.
    static func applyTerminalSurcharge(jti: String) async throws -> ApplySurchargeResponse {
        let body = ["jti": jti]
        return try await request("/stripe/terminal/apply-surcharge", body: body, auth: true)
    }

    static func connectionToken() async throws -> String {
        struct Resp: Decodable { let secret: String }
        let r: Resp = try await request("/stripe/terminal/connection-token", body: [String: String](), auth: true)
        return r.secret
    }

    // MARK: - Helpers

    private static func request<B: Encodable, R: Decodable>(
        _ path: String, body: B, auth: Bool
    ) async throws -> R {
        var req = URLRequest(url: base.appendingPathComponent(path.trimmingLeadingSlash))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if auth {
            guard let token = await MainActor.run(body: { Keychain.read(key: "authToken") }) else {
                throw APIError.unauthorized
            }
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            req.httpBody = try JSONEncoder().encode(body)
        } catch {
            throw APIError.decoding(error)
        }

        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw APIError.network(error)
        }

        guard let http = resp as? HTTPURLResponse else {
            throw APIError.http(0, "No response")
        }
        // A 401 that names its cause (a bad link, an ended sign-in) keeps the
        // body so the message can say which; a bare 401 is an expired token.
        if http.statusCode == 401 && !jsonHasField(data, "code") { throw APIError.unauthorized }
        if !(200..<300).contains(http.statusCode) {
            let bodyString = String(data: data, encoding: .utf8) ?? ""
            throw APIError.http(http.statusCode, bodyString)
        }

        do {
            return try JSONDecoder().decode(R.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }
}

private func jsonHasField(_ data: Data, _ field: String) -> Bool {
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
    return json[field] != nil
}

private extension String {
    var trimmingLeadingSlash: String {
        hasPrefix("/") ? String(dropFirst()) : self
    }
}
