import SwiftUI
import UIKit
import WebKit

// Hand-off to a customer: the owner hands his admin phone over to show the
// secure card page. The page opens in its own full-screen web view that holds
// no admin sign-in: a non-persistent data store (no cookies, localStorage or
// IndexedDB from the admin view), a bridge handler named `wavesCustomer` only
// (never `wavesAdmin`), and a navigation policy that keeps the main frame on
// the portal's /secure/ pages. The customer cannot leave it: the screen cannot
// be swiped away, and "Hand back" asks Face ID, Touch ID or the passcode.
//
// Customer page -> app (window.webkit.messageHandlers.wavesCustomer), each
// answered once with a window event on the customer web view:
//   { type: 'capabilities', requestId } -> 'waveshandoff:capabilities'
//        { requestId, capabilities: ['saveCard', 'acceptTerms'] }
//   { type: 'acceptTerms', requestId, termsVersion, consumerNoticeShown }
//        -> 'waveshandoff:terms' { requestId, status: 'ok' | 'failed', message? }
//   { type: 'saveCard', requestId, consentTextVersion, agreed,
//     feeDisclosedAmount, disclosureVersion }
//        -> 'waveshandoff:savecard' { requestId, status: 'succeeded', card }
//           | { status: 'failed', message } | { status: 'canceled' }
//
// The customer page never holds a staff credential. The app runs the staff
// calls in the covered admin page (window.wavesAdminInPersonTerms and
// window.wavesAdminSaveCardHandoff) under the staff sign-in, with the secure
// token read from the URL the admin page opened, never from the customer page.
@MainActor
final class CustomerHandoff: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    static let handlerName = "wavesCustomer"
    static let capabilitiesEvent = "waveshandoff:capabilities"
    static let termsEvent = "waveshandoff:terms"
    static let saveCardEvent = "waveshandoff:savecard"
    static let capabilities = ["saveCard", "acceptTerms"]

    private static let plainFailure = "Something went wrong. Hand the phone back and try again."

    // The opened link, checked: the portal's own origin, a /secure/<token>
    // path, and handoff=1. Returns the token from the path.
    static func validate(_ link: String) -> (url: URL, token: String)? {
        guard let url = URL(string: link),
              Portal.isPortal(url),
              url.port == Portal.origin.port,
              url.user == nil, url.password == nil,
              isSecurePath(url),
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              comps.queryItems?.contains(where: { $0.name == "handoff" && $0.value == "1" }) == true
        else { return nil }
        let parts = url.path.split(separator: "/", omittingEmptySubsequences: true)
        guard parts.count >= 2, parts[0] == "secure", !parts[1].isEmpty else { return nil }
        return (url, String(parts[1]))
    }

    static func isSecurePath(_ url: URL) -> Bool { url.path.hasPrefix("/secure/") }

    // Main-frame loads stay on the portal's /secure/ pages.
    static func allowsMainFrame(_ url: URL) -> Bool {
        url.absoluteString == "about:blank" || (Portal.isPortal(url) && url.port == Portal.origin.port && isSecurePath(url))
    }

    private let url: URL
    private let secureToken: String
    private let requestId: String?
    private weak var adminPage: WKWebView?
    private let app: AppState
    private let lock: HandoffLock
    private let runSaveCard: (String, @escaping (SaveCardSession.Outcome) -> Void) -> Void
    // Answers the admin page once, when the hand-off ends.
    private let onEnded: ([String: Any]) -> Void
    private var controller: CustomerHandoffController?
    private var saveInFlight = false
    // Admin-page calls (terms, save link) that have not answered yet. Hand back
    // waits for them, and none may act after the hand-off ends.
    private var pendingCalls = 0

    init(url: URL, secureToken: String, firstName: String, requestId: String?, adminPage: WKWebView,
         app: AppState, lock: HandoffLock,
         runSaveCard: @escaping (String, @escaping (SaveCardSession.Outcome) -> Void) -> Void,
         onEnded: @escaping ([String: Any]) -> Void) {
        self.url = url
        self.secureToken = secureToken
        self.requestId = requestId
        self.adminPage = adminPage
        self.app = app
        self.lock = lock
        self.runSaveCard = runSaveCard
        self.onEnded = onEnded
        super.init()
        let web = makeWebView()
        controller = CustomerHandoffController(webView: web, firstName: firstName) { [weak self] in self?.handBack() }
    }

    // False when the screen could not open (another screen is still animating).
    func present() -> Bool {
        guard let controller, let top = TopViewController.current(),
              !top.isBeingDismissed, !top.isBeingPresented else { return false }
        top.present(controller, animated: true)
        // Alerts stay off the screen while the customer holds the phone.
        lock.start()
        controller.webView.load(URLRequest(url: url))
        return true
    }

    private func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        // Nothing from the admin web view: its cookies, localStorage and
        // IndexedDB live in the default store.
        config.websiteDataStore = .nonPersistent()
        config.allowsInlineMediaPlayback = true
        let content = WKUserContentController()
        content.add(WeakMessageHandler(self), name: Self.handlerName)
        config.userContentController = content
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        return web
    }

    // MARK: - Hand back

    private func handBack() {
        // A request in progress finishes first: a pending terms or save-link
        // call, or the open card-save screen.
        guard pendingCalls == 0, !saveInFlight, !app.cardSaveOpen else {
            controller?.showNote("Finishing the card save…")
            return
        }
        Task {
            switch await lock.end() {
            case .ended(let unavailable):
                finish(unavailable ? ["status": "ended", "auth": "unavailable"] : ["status": "ended"])
            case .denied:
                break
            }
        }
    }

    private func finish(_ detail: [String: Any]) {
        guard let controller else { return }
        self.controller = nil
        controller.webView.configuration.userContentController.removeScriptMessageHandler(forName: Self.handlerName)
        controller.dismiss(animated: true)
        onEnded(detail)
    }

    // MARK: - Customer page messages

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the customer view's own top frame, on a /secure/ page of the portal.
        guard let web = message.webView, web === self.controller?.webView,
              message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == Portal.origin.scheme,
              message.frameInfo.securityOrigin.host == Portal.origin.host,
              let current = web.url, Self.allowsMainFrame(current), current.absoluteString != "about:blank",
              let body = message.body as? [String: Any]
        else { return }
        let requestId = body["requestId"] as? String
        switch body["type"] as? String {
        case "capabilities":
            reply(Self.capabilitiesEvent, ["capabilities": Self.capabilities], requestId)
        case "acceptTerms":
            acceptTerms(body, requestId)
        case "saveCard":
            saveCard(body, requestId)
        default:
            break
        }
    }

    private func acceptTerms(_ body: [String: Any], _ requestId: String?) {
        let args: [String: Any] = [
            "secureToken": secureToken,
            "termsVersion": Self.scalar(body["termsVersion"]),
            "consumerNoticeShown": (body["consumerNoticeShown"] as? Bool) ?? false,
        ]
        pendingCalls += 1
        Task {
            defer { pendingCalls -= 1 }
            do {
                let result = try await callAdmin("wavesAdminInPersonTerms", args)
                guard controller != nil else { return }
                // Only an explicit { ok: true } records the terms; anything
                // else (missing value, ok absent or false) is a failure.
                let dict = result as? [String: Any]
                if dict?["ok"] as? Bool == true {
                    reply(Self.termsEvent, ["status": "ok"], requestId)
                } else {
                    reply(Self.termsEvent, ["status": "failed", "message": dict.flatMap { Self.text($0) } ?? Self.plainFailure], requestId)
                }
            } catch {
                reply(Self.termsEvent, ["status": "failed", "message": Self.plainFailure], requestId)
            }
        }
    }

    private func saveCard(_ body: [String: Any], _ requestId: String?) {
        guard !saveInFlight else {
            return reply(Self.saveCardEvent, ["status": "failed", "message": AppState.cardSaveOpenMessage], requestId)
        }
        saveInFlight = true
        let args: [String: Any] = [
            "secureToken": secureToken,
            "consentTextVersion": Self.scalar(body["consentTextVersion"]),
            "agreed": (body["agreed"] as? Bool) ?? false,
            "feeDisclosedAmount": Self.scalar(body["feeDisclosedAmount"]),
            "disclosureVersion": Self.scalar(body["disclosureVersion"]),
        ]
        pendingCalls += 1
        Task {
            defer { pendingCalls -= 1 }
            let result: Any?
            do {
                result = try await callAdmin("wavesAdminSaveCardHandoff", args)
            } catch {
                return failSave(Self.plainFailure, requestId)
            }
            // The hand-off ended while the admin page worked: open nothing.
            guard controller != nil else { saveInFlight = false; return }
            let dict = result as? [String: Any]
            guard let link = dict?["deep_link"] as? String, let linkURL = URL(string: link),
                  let token = SaveCardSession.token(from: linkURL)
            else {
                return failSave(dict.flatMap(Self.text) ?? Self.plainFailure, requestId)
            }
            runSaveCard(token) { [weak self] outcome in
                self?.reply(Self.saveCardEvent, outcome.detail, requestId)
            }
            // The save screen keeps the busy guard; this one only stops a
            // second request in the moment before it opens.
            saveInFlight = false
        }
    }

    private func failSave(_ message: String, _ requestId: String?) {
        saveInFlight = false
        reply(Self.saveCardEvent, ["status": "failed", "message": message], requestId)
    }

    // Runs a staff call in the covered admin page, under the staff sign-in.
    private func callAdmin(_ function: String, _ args: [String: Any]) async throws -> Any? {
        guard let page = adminPage, let url = page.url, Portal.isPortal(url) else { throw Self.noAdminPage }
        return try await page.callAsyncJavaScript(
            """
            if (typeof window[fn] !== 'function') { throw new Error('missing'); }
            return await window[fn](args);
            """,
            arguments: ["fn": function, "args": args],
            in: nil,
            contentWorld: .page
        )
    }

    private static let noAdminPage = NSError(domain: "wavespay", code: -6, userInfo: [
        NSLocalizedDescriptionKey: "The admin page is not available.",
    ])

    // A string or number from the customer page, else null. Nothing else
    // (objects, arrays) crosses into the admin page.
    private static func scalar(_ value: Any?) -> Any {
        if let s = value as? String { return String(s.prefix(200)) }
        if let n = value as? NSNumber { return n }
        return NSNull()
    }

    private static func text(_ dict: [String: Any]) -> String? {
        for key in ["message", "error"] {
            if let s = dict[key] as? String, !s.isEmpty { return String(s.prefix(300)) }
        }
        return nil
    }

    private func reply(_ event: String, _ detail: [String: Any], _ requestId: String?) {
        NativeBridge.dispatch(event, detail, requestId: requestId, to: controller?.webView)
    }

    // MARK: - Navigation: the customer stays on /secure/ pages

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        // Frames inside the page (Stripe card fields) load in place.
        if let frame = action.targetFrame, !frame.isMainFrame { return decisionHandler(.allow) }
        // tel:, sms:, mailto:, other sites, downloads, new windows: nothing leaves.
        decisionHandler(action.targetFrame != nil && !action.shouldPerformDownload && Self.allowsMainFrame(url) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }
        controller?.showOffline()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        controller?.hideOffline()
    }
}

