import SwiftUI

struct LoginView: View {
    @EnvironmentObject var app: AppState
    @State private var email = ""
    @State private var password = ""
    @State private var submitting = false
    @State private var error: String?
    // Two-step sign-in: set once the password passed for an enrolled account.
    @State private var challengeToken: String?
    @State private var code = ""

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

            if challengeToken == nil {
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
            } else {
                Text("Enter the 6-digit code from your authenticator app, or a recovery code.")
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                TextField("Authentication code", text: $code)
                    .textContentType(.oneTimeCode)
                    .autocapitalization(.allCharacters)
                    .disableAutocorrection(true)
                    .padding(14)
                    .background(Color(.secondarySystemBackground))
                    .cornerRadius(12)
            }

            if let error {
                Text(error).foregroundColor(.red).font(.footnote)
            }

            Button(action: submit) {
                if submitting {
                    ProgressView().tint(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                } else {
                    Text(challengeToken == nil ? "Sign in" : "Verify")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                }
            }
            .background(Color.accentColor)
            .foregroundColor(.white)
            .cornerRadius(999)
            .disabled(submitting || (challengeToken == nil ? (email.isEmpty || password.isEmpty) : code.isEmpty))

            if challengeToken != nil {
                Button("Back to email and password") {
                    challengeToken = nil
                    code = ""
                    error = nil
                }
                .font(.footnote)
            }

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
                let resp: API.LoginResponse
                if let challenge = challengeToken {
                    resp = try await API.loginMfa(challengeToken: challenge, code: code.trimmingCharacters(in: .whitespaces))
                } else {
                    resp = try await API.login(email: email, password: password)
                }
                if resp.mfaRequired == true, let challenge = resp.challengeToken {
                    challengeToken = challenge
                    password = ""
                    code = ""
                    return
                }
                guard let token = resp.token, let technician = resp.technician else {
                    self.error = "Sign-in failed. Try again."
                    return
                }
                app.signIn(token: token, techName: technician.name)
                // If a handoff deep link arrived before login, consume it now.
                if let t = PendingHandoff.token {
                    PendingHandoff.token = nil
                    await app.validate(token: t)
                }
            } catch API.APIError.unauthorized where challengeToken != nil {
                // A wrong code and an expired challenge both answer 401 here.
                self.error = "That code did not work. Try again, or go back and sign in again."
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
