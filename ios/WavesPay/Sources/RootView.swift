import SwiftUI

// Waves Admin: the staff portal pages fill the screen, and Tap to Pay runs in
// a sheet over them, so taking a card never leaves the app.
struct RootView: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        PortalView()
            .ignoresSafeArea()
            .sheet(isPresented: paymentSheetShown) {
                PaymentSheet()
                    .environmentObject(app)
                    .interactiveDismissDisabled(app.flow.isBusy)
            }
            .onAppear { TerminalManager.shared.configure() }
    }

    // The sheet shows while a payment is open. Swiping it away closes the
    // payment, which tells the page it was canceled.
    private var paymentSheetShown: Binding<Bool> {
        Binding(
            get: { app.flow.isActive },
            set: { shown in if !shown { app.close() } }
        )
    }
}

struct PaymentSheet: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        switch app.flow {
        case .idle:
            Color(.systemBackground)
        case .validating:
            LoadingView(message: "Verifying payment…")
        case .ready(let handoff):
            CollectView(handoff: handoff)
        case .collecting:
            LoadingView(message: "Tap customer's card or device…")
        case .success(let pi):
            SuccessView(paymentIntentId: pi)
        case .failure(let msg):
            FailureView(message: msg)
        }
    }
}

struct LoadingView: View {
    let message: String
    var body: some View {
        VStack(spacing: 16) {
            ProgressView().scaleEffect(1.5)
            Text(message).foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}

struct SuccessView: View {
    @EnvironmentObject var app: AppState
    let paymentIntentId: String

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 72))
                .foregroundColor(.green)
            Text("Payment collected")
                .font(.title.bold())
            Text(paymentIntentId)
                .font(.caption.monospaced())
                .foregroundColor(.secondary)
            Spacer().frame(height: 20)
            Button("Done") { app.close() }
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}

struct FailureView: View {
    @EnvironmentObject var app: AppState
    let message: String

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 72))
                .foregroundColor(.red)
            Text("Payment failed")
                .font(.title.bold())
            Text(message)
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
                .padding(.horizontal, 40)
            Spacer().frame(height: 20)
            Button("Back") { app.close() }
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}
