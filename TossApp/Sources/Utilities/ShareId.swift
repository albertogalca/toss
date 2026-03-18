import Foundation

enum ShareIdValidator {
    static func isValid(_ shareId: String) -> Bool {
        let length = shareId.count
        guard length >= 10, length <= 24 else { return false }
        return shareId.allSatisfy { c in
            c.isASCII && (c.isLetter || c.isNumber || c == "_" || c == "-")
        }
    }
}
