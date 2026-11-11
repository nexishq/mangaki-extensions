// Typings for the native `host` bridge that the iOS app injects into
// every extension's JavaScript context. Implementations of these methods
// live in `Sources/Mangaki/Core/Extensions/HostBridge.swift`.

interface HostFetchResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

interface HostFetchInit {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /// Cookies are never attached or stored implicitly — pass a `Cookie`
  /// header yourself (e.g. the value from `solveDDoSGuard`).
  headers?: Record<string, string>;
  body?: string;
  /// "base64" returns binary bodies base64-encoded. Default is UTF-8 text;
  /// a non-UTF-8 body rejects the promise.
  encoding?: "text" | "base64";
}

interface DDoSGuardResult {
  /// Cookie header value to attach to subsequent requests (or empty
  /// string if no challenge was needed).
  cookies: string;
}

interface Host {
  /// Simple HTTP wrapper that goes through native URLSession. Returns
  /// the raw response body as a string — caller is responsible for
  /// JSON.parse / HTML handling. https/http to public hosts only:
  /// loopback, private and link-local addresses are rejected.
  fetch(url: string, init?: HostFetchInit): Promise<HostFetchResponse>;

  /// Resolve a DDoS-Guard challenge by spinning up a WKWebView on the
  /// native side and harvesting the cookies it sets. Sources that hit a
  /// guard-protected origin should call this before their first fetch
  /// and pass the returned cookie value as a `Cookie` request header.
  solveDDoSGuard(domain: string): Promise<DDoSGuardResult>;

  /// Forwarded to the iOS unified log (subsystem `app.mangaki.ios`,
  /// category `Extension <id>`). Useful while developing — leaves
  /// breadcrumbs you can read via Console.app.
  log(message: string): void;
}

declare const host: Host;
