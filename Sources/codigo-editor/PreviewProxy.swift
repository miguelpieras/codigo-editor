import Foundation
@preconcurrency import WebKit

enum PreviewProxy {
    static let proxyScheme = "codigo-preview"
    private static let targetScheme = "http"
    private static let originalSchemeParameter = "__codigo_preview_scheme"

    private static let rewritableHosts: Set<String> = [
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "::1",
        "[::1]"
    ]

    private static let scriptSource: String = {
        let hosts = rewritableHosts.sorted().map { "'\($0)'" }.joined(separator: ", ")
        return """
        (function() {
            const PROXY_SCHEME = '\(proxyScheme)';
            const REWRITABLE_HOSTS = new Set([\(hosts)]);
            const ORIGINAL_SCHEME_PARAM = '\(originalSchemeParameter)';

            function shouldProxy(url) {
                if (!url) { return false; }
                const protocol = (url.protocol || '').toLowerCase();
                if (protocol !== 'http:' && protocol !== 'https:') {
                    return false;
                }
                const host = (url.hostname || '').toLowerCase();
                return REWRITABLE_HOSTS.has(host);
            }

            function rewriteURL(input) {
                try {
                    const url = new URL(input, window.location.href);
                    if (!shouldProxy(url)) {
                        return url.toString();
                    }

                    const originalProtocol = (url.protocol || '').toLowerCase();
                    const proxied = new URL(url.toString());
                    proxied.protocol = PROXY_SCHEME + ':';

                    if (originalProtocol === 'http:' || originalProtocol === 'https:') {
                        const schemeValue = originalProtocol.slice(0, -1);
                        proxied.searchParams.set(ORIGINAL_SCHEME_PARAM, schemeValue);
                    }

                    const proxiedString = proxied.toString();
                    if (url.toString() !== proxiedString) {
                        console.debug('[PreviewProxy] Rewriting URL', input, '->', proxiedString);
                    }
                    return proxiedString;
                } catch (_) {
                    return input;
                }
            }

            const originalFetch = window.fetch;
            const hasRequest = typeof Request === 'function';
            if (typeof originalFetch === 'function') {
                window.fetch = function(resource, init) {
                    let rewritten = resource;
                    if (typeof resource === 'string') {
                        rewritten = rewriteURL(resource);
                    } else if (hasRequest && resource instanceof Request) {
                        const updated = rewriteURL(resource.url);
                        if (updated !== resource.url) {
                            rewritten = new Request(updated, resource);
                        }
                    }
                    return originalFetch.call(this, rewritten, init);
                };
            }

            if (typeof XMLHttpRequest !== 'undefined') {
                const originalXHROpen = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                    const rewritten = rewriteURL(url);
                    if (rewritten !== url) {
                        console.debug('[PreviewProxy] Rewriting XHR', url, '->', rewritten);
                    }
                    return originalXHROpen.call(this, method, rewritten, ...rest);
                };
            }

            const OriginalEventSource = window.EventSource;
            if (OriginalEventSource) {
                window.EventSource = function(url, configuration) {
                    const rewritten = rewriteURL(url);
                    return new OriginalEventSource(rewritten, configuration);
                };
                window.EventSource.prototype = OriginalEventSource.prototype;
            }

            const OriginalWebSocket = window.WebSocket;
            if (OriginalWebSocket) {
                window.WebSocket = function(url, protocols) {
                    const rewritten = rewriteURL(url);
                    return new OriginalWebSocket(rewritten, protocols);
                };
                window.WebSocket.prototype = OriginalWebSocket.prototype;
            }
        })();
        """
    }()

    @MainActor static func userScripts() -> [WKUserScript] {
        [WKUserScript(source: scriptSource, injectionTime: .atDocumentStart, forMainFrameOnly: false)]
    }

    static func destinationURL(for url: URL) -> URL {
        let normalised = normaliseDirectoryURL(for: url)
        if let proxied = proxiedURL(for: normalised) {
            return proxied
        }
        return normalised
    }

    static func proxiedURL(for url: URL) -> URL? {
        let normalised = normaliseDirectoryURL(for: url)
        guard shouldProxy(normalised),
              var components = URLComponents(url: normalised, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let originalScheme = components.scheme
        components.scheme = proxyScheme
        var items = components.queryItems ?? []
        items.removeAll { $0.name == originalSchemeParameter }
        if let originalScheme {
            items.append(URLQueryItem(name: originalSchemeParameter, value: originalScheme))
        }
        components.queryItems = items.isEmpty ? nil : items
        return components.url
    }

    static func unproxiedURL(from url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let items = components.queryItems ?? []
        let schemeOverride = items.first { $0.name == originalSchemeParameter }?.value
        let filteredItems = items.filter { $0.name != originalSchemeParameter }
        components.queryItems = filteredItems.isEmpty ? nil : filteredItems
        components.scheme = schemeOverride?.lowercased() ?? targetScheme
        components.user = nil
        components.password = nil
        return components.url
    }

    static func shouldProxy(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == targetScheme || scheme == "https" else {
            return false
        }
        guard let host = url.host?.lowercased() else {
            return false
        }
        return rewritableHosts.contains(host)
    }

    private static func normaliseDirectoryURL(for url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              scheme == targetScheme || scheme == "https" else {
            return url
        }

        var path = components.percentEncodedPath
        guard !path.isEmpty else {
            return url
        }
        if path.hasSuffix("/") {
            return components.url ?? url
        }

        let lastSegment = path.split(separator: "/").last ?? Substring()
        if lastSegment.contains(".") {
            return url
        }

        path += "/"
        components.percentEncodedPath = path
        return components.url ?? url
    }
}

@MainActor
final class PreviewProxySchemeHandler: NSObject, WKURLSchemeHandler {
    private let session: URLSession
    private let sessionQueue: OperationQueue
    @MainActor private var activeTasks: [ObjectIdentifier: URLSessionDataTask] = [:]

