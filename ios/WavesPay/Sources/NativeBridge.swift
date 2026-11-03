import SwiftUI
import WebKit

// The bridge messages for save-card mode and the hand-off lock. PortalCoordinator
// passes these four to `handle`; every other message stays in PortalView.
//
//   { type: 'capabilities', requestId }  -> 'wavesadmin:capabilities'
//        { requestId, capabilities: ['saveCard', 'handoffLock'] }
//   { type: 'handoffStart', requestId }  -> 'wavesadmin:handoff'
//        { requestId, status: 'started' }
//   { type: 'handoffEnd', requestId }    -> 'wavesadmin:handoff'
//        { requestId, status: 'ended' | 'denied', auth?: 'unavailable' }
//   { type: 'saveCard', requestId, deepLink } -> 'wavesadmin:savecard'
//        { requestId, status: 'succeeded', card } | { status: 'failed', message }
//        | { status: 'canceled' }
//
// Each request gets exactly one answer, in the web view that asked.
@MainActor
final class NativeBridge {
    static let messageTypes: Set<String> = ["capabilities", "handoffStart", "handoffEnd", "saveCard"]
    static let capabilities = ["saveCard", "handoffLock"]

    static let capabilitiesEvent = "wavesadmin:capabilities"
    static let handoffEvent = "wavesadmin:handoff"
    static let saveCardEvent = "wavesadmin:savecard"

    private let lock: HandoffLock
    // True while a payment sheet is open (AppState.flow).
    private let paymentIsOpen: () -> Bool
    private var saveCardController: UIViewController?
    private var saveCardRunning = false

    init(lock: HandoffLock? = nil, paymentIsOpen: @escaping () -> Bool) {
        self.lock = lock ?? HandoffLock.shared
        self.paymentIsOpen = paymentIsOpen
    }

    func handle(_ body: [String: Any], from page: WKWebView) {
        let requestId = body["requestId"] as? String
        switch body["type"] as? String {
        case "capabilities":
            send(Self.capabilitiesEvent, ["capabilities": Self.capabilities], requestId: requestId, to: page)
        case "handoffStart":
            lock.start()
            send(Self.handoffEvent, ["status": "started"], requestId: requestId, to: page)
        case "handoffEnd":
            Task { [weak self, weak page] in
                guard let self else { return }
                let detail: [String: Any]
                switch await self.lock.end() {
                case .ended(let unavailable):
                    detail = unavailable ? ["status": "ended", "auth": "unavailable"] : ["status": "ended"]
                case .denied:
                    detail = ["status": "denied"]
                }
                self.send(Self.handoffEvent, detail, requestId: requestId, to: page)
            }
        case "saveCard":
            startSaveCard(body, requestId: requestId, from: page)
        default:
            break
        }
    }

    // MARK: - Save card

    private func startSaveCard(_ body: [String: Any], requestId: String?, from page: WKWebView) {
        // One save at a time, and never over an open payment.
        if saveCardRunning || paymentIsOpen() {
            return fail("Another payment is already open in Waves Admin.", requestId: requestId, to: page)
        }
        guard let link = body["deepLink"] as? String, let url = URL(string: link),
              let token = SaveCardSession.token(from: url)
        else {
            return fail("This card link is not valid. Start again from the booking page.", requestId: requestId, to: page)
        }
        let session = SaveCardSession()
        let controller = UIHostingController(rootView: SaveCardView(session: session))
        // The Waves look is light by design; dark mode would fight the glass.
        controller.overrideUserInterfaceStyle = .light
        // Closed only by this flow ending: a swipe must not strand the request.
        controller.isModalInPresentation = true
        guard present(controller) else {
            return fail("Waves Admin could not open the card screen. Try again.", requestId: requestId, to: page)
        }
        saveCardRunning = true
        saveCardController = controller
        // Connect the reader while the link is checked.
        TerminalManager.shared.prepare()
        Task { [weak self, weak page] in
            let outcome = await session.run(token: token)
            guard let self else { return }
            switch outcome {
            case .succeeded(let card):
                self.send(Self.saveCardEvent, ["status": "succeeded", "card": card], requestId: requestId, to: page)
                // Hold "Card saved" a moment, then close the screen.
                try? await Task.sleep(nanoseconds: 1_300_000_000)
            case .failed(let message):
                self.send(Self.saveCardEvent, ["status": "failed", "message": message], requestId: requestId, to: page)
            case .canceled:
                self.send(Self.saveCardEvent, ["status": "canceled"], requestId: requestId, to: page)
            }
            self.finishSaveCard()
        }
    }

    private func finishSaveCard() {
        saveCardController?.dismiss(animated: true)
        saveCardController = nil
        saveCardRunning = false
    }

    private func fail(_ message: String, requestId: String?, to page: WKWebView) {
        send(Self.saveCardEvent, ["status": "failed", "message": message], requestId: requestId, to: page)
    }

    // MARK: - Helpers

    private func present(_ controller: UIViewController) -> Bool {
        guard let top = TopViewController.current(), !top.isBeingDismissed, !top.isBeingPresented else { return false }
        top.present(controller, animated: true)
        return true
    }

    // A CustomEvent on the asking web view's window, only while it shows a
    // portal page.
    private func send(_ event: String, _ detail: [String: Any], requestId: String?, to page: WKWebView?) {
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
