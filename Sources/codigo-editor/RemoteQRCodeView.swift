import SwiftUI
import CoreImage
import CoreImage.CIFilterBuiltins

struct RemoteQRCodeView: View {
    let contents: String

    var body: some View {
        if let image = RemoteQRCodeGenerator.makeQRCode(from: contents) {
            Image(nsImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
        } else {
            ZStack {
                Color(nsColor: .windowBackgroundColor)
                Text("QR unavailable")
                    .foregroundColor(.secondary)
                    .font(.footnote)
            }
        }
    }
}

enum RemoteQRCodeGenerator {
    static func makeQRCode(from string: String) -> NSImage? {
        guard let data = string.data(using: .utf8) else {
            return nil
        }

        let filter = CIFilter.qrCodeGenerator()
        filter.setValue(data, forKey: "inputMessage")
        filter.setValue("Q", forKey: "inputCorrectionLevel")

        guard let outputImage = filter.outputImage else {
            return nil
        }

        let transform = CGAffineTransform(scaleX: 12, y: 12)
        let scaledImage = outputImage.transformed(by: transform)
        let rep = NSCIImageRep(ciImage: scaledImage)
        let size = NSSize(width: scaledImage.extent.size.width, height: scaledImage.extent.size.height)
        let nsImage = NSImage(size: size)
        nsImage.addRepresentation(rep)
        return nsImage
    }
}