    override init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 30
        sessionQueue = OperationQueue()
        sessionQueue.maxConcurrentOperationCount = 4
        sessionQueue.qualityOfService = .userInitiated
        session = URLSession(configuration: configuration, delegate: nil, delegateQueue: sessionQueue)
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let incomingURL = urlSchemeTask.request.url,
              let outboundURL = PreviewProxy.unproxiedURL(from: incomingURL) else {
            urlSchemeTask.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorBadURL))
            return
        }

        var request = URLRequest(url: outboundURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = urlSchemeTask.request.httpMethod
        request.allHTTPHeaderFields = urlSchemeTask.request.allHTTPHeaderFields
        if let body = urlSchemeTask.request.httpBody {
            request.httpBody = body
        } else if let stream = urlSchemeTask.request.httpBodyStream {
            request.httpBody = Data(reading: stream)
        }

        let taskBox = SchemeTaskBox(task: urlSchemeTask)

        let dataTask = session.dataTask(with: request) { [weak self] data, response, error in
            Task { @MainActor in
                guard let self else { return }
                _ = self.popTask(for: taskBox.task)

                if let error {
                    let nsError = error as NSError
                    if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
                        return
                    }
                    taskBox.task.didFailWithError(error)
                    return
                }

                guard let httpResponse = response as? HTTPURLResponse else {
                    taskBox.task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorUnknown))
                    return
                }

                let headers = Self.sanitizedHeaders(from: httpResponse)
                let sanitizedResponse = HTTPURLResponse(
                    url: incomingURL,
                    statusCode: httpResponse.statusCode,
                    httpVersion: "HTTP/1.1",
                    headerFields: headers
                ) ?? httpResponse

                taskBox.task.didReceive(sanitizedResponse)
                if let data {
                    taskBox.task.didReceive(data)
                }
                taskBox.task.didFinish()
            }
        }

        storeTask(dataTask, for: urlSchemeTask)
        dataTask.resume()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        if let task = popTask(for: urlSchemeTask) {
            task.cancel()
        }
    }

    deinit {
        session.invalidateAndCancel()
        sessionQueue.cancelAllOperations()
    }

    @MainActor
    private func storeTask(_ task: URLSessionDataTask, for schemeTask: any WKURLSchemeTask) {
        activeTasks[ObjectIdentifier(schemeTask as AnyObject)] = task
    }

    @MainActor
    private func popTask(for schemeTask: any WKURLSchemeTask) -> URLSessionDataTask? {
        activeTasks.removeValue(forKey: ObjectIdentifier(schemeTask as AnyObject))
    }

    private static func sanitizedHeaders(from response: HTTPURLResponse) -> [String: String] {
        var headers: [String: String] = [:]
        for (keyAny, valueAny) in response.allHeaderFields {
            guard let key = keyAny as? String else { continue }
            let value = (valueAny as? String) ?? String(describing: valueAny)
            if key.caseInsensitiveCompare("Strict-Transport-Security") == .orderedSame {
                continue
            }
            if key.caseInsensitiveCompare("Content-Security-Policy") == .orderedSame {
                let cleaned = removeUpgradeInsecureDirective(from: value)
                if cleaned.isEmpty { continue }
                headers[key] = cleaned
                continue
            }
            headers[key] = value
        }
        return headers
    }

    private static func removeUpgradeInsecureDirective(from policy: String) -> String {
        let directives = policy.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
        let filtered = directives.filter { directive in
            directive.caseInsensitiveCompare("upgrade-insecure-requests") != .orderedSame
        }
        return filtered.joined(separator: "; ")
    }
}

private struct SchemeTaskBox: @unchecked Sendable {
    let task: any WKURLSchemeTask
}

private extension Data {
    init(reading stream: InputStream) {
        self.init()
        stream.open()
        defer { stream.close() }
        let bufferSize = 16_384
        var buffer = Array<UInt8>(repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: bufferSize)
            if count <= 0 { break }
            buffer.withUnsafeBytes { pointer in
                if let baseAddress = pointer.baseAddress?.assumingMemoryBound(to: UInt8.self) {
                    append(baseAddress, count: count)
                }
            }
        }
    }
}
