import Foundation
import CryptoKit
import WebRTC

/// Handles WebRTC peer connections for file transfer (sender side).
/// Each recipient session gets its own peer connection + data channel.
final class WebRTCService: NSObject, @unchecked Sendable {
    private let factory: RTCPeerConnectionFactory
    private var connections: [String: PeerSession] = [:]
    private let lock = NSLock()

    var onSendSignal: ((String, String, [String: Any]) -> Void)?
    var fileShareManager: FileShareManager?

    static let chunkSize = 64 * 1024
    static let highWater = 4 * 1024 * 1024
    static let maxConcurrentPerShare = 5

    override init() {
        RTCInitializeSSL()
        let decoderFactory = RTCDefaultVideoDecoderFactory()
        let encoderFactory = RTCDefaultVideoEncoderFactory()
        factory = RTCPeerConnectionFactory(encoderFactory: encoderFactory, decoderFactory: decoderFactory)
        super.init()
    }

    func handleRecipientReady(shareId: String, sessionId: String, iceServers: [RTCIceServer]) {
        let key = "\(shareId):\(sessionId)"

        lock.lock()
        let activeCount = connections.keys.filter { $0.hasPrefix("\(shareId):") }.count
        lock.unlock()
        guard activeCount < Self.maxConcurrentPerShare else {
            print("[webrtc] max concurrent transfers for \(shareId)")
            return
        }

        let config = RTCConfiguration()
        config.iceServers = iceServers
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually

        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = factory.peerConnection(with: config, constraints: constraints, delegate: nil) else {
            print("[webrtc] failed to create peer connection")
            return
        }

        let dcConfig = RTCDataChannelConfiguration()
        dcConfig.isOrdered = true
        guard let dc = pc.dataChannel(forLabel: "file", configuration: dcConfig) else {
            print("[webrtc] failed to create data channel")
            pc.close()
            return
        }

        let session = PeerSession(
            shareId: shareId,
            sessionId: sessionId,
            peerConnection: pc,
            dataChannel: dc,
            service: self
        )

        lock.lock()
        connections[key] = session
        lock.unlock()

        pc.delegate = session
        dc.delegate = session

        let offerConstraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        pc.offer(for: offerConstraints) { [weak self] sdp, error in
            guard let self, let sdp, error == nil else {
                print("[webrtc] offer failed: \(error?.localizedDescription ?? "")")
                return
            }
            pc.setLocalDescription(sdp) { error in
                if let error {
                    print("[webrtc] setLocalDescription failed: \(error)")
                    return
                }
                self.onSendSignal?(shareId, sessionId, [
                    "type": "offer",
                    "sdp": ["type": "offer", "sdp": sdp.sdp]
                ])
            }
        }
    }

    func handleAnswer(shareId: String, sessionId: String, sdp: [String: Any]) {
        let key = "\(shareId):\(sessionId)"
        lock.lock()
        let session = connections[key]
        lock.unlock()
        guard let session else { return }

        guard let sdpString = sdp["sdp"] as? String else { return }
        let remoteSDP = RTCSessionDescription(type: .answer, sdp: sdpString)
        session.peerConnection.setRemoteDescription(remoteSDP) { error in
            if let error {
                print("[webrtc] setRemoteDescription failed: \(error)")
            }
        }
    }

    func handleRemoteICE(shareId: String, sessionId: String, candidate: [String: Any]) {
        let key = "\(shareId):\(sessionId)"
        lock.lock()
        let session = connections[key]
        lock.unlock()
        guard let session else { return }

        guard let sdp = candidate["candidate"] as? String,
              let sdpMLineIndex = candidate["sdpMLineIndex"] as? Int32 else { return }
        let sdpMid = candidate["sdpMid"] as? String
        let ice = RTCIceCandidate(sdp: sdp, sdpMLineIndex: sdpMLineIndex, sdpMid: sdpMid)
        session.peerConnection.add(ice) { error in
            if let error {
                print("[webrtc] addIceCandidate failed: \(error)")
            }
        }
    }

    func removeSession(key: String) {
        lock.lock()
        connections.removeValue(forKey: key)
        lock.unlock()
    }

    func cleanup() {
        lock.lock()
        let sessions = connections
        connections.removeAll()
        lock.unlock()
        for (_, session) in sessions {
            session.dataChannel.close()
            session.peerConnection.close()
        }
    }
}

// MARK: - PeerSession

private final class PeerSession: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate, @unchecked Sendable {
    let shareId: String
    let sessionId: String
    let peerConnection: RTCPeerConnection
    let dataChannel: RTCDataChannel
    weak var service: WebRTCService?
    private var transferTask: Task<Void, Never>?
    private var authContinuation: CheckedContinuation<String, Never>?

