#!/usr/bin/env swift
// Standalone smoke-test for the extension runtime: loads a JS bundle,
// runs its `mangaList` method against the real source API, prints the
// first few results. Run with:
//   swift mangaki-extensions/test_runtime.swift mangaki-extensions/dist/sources/mangadex/source.js
//
// Mirrors the iOS app's ExtensionRuntime + HostBridge minimally — enough
// to verify the bundle JS is parseable, the source class instantiates,
// and a method actually returns sensible data.

import Foundation
import JavaScriptCore

guard CommandLine.arguments.count >= 2 else {
    print("usage: \(CommandLine.arguments[0]) <bundle.js>")
    exit(1)
}
let bundlePath = CommandLine.arguments[1]
let bundleSource = try String(contentsOfFile: bundlePath, encoding: .utf8)

guard let ctx = JSContext() else { exit(2) }
ctx.exceptionHandler = { _, e in print("[JS exception] \(e?.toString() ?? "?")") }

// Minimal host bridge: fetch + log + stub solveDDoSGuard.
let host = JSValue(newObjectIn: ctx)!

let logBlock: @convention(block) (String) -> Void = { msg in print("[log] \(msg)") }
host.setObject(unsafeBitCast(logBlock, to: AnyObject.self),
               forKeyedSubscript: "log" as NSString)

let fetchBlock: @convention(block) (String, JSValue?) -> JSValue = { urlStr, opts in
    let promiseCtor = ctx.objectForKeyedSubscript("Promise")!
    var resolveFn: JSValue?
    var rejectFn: JSValue?
    let executor: @convention(block) (JSValue, JSValue) -> Void = { r, j in
        resolveFn = r; rejectFn = j
    }
    let promise = promiseCtor.construct(withArguments: [JSValue(object: executor, in: ctx)!])!

    print("[fetch] \(urlStr)")
    guard let url = URL(string: urlStr) else {
        rejectFn?.call(withArguments: ["bad url: \(urlStr)"])
        return promise
    }
    var request = URLRequest(url: url)
    request.timeoutInterval = 20
    if let opts, !opts.isUndefined {
        // `toString()` on a missing key yields "undefined", which servers
        // reject — only set the method when the extension passed one.
        if let m = opts.objectForKeyedSubscript("method"), !m.isUndefined, !m.isNull,
           let method = m.toString(), !method.isEmpty {
            request.httpMethod = method
        }
        if let headers = opts.objectForKeyedSubscript("headers")?.toDictionary() as? [String: String] {
            for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
        }
        if let body = opts.objectForKeyedSubscript("body"), !body.isUndefined,
           let s = body.toString() {
            request.httpBody = s.data(using: .utf8)
        }
    }
    URLSession.shared.dataTask(with: request) { data, resp, err in
        if let err {
            rejectFn?.call(withArguments: [err.localizedDescription]); return
        }
        guard let http = resp as? HTTPURLResponse else {
            rejectFn?.call(withArguments: ["no http"]); return
        }
        let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
            if let ks = k as? String, let vs = v as? String { headers[ks] = vs }
        }
        resolveFn?.call(withArguments: [["status": http.statusCode, "body": body, "headers": headers]])
    }.resume()
    return promise
}
host.setObject(unsafeBitCast(fetchBlock, to: AnyObject.self),
               forKeyedSubscript: "fetch" as NSString)

let ddosBlock: @convention(block) (String) -> JSValue = { _ in
    let p = ctx.objectForKeyedSubscript("Promise")!
    return p.invokeMethod("resolve", withArguments: [["cookies": ""]])
}
host.setObject(unsafeBitCast(ddosBlock, to: AnyObject.self),
               forKeyedSubscript: "solveDDoSGuard" as NSString)

ctx.setObject(host, forKeyedSubscript: "host" as NSString)

// Load bundle.
ctx.evaluateScript(bundleSource)
if let ex = ctx.exception {
    print("[bundle parse failed] \(ex.toString() ?? "?")")
    exit(3)
}
guard let SourceClass = ctx.objectForKeyedSubscript("MangakiExtension"),
      !SourceClass.isUndefined else {
    print("[no MangakiExtension global]")
    exit(4)
}
guard let source = SourceClass.construct(withArguments: []),
      !source.isUndefined else {
    print("[failed to instantiate]")
    exit(5)
}
print("[ok] loaded source: \(source.toString() ?? "?")")

