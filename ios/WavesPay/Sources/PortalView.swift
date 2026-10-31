import Combine
import SwiftUI
import WebKit

// The staff portal (/admin) in a web view, with Tap to Pay wired in.
//
// Page → app: a staff page asks for Tap to Pay with
//   window.webkit.messageHandlers.wavesAdmin.postMessage(
//     { type: 'tapToPay', requestId, deepLink })
// where deepLink is the wavespay://collect?t=<jwt> link that
// POST /api/stripe/terminal/handoff returned.
//
// App → page: each request gets exactly one answer, in the page that asked
// (the main view or a portal popup),
//   window.dispatchEvent(new CustomEvent('wavesadmin:taptopay', { detail }))
// detail = { requestId, status: 'succeeded' | 'failed' | 'canceled',
//            invoiceId?, paymentIntentId?, message? }
//
// Reader warm-up: a signed-in staff page posts { type: 'prepareReader' } and
// defines window.wavesAdminConnectionToken(), which resolves with a Stripe
// connection token from POST /api/stripe/terminal/connection-token under the
// page's own sign-in. The app then connects the reader before any payment.
//
// Staff alerts: a signed-in staff page posts { type: 'registerPush' }; the app
// asks for notification permission and answers with
//   window.dispatchEvent(new CustomEvent('wavesadmin:pushtoken', { detail }))
// detail = { token, environment: 'sandbox' | 'production' }, which the page
// registers under its own sign-in. { type: 'badge', count } sets the icon badge;
// { type: 'clearAlerts' } (sign-out) clears shown alerts and the badge.
//
// The page side of this contract is client/src/lib/tapToPay.js and
// client/src/native/wavesAdminPush.js.

enum Portal {
    static let messageHandler = "wavesAdmin"
    static let resultEvent = "wavesadmin:taptopay"

    static var origin: URL { API.portalOrigin }
    static var startURL: URL { URL(string: "/admin/", relativeTo: origin)!.absoluteURL }

    static func isPortal(_ url: URL) -> Bool {
        url.scheme == origin.scheme && url.host == origin.host
    }
}

struct TapToPayResult {
    enum Status: String { case succeeded, failed, canceled }

    let requestId: String?
    let status: Status
    var invoiceId: String? = nil
    var paymentIntentId: String? = nil
    var message: String? = nil

    var detail: [String: Any] {
        var d: [String: Any] = ["status": status.rawValue]
        if let requestId { d["requestId"] = requestId }
        if let invoiceId { d["invoiceId"] = invoiceId }
        if let paymentIntentId { d["paymentIntentId"] = paymentIntentId }
        if let message { d["message"] = message }
        return d
    }
}

struct PortalView: UIViewRepresentable {
    @EnvironmentObject var app: AppState

    func makeCoordinator() -> PortalCoordinator { PortalCoordinator(app: app) }

    func makeUIView(context: Context) -> WKWebView {
        let coordinator = context.coordinator
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        // Added to the normal iOS WebKit user agent, so server logs can tell
        // Waves Admin from Safari.
        config.applicationNameForUserAgent = "Mobile/15E148 WavesAdmin/\(appVersion)"
        config.userContentController.add(WeakMessageHandler(coordinator), name: Portal.messageHandler)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        // The page lays itself out under the notch with env(safe-area-inset-*)
        // (viewport-fit=cover), as it does in the home-screen web app.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        webView.isInspectable = true
        #endif
        coordinator.webView = webView
        app.portal = coordinator
        webView.load(URLRequest(url: Portal.startURL))
        // A tapped alert opens its page here; one that launched the app was
        // held until now and replaces the start page.
        StaffAlerts.shared.openPage = { [weak webView] url in webView?.load(URLRequest(url: url)) }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1"
    }
}

