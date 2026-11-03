import SwiftUI

// Tap to Pay in save-card mode: one SetupIntent, no charge. The page starts it
// with { type: 'saveCard', requestId, deepLink } (deepLink =
// wavespay://save-card?t=<jwt>) and the app answers once with a
// 'wavesadmin:savecard' window event (see NativeBridge). This screen never
// shows an amount or a surcharge, and the flow never calls /payment-intent or
// /apply-surcharge.
@MainActor
final class SaveCardSession: ObservableObject {
    enum Step: Equatable {
        case working(String, detail: String?)
        case saved
    }

    enum Outcome {
        case succeeded(card: [String: Any])
        case failed(String)
        case canceled
    }

    @Published private(set) var step: Step = .working("Getting the card reader ready…", detail: nil)

    // The checked token inside wavespay://save-card?t=<jwt>.
    static func token(from url: URL) -> String? {
        guard url.scheme == "wavespay",
              url.host == "save-card",
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let token = comps.queryItems?.first(where: { $0.name == "t" })?.value,
              !token.isEmpty
        else { return nil }
        return token
    }

    // Checks the link with the server, makes sure the reader is connected,
    // saves the card with Tap to Pay, and tells the server it is done.
    func run(token: String) async -> Outcome {
        do {
            let validated = try await API.validateSaveCardHandoff(token: token)
            guard validated.kind == "save_card" else {
                return .failed("This card link is not valid. Start again from the booking page.")
            }
            // The terminal token authorizes the connection-token and
            // complete-setup calls, as the payment token does for a payment.
            Keychain.write(key: "authToken", value: validated.auth_token)
            _ = try await TerminalManager.shared.saveCard(
                clientSecret: validated.setup_intent_client_secret,
                onCardRead: { step = .working("Saving the card…", detail: "Keep this screen open.") }
            )
            step = .working("Saving the card…", detail: "Keep this screen open.")
            let done = try await API.completeSetup(setupIntentId: validated.setup_intent_id)
            guard done.ok else { return .failed("The card could not be saved. Try again.") }
            step = .saved
            return .succeeded(card: done.card?.detail ?? [:])
        } catch {
            if TerminalManager.isCustomerCancel(error) { return .canceled }
            return .failed(Self.message(for: error))
        }
    }

    // The server's own text when it sent one ({ error, code }), else the
    // error's description.
    static func message(for error: Error) -> String {
        if let text = API.serverText(error) { return text }
        if case API.APIError.unauthorized = error {
            return "This card link timed out. Start again from the booking page."
        }
        return error.localizedDescription
    }
}

struct SaveCardView: View {
    @ObservedObject var session: SaveCardSession
    @State private var shown = false

    var body: some View {
        switch session.step {
        case .working(let title, let detail):
            LoadingView(title: title, detail: detail)
        case .saved:
            SheetLayout {
                GlassCard {
                    VStack(spacing: 12) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 68))
                            .foregroundStyle(Brand.success)
                            .scaleEffect(shown ? 1 : 0.4)
                            .opacity(shown ? 1 : 0)
                        Text("Card saved")
                            .font(.system(size: 26, weight: .bold))
                            .foregroundStyle(Brand.ink)
                    }
                }
            } actions: {
                EmptyView()
            }
            .onAppear {
                withAnimation(.spring(response: 0.45, dampingFraction: 0.55)) { shown = true }
            }
        }
    }
}