// Build filter via JSON.parse so nested empty arrays survive bridging.
let filterJSON = """
{"query":"","sort":"lastChapter",
 "type":{"include":[],"exclude":[]},
 "status":{"include":[],"exclude":[]},
 "rating":{"include":[],"exclude":[]},
 "format":{"include":[],"exclude":[]},
 "labels":{"include":[],"exclude":[]}}
"""
ctx.evaluateScript("globalThis.__filter = \(filterJSON);")
let filter = ctx.objectForKeyedSubscript("__filter")!

// Use invokeMethod so `this` is bound to the source instance.
let promise = source.invokeMethod("mangaList", withArguments: [filter, NSNull()])!

let sem = DispatchSemaphore(value: 0)
var resolved: JSValue?
var rejected: String?

let onR: @convention(block) (JSValue?) -> Void = { v in resolved = v; sem.signal() }
let onJ: @convention(block) (JSValue?) -> Void = { v in rejected = v?.toString() ?? "?"; sem.signal() }

promise.invokeMethod("then", withArguments: [
    JSValue(object: onR, in: ctx)!,
    JSValue(object: onJ, in: ctx)!
])

// Pump the runloop until the promise settles. Hard-cap at 30s.
let deadline = Date().addingTimeInterval(30)
while sem.wait(timeout: .now()) == .timedOut {
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    if Date() > deadline { print("[timeout]"); exit(7) }
}

if let rejected {
    print("[mangaList rejected] \(rejected)")
    exit(8)
}
guard let result = resolved, let dict = result.toDictionary() else {
    print("[no dict]"); exit(9)
}
print("[result keys] \(Array(dict.keys))")
let items = dict["items"] as? [[String: Any]] ?? []
print("[items count] \(items.count)")
for (i, m) in items.prefix(3).enumerated() {
    let title = m["title"] ?? "?"
    let slug = m["slug"] ?? "?"
    print("  \(i + 1). \(title) [\(slug)]")
}
print("[endCursor] \(dict["endCursor"] ?? "nil") hasMore=\(dict["hasMore"] ?? "?")")

// MARK: - mangaDetails + chapters smoke test
// The app passes `remoteID` to mangaDetails and "<sourceID>:<remoteID>" to
// chapters; mirror that. The source id is the bundle's folder name.
let sourceID = URL(fileURLWithPath: bundlePath).deletingLastPathComponent().lastPathComponent
guard let firstItem = items.first,
      let firstSlug = (firstItem["remoteID"] ?? firstItem["slug"]) as? String else {
    print("[no items, skipping details]"); exit(0)
}

func awaitPromise(_ p: JSValue) -> (JSValue?, String?) {
    let sem = DispatchSemaphore(value: 0)
    var resolved: JSValue?
    var rejected: String?
    let onR: @convention(block) (JSValue?) -> Void = { v in resolved = v; sem.signal() }
    let onJ: @convention(block) (JSValue?) -> Void = { v in rejected = v?.toString() ?? "?"; sem.signal() }
    p.invokeMethod("then", withArguments: [
        JSValue(object: onR, in: ctx)!,
        JSValue(object: onJ, in: ctx)!
    ])
    let deadline = Date().addingTimeInterval(30)
    while sem.wait(timeout: .now()) == .timedOut {
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        if Date() > deadline { return (nil, "timeout") }
    }
    return (resolved, rejected)
}

print("\n--- mangaDetails(\(firstSlug)) ---")
let detailsPromise = source.invokeMethod("mangaDetails", withArguments: [firstSlug])!
let (detailsResult, detailsErr) = awaitPromise(detailsPromise)
if let detailsErr { print("[rejected] \(detailsErr)"); exit(10) }
guard let details = detailsResult?.toDictionary() else { print("[no dict]"); exit(11) }
let summary = details["summary"] as? [String: Any] ?? [:]
print("title: \(summary["title"] ?? "?")")
print("type: \(summary["type"] ?? "?") status: \(summary["status"] ?? "?")")
print("genres: \(details["genres"] ?? [])")
print("description: \(String(describing: details["description"]).prefix(120))…")

print("\n--- chapters(\(sourceID):\(firstSlug)) ---")
let chPromise = source.invokeMethod("chapters", withArguments: ["\(sourceID):\(firstSlug)"])!
let (chResult, chErr) = awaitPromise(chPromise)
if let chErr { print("[rejected] \(chErr)"); exit(12) }
let chArr = chResult?.toArray() as? [[String: Any]] ?? []
print("[chapter count] \(chArr.count)")
for c in chArr.prefix(3) {
    print("  ch \(c["number"] ?? "?") (\(c["language"] ?? "?")) — \(c["title"] ?? "—")")
}

exit(0)
