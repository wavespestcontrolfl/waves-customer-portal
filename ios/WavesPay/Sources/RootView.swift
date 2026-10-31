import SwiftUI

// Waves Admin: the staff portal pages fill the screen, and Tap to Pay runs in
// a sheet over them, so taking a card never leaves the app. PortalCoordinator
// presents PaymentSheet over whatever is on top, a portal popup included.
struct RootView: View {
    @EnvironmentObject var app: AppState
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        PortalView()
            .ignoresSafeArea()
            .onAppear { TerminalManager.shared.configure() }
            // Back from another app: reconnect the reader if it dropped.
            .onChange(of: scenePhase) { phase in
                if phase == .active { TerminalManager.shared.prepare() }
            }
            #if DEBUG
            .task { await PaymentPreview.show(in: app) }
            #endif
    }
}

struct PaymentSheet: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        switch app.flow {
        case .idle:
            WavesScene()
        case .validating:
            LoadingView(title: "Getting the payment ready…")
        case .ready(let handoff):
            CollectView(handoff: handoff)
        case .collecting(.starting):
            LoadingView(title: "Opening Tap to Pay…")
        case .collecting(.finishing):
            LoadingView(title: "Finishing the payment…", detail: "Keep this screen open.")
        case .success(let receipt):
            SuccessView(receipt: receipt)
        case .failure(let msg):
            FailureView(message: msg)
        }
    }
}

struct LoadingView: View {
    let title: String
    var detail: String? = nil

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            WavesLogo(height: 128)
            ProgressView()
                .controlSize(.large)
                .tint(Brand.ink)
            VStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(Brand.ink)
                if let detail {
                    Text(detail)
                        .font(.system(size: 16))
                        .foregroundStyle(Brand.body)
                }
            }
            .multilineTextAlignment(.center)
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(WavesScene())
    }
}

struct SuccessView: View {
    @EnvironmentObject var app: AppState
    let receipt: Receipt
    @State private var shown = false

    // A credit card's surcharge, as its own row above the total paid.
    private var surchargeRows: [(label: String, cents: Int)] {
        guard let due = receipt.amountDueCents, receipt.amountCents > due else { return [] }
        return [("Card surcharge", receipt.amountCents - due)]
    }

    var body: some View {
        SheetLayout {
            GlassCard {
                VStack(spacing: 12) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 68))
                        .foregroundStyle(Brand.success)
                        .scaleEffect(shown ? 1 : 0.4)
                        .opacity(shown ? 1 : 0)
                    Text("Payment collected")
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(Brand.ink)
                    Text(Money.format(receipt.amountCents, currency: receipt.currency))
                        .font(.system(size: 48, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(Brand.ink)
                    if let card = receipt.card {
                        Text(card)
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(Brand.body)
                    }
                    if let name = receipt.customerName, !name.isEmpty {
                        Text("From \(name)")
                            .font(.system(size: 17))
                            .foregroundStyle(Brand.body)
                    }
                    if !receipt.items.isEmpty {
                        ServicesList(
                            items: receipt.items, adjustments: receipt.adjustments, extraRows: surchargeRows,
                            totalLabel: "Total paid", totalCents: receipt.amountCents,
                            invoiceNumber: receipt.invoiceNumber, currency: receipt.currency
                        )
                    }
                    Text(receipt.paymentIntentId)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(Brand.body.opacity(0.6))
                        .padding(.top, 4)
                }
            }
        } actions: {
            Button("Done") { app.close() }
                .buttonStyle(GoldButtonStyle())
                .padding(.bottom, 8)
        }
        .onAppear {
            withAnimation(.spring(response: 0.45, dampingFraction: 0.55)) { shown = true }
        }
    }
}

struct FailureView: View {
    @EnvironmentObject var app: AppState
    let message: String

    var body: some View {
        SheetLayout {
            GlassCard {
                VStack(spacing: 14) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 68))
                        .foregroundStyle(Brand.alert)
                    Text("Payment failed")
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(Brand.ink)
                    Text(message)
                        .font(.system(size: 17))
                        .foregroundStyle(Brand.body)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } actions: {
            Button("Back") { app.close() }
                .buttonStyle(GoldButtonStyle())
                .padding(.bottom, 8)
        }
    }
}

#if DEBUG
// Opens one payment screen with sample data, for simulator screenshots:
//   xcrun simctl launch booted com.wavespestcontrol.wavespay \
//     -WavesPreviewScreen success -howToTapShown YES
// Screens: validating, ready, ready-long, starting, finishing, success, failure.
enum PaymentPreview {
    @MainActor
    static func show(in app: AppState) async {
        guard let screen = UserDefaults.standard.string(forKey: "WavesPreviewScreen") else { return }
        // Let the portal view attach its sheet presenter first.
        try? await Task.sleep(nanoseconds: 800_000_000)
        let items: [API.ValidatedHandoff.Item] = [
            .init(description: "Quarterly Pest Control Service", amount_cents: 11900),
            .init(description: "Lawn Fertilization", amount_cents: 7000),
        ]
        let handoff = API.ValidatedHandoff(
            invoice_id: "preview", customer_name: "Sample Customer",
            amount_cents: 18900, currency: "usd", authToken: nil,
            surcharge_enabled: true, surcharge_cents: 548, credit_total_cents: 19448,
            invoice_number: "WPC-2026-0123", items: items, adjustments: []
        )
        // Six services, a discount and account credit: the card scrolls.
        let long = API.ValidatedHandoff(
            invoice_id: "preview", customer_name: "Sample Customer",
            amount_cents: 39000, currency: "usd", authToken: nil,
            surcharge_enabled: true, surcharge_cents: 1131, credit_total_cents: 40131,
            invoice_number: "WPC-2026-0124",
            items: items + [
                .init(description: "Mosquito Barrier Treatment", amount_cents: 8500),
                .init(description: "Rodent Bait Stations × 4", amount_cents: 6000),
                .init(description: "Termite Monitoring", amount_cents: 5000),
                .init(description: "Shrub Fertilization", amount_cents: 4500),
            ],
            adjustments: [
                .init(label: "Gold WaveGuard discount", amount_cents: -2000),
                .init(label: "Account credit applied", amount_cents: -1900),
            ]
        )
        switch screen {
        case "validating": app.flow = .validating
        case "ready": app.flow = .ready(handoff)
        case "ready-long": app.flow = .ready(long)
        case "starting": app.flow = .collecting(.starting)
        case "finishing": app.flow = .collecting(.finishing)
        case "success":
            app.flow = .success(Receipt(
                paymentIntentId: "pi_preview", amountCents: 19448, currency: "usd",
                customerName: "Sample Customer", card: "Visa •••• 4242 · Credit",
                invoiceNumber: "WPC-2026-0123", items: items, amountDueCents: 18900
            ))
        case "failure":
            app.flow = .failure("The invoice total changed. Close this and tap Tap to Pay again.")
        default: break
        }
    }
}
#endif
