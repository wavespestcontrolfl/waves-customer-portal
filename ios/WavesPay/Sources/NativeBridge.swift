import SwiftUI
import WebKit

// The admin page's bridge messages for the customer hand-off (Book at the
// Table). PortalCoordinator passes these to `handle`; every other message stays
// in PortalView. The customer's own messages are in CustomerHandoff.swift.
//
//   { type: 'capabilities', requestId }  -> 'wavesadmin:capabilities'
//        { requestId, capabilities: ['handoffOpen'] }
//   { type: 'handoffOpen', requestId, url, firstName } -> 'wavesadmin:handoff'
//        { requestId, status: 'ended', auth?: 'unavailable' }
//        | { requestId, status: 'failed', message }
//      url is the portal's own /secure/<token>?handoff=1 page. The app shows
//      it full screen in an isolated web view (no admin sign-in) until the
//      owner hands back with Face ID. It answers once, when that ends.
//
// Each request gets exactly one answer, in the web view that asked.
@MainActor
final class NativeBridge {
    static let messageTypes: Set<String> = ["capabilities", "handoffOpen"]
    static let capabilities = ["handoffOpen"]

    static let capabilitiesEvent = "wavesadmin:capabilities"
    static let handoffEvent = "wavesadmin:handoff"

    private let lock: HandoffLock
    // Owns the shared busy state: app.cardSaveOpen is true from the moment a
    // save opens until it ends, whatever the outcome.
    private let app: AppState
    private var saveCardController: UIViewController?
    private var customerHandoff: CustomerHandoff?

    init(lock: HandoffLock? = nil, app: AppState) {
        self.lock = lock ?? HandoffLock.shared
        self.app = app
    }

    func handle(_ body: [String: Any], from page: WKWebView) {
        let requestId = body["requestId"] as? String
        switch body["type"] as? String {
        case "capabilities":
            Self.dispatch(Self.capabilitiesEvent, ["capabilities": Self.capabilities], requestId: requestId, to: page)
        case "handoffOpen":
            openHandoff(body, requestId: requestId, from: page)
        default:
            break
        }
    }

    // MARK: - Customer hand-off

    private func openHandoff(_ body: [String: Any], requestId: String?, from page: WKWebView) {
        func failed(_ message: String) {
            Self.dispatch(Self.handoffEvent, ["status": "failed", "message": message], requestId: requestId, to: page)
        }
        if customerHandoff != nil || app.cardSaveOpen || app.flow.isActive {
            return failed("A payment or a hand-off is already open in Waves Admin. Finish it first.")
        }
        guard let link = body["url"] as? String, let checked = CustomerHandoff.validate(link) else {
            return failed("This card link is not valid. Start again from the booking page.")
        }
        let name = String(((body["firstName"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
        let handoff = CustomerHandoff(
            url: checked.url, secureToken: checked.token, firstName: name, requestId: requestId, adminPage: page,
            app: app, lock: lock,
            runSaveCard: { [weak self] token, onOutcome in self?.runSaveCard(token: token, onOutcome: onOutcome) },
            onEnded: { [weak self, weak page] detail in
                self?.customerHandoff = nil
                Self.dispatch(Self.handoffEvent, detail, requestId: requestId, to: page)
            }
        )
        guard handoff.present() else {
            return failed("Waves Admin could not open the card screen. Try again.")
        }
        customerHandoff = handoff
    }

    // MARK: - Save card

    // Opens the save screen and runs one save. `onOutcome` runs when the save
    // ends, before the "Card saved" screen closes. A busy or unopenable screen
    // ends at once with a failed outcome. Everything that starts the save
    // happens before this returns, so the busy guard is set on the same turn.
    private func runSaveCard(token: String, onOutcome: @escaping (SaveCardSession.Outcome) -> Void) {
        // One save at a time, and never over an open payment.
        if app.cardSaveOpen || app.flow.isActive {
            let busy = app.cardSaveOpen ? AppState.cardSaveOpenMessage : "A payment is open in Waves Admin. Finish it first."
            return onOutcome(.failed(busy))
        }
        let session = SaveCardSession()
        let controller = UIHostingController(rootView: SaveCardView(session: session))
        // The Waves look is light by design; dark mode would fight the glass.
        controller.overrideUserInterfaceStyle = .light
        // Closed only by this flow ending: a swipe must not strand the request.
        controller.isModalInPresentation = true
        guard present(controller) else {
            return onOutcome(.failed("Waves Admin could not open the card screen. Try again."))
        }
        app.cardSaveOpen = true
        saveCardController = controller
        // Connect the reader while the link is checked.
        TerminalManager.shared.prepare()
        Task { [weak self] in
            let outcome = await session.run(token: token)
            onOutcome(outcome)
            if case .succeeded = outcome {
                // Hold "Card saved" a moment, then close the screen.
                try? await Task.sleep(nanoseconds: 1_300_000_000)
            }
            self?.finishSaveCard()
        }
    }

    private func finishSaveCard() {
        saveCardController?.dismiss(animated: true)
        saveCardController = nil
        app.cardSaveOpen = false
    }

    // MARK: - Helpers

    private func present(_ controller: UIViewController) -> Bool {
        guard let top = TopViewController.current(), !top.isBeingDismissed, !top.isBeingPresented else { return false }
        top.present(controller, animated: true)
        return true
    }

    // A CustomEvent on a web view's window, only while it shows a portal page.
    static func dispatch(_ event: String, _ detail: [String: Any], requestId: String?, to page: WKWebView?) {
        guard let page, let url = page.url, Portal.isPortal(url) else { return }
        var detail = detail
        if let requestId { detail["requestId"] = requestId }
        page.callAsyncJavaScript(
            "window.dispatchEvent(new CustomEvent(name, { detail }));",
            arguments: ["name": event, "detail": detail],
            in: nil,
            in: .page,
            completionHandler: nil
        )
    }

    // MARK: - A save-card link from outside the app

    // wavespay://save-card from Safari or another app never starts a save: the
    // link carries no page to answer, so the owner is told where to start.
    static func showOpenFromAppNotice(retry: Bool = true) {
        guard let top = TopViewController.current(), !top.isBeingDismissed, !top.isBeingPresented else {
            // A cold launch has no screen to show it on yet: try once more.
            if retry {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { showOpenFromAppNotice(retry: false) }
            }
            return
        }
        let alert = UIAlertController(title: nil, message: "Open this from Waves Admin.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        top.present(alert, animated: true)
    }
}
