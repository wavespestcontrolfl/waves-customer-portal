import SwiftUI

struct CollectView: View {
    @EnvironmentObject var app: AppState
    let handoff: API.ValidatedHandoff

    // Apple asks for its "How to Tap" lesson when Tap to Pay is first used.
    @AppStorage("howToTapShown") private var howToTapShown = false

    private var dollarAmount: String { currency(handoff.amount_cents) }

    private func currency(_ cents: Int) -> String {
        Money.format(cents, currency: handoff.currency)
    }

    var body: some View {
        VStack(spacing: 0) {
            WavesLogo(height: 104)
                .padding(.top, 28)

            Spacer(minLength: 20)

            GlassCard {
                VStack(spacing: 10) {
                    Text("Collect")
                        .font(.system(size: 13, weight: .bold))
                        .tracking(1.4)
                        .textCase(.uppercase)
                        .foregroundStyle(Brand.ink.opacity(0.7))

                    Text(dollarAmount)
                        .font(.system(size: 64, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(Brand.ink)
                        .minimumScaleFactor(0.5)
                        .lineLimit(1)

                    if let name = handoff.customer_name, !name.isEmpty {
                        Text("From \(name)")
                            .font(.system(size: 18, weight: .medium))
                            .foregroundStyle(Brand.body)
                    }

                    // Point-of-sale surcharge disclosure — shown before the tap so the
                    // customer consents by tapping. The credit total is the server's
                    // figure (matches the charge); debit/prepaid pay the base, no
                    // surcharge. Only appears when the feature is live server-side.
                    if handoff.surcharge_enabled == true,
                       let creditTotal = handoff.credit_total_cents,
                       let surcharge = handoff.surcharge_cents, surcharge > 0 {
                        VStack(spacing: 4) {
                            Text("Credit card: \(currency(creditTotal))")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(Brand.ink)
                            Text("includes \(currency(surcharge)) (2.9%) card surcharge · debit cards pay \(dollarAmount), no surcharge")
                                .font(.system(size: 15))
                                .foregroundStyle(Brand.body)
                        }
                        .multilineTextAlignment(.center)
                        // The disclosure must show in full: never cut it to one line.
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, 12)
                        .padding(.horizontal, 14)
                        .frame(maxWidth: .infinity)
                        .background(
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .fill(.white.opacity(0.55))
                        )
                        .padding(.top, 6)
                    }
                }
            }

            Spacer(minLength: 20)

            // Apple's naming and symbol for the checkout button.
            Button(action: collect) {
                Label("Tap to Pay on iPhone", systemImage: "wave.3.right.circle.fill")
            }
            .buttonStyle(GoldButtonStyle())

            HStack(spacing: 12) {
                if #available(iOS 18.0, *) {
                    Button("How to Tap") { Task { await HowToTap.present() } }
                        .buttonStyle(GlassChipButtonStyle())
                }
                Button("Cancel") { app.close() }
                    .buttonStyle(GlassChipButtonStyle())
            }
            .padding(.top, 14)
            .padding(.bottom, 8)
        }
        .padding(.horizontal, 24)
        .background(WavesScene())
        .task {
            guard !howToTapShown else { return }
            howToTapShown = true
            await HowToTap.present()
        }
    }

    private func collect() {
        // One tap starts one charge, even on a fast double tap.
        guard case .ready = app.flow else { return }
        app.beginCollecting()
        // No-op when the reader is connected or connecting; otherwise the
        // connect runs while the server makes the PaymentIntent.
        TerminalManager.shared.prepare()
        Task {
            do {
                let pi = try await API.createPaymentIntent(jti: extractJti())
                let confirmed = try await TerminalManager.shared.collect(
                    clientSecret: pi.clientSecret,
                    jti: extractJti(),
                    surchargeEnabled: handoff.surcharge_enabled == true,
                    onCardRead: { app.cardRead() }
                )
                app.collected(Receipt(confirmed, fallbackId: pi.paymentIntentId, customerName: handoff.customer_name))
            } catch {
                app.fail(error.localizedDescription)
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

enum Money {
    static func format(_ cents: Int, currency: String) -> String {
        let dollars = Double(cents) / 100.0
        let fmt = NumberFormatter()
        fmt.numberStyle = .currency
        fmt.currencyCode = currency.uppercased()
        return fmt.string(from: NSNumber(value: dollars)) ?? "$\(dollars)"
    }
}
