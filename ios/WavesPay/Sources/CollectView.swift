import SwiftUI

struct CollectView: View {
    @EnvironmentObject var app: AppState
    let handoff: API.ValidatedHandoff
    // The jti from the same check as `handoff`. /payment-intent and the
    // surcharge step use it to find the burned handoff row (tech, invoice,
    // amount all bound to it).
    let jti: String

    // Apple asks for its "How to Tap" lesson when Tap to Pay is first used.
    @AppStorage("howToTapShown") private var howToTapShown = false

    private var dollarAmount: String { currency(handoff.amount_cents) }

    private func currency(_ cents: Int) -> String {
        Money.format(cents, currency: handoff.currency)
    }

    var body: some View {
        SheetLayout {
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
                    // customer consents by tapping. It sits above the service list, so
                    // a long invoice never scrolls it out of view. The credit total is
                    // the server's figure (matches the charge); debit/prepaid pay the
                    // base, no surcharge. Only appears when the feature is live
                    // server-side.
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

                    if let items = handoff.items, !items.isEmpty {
                        ServicesList(
                            items: items, adjustments: handoff.adjustments ?? [],
                            totalLabel: "Total due", totalCents: handoff.amount_cents,
                            invoiceNumber: handoff.invoice_number, currency: handoff.currency
                        )
                    }
                }
            }
        } actions: {
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
                let pi = try await API.createPaymentIntent(jti: jti)
                let confirmed = try await TerminalManager.shared.collect(
                    clientSecret: pi.clientSecret,
                    jti: jti,
                    surchargeEnabled: handoff.surcharge_enabled == true,
                    onCardRead: { app.cardRead() }
                )
                app.collected(Receipt(confirmed, fallbackId: pi.paymentIntentId, handoff: handoff))
            } catch {
                app.fail(error.localizedDescription)
            }
        }
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

// What the customer pays for: the invoice's services and the totals rows down
// to the amount due, as the invoice PDF prints them. When the server sends no
// prices (its rows did not add up to the charge), it lists the names only.
struct ServicesList: View {
    let items: [API.ValidatedHandoff.Item]
    let adjustments: [API.ValidatedHandoff.Adjustment]
    var extraRows: [(label: String, cents: Int)] = []
    let totalLabel: String
    let totalCents: Int
    let invoiceNumber: String?
    let currency: String

    private var priced: Bool { items.allSatisfy { $0.amount_cents != nil } }

    // A long invoice keeps its first three services and folds the rest into one row.
    private var rows: [(label: String, cents: Int?)] {
        guard items.count > 4 else { return items.map { ($0.description, $0.amount_cents) } }
        let rest = items.dropFirst(3)
        let restCents = priced ? rest.reduce(0) { $0 + ($1.amount_cents ?? 0) } : nil
        return items.prefix(3).map { ($0.description, $0.amount_cents) } + [("\(rest.count) more services", restCents)]
    }

    var body: some View {
        VStack(spacing: 7) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                LineRow(label: row.label, cents: row.cents, currency: currency)
            }
            if priced {
                ForEach(Array(adjustments.enumerated()), id: \.offset) { _, row in
                    LineRow(label: row.label, cents: row.amount_cents, currency: currency, muted: true)
                }
                ForEach(Array(extraRows.enumerated()), id: \.offset) { _, row in
                    LineRow(label: row.label, cents: row.cents, currency: currency, muted: true)
                }
                Divider().padding(.vertical, 2)
                LineRow(label: totalLabel, cents: totalCents, currency: currency, bold: true)
            }
            if let invoiceNumber, !invoiceNumber.isEmpty {
                Text("Invoice \(invoiceNumber)")
                    .font(.system(size: 14))
                    .foregroundStyle(Brand.body)
                    .padding(.top, 2)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, 12)
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(.white.opacity(0.4)))
        .padding(.top, 4)
    }
}

private struct LineRow: View {
    let label: String
    let cents: Int?
    let currency: String
    var muted = false
    var bold = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(label)
                .multilineTextAlignment(cents == nil ? .center : .leading)
                .frame(maxWidth: .infinity, alignment: cents == nil ? .center : .leading)
            if let cents {
                Text(cents < 0 ? "−" + Money.format(-cents, currency: currency) : Money.format(cents, currency: currency))
                    .monospacedDigit()
            }
        }
        .font(.system(size: 16, weight: bold ? .semibold : .medium))
        .foregroundStyle(muted ? Brand.body : Brand.ink)
    }
}