extension SaveCardSession.Outcome {
    var detail: [String: Any] {
        switch self {
        case .succeeded(let card): return ["status": "succeeded", "card": card]
        case .failed(let message): return ["status": "failed", "message": message]
        case .canceled: return ["status": "canceled"]
        }
    }
}

// The customer view's screen: glass top bar ("Handed to X", Hand back) over
// the isolated web view. Light by design, and not swipe-dismissable.
final class CustomerHandoffController: UIViewController {
    let webView: WKWebView
    private let firstName: String
    private let onHandBack: () -> Void
    private var offlineLabel: UILabel?
    private let titleLabel = UILabel()
    private var barTitle: String { firstName.isEmpty ? "Handed to you" : "Handed to \(firstName)" }

    init(webView: WKWebView, firstName: String, onHandBack: @escaping () -> Void) {
        self.webView = webView
        self.firstName = firstName
        self.onHandBack = onHandBack
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        isModalInPresentation = true
        overrideUserInterfaceStyle = .light
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Color(hex: 0xE0EEF9))

        let bar = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialLight))
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.contentView.backgroundColor = UIColor.white.withAlphaComponent(0.45)

        let label = titleLabel
        label.text = barTitle
        label.font = .systemFont(ofSize: 17, weight: .semibold)
        label.textColor = UIColor(Brand.ink)
        label.adjustsFontSizeToFitWidth = true
        label.minimumScaleFactor = 0.7

        var buttonConfig = UIButton.Configuration.filled()
        buttonConfig.title = "Hand back"
        buttonConfig.baseBackgroundColor = UIColor(Color(hex: 0xF5B729))
        buttonConfig.baseForegroundColor = UIColor(Brand.ink)
        buttonConfig.cornerStyle = .capsule
        buttonConfig.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 18, bottom: 8, trailing: 18)
        let button = UIButton(configuration: buttonConfig, primaryAction: UIAction { [weak self] _ in self?.onHandBack() })
        button.setContentCompressionResistancePriority(.required, for: .horizontal)

        let row = UIStackView(arrangedSubviews: [label, button])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false
        bar.contentView.addSubview(row)

        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        view.addSubview(bar)
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            row.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            row.bottomAnchor.constraint(equalTo: bar.bottomAnchor, constant: -8),
            row.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 16),
            row.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -16),
            webView.topAnchor.constraint(equalTo: bar.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    // A short line in the top bar; the name returns after a moment.
    func showNote(_ text: String) {
        titleLabel.text = text
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let self else { return }
            self.titleLabel.text = self.barTitle
        }
    }

    func showOffline() {
        guard offlineLabel == nil else { return }
        let label = UILabel()
        label.text = "Can't reach Waves. Check the signal, or hand the phone back."
        label.numberOfLines = 0
        label.textAlignment = .center
        label.textColor = UIColor(Brand.body)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
        ])
        offlineLabel = label
    }

    func hideOffline() {
        offlineLabel?.removeFromSuperview()
        offlineLabel = nil
    }
}

// If the app starts with hand-off mode still on (it was closed while the
// customer held the phone), the customer view is gone. RootView shows this
// screen INSTEAD of the portal web view, which is not created until the device
// check passes (Face ID, Touch ID or the passcode). A phone with no passcode
// cannot be checked and unlocks at once, as Hand back does.
struct HandoffLockedView: View {
    let onUnlocked: () -> Void
    @State private var checking = false

    var body: some View {
        SheetLayout {
            GlassCard {
                VStack(spacing: 12) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 52))
                        .foregroundStyle(Brand.ink)
                    Text("Waves Admin is locked")
                        .font(.system(size: 24, weight: .bold))
                        .foregroundStyle(Brand.ink)
                    Text("Unlock with Face ID or your passcode.")
                        .font(.system(size: 17))
                        .foregroundStyle(Brand.body)
                        .multilineTextAlignment(.center)
                }
            }
        } actions: {
            Button("Unlock") { Task { await unlock() } }
                .buttonStyle(GoldButtonStyle())
                .padding(.bottom, 8)
        }
        .task { await unlock() }
    }

    private func unlock() async {
        guard !checking else { return }
        checking = true
        defer { checking = false }
        if case .ended = await HandoffLock.shared.end() { onUnlocked() }
    }
}
