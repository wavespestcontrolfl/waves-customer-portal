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
    //
    // When `surchargeEnabled` is true we run the two-step credit-card surcharge:
    // collect the card (funding becomes known), ask the server to raise the PI to
    // base + 2.9% for credit cards, then confirm. The collect uses
    // updatePaymentIntent so the SDK confirms against the server-updated amount.
    //
    // Surcharge is NOT best-effort once the customer has seen the disclosure: we
    // must never silently settle a credit card at base because the surcharge
    // step failed. We confirm only on a definitive server result —
    // applied:true (credit, PI raised) or applied:false with no failure reason
    // (a real debit/prepaid/unknown no-surcharge, or the gate being off). Any
    // network/HTTP error or failure reason (awaiting_card / pi_not_updatable /
    // apply_failed) aborts so the tech can re-tap rather than under-charge.
    //
    // ⚠️ FIELD TEST before flipping GATE_TERMINAL_SURCHARGE on: verify on a real
    // device with real credit AND debit cards that (a) the confirmed amount
    // equals base + surcharge for credit and base for debit, and (b) the SDK
    // picks up the server-side amount change here (StripeTerminal 5.x +
    // 2026-03-25.preview surcharge API). If confirm rejects the amount change,
    // re-retrieve the PI after apply-surcharge and confirm the fresh object.
    func collect(clientSecret: String, jti: String, surchargeEnabled: Bool) async throws -> PaymentIntent {
        try await ensureConnected()
        let pi = try await retrievePI(clientSecret: clientSecret)
        let collected = try await collectMethod(pi: pi, allowAmountUpdate: surchargeEnabled)
        if surchargeEnabled {
            // Throws on network/HTTP error → aborts the charge (no silent base settle).
            let resp = try await API.applyTerminalSurcharge(jti: jti)
            let failureReasons: Set<String> = ["awaiting_card", "pi_not_updatable", "apply_failed"]
            if let reason = resp.reason, failureReasons.contains(reason) {
                throw NSError(domain: "wavespay", code: -4, userInfo: [
                    NSLocalizedDescriptionKey: "Couldn't finalize the card surcharge. Please tap to collect again.",
                ])
            }
            // applied:true (credit raised) or applied:false w/o failure reason
            // (debit/prepaid/unknown no-surcharge, or gate off) → safe to confirm.
        }
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

    // `allowAmountUpdate` sets updatePaymentIntent so the server can raise the PI
    // amount (the surcharge) after collect and before confirm. Off → today's
    // single-amount behavior, byte-for-byte.
    private func collectMethod(pi: PaymentIntent, allowAmountUpdate: Bool) async throws -> PaymentIntent {
        let config = try? CollectPaymentIntentConfigurationBuilder()
            .setUpdatePaymentIntent(allowAmountUpdate)
            .build()
        return try await withCheckedThrowingContinuation { cont in
            let completion: (PaymentIntent?, Error?) -> Void = { pi, error in
                if let error { cont.resume(throwing: error) }
                else if let pi { cont.resume(returning: pi) }
                else { cont.resume(throwing: NSError(domain: "wavespay", code: -1)) }
            }
            if let config {
                _ = Terminal.shared.collectPaymentMethod(pi, collectConfig: config, completion: completion)
            } else {
                _ = Terminal.shared.collectPaymentMethod(pi, completion: completion)
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
