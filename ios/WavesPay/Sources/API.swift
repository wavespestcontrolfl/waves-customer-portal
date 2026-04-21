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

    struct ValidatedHandoff: Decodable {
        let invoice_id: String
        let customer_name: String?
        let amount_cents: Int
        let currency: String
    }

    struct PaymentIntentResponse: Decodable {
        let clientSecret: String
        let paymentIntentId: String
        let amount: Int
    }

    struct LoginResponse: Decodable {
        let token: String
        let technician: Technician
        struct Technician: Decodable { let id: String; let name: String }

        // Server returns the tech under `user` (shared with the web admin portal);
        // iOS keeps the domain-correct `technician` name locally.
        enum CodingKeys: String, CodingKey {
            case token
            case technician = "user"
        }
    }

    enum APIError: LocalizedError {
        case http(Int, String)
        case network(Error)
        case decoding(Error)
        case unauthorized

        var errorDescription: String? {
            switch self {
            case .http(let code, let body): return "HTTP \(code): \(body)"
            case .network(let e): return "Network error: \(e.localizedDescription)"
            case .decoding(let e): return "Decoding error: \(e.localizedDescription)"
            case .unauthorized: return "Session expired — please sign in again."
            }
        }
    }

    static func login(email: String, password: String) async throws -> LoginResponse {
        let body = ["email": email, "password": password]
        return try await request("/admin/auth/login", body: body, auth: false)
    }

    static func validateHandoff(token: String) async throws -> ValidatedHandoff {
        // Unauthenticated — the signed JWT IS the auth for this call.
        let body = ["token": token]
        return try await request("/stripe/terminal/validate-handoff", body: body, auth: false)
    }

    static func createPaymentIntent(jti: String) async throws -> PaymentIntentResponse {
        let body = ["jti": jti]
        return try await request("/stripe/terminal/payment-intent", body: body, auth: true)
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
        if http.statusCode == 401 { throw APIError.unauthorized }
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

private extension String {
    var trimmingLeadingSlash: String {
        hasPrefix("/") ? String(dropFirst()) : self
    }
}
