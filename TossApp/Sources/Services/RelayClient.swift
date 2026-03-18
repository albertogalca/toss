import Foundation

actor RelayClient {
    private var webSocketTask: URLSessionWebSocketTask?
    private let session = URLSession(configuration: .default)
    private let relayURL: URL
    private var reconnectTask: Task<Void, Never>?
    private var reregisterTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var _isConnected = false
    private var onStatusChange: ((Bool) -> Void)?
    private var onRelayMessage: (([String: Any]) -> Void)?
    private var getRegistrationData: (() async -> [(shareId: String, httpEndpoints: [String], hasPassword: Bool, fileName: String, fileSize: Int64)])?

    var isConnected: Bool { _isConnected }

    init(relayURL: URL) {
        self.relayURL = relayURL
    }

    func setHandlers(
        onStatusChange: @escaping (Bool) -> Void,
        onRelayMessage: @escaping ([String: Any]) -> Void,
        getRegistrationData: @escaping () async -> [(shareId: String, httpEndpoints: [String], hasPassword: Bool, fileName: String, fileSize: Int64)]
    ) {
        self.onStatusChange = onStatusChange
        self.onRelayMessage = onRelayMessage
        self.getRegistrationData = getRegistrationData
    }

    func connect() {
        disconnect()

        let task = session.webSocketTask(with: relayURL)
        self.webSocketTask = task
        task.resume()

        receiveTask = Task { [weak self] in
            guard let self else { return }
            await self.receiveLoop()
        }

        task.sendPing { [weak self] error in
            Task {
                guard let self else { return }
                if error == nil {
                    await self.handleConnected()
                } else {
                    await self.handleDisconnected()
                }
            }
        }
    }

    func disconnect() {
        reconnectTask?.cancel()
        reconnectTask = nil
        reregisterTask?.cancel()
        reregisterTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        _isConnected = false
    }

    func register(shareId: String, httpEndpoints: [String], hasPassword: Bool, fileName: String, fileSize: Int64) {
        send([
            "type": "register",
            "shareId": shareId,
            "httpEndpoints": httpEndpoints,
            "hasPassword": hasPassword,
            "fileName": fileName,
            "fileSize": fileSize,
        ])
    }

    func unregister(shareId: String) {
        send(["type": "unregister", "shareId": shareId])
    }

    func sendSignal(shareId: String, sessionId: String, data: [String: Any]) {
        send([
            "type": "signal",
            "shareId": shareId,
            "sessionId": sessionId,
            "data": data,
        ])
    }

    // MARK: - Private

    private func handleConnected() {
        _isConnected = true
        onStatusChange?(true)
        print("[ws] connected to relay")
        Task { await registerAll() }

        reregisterTask?.cancel()
        reregisterTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(600))
                if !Task.isCancelled { await registerAll() }
            }
        }
    }

    private func handleDisconnected() {
        guard _isConnected || webSocketTask != nil else { return }
        _isConnected = false
        onStatusChange?(false)
        reregisterTask?.cancel()
        reregisterTask = nil
        print("[ws] disconnected from relay")
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        reconnectTask = Task {
            try? await Task.sleep(for: .seconds(3))
            if !Task.isCancelled { connect() }
        }
    }

    private func registerAll() async {
        guard let getData = getRegistrationData else { return }
        let entries = await getData()
        for entry in entries {
            register(shareId: entry.shareId, httpEndpoints: entry.httpEndpoints, hasPassword: entry.hasPassword, fileName: entry.fileName, fileSize: entry.fileSize)
        }
    }

    private func receiveLoop() async {
        guard let task = webSocketTask else { return }
        try? await Task.sleep(for: .milliseconds(100))

        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                switch message {
                case .string(let text):
                    if let data = text.data(using: .utf8),
                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let type = json["type"] as? String {
                        if type == "error" {
                            print("[ws] relay error: \(json["message"] ?? "")")
                        } else if type == "recipient-ready" || type == "signal" {
                            onRelayMessage?(json)
                        }
                    }
                case .data:
                    break
                @unknown default:
                    break
                }
            } catch {
                await handleDisconnected()
                return
            }
        }
    }

    private func send(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: data, encoding: .utf8) else { return }
        webSocketTask?.send(.string(text)) { error in
            if let error {
                print("[ws] send error: \(error.localizedDescription)")
            }
        }
    }
}
