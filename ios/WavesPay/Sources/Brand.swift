import SwiftUI

// The Waves look for the payment screens. Customers see these screens, so
// they follow the customer pages' glass theme, not the monochrome admin:
// light blue mesh scene, frosted cards, deep-blue headings and prices, gold
// call to action. Values mirror client/src/glass/glass-theme.css and the
// scene in client/src/glass/glass-engine.js.
enum Brand {
    static let ink = Color(hex: 0x04395E)        // headings, prices (--brand)
    static let body = Color(hex: 0x334155)       // body text
    static let accent = Color(hex: 0x0A7EC2)     // links
    static let success = Color(hex: 0x16A34A)
    static let alert = Color(hex: 0xC8102E)
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

// Mesh-gradient backdrop: brand blues with a touch of gold.
struct WavesScene: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(hex: 0xE0EEF9), Color(hex: 0xF5FAFE), Color(hex: 0xE5EFF7)],
                startPoint: .top, endPoint: .bottom
            )
            glow(0x0A7EC2, 0.40, at: UnitPoint(x: 0.85, y: -0.1), radius: 520)
            glow(0xF0A500, 0.16, at: UnitPoint(x: -0.1, y: 0.3), radius: 420)
            glow(0x065A8C, 0.32, at: UnitPoint(x: 0.75, y: 0.95), radius: 520)
            glow(0x38AAE1, 0.16, at: UnitPoint(x: 0.4, y: 0.55), radius: 300)
        }
        .ignoresSafeArea()
    }

    private func glow(_ hex: UInt32, _ opacity: Double, at center: UnitPoint, radius: CGFloat) -> some View {
        RadialGradient(
            colors: [Color(hex: hex, opacity: opacity), .clear],
            center: center, startRadius: 0, endRadius: radius
        )
    }
}

struct WavesLogo: View {
    var height: CGFloat = 96

    var body: some View {
        Image("WavesLogo")
            .resizable()
            .scaledToFit()
            .frame(height: height)
            .shadow(color: Brand.ink.opacity(0.18), radius: 12, y: 6)
            .accessibilityLabel("Waves")
    }
}

// Frosted section card.
struct GlassCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 26, style: .continuous)
        content
            .padding(.vertical, 26)
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity)
            .background(
                shape.fill(LinearGradient(
                    colors: [.white.opacity(0.62), .white.opacity(0.36)],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                ))
            )
            .background(.ultraThinMaterial, in: shape)
            .overlay(shape.strokeBorder(.white.opacity(0.7), lineWidth: 1))
            .shadow(color: Brand.ink.opacity(0.10), radius: 24, y: 12)
    }
}

// Gold call to action (the glass theme's accent button).
struct GoldButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(Brand.ink)
            .frame(maxWidth: .infinity, minHeight: 58)
            .background(
                Capsule().fill(LinearGradient(
                    colors: [Color(hex: 0xFFE27A), Color(hex: 0xF5B729)],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                ))
            )
            .overlay(Capsule().strokeBorder(Color(hex: 0xFFEEB4), lineWidth: 1))
            .shadow(color: Color(hex: 0xB46E00, opacity: 0.25), radius: 13, y: 8)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.6), value: configuration.isPressed)
    }
}

// Frosted pill for secondary actions.
struct GlassChipButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(Brand.ink)
            .padding(.horizontal, 22)
            .frame(minHeight: 44)
            .background(Capsule().fill(.white.opacity(configuration.isPressed ? 0.75 : 0.5)))
            .overlay(Capsule().strokeBorder(.white.opacity(0.8), lineWidth: 1))
    }
}

// The payment sheet's frame: logo at the top, card in the middle, actions at
// the bottom. When a long invoice makes the card too tall for the screen, the
// logo and card scroll and the actions stay on screen.
struct SheetLayout<Card: View, Actions: View>: View {
    @ViewBuilder var card: Card
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: 0) {
            ViewThatFits(in: .vertical) {
                VStack(spacing: 0) {
                    WavesLogo(height: 104).padding(.top, 28)
                    Spacer(minLength: 20)
                    card
                    Spacer(minLength: 20)
                }
                ScrollView {
                    VStack(spacing: 20) {
                        WavesLogo(height: 104).padding(.top, 28)
                        card
                    }
                    .padding(.bottom, 20)
                }
            }
            actions
        }
        .padding(.horizontal, 24)
        .background(WavesScene())
    }
}
