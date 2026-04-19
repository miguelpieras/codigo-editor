import AppKit
import SwiftUI

struct AboutContactChannel: Identifiable {
    let title: String
    let description: String
    let linkTitle: String
    let destination: URL

    var id: String { title }
}

struct AboutView: View {
    let applicationName: String
    let applicationVersion: String
    let buildNumber: String?
    let applicationIcon: NSImage
    let contactChannels: [AboutContactChannel]
    let closingNote: String

    private var versionDisplay: String {
        guard let buildNumber, !buildNumber.isEmpty, buildNumber != applicationVersion else {
            return "Version \(applicationVersion)"
        }
        return "Version \(applicationVersion) (\(buildNumber))"
    }

    var body: some View {
        VStack(spacing: 24) {
            HStack(alignment: .center, spacing: 20) {
                Image(nsImage: applicationIcon)
                    .resizable()
                    .frame(width: 84, height: 84)
                    .cornerRadius(16)
                    .shadow(radius: 4)
                VStack(alignment: .leading, spacing: 4) {
                    Text(applicationName)
                        .font(.system(size: 24, weight: .semibold))
                    Text(versionDisplay)
                        .font(.system(size: 14))
                        .foregroundColor(.secondary)
                }
                Spacer()
            }

            if contactChannels.isEmpty {
                Text("No private support channels are bundled with this build.")
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(contactChannels) { channel in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(channel.title)
                                .font(.system(size: 14, weight: .semibold))
                            Text(channel.description)
                                .font(.system(size: 13))
                            Link(channel.linkTitle, destination: channel.destination)
                                .font(.system(size: 13))
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Text(closingNote)
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            Spacer(minLength: 0)
        }
        .padding(.vertical, 24)
        .padding(.horizontal, 28)
        .frame(minWidth: 460, idealWidth: 480, minHeight: 360)
    }
}

#if DEBUG
struct AboutView_Previews: PreviewProvider {
    static var previews: some View {
        AboutView(
            applicationName: "Codigo Editor",
            applicationVersion: "1.2.3",
            buildNumber: "456",
            applicationIcon: NSImage(named: NSImage.applicationIconName) ?? NSImage(),
            contactChannels: [],
            closingNote: "Community links and contribution guidelines should be published with the repository."
        )
        .frame(width: 500, height: 360)
    }
}
#endif