@MainActor
final class PortalCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler,
    WKDownloadDelegate, UIAdaptivePresentationControllerDelegate {
    let app: AppState
    weak var webView: WKWebView?
    // The web view whose page asked for the open payment; it gets the answer.
    private weak var requester: WKWebView?
    // The page that last asked to prepare the reader; it fetches the tokens.
    private weak var readerPage: WKWebView?
    // The page that last asked for staff alerts; it registers the device token.
    private weak var alertsPage: WKWebView?
    private var paymentController: UIViewController?
    private weak var popup: UIViewController?
    private var offlineView: UIView?
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var flowWatch: AnyCancellable?

    init(app: AppState) {
        self.app = app
        super.init()
        flowWatch = app.$flow
            .receive(on: RunLoop.main)
            .sink { [weak self] flow in self?.showPayment(for: flow) }
    }

    // MARK: - Tap to Pay bridge

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only a portal page's top frame may use the bridge: the main view or
        // a portal popup, which shares it.
        guard let sender = message.webView,
              message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == Portal.origin.scheme,
              message.frameInfo.securityOrigin.host == Portal.origin.host,
              let body = message.body as? [String: Any]
        else { return }
        switch body["type"] as? String {
        case "tapToPay": startPayment(body, from: sender)
        case "prepareReader": prepareReader(from: sender)
        case "registerPush": registerPush(from: sender)
        case "badge": StaffAlerts.shared.setBadge((body["count"] as? Int) ?? 0)
        case "clearAlerts": StaffAlerts.shared.clearShown()
        default: break
        }
    }

    private func startPayment(_ body: [String: Any], from sender: WKWebView) {
        let requestId = body["requestId"] as? String
        if app.flow.isActive {
            // One payment at a time: answer this page, keep the open payment.
            deliver(TapToPayResult(
                requestId: requestId, status: .failed,
                message: "Another payment is already open in Waves Admin."
            ), to: sender)
            return
        }
        guard let link = body["deepLink"] as? String, let url = URL(string: link) else {
            deliver(TapToPayResult(
                requestId: requestId, status: .failed,
                message: "The payment link is missing. Tap Tap to Pay again."
            ), to: sender)
            return
        }
        requester = sender
        app.startCollect(from: url, requestId: requestId)
    }

    private func prepareReader(from page: WKWebView) {
        readerPage = page
        TerminalManager.shared.pageConnectionToken = { [weak self] in
            guard let self else { throw Self.noTokenPage }
            return try await self.connectionTokenFromPage()
        }
        TerminalManager.shared.prepare()
    }

    private func connectionTokenFromPage() async throws -> String {
        guard let page = readerPage ?? webView, let url = page.url, Portal.isPortal(url) else {
            throw Self.noTokenPage
        }
        let secret = try await page.callAsyncJavaScript(
            "return await window.wavesAdminConnectionToken();",
            arguments: [:],
            in: nil,
            contentWorld: .page
        )
        guard let secret = secret as? String, !secret.isEmpty else { throw Self.noTokenPage }
        return secret
    }

    private static let noTokenPage = NSError(domain: "wavespay", code: -5, userInfo: [
        NSLocalizedDescriptionKey: "No signed-in portal page to connect the card reader.",
    ])

    private func registerPush(from page: WKWebView) {
        alertsPage = page
        StaffAlerts.shared.onToken = { [weak self] token in self?.deliverPushToken(token) }
        StaffAlerts.shared.register()
    }

    private func deliverPushToken(_ token: String) {
        guard let page = alertsPage ?? webView, let url = page.url, Portal.isPortal(url) else { return }
        page.callAsyncJavaScript(
            "window.dispatchEvent(new CustomEvent(name, { detail }));",
            arguments: [
                "name": "wavesadmin:pushtoken",
                "detail": ["token": token, "environment": StaffAlerts.environment],
            ],
            in: nil,
            in: .page,
            completionHandler: nil
        )
    }

    func deliver(_ result: TapToPayResult) {
        deliver(result, to: requester ?? webView)
    }

    private func deliver(_ result: TapToPayResult, to target: WKWebView?) {
        guard let target, let url = target.url, Portal.isPortal(url) else { return }
        target.callAsyncJavaScript(
            "window.dispatchEvent(new CustomEvent(name, { detail }));",
            arguments: ["name": Portal.resultEvent, "detail": result.detail],
            in: nil,
            in: .page,
            completionHandler: nil
        )
    }

    // MARK: - Payment sheet

    // Shown over whatever is on top (the portal, or a portal popup) while a
    // payment is open; it cannot be swiped away during a server check or a tap.
    private func showPayment(for flow: AppState.Flow) {
        if !flow.isActive {
            paymentController?.dismiss(animated: true)
            paymentController = nil
            return
        }
        if let paymentController {
            paymentController.isModalInPresentation = flow.isBusy
            return
        }
        let controller = UIHostingController(rootView: PaymentSheet().environmentObject(app))
        // The Waves look is light by design; dark mode would fight the glass.
        controller.overrideUserInterfaceStyle = .light
        controller.isModalInPresentation = flow.isBusy
        controller.presentationController?.delegate = self
        guard present(controller) else {
            app.abandon("Waves Admin could not open the payment screen. Tap Tap to Pay again.")
            return
        }
        paymentController = controller
    }

    // The sheet was swiped away (only possible on the amount, success and
    // failure screens).
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        paymentController = nil
        app.close()
    }

    // MARK: - Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == "wavespay" {
            // A page that still uses the app-switch link: take the payment here.
            if !app.flow.isActive { requester = webView }
            app.handleIncomingURL(url)
            return decisionHandler(.cancel)
        }
        if action.shouldPerformDownload { return decisionHandler(.download) }
        if ["about", "blob", "data"].contains(url.scheme ?? "") || Portal.isPortal(url) {
            return decisionHandler(.allow)
        }
        // Frames inside a portal page (Stripe card fields, map embeds) load in place.
        if let frame = action.targetFrame, !frame.isMainFrame { return decisionHandler(.allow) }
        // Phone, text, email, maps and other sites open outside the app.
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        // A file (PDF, CSV) opened over the staff page would strand the tech on
        // it: the main view saves it and offers the share sheet. Popups show it.
        if response.isForMainFrame, webView === self.webView,
           let mime = response.response.mimeType, mime != "text/html" {
            return decisionHandler(.download)
        }
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView else { return }
        let ns = error as NSError
        // Canceled loads and policy hand-offs (downloads, outside links) are not outages.
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }
        showOffline(on: webView)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        offlineView?.removeFromSuperview()
        offlineView = nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // iOS ends the page's process under memory pressure; reload instead of
        // leaving a blank screen.
        webView.reload()
    }

    // MARK: - Popups (window.open, target=_blank)

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if (url.scheme == "http" || url.scheme == "https") && !Portal.isPortal(url) {
            UIApplication.shared.open(url)
            return nil
        }
        // Portal pages and files open in a sheet that shares the sign-in;
        // Done returns to the page underneath, untouched.
        let child = WKWebView(frame: .zero, configuration: configuration)
        child.navigationDelegate = self
        child.uiDelegate = self
        let controller = PopupController(webView: child)
        popup = controller
        present(UINavigationController(rootViewController: controller))
        return child
    }

    func webViewDidClose(_ webView: WKWebView) {
        guard webView !== self.webView else { return }
        popup?.dismiss(animated: true)
    }

    // MARK: - alert(), confirm(), prompt()

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let done = Once((), { _ in completionHandler() })
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done(()) })
        present(alert)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let done = Once(false, completionHandler)
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done(true) })
        present(alert)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let done = Once(nil, completionHandler)
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
            done(alert?.textFields?.first?.text ?? "")
        })
        present(alert)
    }

    // MARK: - Downloads

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            return completionHandler(nil)
        }
        let file = folder.appendingPathComponent(suggestedFilename.isEmpty ? "download" : suggestedFilename)
        downloads[ObjectIdentifier(download)] = file
        completionHandler(file)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = webView
        present(share)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        let alert = UIAlertController(title: nil, message: "The file did not download. Try again.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert)
    }

    // MARK: - Helpers

    @discardableResult
    private func present(_ controller: UIViewController) -> Bool {
        guard let top = TopViewController.current(), !top.isBeingDismissed else { return false }
        top.present(controller, animated: true)
        return true
    }

    private func showOffline(on webView: WKWebView) {
        guard offlineView == nil else { return }
        let label = UILabel()
        label.text = "Can't reach the Waves portal. Check your signal, then tap Retry."
        label.numberOfLines = 0
        label.textAlignment = .center
        label.textColor = .secondaryLabel
        let retry = UIButton(type: .system, primaryAction: UIAction(title: "Retry") { [weak self, weak webView] _ in
            guard let self, let webView else { return }
            self.offlineView?.removeFromSuperview()
            self.offlineView = nil
            if webView.url == nil {
                webView.load(URLRequest(url: Portal.startURL))
            } else {
                webView.reload()
            }
        })
        retry.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        let stack = UIStackView(arrangedSubviews: [label, retry])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        let overlay = UIView()
        overlay.backgroundColor = .systemBackground
        overlay.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(stack)
        webView.addSubview(overlay)
        NSLayoutConstraint.activate([
            overlay.topAnchor.constraint(equalTo: webView.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: webView.bottomAnchor),
            overlay.leadingAnchor.constraint(equalTo: webView.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: webView.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: overlay.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: overlay.trailingAnchor, constant: -32),
        ])
        offlineView = overlay
    }
}

