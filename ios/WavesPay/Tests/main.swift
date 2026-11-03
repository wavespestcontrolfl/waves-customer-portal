// Logic check for HandoffLock (start, end, denied, unavailable, persisted flag,
// staff alerts paused and resumed). There is no XCTest target. From ios/WavesPay:
//   swiftc -o /tmp/handoff-check Sources/HandoffLock.swift Tests/main.swift && /tmp/handoff-check
import Foundation
@MainActor func check(_ c: Bool, _ m: String) { if !c { print("FAIL", m); exit(1) } else { print("ok", m) } }
@MainActor func run() async {
    let suite = "hl-test-\(UUID().uuidString)"
    let d = UserDefaults(suiteName: suite)!
    var next = HandoffLock.AuthResult.denied
    var paused = 0, resumed = 0
    let lock = HandoffLock(defaults: d, authenticate: { next },
                           pauseAlerts: { paused += 1 }, resumeAlerts: { resumed += 1 })
    check(!lock.isActive, "starts off")
    lock.start(); check(lock.isActive && paused == 1, "start sets flag and pauses alerts")
    check(HandoffLock(defaults: d, authenticate: { .denied }).isActive, "flag persists to a new instance (relaunch)")
    check(await lock.end() == .denied && lock.isActive && resumed == 0, "denied stays locked, alerts stay paused")
    next = .success
    check(await lock.end() == .ended(unavailable: false) && !lock.isActive && resumed == 1, "success unlocks and resumes alerts")
    lock.start(); next = .unavailable
    check(await lock.end() == .ended(unavailable: true) && !lock.isActive && resumed == 2, "unavailable ends with auth flag, resumes alerts")
    lock.start(); lock.clear(); check(!lock.isActive && resumed == 2, "sign-out clears without resuming alerts")
    check(HandoffLock.presentation(handoffActive: true) == [.badge], "locked: badge only, no banner, sound or list")
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
