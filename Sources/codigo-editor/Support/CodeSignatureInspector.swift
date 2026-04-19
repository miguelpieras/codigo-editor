import Foundation
import Security

enum CodeSignatureInspector {
    static let currentTeamIdentifier = teamIdentifier(for: Bundle.main.bundleURL)
    static let hasTeamIdentifier = currentTeamIdentifier != nil

    static func teamIdentifier(for bundleURL: URL) -> String? {
        let executableURL = executableURL(for: bundleURL)
        var staticCode: SecStaticCode?
        let status = SecStaticCodeCreateWithPath(executableURL as CFURL, SecCSFlags(), &staticCode)
        guard status == errSecSuccess, let code = staticCode else {
            return nil
        }

        var signingInfo: CFDictionary?
        let infoStatus = SecCodeCopySigningInformation(code, SecCSFlags(), &signingInfo)
        guard infoStatus == errSecSuccess, let info = signingInfo as? [String: Any] else {
            return nil
        }

        if let teamIdentifier = info[kSecCodeInfoTeamIdentifier as String] as? String {
            return teamIdentifier.isEmpty ? nil : teamIdentifier
        }

        if let formatValue = info[kSecCodeInfoFormat as String] as? NSNumber,
           formatValue.intValue == 2 { // kSecCodeSignatureAdhoc
            return nil
        }

        return nil
    }

    private static func executableURL(for bundleURL: URL) -> URL {
        if bundleURL.pathExtension == "app",
           let bundle = Bundle(url: bundleURL),
           let executableURL = bundle.executableURL {
            return executableURL
        }
        return bundleURL
    }
}
