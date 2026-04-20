import SwiftUI

struct CollectView: View {
    @EnvironmentObject var app: AppState
    let handoff: API.ValidatedHandoff

    private var dollarAmount: String {
        let dollars = Double(handoff.amount_cents) / 100.0
        let fmt = NumberFormatter()
        fmt.numberStyle = .currency
        fmt.currencyCode = handoff.currency.uppercased()
        return fmt.string(from: NSNumber(value: dollars)) ?? "$\(dollars)"
    }

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text("Collect")
                .font(.headline).foregroundColor(.secondary).textCase(.uppercase)

            Text(dollarAmount)
                .font(.system(size: 72, weight: .bold, design: .rounded))
                .minimumScaleFactor(0.5)
                .lineLimit(1)

            if let name = handoff.customer_name, !name.isEmpty {
                Text("From \(name)")
                    .font(.title3)
                    .foregroundColor(.secondary)
            }

            Spacer()

            Button(action: collect) {
                Label("Tap to Collect", systemImage: "wave.3.forward")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 18)
            }
            .background(Color.accentColor)
            .foregroundColor(.white)
            .cornerRadius(999)

            Button("Cancel") { app.flow = .idle }
                .foregroundColor(.secondary)
                .padding(.bottom, 10)
        }
        .padding(.horizontal, 28)
        .background(Color(.systemBackground))
    }

    private func collect() {
        app.flow = .collecting
        Task {
            do {
                let pi = try await API.createPaymentIntent(jti: extractJti())
                let confirmed = try await TerminalManager.shared.collect(clientSecret: pi.clientSecret)
                app.flow = .success(confirmed.stripeId ?? pi.paymentIntentId)
            } catch {
                app.flow = .failure(error.localizedDescription)
            }
        }
    }

    // jti was decoded from the JWT during validate() and stashed in
    // PendingHandoff. /payment-intent uses it to look up the burned
    // handoff row (tech, invoice, amount all bound to the jti).
    private func extractJti() -> String {
        return PendingHandoff.jti ?? ""
    }
}
