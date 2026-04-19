import AppKit
import SwiftUI

struct ContactInfoView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            header

            Text("This build does not ship with private support channels. Publish your repository URL, issue tracker, or community links alongside the project release.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.leading)

            Spacer(minLength: 0)

            Text("Update this window if you want the open-source build to point to a public homepage or issue tracker.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(24)
        .frame(width: 420)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 16) {
            if let icon = appIcon {
                icon
                    .resizable()
                    .frame(width: 64, height: 64)
                    .cornerRadius(14)
                    .shadow(radius: 2)
                    .accessibilityHidden(true)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Get in Touch")
                    .font(.title2)
                    .bold()
                Text("Configure public project links here if you want this build to expose them.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
            }
        }
    }

    private var appIcon: Image? {
        guard let icon = NSApp.applicationIconImage else {
            return nil
        }
        return Image(nsImage: icon)
    }
}
