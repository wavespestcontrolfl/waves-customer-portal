import ActivityKit
import SwiftUI
import WidgetKit

// The Lock Screen visit card: what the customer sees (docs/mobile/live-activity.md). The server sends the
// two lines and the step; this file only draws them. It shows no time and no ETA, because the server
// sends none.

@main
struct WavesVisitCardBundle: WidgetBundle {
    var body: some Widget {
        WavesVisitCardWidget()
    }
}

// Waves brand colors (docs/design/waves-customer-facing-design-brief.md): Blue Deeper and Gold.
private enum Brand {
    static let navy = Color(red: 27.0 / 255.0, green: 44.0 / 255.0, blue: 91.0 / 255.0)
    static let gold = Color(red: 1.0, green: 215.0 / 255.0, blue: 0.0)
}

// Shown in place of the service name when iOS reports the card stale: the visit has had no news past its
// usual time (the server sets that time on every update).
private let staleHint = "Open the Waves app for the latest."

private func symbolName(for phase: String) -> String {
    switch phase {
    case "on_property": return "house.fill"
    case "complete": return "checkmark.circle.fill"
    default: return "box.truck.fill"
    }
}

/// Three marks: on the way, arrived, complete. Marks up to `step` are filled.
private struct StepMarks: View {
    let step: Int
    let dimmed: Bool

    var body: some View {
        HStack(spacing: 6) {
            ForEach(1...3, id: \.self) { index in
                Capsule()
                    .fill(index <= step ? Brand.gold : Color.white.opacity(0.28))
                    .frame(height: 5)
            }
        }
        .opacity(dimmed ? 0.5 : 1)
        .accessibilityHidden(true)
    }
}

private struct LockScreenCard: View {
    let state: WavesVisitAttributes.ContentState
    let stale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: symbolName(for: state.phase))
                    .font(.title2)
                    .foregroundStyle(Brand.gold)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.title)
                        .font(.headline)
                        .foregroundStyle(.white)
                        .lineLimit(2)
                    Text(stale ? staleHint : state.detail)
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.82))
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            StepMarks(step: state.step, dimmed: stale)
        }
        .padding(16)
        .accessibilityElement(children: .combine)
    }
}

struct WavesVisitCardWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: WavesVisitAttributes.self) { context in
            LockScreenCard(state: context.state, stale: context.isStale)
                .activityBackgroundTint(Brand.navy)
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: symbolName(for: context.state.phase))
                        .font(.title2)
                        .foregroundStyle(Brand.gold)
                        .accessibilityHidden(true)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.title)
                        .font(.headline)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(context.isStale ? staleHint : context.state.detail)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        StepMarks(step: context.state.step, dimmed: context.isStale)
                    }
                }
            } compactLeading: {
                Image(systemName: symbolName(for: context.state.phase))
                    .foregroundStyle(Brand.gold)
            } compactTrailing: {
                Text("\(min(max(context.state.step, 1), 3)) of 3")
                    .font(.caption2)
                    .monospacedDigit()
            } minimal: {
                Image(systemName: symbolName(for: context.state.phase))
                    .foregroundStyle(Brand.gold)
            }
            .keylineTint(Brand.gold)
        }
    }
}
