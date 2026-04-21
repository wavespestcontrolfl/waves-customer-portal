import Foundation
import StripeTerminal

// Wraps the Stripe Terminal iOS SDK for Tap to Pay on iPhone.
//
// Lifecycle:
//   1. `TerminalManager.shared.configure()` — called once at app startup.
//      Registers the connection-token provider. Must run before any call
//      that hits `Terminal.shared`.
//   2. `collect(clientSecret:)` — discovers the on-device Tap-to-Pay reader,
//      connects if not already connected, retrieves the PaymentIntent via
//      the client secret, collects the payment method (NFC sheet), and
//      confirms. Reused across charges — connecting once per app session
//      is enough; Stripe's SDK maintains the local reader.
//
// Thread: public async methods hop to the main actor because the SDK
// delivers delegate callbacks there. The SDK itself serializes internally.

@MainActor
final class TerminalManager: NSObject {
    static let shared = TerminalManager()

    private var isConfigured = false
    private var isConnected = false
    private var discoverCancelable: Cancelable?

    func configure() {
        guard !isConfigured else { return }
        Terminal.setTokenProvider(TokenProvider.shared)
        isConfigured = true
    }

    // Full collect-and-confirm flow. Returns the final PaymentIntent on success.
    func collect(clientSecret: String) async throws -> PaymentIntent {
        try await ensureConnected()
        let pi = try await retrievePI(clientSecret: clientSecret)
        let collected = try await collectMethod(pi: pi)
        let confirmed = try await confirmPI(pi: collected)
        return confirmed
    }

    // MARK: - Private

    private func ensureConnected() async throws {
        if isConnected, Terminal.shared.connectionStatus == .connected { return }

        // Discover local Tap-to-Pay reader. On iPhone Tap-to-Pay, discovery
        // returns a single synthetic reader representing the device itself.
        let config = try LocalMobileDiscoveryConfigurationBuilder().build()
        let reader = try await discoverFirstReader(config: config)
        try await connectTapToPay(reader: reader)
        isConnected = true
    }

    private func discoverFirstReader(config: LocalMobileDiscoveryConfiguration) async throws -> Reader {
        try await withCheckedThrowingContinuation { cont in
            var resumed = false
            let delegate = DiscoveryCallback { [weak self] readers in
                guard !resumed, let reader = readers.first else { return }
                resumed = true
                self?.discoverCancelable?.cancel { _ in }
                self?.discoverCancelable = nil
                cont.resume(returning: reader)
            }
            self.discoverCancelable = Terminal.shared.discoverReaders(config, delegate: delegate) { error in
                if let error, !resumed {
                    resumed = true
                    cont.resume(throwing: error)
                }
            }
        }
    }

    private func connectTapToPay(reader: Reader) async throws {
        let locId = Bundle.main.object(forInfoDictionaryKey: "STRIPE_TERMINAL_LOCATION_ID") as? String ?? ""
        let connConfig = try LocalMobileConnectionConfigurationBuilder(locationId: locId).build()
        _ = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Reader, Error>) in
            Terminal.shared.connectLocalMobileReader(reader, delegate: ReconnectDelegate.shared, connectionConfig: connConfig) { reader, error in
                if let error { cont.resume(throwing: error) }
                else if let reader { cont.resume(returning: reader) }
                else { cont.resume(throwing: NSError(domain: "wavespay", code: -1, userInfo: [NSLocalizedDescriptionKey: "Unknown connect failure"])) }
            }
        }
    }

    private func retrievePI(clientSecret: String) async throws -> PaymentIntent {
        try await withCheckedThrowingContinuation { cont in
            Terminal.shared.retrievePaymentIntent(clientSecret: clientSecret) { pi, error in
                if let error { cont.resume(throwing: error) }
                else if let pi { cont.resume(returning: pi) }
                else { cont.resume(throwing: NSError(domain: "wavespay", code: -1)) }
            }
        }
    }

    private func collectMethod(pi: PaymentIntent) async throws -> PaymentIntent {
        try await withCheckedThrowingContinuation { cont in
            _ = Terminal.shared.collectPaymentMethod(pi) { pi, error in
                if let error { cont.resume(throwing: error) }
                else if let pi { cont.resume(returning: pi) }
                else { cont.resume(throwing: NSError(domain: "wavespay", code: -1)) }
            }
        }
    }

    private func confirmPI(pi: PaymentIntent) async throws -> PaymentIntent {
        try await withCheckedThrowingContinuation { cont in
            Terminal.shared.confirmPaymentIntent(pi) { pi, error in
                if let error { cont.resume(throwing: error) }
                else if let pi { cont.resume(returning: pi) }
                else { cont.resume(throwing: NSError(domain: "wavespay", code: -1)) }
            }
        }
    }
}

// MARK: - Connection token provider

final class TokenProvider: NSObject, ConnectionTokenProvider {
    static let shared = TokenProvider()

    func fetchConnectionToken(_ completion: @escaping ConnectionTokenCompletionBlock) {
        Task {
            do {
                let secret = try await API.connectionToken()
                completion(secret, nil)
            } catch {
                completion(nil, error)
            }
        }
    }
}

// MARK: - Discovery callback shim

private final class DiscoveryCallback: NSObject, DiscoveryDelegate {
    let onReaders: ([Reader]) -> Void
    init(onReaders: @escaping ([Reader]) -> Void) { self.onReaders = onReaders }
    func terminal(_ terminal: Terminal, didUpdateDiscoveredReaders readers: [Reader]) {
        onReaders(readers)
    }
}

// MARK: - Local mobile reader delegate (+ reconnection)
//
// `connectLocalMobileReader` requires a `LocalMobileReaderDelegate` (5 required
// methods covering update install progress, input prompts, and display
// messages). We also conform to `ReconnectionDelegate` so Stripe's auto-
// reconnect hooks have somewhere to land if we ever enable them on the
// connection config. All methods are intentional stubs for v1 — the NFC
// flow is short and we let Stripe's built-in UI handle user messaging.

private final class ReconnectDelegate: NSObject, LocalMobileReaderDelegate, ReconnectionDelegate {
    static let shared = ReconnectDelegate()

    // LocalMobileReaderDelegate — required
    func localMobileReader(_ reader: Reader, didStartInstallingUpdate update: ReaderSoftwareUpdate, cancelable: Cancelable?) {}
    func localMobileReader(_ reader: Reader, didReportReaderSoftwareUpdateProgress progress: Float) {}
    func localMobileReader(_ reader: Reader, didFinishInstallingUpdate update: ReaderSoftwareUpdate?, error: Error?) {}
    func localMobileReader(_ reader: Reader, didRequestReaderInput inputOptions: ReaderInputOptions) {}
    func localMobileReader(_ reader: Reader, didRequestReaderDisplayMessage displayMessage: ReaderDisplayMessage) {}

    // ReconnectionDelegate — stubs
    func reader(_ reader: Reader, didStartReconnect cancelable: Cancelable, disconnectReason: DisconnectReason) {}
    func readerDidSucceedReconnect(_ reader: Reader) {}
    func readerDidFailReconnect(_ reader: Reader) {}
}
