import Foundation
import CoreLocation
import StripeTerminal

// Wraps the Stripe Terminal iOS SDK (5.x) for Tap to Pay on iPhone.
//
// Lifecycle:
//   1. `TerminalManager.shared.configure()` — called once at app startup.
//      Initializes the Terminal singleton with our token provider and
//      requests location permission. Must run before any access to
//      `Terminal.shared`.
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
    // Stripe holds the DiscoveryDelegate weakly (SCPConnectionConfiguration.h:29).
    // Retain it here so it outlives the withCheckedThrowingContinuation closure.
    private var discoveryDelegate: DiscoveryCallback?
    private let locationManager = CLLocationManager()

    func configure() {
        guard !isConfigured else { return }
        Terminal.initWithTokenProvider(TokenProvider.shared)
        if locationManager.authorizationStatus == .notDetermined {
            locationManager.requestWhenInUseAuthorization()
        }
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

        switch locationManager.authorizationStatus {
        case .denied, .restricted:
            throw NSError(domain: "wavespay", code: -3, userInfo: [NSLocalizedDescriptionKey: "Location is off for WavesPay. Enable it in Settings → Privacy → Location Services, then try again."])
        default:
            break
        }

        // Discover the on-device Tap-to-Pay reader. Discovery returns a
        // single synthetic reader representing the iPhone itself.
        let config = try TapToPayDiscoveryConfigurationBuilder().build()
        let reader = try await discoverFirstReader(config: config)
        try await connectTapToPay(reader: reader)
        isConnected = true
    }

    private func discoverFirstReader(config: TapToPayDiscoveryConfiguration) async throws -> Reader {
        try await withCheckedThrowingContinuation { cont in
            var resumed = false
            let delegate = DiscoveryCallback { [weak self] readers in
                guard !resumed, let reader = readers.first else { return }
                resumed = true
                self?.discoverCancelable?.cancel { _ in }
                self?.discoverCancelable = nil
                self?.discoveryDelegate = nil
                cont.resume(returning: reader)
            }
            self.discoveryDelegate = delegate
            self.discoverCancelable = Terminal.shared.discoverReaders(config, delegate: delegate) { [weak self] error in
                if let error, !resumed {
                    resumed = true
                    self?.discoveryDelegate = nil
                    cont.resume(throwing: error)
                }
            }
        }
    }

    private func connectTapToPay(reader: Reader) async throws {
        let locId = Bundle.main.object(forInfoDictionaryKey: "STRIPE_TERMINAL_LOCATION_ID") as? String ?? ""
        let connConfig = try TapToPayConnectionConfigurationBuilder(
            delegate: TapToPayDelegate.shared,
            locationId: locId
        ).build()
        _ = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Reader, Error>) in
            Terminal.shared.connectReader(reader, connectionConfig: connConfig) { reader, error in
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

// MARK: - Tap-to-Pay reader delegate
//
// `TapToPayConnectionConfiguration` requires a delegate conforming to
// `TapToPayReaderDelegate` (5 required methods: update install progress,
// input prompts, display messages). `TapToPayReaderDelegate` inherits from
// `ReaderDelegate`, which carries the auto-reconnect hooks. All methods
// are intentional stubs for v1 — the NFC flow is short and we let Stripe's
// built-in UI handle user messaging.

private final class TapToPayDelegate: NSObject, TapToPayReaderDelegate {
    static let shared = TapToPayDelegate()

    func tapToPayReader(_ reader: Reader, didStartInstallingUpdate update: ReaderSoftwareUpdate, cancelable: Cancelable?) {}
    func tapToPayReader(_ reader: Reader, didReportReaderSoftwareUpdateProgress progress: Float) {}
    func tapToPayReader(_ reader: Reader, didFinishInstallingUpdate update: ReaderSoftwareUpdate?, error: Error?) {}
    func tapToPayReader(_ reader: Reader, didRequestReaderInput inputOptions: ReaderInputOptions) {}
    func tapToPayReader(_ reader: Reader, didRequestReaderDisplayMessage displayMessage: ReaderDisplayMessage) {}
}
