import Foundation
import NIO
import NIOHTTP1

actor HTTPFileServer {
    private var channel: Channel?
    private let fileShareManager: FileShareManager
    private let allowedOrigin: String
    private(set) var port: Int = 0

    init(fileShareManager: FileShareManager, allowedOrigin: String = "*") {
        self.fileShareManager = fileShareManager
        self.allowedOrigin = allowedOrigin
    }

    func start() async throws {
        let fileShareManager = self.fileShareManager
        let allowedOrigin = self.allowedOrigin

        let group = MultiThreadedEventLoopGroup(numberOfThreads: 2)
        let fileIO = NonBlockingFileIO(threadPool: .singleton)

        let bootstrap = ServerBootstrap(group: group)
            .serverChannelOption(.backlog, value: 256)
            .childChannelInitializer { channel in
                channel.pipeline.configureHTTPServerPipeline().flatMap {
                    channel.pipeline.addHandler(
                        HTTPHandler(
                            fileShareManager: fileShareManager,
                            fileIO: fileIO,
                            allowedOrigin: allowedOrigin
                        )
                    )
                }
            }
            .childChannelOption(.maxMessagesPerRead, value: 16)

        let ch = try await bootstrap.bind(host: "0.0.0.0", port: 0).get()
        self.channel = ch
        if let addr = ch.localAddress {
            self.port = addr.port ?? 0
        }
        print("[http] file server listening on port \(self.port)")
    }

    func stop() async {
        try? await channel?.close()
    }
}

// MARK: - HTTP Handler

private final class HTTPHandler: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = HTTPServerRequestPart
    typealias OutboundOut = HTTPServerResponsePart

    private let fileShareManager: FileShareManager
    private let fileIO: NonBlockingFileIO
    private let allowedOrigin: String

    private var requestHead: HTTPRequestHead?

    init(fileShareManager: FileShareManager, fileIO: NonBlockingFileIO, allowedOrigin: String) {
        self.fileShareManager = fileShareManager
        self.fileIO = fileIO
        self.allowedOrigin = allowedOrigin
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let part = unwrapInboundIn(data)
        switch part {
        case .head(let head):
            requestHead = head
        case .body:
            break
        case .end:
            guard let head = requestHead else { return }
            requestHead = nil
            handleRequest(context: context, head: head)
        }
    }

    private func handleRequest(context: ChannelHandlerContext, head: HTTPRequestHead) {
        if head.method == .OPTIONS {
            sendResponse(context: context, status: .noContent, headers: [
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "*",
            ])
            return
        }

        guard head.method == .GET else {
            sendResponse(context: context, status: .methodNotAllowed)
            return
        }

        // Parse URL
        guard let urlComponents = URLComponents(string: head.uri) else {
            sendResponse(context: context, status: .badRequest)
            return
        }

        let path = urlComponents.path
        let downloadPrefix = "/download/"
        guard path.hasPrefix(downloadPrefix) else {
            sendResponse(context: context, status: .notFound)
            return
        }

        let rawShareId = String(path.dropFirst(downloadPrefix.count))
        let shareId = rawShareId.removingPercentEncoding ?? rawShareId

        guard ShareIdValidator.isValid(shareId) else {
            sendJSON(context: context, status: .badRequest, body: ["error": "invalid shareId"])
            return
        }

        let token = urlComponents.queryItems?.first(where: { $0.name == "token" })?.value ?? ""
        let ctx = context

        Task {
            guard let file = await fileShareManager.file(for: shareId) else {
                await MainActor.run { sendJSON(context: ctx, status: .notFound, body: ["error": "not found"]) }
                return
            }

            // Password check
            if file.hasPassword {
                let valid = await fileShareManager.verifyPassword(shareId: shareId, candidateHash: token)
                if !valid {
                    await MainActor.run { sendJSON(context: ctx, status: .forbidden, body: ["error": "invalid token"]) }
                    return
                }
            }

            // Check file exists
            guard FileManager.default.fileExists(atPath: file.filePath) else {
                await MainActor.run { sendJSON(context: ctx, status: .gone, body: ["error": "file gone"]) }
                return
            }

            await MainActor.run {
                self.streamFile(context: ctx, file: file)
            }
        }
    }

    private func streamFile(context: ChannelHandlerContext, file: SharedFile) {
        let mimeType = MIMEType.mimeType(for: file.fileName)
        let encodedName = file.fileName.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? file.fileName

        var headers = HTTPHeaders()
        headers.add(name: "Content-Type", value: mimeType)
        headers.add(name: "Content-Length", value: "\(file.fileSize)")
        headers.add(name: "Content-Disposition", value: "attachment; filename=\"\(encodedName)\"")
        headers.add(name: "Access-Control-Allow-Origin", value: allowedOrigin)
        headers.add(name: "Access-Control-Expose-Headers", value: "Content-Length, Content-Disposition")

        let responseHead = HTTPResponseHead(version: .http1_1, status: .ok, headers: headers)
        context.write(wrapOutboundOut(.head(responseHead)), promise: nil)

        let fileHandle: NIOFileHandle
        do {
            fileHandle = try NIOFileHandle(path: file.filePath)
        } catch {
            // File open failed - send error
            context.close(promise: nil)
            return
        }

        let region = FileRegion(fileHandle: fileHandle, readerIndex: 0, endIndex: Int(file.fileSize))
        context.writeAndFlush(wrapOutboundOut(.body(.fileRegion(region)))).whenComplete { _ in
            try? fileHandle.close()
            context.writeAndFlush(self.wrapOutboundOut(.end(nil)), promise: nil)
        }
    }

    private func sendResponse(context: ChannelHandlerContext, status: HTTPResponseStatus, headers: [String: String] = [:]) {
        var httpHeaders = HTTPHeaders()
        httpHeaders.add(name: "Access-Control-Allow-Origin", value: allowedOrigin)
        for (k, v) in headers {
            httpHeaders.add(name: k, value: v)
        }
        let head = HTTPResponseHead(version: .http1_1, status: status, headers: httpHeaders)
        context.write(wrapOutboundOut(.head(head)), promise: nil)
        context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: nil)
    }

    private func sendJSON(context: ChannelHandlerContext, status: HTTPResponseStatus, body: [String: String]) {
        var headers = HTTPHeaders()
        headers.add(name: "Content-Type", value: "application/json")
        headers.add(name: "Access-Control-Allow-Origin", value: allowedOrigin)

        let jsonData = (try? JSONSerialization.data(withJSONObject: body)) ?? Data()
        var buffer = context.channel.allocator.buffer(capacity: jsonData.count)
        buffer.writeBytes(jsonData)

        let head = HTTPResponseHead(version: .http1_1, status: status, headers: headers)
        context.write(wrapOutboundOut(.head(head)), promise: nil)
        context.write(wrapOutboundOut(.body(.byteBuffer(buffer))), promise: nil)
        context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: nil)
    }
}
