import Foundation
import UserNotifications

final class NotificationPermissionGateway: @unchecked Sendable {
    private let center: UNUserNotificationCenter

    init(center: UNUserNotificationCenter) {
        self.center = center
    }

    func determinePermission(completion: @escaping @MainActor (Bool) -> Void) {
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                Task { @MainActor in
                    completion(true)
                }
            case .denied:
                Task { @MainActor in
                    completion(false)
                }
            case .notDetermined:
                self.requestAuthorization(completion: completion)
            @unknown default:
                Task { @MainActor in
                    completion(false)
                }
            }
        }
    }

    private func requestAuthorization(completion: @escaping @MainActor (Bool) -> Void) {
        center.requestAuthorization(options: [.alert, .badge]) { granted, _ in
            Task { @MainActor in
                completion(granted)
            }
        }
    }
}
