import SwiftUI

struct RootView: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        Group {
            if !app.isLoggedIn {
                LoginView()
            } else {
                switch app.flow {
                case .idle:
                    IdleView()
                case .validating:
                    LoadingView(message: "Verifying payment link…")
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
        .onAppear { TerminalManager.shared.configure() }
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

struct IdleView: View {
    @EnvironmentObject var app: AppState
    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "wave.3.right")
                .font(.system(size: 48, weight: .regular))
                .foregroundColor(.accentColor)
            Text("WavesPay")
                .font(.largeTitle.bold())
            Text("Tap a \"Charge now\" button in the Waves portal to start a payment.")
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
                .padding(.horizontal, 40)

            Spacer()

            if let name = app.techName {
                Text("Signed in as \(name)").foregroundColor(.secondary).font(.footnote)
            }
            Button("Sign out") { app.signOut() }
                .font(.footnote)
                .padding(.bottom, 20)
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
            Button("Done") { app.flow = .idle }
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
            Button("Back") { app.flow = .idle }
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}