    var key: String { "\(shareId):\(sessionId)" }

    init(shareId: String, sessionId: String, peerConnection: RTCPeerConnection, dataChannel: RTCDataChannel, service: WebRTCService) {
        self.shareId = shareId
        self.sessionId = sessionId
        self.peerConnection = peerConnection
        self.dataChannel = dataChannel
        self.service = service
        super.init()
    }

    private func close() {
        transferTask?.cancel()
        dataChannel.close()
        peerConnection.close()
        service?.removeSession(key: key)
    }

    private func sendJSON(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
        dataChannel.sendData(RTCDataBuffer(data: data, isBinary: false))
    }

    // MARK: - RTCPeerConnectionDelegate

    func peerConnection(_ pc: RTCPeerConnection, didChange state: RTCSignalingState) {}
    func peerConnection(_ pc: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ pc: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ pc: RTCPeerConnection) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange state: RTCIceGatheringState) {}
    func peerConnection(_ pc: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ pc: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    func peerConnection(_ pc: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        service?.onSendSignal?(shareId, sessionId, [
            "type": "ice-candidate",
            "candidate": [
                "candidate": candidate.sdp,
                "sdpMLineIndex": candidate.sdpMLineIndex,
                "sdpMid": candidate.sdpMid ?? ""
            ]
        ])
    }

    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        if newState == .failed || newState == .disconnected {
            print("[webrtc] ice \(newState == .failed ? "failed" : "disconnected") for \(key)")
            close()
        }
    }

    // MARK: - RTCDataChannelDelegate

    func dataChannelDidChangeState(_ dc: RTCDataChannel) {
        if dc.readyState == .open {
            print("[webrtc] data channel open for \(key)")
            startTransfer()
        } else if dc.readyState == .closed {
            close()
        }
    }

    func dataChannel(_ dc: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard !buffer.isBinary, let text = String(data: buffer.data, encoding: .utf8) else { return }
        authContinuation?.resume(returning: text)
        authContinuation = nil
    }

    // MARK: - Transfer

    private func startTransfer() {
        guard let manager = service?.fileShareManager else {
            close()
            return
        }

        transferTask = Task { [weak self] in
            guard let self else { return }

            guard let file = await manager.file(for: shareId) else {
                close()
                return
            }

            // Password auth
            if file.hasPassword {
                sendJSON(["type": "auth-required"])

                var authenticated = false
                for _ in 0..<5 {
                    let response: String = await withCheckedContinuation { cont in
                        self.authContinuation = cont
                    }

                    guard let data = response.data(using: .utf8),
                          let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          msg["type"] as? String == "auth",
                          let password = msg["password"] as? String else { continue }

                    let hash = SHA256.hash(data: Data(password.utf8))
                        .map { String(format: "%02x", $0) }.joined()
                    let valid = await manager.verifyPassword(shareId: shareId, candidateHash: hash)

                    if valid {
                        sendJSON(["type": "auth-ok"])
                        authenticated = true
                        break
                    } else {
                        sendJSON(["type": "auth-failed"])
                    }
                }

                guard authenticated else {
                    print("[webrtc] auth failed for \(key)")
                    close()
                    return
                }
            }

            // Metadata
            sendJSON([
                "type": "metadata",
                "fileName": file.fileName,
                "fileSize": file.fileSize,
                "mimeType": MIMEType.mimeType(for: file.fileName),
            ])

            // Stream file
            guard let fh = FileHandle(forReadingAtPath: file.filePath) else {
                close()
                return
            }
            defer { fh.closeFile() }

            var offset: UInt64 = 0
            let total = UInt64(file.fileSize)

            while offset < total && !Task.isCancelled {
                guard dataChannel.readyState == .open else { break }

                // Back-pressure
                while dataChannel.bufferedAmount > UInt64(WebRTCService.highWater) && !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(10))
                    guard dataChannel.readyState == .open else { break }
                }
                guard dataChannel.readyState == .open else { break }

                fh.seek(toFileOffset: offset)
                let length = min(UInt64(WebRTCService.chunkSize), total - offset)
                let chunk = fh.readData(ofLength: Int(length))
                guard !chunk.isEmpty else { break }

                dataChannel.sendData(RTCDataBuffer(data: chunk, isBinary: true))
                offset += UInt64(chunk.count)
            }

            guard dataChannel.readyState == .open, !Task.isCancelled else {
                close()
                return
            }

            sendJSON(["type": "done"])
            print("[webrtc] transfer complete for \(key)")

            try? await Task.sleep(for: .seconds(2))
            close()
        }
    }
}
