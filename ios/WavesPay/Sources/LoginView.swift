import SwiftUI

struct LoginView: View {
    @EnvironmentObject var app: AppState
    @State private var email = ""
    @State private var password = ""
    @State private var submitting = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "wave.3.right")
                .font(.system(size: 48))
                .foregroundColor(.accentColor)
            Text("WavesPay").font(.largeTitle.bold())
            Text("Sign in with your tech credentials")
                .foregroundColor(.secondary)
                .padding(.bottom, 8)

            TextField("Email", text: $email)
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)
                .autocapitalization(.none)
                .padding(14)
                .background(Color(.secondarySystemBackground))
                .cornerRadius(12)

            SecureField("Password", text: $password)
                .textContentType(.password)
                .padding(14)
                .background(Color(.secondarySystemBackground))
                .cornerRadius(12)

            if let error {
                Text(error).foregroundColor(.red).font(.footnote)
            }

            Button(action: submit) {
                if submitting {
                    ProgressView().tint(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                } else {
                    Text("Sign in")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                }
            }
            .background(Color.accentColor)
            .foregroundColor(.white)
            .cornerRadius(999)
            .disabled(submitting || email.isEmpty || password.isEmpty)

            Spacer()
        }
        .padding(.horizontal, 24)
        .background(Color(.systemBackground))
    }

    private func submit() {
        submitting = true
        error = nil
        Task {
            defer { submitting = false }
            do {
                let resp = try await API.login(email: email, password: password)
                app.signIn(token: resp.token, techName: resp.technician.name)
                // If a handoff deep link arrived before login, consume it now.
                if let t = PendingHandoff.token {
                    PendingHandoff.token = nil
                    await app.validate(token: t)
                }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
