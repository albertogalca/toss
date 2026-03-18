import Foundation
import Darwin

enum NetworkInfo {
    static func localIPv4Addresses() -> [String] {
        var addresses: [String] = []
        var ifaddr: UnsafeMutablePointer<ifaddrs>?

        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return addresses }
        defer { freeifaddrs(ifaddr) }

        var ptr: UnsafeMutablePointer<ifaddrs>? = firstAddr
        while let ifa = ptr {
            let sa = ifa.pointee.ifa_addr
            if let sa = sa, sa.pointee.sa_family == UInt8(AF_INET) {
                let flags = Int32(ifa.pointee.ifa_flags)
                let isLoopback = (flags & IFF_LOOPBACK) != 0
                if !isLoopback {
                    var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    if getnameinfo(sa, socklen_t(sa.pointee.sa_len),
                                   &hostname, socklen_t(hostname.count),
                                   nil, 0, NI_NUMERICHOST) == 0 {
                        addresses.append(String(cString: hostname))
                    }
                }
            }
            ptr = ifa.pointee.ifa_next
        }

        return addresses
    }

    static func httpEndpoints(port: Int) -> [String] {
        var endpoints = ["http://127.0.0.1:\(port)"]
        for ip in localIPv4Addresses() {
            endpoints.append("http://\(ip):\(port)")
        }
        return endpoints
    }
}
