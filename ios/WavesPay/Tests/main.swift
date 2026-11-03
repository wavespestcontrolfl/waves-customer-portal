// Logic check for HandoffLock (start, end, denied, unavailable, persisted flag).
// There is no XCTest target. From ios/WavesPay:
//   swiftc -o /tmp/handoff-check Sources/HandoffLock.swift Tests/main.swift && /tmp/handoff-check
import Foundation
@MainActor func check(_ c: Bool, _ m: String) { if !c { print("FAIL", m); exit(1) } else { print("ok", m) } }
@MainActor func run() async {
    let suite = "hl-test-\(UUID().uuidString)"
    let d = UserDefaults(suiteName: suite)!
    var next = HandoffLock.AuthResult.denied
    let lock = HandoffLock(defaults: d, authenticate: { next })
    check(!lock.isActive, "starts off")
    lock.start(); check(lock.isActive, "start sets flag")
    check(HandoffLock(defaults: d, authenticate: { .denied }).isActive, "flag persists to a new instance (relaunch)")
    check(await lock.end() == .denied && lock.isActive, "denied stays locked")
    next = .success; check(await lock.end() == .ended(unavailable: false) && !lock.isActive, "success unlocks")
    lock.start(); next = .unavailable
    check(await lock.end() == .ended(unavailable: true) && !lock.isActive, "unavailable ends with auth flag")
    lock.start(); lock.clear(); check(!lock.isActive, "sign-out clears")
    check(HandoffLock.presentation(handoffActive: true) == [.list, .badge], "locked: no banner or sound")
    check(HandoffLock.presentation(handoffActive: false) == [.banner, .list, .sound, .badge], "unlocked: unchanged")
    // overlapping end is denied
    lock.start()
    let slow = HandoffLock(defaults: d, authenticate: { try? await Task.sleep(nanoseconds: 200_000_000); return .success })
    async let a = slow.end()
    try? await Task.sleep(nanoseconds: 50_000_000)
    let b = await slow.end()
    check(b == .denied, "overlapping end denied")
    check(await a == .ended(unavailable: false), "first end completes")
    d.removePersistentDomain(forName: suite)
}
Task { @MainActor in await run(); exit(0) }
RunLoop.main.run()
