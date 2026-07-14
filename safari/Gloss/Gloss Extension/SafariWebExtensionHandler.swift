//
//  SafariWebExtensionHandler.swift
//  Gloss Extension
//
//  Created by samsoncj on 7/14/26.
//

import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let appGroup = "group.com.samsoncj.gloss"
    private static let tokenKey = "browser-pairing-token"

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        let response = NSExtensionItem()

        guard message?["type"] as? String == "pairing-token" else {
            response.userInfo = [SFExtensionMessageKey: ["error": "Unsupported native message."]]
            context.completeRequest(returningItems: [response])
            return
        }

        let token = UserDefaults(suiteName: Self.appGroup)?.string(forKey: Self.tokenKey) ?? ""
        guard Self.isValidToken(token) else {
            response.userInfo = [SFExtensionMessageKey: ["error": "Open Gloss to initialize Safari pairing."]]
            context.completeRequest(returningItems: [response])
            return
        }

        response.userInfo = [SFExtensionMessageKey: ["pairingToken": token]]
        context.completeRequest(returningItems: [response])
    }

    private static func isValidToken(_ token: String) -> Bool {
        token.count == 43
            && token.utf8.allSatisfy {
                (48...57).contains($0)
                    || (65...90).contains($0)
                    || (97...122).contains($0)
                    || $0 == 45
                    || $0 == 95
            }
    }
}
