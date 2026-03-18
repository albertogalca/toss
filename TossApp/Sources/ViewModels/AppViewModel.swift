import Foundation
import AppKit
import WebRTC

@Observable
final class AppViewModel {
    var files: [SharedFile] = []
    var isConnected = false

    private let fileShareManager = FileShareManager()
    private let httpServer: HTTPFileServer
    private let relayClient: RelayClient
    private let webrtcService = WebRTCService()
    private let relayURL: String
    private let receiverURL: String
    private let allowedOrigin: String

    private var iceServers: [RTCIceServer] = [
        RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"]),
        RTCIceServer(urlStrings: ["stun:stun1.l.google.com:19302"]),
    ]

    init() {
        relayURL = ProcessInfo.processInfo.environment["RELAY_URL"] ?? "wss://relay.toss.albertogalca.com"
        receiverURL = ProcessInfo.processInfo.environment["RECEIVER_URL"] ?? "https://toss.albertogalca.com"
        allowedOrigin = ProcessInfo.processInfo.environment["ALLOWED_ORIGIN"] ?? "*"

        httpServer = HTTPFileServer(fileShareManager: fileShareManager, allowedOrigin: allowedOrigin)
        relayClient = RelayClient(relayURL: URL(string: relayURL)!)
    }

    func start() async {
        files = await fileShareManager.allFiles

        try? await httpServer.start()

        // Configure WebRTC
        webrtcService.fileShareManager = fileShareManager
        webrtcService.onSendSignal = { [weak self] shareId, sessionId, data in
            guard let self else { return }
            Task {
                await self.relayClient.sendSignal(shareId: shareId, sessionId: sessionId, data: data)
            }
        }

        // Fetch ICE config from relay
        await fetchIceConfig()

        let httpPort = await httpServer.port
        await relayClient.setHandlers(
            onStatusChange: { [weak self] connected in
                Task { @MainActor in
                    self?.isConnected = connected
                }
            },
            onRelayMessage: { [weak self] msg in
                self?.handleRelayMessage(msg)
            },
            getRegistrationData: { [weak self] () async -> [(shareId: String, httpEndpoints: [String], hasPassword: Bool, fileName: String, fileSize: Int64)] in
                guard let self else { return [] }
                let currentFiles = await self.fileShareManager.allFiles
                let endpoints = NetworkInfo.httpEndpoints(port: httpPort)
                return currentFiles.map { file in
                    (shareId: file.shareId, httpEndpoints: endpoints, hasPassword: file.hasPassword, fileName: file.fileName, fileSize: file.fileSize)
                }
            }
        )

        await relayClient.connect()
    }

    func stop() async {
        webrtcService.cleanup()
        await relayClient.disconnect()
        await httpServer.stop()
    }

    @MainActor
    func addFiles(urls: [URL]) async {
        let httpPort = await httpServer.port
        for url in urls {
            let file = await fileShareManager.addFile(url: url, password: nil)
            files = await fileShareManager.allFiles
            let endpoints = NetworkInfo.httpEndpoints(port: httpPort)
            await relayClient.register(
                shareId: file.shareId,
                httpEndpoints: endpoints,
                hasPassword: file.hasPassword,
                fileName: file.fileName,
                fileSize: file.fileSize
            )
        }
    }

    @MainActor
    func removeFile(shareId: String) async {
        await relayClient.unregister(shareId: shareId)
        await fileShareManager.removeFile(shareId: shareId)
        files = await fileShareManager.allFiles
    }

    func shareURL(shareId: String) -> String {
        "\(receiverURL)/#/\(shareId)"
    }

    @MainActor
    func copyLink(shareId: String) {
        let url = shareURL(shareId: shareId)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url, forType: .string)
    }

    @MainActor
    func setPassword(shareId: String, password: String?) async {
        await fileShareManager.setPassword(shareId: shareId, password: password)
        files = await fileShareManager.allFiles
        let httpPort = await httpServer.port
        if let file = await fileShareManager.file(for: shareId) {
            let endpoints = NetworkInfo.httpEndpoints(port: httpPort)
            await relayClient.register(
                shareId: file.shareId,
                httpEndpoints: endpoints,
                hasPassword: file.hasPassword,
                fileName: file.fileName,
                fileSize: file.fileSize
            )
        }
    }

    // MARK: - Private

    private func handleRelayMessage(_ msg: [String: Any]) {
        guard let type = msg["type"] as? String,
              let shareId = msg["shareId"] as? String,
              let sessionId = msg["sessionId"] as? String else { return }

        switch type {
        case "recipient-ready":
            webrtcService.handleRecipientReady(shareId: shareId, sessionId: sessionId, iceServers: iceServers)

        case "signal":
            guard let data = msg["data"] as? [String: Any],
                  let signalType = data["type"] as? String else { return }

            if signalType == "answer" {
                if let sdp = data["sdp"] as? [String: Any] {
                    webrtcService.handleAnswer(shareId: shareId, sessionId: sessionId, sdp: sdp)
                }
            } else if signalType == "ice-candidate" {
                if let candidate = data["candidate"] as? [String: Any] {
                    webrtcService.handleRemoteICE(shareId: shareId, sessionId: sessionId, candidate: candidate)
                }
            }

        default:
            break
        }
    }

    private func fetchIceConfig() async {
        let httpUrl = relayURL.replacingOccurrences(of: "wss://", with: "https://")
            .replacingOccurrences(of: "ws://", with: "http://")
        guard let url = URL(string: "\(httpUrl)/ice-config") else { return }

        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let servers = json["iceServers"] as? [[String: Any]] {
                var rtcServers: [RTCIceServer] = []
                for server in servers {
                    guard let urls = server["urls"] as? String else { continue }
                    if let username = server["username"] as? String,
                       let credential = server["credential"] as? String {
                        rtcServers.append(RTCIceServer(urlStrings: [urls], username: username, credential: credential))
                    } else {
                        rtcServers.append(RTCIceServer(urlStrings: [urls]))
                    }
                }
                if !rtcServers.isEmpty {
                    iceServers = rtcServers
                }
            }
        } catch {
            print("[ice] failed to fetch config: \(error.localizedDescription)")
        }
    }
}