// A portal page or file opened with window.open / target=_blank.
final class PopupController: UIViewController {
    private let webView: WKWebView
    private var titleObservation: NSKeyValueObservation?

    init(webView: WKWebView) {
        self.webView = webView
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func loadView() {
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            systemItem: .done,
            primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) }
        )
        titleObservation = webView.observe(\.title, options: [.initial, .new]) { [weak self] webView, _ in
            let title = webView.title
            DispatchQueue.main.async { self?.navigationItem.title = title }
        }
    }
}

// WKUserContentController keeps its handlers alive; this proxy keeps it from
// keeping the coordinator alive too.
@MainActor
final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

// WebKit requires each dialog's completion handler to run exactly once. Once
// runs it on the first call, and with the fallback value if the dialog is
// dropped without an answer (for example when it could not be presented).
final class Once<Value> {
    private var handler: ((Value) -> Void)?
    private let fallback: Value

    init(_ fallback: Value, _ handler: @escaping (Value) -> Void) {
        self.fallback = fallback
        self.handler = handler
    }

    func callAsFunction(_ value: Value) {
        handler?(value)
        handler = nil
    }

    deinit {
        handler?(fallback)
    }
}

enum TopViewController {
    @MainActor
    static func current() -> UIViewController? {
        let root = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }?
            .rootViewController
        var top = root
        while let next = top?.presentedViewController { top = next }
        return top
    }
}
