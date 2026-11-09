import AppKit
import ApplicationServices
import Foundation

// User-run utility. Building or --validate-request never reads or controls apps.
struct NavigationRequest: Decodable {
    let version: Int
    let thread_id: String
    let node_id: String
    let message_id: String
    let role: String
    let user_position: Int
    let captured_user_count: Int
    let anchors: [String]
    let excluded_origins: [String]?
    let scope: String?
    let short_text: String?
    let context_anchors: [String]?

    func validate() throws {
        guard version == 1, UUID(uuidString: thread_id) != nil,
              !node_id.isEmpty, node_id.count <= 256,
              !message_id.isEmpty, message_id.count <= 256,
              ["user", "assistant"].contains(role),
              user_position > 0, user_position <= captured_user_count,
              captured_user_count <= 100_000,
              anchors.count <= 4,
              anchors.allSatisfy({ !$0.isEmpty && $0.count <= 64 }),
              (context_anchors ?? []).count <= 4,
              (context_anchors ?? []).allSatisfy({ $0.count >= 8 && $0.count <= 64 }),
              short_text == nil || (role == "user" && anchors.isEmpty && !(short_text!.isEmpty) && short_text!.count < 8),
              context_anchors == nil || short_text != nil,
              scope == nil || ["thread", "current_window"].contains(scope!),
              (excluded_origins ?? []).count <= 3,
              (excluded_origins ?? []).allSatisfy({ origin in
                  guard let url = URL(string: origin) else { return false }
                  return url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host ?? "")
              })
        else { throw NavigationError.invalidRequest }
    }
}

enum NavigationError: Error { case invalidRequest }

func respond(_ status: String, verified: Bool = false, diagnostics: [String: Any]? = nil,
             method: String? = nil) -> Never {
    var result: [String: Any] = ["status": status, "verified": verified]
    if let diagnostics { result["diagnostics"] = diagnostics }
    if let method { result["method"] = method }
    if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
    exit(["located", "turn_revealed", "search_requested", "context_revealed", "valid_request", "self_test_passed"].contains(status) ? 0 : 1)
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
    let value = attribute(element, name)
    if let text = value as? String { return text }
    if let url = value as? URL { return url.absoluteString }
    return ""
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, kAXChildrenAttribute as String) as? [AXUIElement] ?? []
}

func normalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").lowercased()
}

let defaultExcludedOrigins: Set<String> = ["http://127.0.0.1:18766", "http://localhost:18766"]

func origin(_ text: String) -> String? {
    guard let url = URL(string: text), let scheme = url.scheme, let host = url.host else { return nil }
    return "\(scheme.lowercased())://\(host.lowercased())" + (url.port.map { ":\($0)" } ?? "")
}

func isExcluded(_ url: String, origins: Set<String>) -> Bool {
    origin(url).map { origins.contains($0) } ?? false
}

struct SurfaceSnapshot {
    let url: String
    let document: String
    var focused = true
    var targetButtons = 0
    var railButtons = 0
    var railScanComplete = false
}

func isNativeAddress(_ text: String) -> Bool {
    if text.isEmpty { return true }
    guard let url = URLComponents(string: text), url.user == nil, url.password == nil else { return false }
    switch url.scheme?.lowercased() {
    case "app": return url.host == "-"
    case "codex", "codex-dev": return url.host == "threads"
    case "http", "https":
        return ["chatgpt.com", "chatgpt-staging.com", "localhost", "127.0.0.1"].contains(url.host?.lowercased() ?? "")
    default: return false
    }
}

func routeThreadID(_ text: String) -> UUID? {
    guard !text.isEmpty, isNativeAddress(text), let url = URLComponents(string: text) else { return nil }
    let parts = url.path.split(separator: "/").map(String.init)
    if ["codex", "codex-dev"].contains(url.scheme ?? ""), parts.count == 1 {
        return UUID(uuidString: parts[0])
    }
    // These are the actual Codex conversation routes in this app build.
    guard parts.count == 2, parts[0] == "local" else { return nil }
    return UUID(uuidString: parts[1])
}

func eligibleSurfaces(_ surfaces: [SurfaceSnapshot], thread: String, excluding: Set<String>) -> [Int] {
    guard let expected = UUID(uuidString: thread) else { return [] }
    return surfaces.indices.filter { index in
        let surface = surfaces[index]
        let addresses = [surface.url, surface.document]
        return surface.focused
            && !addresses.contains { isExcluded($0, origins: excluding) }
            && addresses.allSatisfy(isNativeAddress)
            && !addresses.compactMap(routeThreadID).contains { $0 != expected }
    }
}

func selectSurface(_ surfaces: [SurfaceSnapshot], thread: String,
                   excluding: Set<String>, complete: Bool, windowMatchesThread: Bool = false) -> Int? {
    guard complete, let expected = UUID(uuidString: thread) else { return nil }
    let eligible = eligibleSurfaces(surfaces, thread: thread, excluding: excluding)
    let matches = eligible.filter { index in
        [surfaces[index].url, surfaces[index].document].compactMap(routeThreadID).contains(expected)
    }
    if matches.count == 1 { return matches[0] }
    if matches.isEmpty && windowMatchesThread && eligible.count == 1 { return eligible[0] }
    return nil
}

func compatibleWindow(_ window: SurfaceSnapshot, thread: String, excluding: Set<String>) -> Bool {
    guard let expected = UUID(uuidString: thread) else { return false }
    let addresses = [window.url, window.document]
    return !addresses.contains { isExcluded($0, origins: excluding) }
        && !addresses.compactMap(routeThreadID).contains { $0 != expected }
}

func selectCurrentSurface(_ surfaces: [SurfaceSnapshot], thread: String, excluding: Set<String>,
                          window: SurfaceSnapshot, complete: Bool, appIsFrontmost: Bool) -> Int? {
    guard complete, appIsFrontmost, compatibleWindow(window, thread: thread, excluding: excluding) else { return nil }
    let eligible = eligibleSurfaces(surfaces, thread: thread, excluding: excluding)
    guard eligible.allSatisfy({ surfaces[$0].railScanComplete }) else { return nil }
    // This establishes only a unique navigation surface in the current window,
    // not the identity of the conversation represented by a generic URL.
    let matches = eligible.filter {
        surfaces[$0].railScanComplete && surfaces[$0].targetButtons == 1 && surfaces[$0].railButtons >= 4
    }
    return matches.count == 1 ? matches[0] : nil
}

func selectSearchSurface(_ surfaces: [SurfaceSnapshot], thread: String, excluding: Set<String>,
                         window: SurfaceSnapshot, complete: Bool) -> Int? {
    guard complete, compatibleWindow(window, thread: thread, excluding: excluding) else { return nil }
    let eligible = eligibleSurfaces(surfaces, thread: thread, excluding: excluding)
    guard eligible.count == 1, let index = eligible.first,
          surfaces[index].railScanComplete, surfaces[index].railButtons == 0,
          [surfaces[index].url, surfaces[index].document].contains(where: {
              let url = URLComponents(string: $0)
              return url?.scheme == "app" && url?.host == "-"
          }) else { return nil }
    return index
}

func nativeAppSurface(_ surface: SurfaceSnapshot) -> Bool {
    [surface.url, surface.document].contains {
        let url = URLComponents(string: $0)
        return url?.scheme == "app" && url?.host == "-"
    }
}

func focusedFindCandidate(fieldMatches: Bool, windowMatches: Bool, surface: SurfaceSnapshot,
                          thread: String, excluding: Set<String>) -> Bool {
    fieldMatches && windowMatches && nativeAppSurface(surface)
        && eligibleSurfaces([surface], thread: thread, excluding: excluding) == [0]
}

struct ChatSurface {
    let root: AXUIElement
    let useFind: Bool
}

struct Traversal {
    let matches: [AXUIElement]
    let nestedDocuments: [AXUIElement]
    let complete: Bool
    let visited: Int
    let readErrors: Int
}

func walk(_ root: AXUIElement, within seconds: TimeInterval = 1,
          excluding: Set<String> = defaultExcludedOrigins, stopAtWebArea: Bool = false,
          stayInDocument: Bool = false,
          match: (AXUIElement) -> Bool) -> Traversal {
    var queue = [root]
    var index = 0
    var found: [AXUIElement] = []
    var nested: [AXUIElement] = []
    var readErrors = 0
    let deadline = Date().addingTimeInterval(seconds)
    while index < queue.count && index < 12_000 && Date() < deadline {
        let element = queue[index]
        index += 1
        var rawRole: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &rawRole) == .success,
              let role = rawRole as? String else {
            readErrors += 1
            continue
        }
        // Exclude the map itself, not every HTTP(S) document: the native
        // application can also expose a web URL through Accessibility.
        if role == "AXWebArea" {
            let url = stringAttribute(element, "AXURL")
            let document = stringAttribute(element, "AXDocument")
            if isExcluded(url, origins: excluding) || isExcluded(document, origins: excluding) { continue }
            if stayInDocument && !CFEqual(element, root) {
                nested.append(element)
                continue
            }
        }
        if match(element) { found.append(element) }
        if stopAtWebArea && role == "AXWebArea" { continue }
        var rawChildren: CFTypeRef?
        let childrenStatus = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &rawChildren)
        if childrenStatus == .success {
            if let values = rawChildren as? [AXUIElement] { queue.append(contentsOf: values) }
            else { readErrors += 1 }
        } else if childrenStatus != .attributeUnsupported && childrenStatus != .noValue {
            readErrors += 1
        }
    }
    return Traversal(matches: found, nestedDocuments: nested,
                     complete: readErrors == 0 && index == queue.count, visited: index, readErrors: readErrors)
}

func nativeChatRoot(_ app: AXUIElement, window: AXUIElement, request: NavigationRequest, excluding: Set<String>,
                    until discoveryDeadline: Date, diagnostics: inout [String: Any]) -> ChatSurface? {
    let thread = request.thread_id
    guard let currentWindow = attribute(app, kAXFocusedWindowAttribute as String),
          CFGetTypeID(currentWindow) == AXUIElementGetTypeID(), CFEqual(currentWindow, window) else {
        diagnostics = ["focused_window": false]
        return nil
    }
    let windowSnapshot = SurfaceSnapshot(url: stringAttribute(window, "AXURL"),
                                         document: stringAttribute(window, "AXDocument"))
    guard compatibleWindow(windowSnapshot, thread: thread, excluding: excluding) else {
        diagnostics = ["focused_window": true, "window_conflict": true]
        return nil
    }
    let windowMatchesThread = selectSurface([windowSnapshot], thread: thread, excluding: excluding, complete: true) != nil
    // Start at the focused window, avoiding the application's menu tree.
    // Stop at document boundaries so long transcripts cannot starve this scan.
    let scan = walk(window, within: max(0, min(0.8, discoveryDeadline.timeIntervalSinceNow)), excluding: excluding, stopAtWebArea: true) {
        stringAttribute($0, kAXRoleAttribute as String) == "AXWebArea"
    }
    var roots = scan.matches
    var snapshots = roots.map {
        SurfaceSnapshot(url: stringAttribute($0, "AXURL"), document: stringAttribute($0, "AXDocument"))
    }
    if request.scope != "current_window" {
        guard let index = selectSurface(snapshots, thread: thread, excluding: excluding,
                                        complete: scan.complete, windowMatchesThread: windowMatchesThread) else { return nil }
        return ChatSurface(root: roots[index], useFind: false)
    }
    // Inspect each document separately. A wrapper WebArea must not hide a
    // nested native document, and embedded pages must not lend it their rail.
    let deadline = min(Date().addingTimeInterval(3.2), discoveryDeadline)
    var index = 0
    var inspected = 0, buttons = 0, labelled = 0, nodes = 0, nestedCount = 0
    var readErrors = scan.readErrors
    var documentsComplete = scan.complete && roots.count <= 6
    while documentsComplete && index < roots.count && Date() < deadline {
        defer { index += 1 }
        guard eligibleSurfaces([snapshots[index]], thread: thread, excluding: excluding) == [0] else { continue }
        inspected += 1
        let remaining = deadline.timeIntervalSinceNow
        let rails = walk(roots[index], within: min(1.3, remaining), excluding: excluding, stayInDocument: true) { element in
            guard stringAttribute(element, kAXRoleAttribute as String) == kAXButtonRole as String else { return false }
            buttons += 1
            let labels = [kAXDescriptionAttribute, kAXTitleAttribute, kAXHelpAttribute].map {
                stringAttribute(element, $0 as String)
            }
            if labels.contains(where: { !$0.isEmpty }) { labelled += 1 }
            return labels.contains { railPosition($0) != nil }
        }
        nodes += rails.visited
        readErrors += rails.readErrors
        snapshots[index].railScanComplete = rails.complete
        snapshots[index].railButtons = rails.matches.count
        snapshots[index].targetButtons = rails.matches.filter { navigationPosition($0) == request.user_position }.count
        documentsComplete = documentsComplete && rails.complete
        for child in rails.nestedDocuments where !roots.contains(where: { CFEqual($0, child) }) {
            nestedCount += 1
            guard roots.count < 6 else { documentsComplete = false; break }
            roots.append(child)
            snapshots.append(SurfaceSnapshot(url: stringAttribute(child, "AXURL"),
                                             document: stringAttribute(child, "AXDocument")))
        }
    }
    documentsComplete = documentsComplete && index == roots.count
    let eligible = eligibleSurfaces(snapshots, thread: thread, excluding: excluding)
    diagnostics = ["diagnostic_version": 2, "focused_window": true, "native_pages": snapshots.count,
                   "readable_addresses": snapshots.filter { !$0.url.isEmpty || !$0.document.isEmpty }.count,
                   "matching_pages": snapshots.filter { [$0.url, $0.document].compactMap(routeThreadID).contains(UUID(uuidString: thread)!) }.count,
                   "scan_complete": scan.complete, "eligible_pages": eligible.count,
                   "inspected_pages": inspected, "nested_pages": nestedCount,
                   "readable_buttons": min(buttons, 12000), "labelled_buttons": min(labelled, 12000),
                   "rail_buttons": min(snapshots.reduce(0) { $0 + $1.railButtons }, 12000),
                   "target_buttons": min(snapshots.reduce(0) { $0 + $1.targetButtons }, 12000),
                   "rail_nodes": min(nodes, 12000), "rail_scan_complete": documentsComplete,
                   "ax_read_errors": min(readErrors, 12000),
                   "document_scan_complete": documentsComplete,
                   "file_address_pages": snapshots.filter { [$0.url, $0.document].contains { URLComponents(string: $0)?.scheme == "file" } }.count,
                   "unknown_address_pages": snapshots.filter { ![$0.url, $0.document].allSatisfy(isNativeAddress) }.count]
    if let index = selectCurrentSurface(snapshots, thread: thread, excluding: excluding,
                                        window: windowSnapshot, complete: documentsComplete, appIsFrontmost: true) {
        return ChatSurface(root: roots[index], useFind: false)
    }
    if let index = selectSearchSurface(snapshots, thread: thread, excluding: excluding,
                                       window: windowSnapshot, complete: documentsComplete) {
        return ChatSurface(root: roots[index], useFind: true)
    }
    return nil
}

func railPosition(_ label: String) -> Int? {
    let lower = label.lowercased()
    guard lower.contains("user message") || (lower.contains("用户") && lower.contains("消息"))
        || (lower.contains("使用者") && lower.contains("訊息")) else { return nil }
    let pieces = lower.split(whereSeparator: { !$0.isNumber })
    guard pieces.count == 1 else { return nil }
    return Int(pieces[0])
}

func navigationPosition(_ element: AXUIElement) -> Int? {
    guard stringAttribute(element, kAXRoleAttribute as String) == kAXButtonRole as String else { return nil }
    for name in [kAXDescriptionAttribute, kAXTitleAttribute, kAXHelpAttribute] {
        if let position = railPosition(stringAttribute(element, name as String)) { return position }
    }
    return nil
}

func sameFocusedWindow(_ app: AXUIElement, window: AXUIElement, pid: pid_t) -> Bool {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          let focused = attribute(app, kAXFocusedWindowAttribute as String),
          CFGetTypeID(focused) == AXUIElementGetTypeID() else { return false }
    return CFEqual(focused, window)
}

func elementRect(_ e: AXUIElement) -> CGRect? {
        guard let p = attribute(e, kAXPositionAttribute as String),
              let s = attribute(e, kAXSizeAttribute as String),
              CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID()
        else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point),
              AXValueGetValue(s as! AXValue, .cgSize, &size), size.width > 0, size.height > 0
        else { return nil }
        return CGRect(origin: point, size: size)
}

func isVisible(_ element: AXUIElement, window: AXUIElement, viewportInset: CGFloat = 45) -> Bool {
    guard let area = elementRect(element), let viewport = elementRect(window) else { return false }
    return viewport.insetBy(dx: 0, dy: viewportInset).contains(CGPoint(x: area.midX, y: area.midY))
}

func contextTextMatches(_ text: String, query: String) -> Bool {
    let text = normalized(text)
    let query = normalized(query)
    return text.contains(query) || (text.count >= 6 && query.hasPrefix(text))
}

func revealShortSource(_ root: AXUIElement, request: NavigationRequest, query: String,
                       app: AXUIElement, window: AXUIElement, pid: pid_t,
                       excluding: Set<String>, until deadline: Date) -> Bool {
    guard let short = request.short_text else { return false }
    let context = walk(root, within: max(0, min(0.7, deadline.timeIntervalSinceNow)),
                       excluding: excluding, stayInDocument: true) {
        stringAttribute($0, kAXRoleAttribute as String) == kAXStaticTextRole as String
            && contextTextMatches(stringAttribute($0, kAXValueAttribute as String), query: query)
    }
    guard context.complete, context.matches.count == 1, let origin = context.matches.first,
          let contextFrame = elementRect(origin) else { return false }
    var group = origin
    for _ in 0..<8 {
        guard Date() < deadline,
              let raw = attribute(group, kAXParentAttribute as String),
              CFGetTypeID(raw) == AXUIElementGetTypeID() else { return false }
        group = raw as! AXUIElement
        let role = stringAttribute(group, kAXRoleAttribute as String)
        if role == "AXWebArea" || role == kAXWindowRole as String { return false }
        let source = walk(group, within: max(0, min(0.3, deadline.timeIntervalSinceNow)),
                          excluding: excluding, stayInDocument: true) {
            stringAttribute($0, kAXRoleAttribute as String) == kAXStaticTextRole as String
                && normalized(stringAttribute($0, kAXValueAttribute as String)) == normalized(short)
        }
        guard source.complete else { continue }
        if source.matches.count > 1 { return false }
        guard let target = source.matches.first, let frame = elementRect(target),
              frame.midY < contextFrame.midY else { continue }
        guard sameFocusedWindow(app, window: window, pid: pid) else { return false }
        if isVisible(target, window: window, viewportInset: 70) { return true }
        // Reveal the source or its compact turn container when the platform
        // exposes a supported action. Never select another repeated match.
        for candidate in [target, group] {
            var actions: CFArray?
            guard Date() < deadline,
                  AXUIElementCopyActionNames(candidate, &actions) == .success,
                  let names = actions as? [String], names.contains("AXScrollToVisible"),
                  sameFocusedWindow(app, window: window, pid: pid) else { continue }
            if AXUIElementPerformAction(candidate, "AXScrollToVisible" as CFString) == .success {
                Thread.sleep(forTimeInterval: 0.1)
                if sameFocusedWindow(app, window: window, pid: pid)
                    && isVisible(target, window: window, viewportInset: 70) { return true }
            }
        }
        return false
    }
    return false
}

func visibleOriginal(_ root: AXUIElement, request: NavigationRequest, excluding: Set<String>,
                     app: AXUIElement, focusedWindow: AXUIElement, pid: pid_t,
                     until deadline: Date) -> Bool {
    guard Date() < deadline else { return false }
    guard let window = attribute(root, kAXWindowAttribute as String),
          CFGetTypeID(window) == AXUIElementGetTypeID(), !request.anchors.isEmpty else { return false }
    let scan = walk(root, within: max(0, min(0.8, deadline.timeIntervalSinceNow)), excluding: excluding, stayInDocument: true) { element in
        let role = stringAttribute(element, kAXRoleAttribute as String)
        guard role == kAXStaticTextRole as String else { return false }
        let text = normalized(stringAttribute(element, kAXValueAttribute as String))
        return request.anchors.contains { text.contains(normalized($0)) }
    }
    // Readability does not prove visibility: require one original text match
    // and an actual supported scroll-to-visible action before claiming success.
    guard scan.complete, scan.matches.count == 1 else { return false }
    let target = scan.matches[0]
    var actions: CFArray?
    guard AXUIElementCopyActionNames(target, &actions) == .success,
          let names = actions as? [String], names.contains("AXScrollToVisible"),
          Date() < deadline,
          sameFocusedWindow(app, window: focusedWindow, pid: pid),
          AXUIElementPerformAction(target, "AXScrollToVisible" as CFString) == .success
    else { return false }
    Thread.sleep(forTimeInterval: 0.15)
    return sameFocusedWindow(app, window: focusedWindow, pid: pid)
        && isVisible(target, window: window as! AXUIElement)
}

let chatScopeLabels = ["Search chat", "搜索聊天", "搜尋對話"]
let chatFindLabels = ["Find in chat", "在聊天中查找", "在對話中尋找"]
let nextResultLabels = ["Next result", "下一个结果", "下一個結果"]
let previousResultLabels = ["Previous result", "上一个结果", "上一個結果"]
let chatFindPlaceholders = ["Search chat…", "Search chat...", "搜索聊天…", "搜索聊天...", "搜尋對話…", "搜尋對話..."]
let browserFindLabels = ["Find in page", "在页面中查找", "在頁面中尋找"]
let browserFindPlaceholders = ["Find in page…", "Find in page...", "在页面中查找…", "在頁面中尋找…"]

func labelsMatch(_ values: [String], _ labels: [String]) -> Bool {
    let expected = Set(labels.map(normalized))
    return values.contains { expected.contains(normalized($0)) }
}

func controlLabels(_ element: AXUIElement) -> [String] {
    var values = [kAXDescriptionAttribute, kAXTitleAttribute, kAXHelpAttribute].map {
        stringAttribute(element, $0 as String)
    }
    // Chromium can expose a text field's label through AXTitleUIElement
    // rather than duplicating it in AXTitle or AXDescription.
    if let raw = attribute(element, kAXTitleUIElementAttribute as String),
       CFGetTypeID(raw) == AXUIElementGetTypeID() {
        let label = raw as! AXUIElement
        if stringAttribute(label, kAXRoleAttribute as String) == kAXStaticTextRole as String {
            values.append(stringAttribute(label, kAXValueAttribute as String))
            values.append(stringAttribute(label, kAXTitleAttribute as String))
        }
    }
    return values
}

func hasExactLabel(_ element: AXUIElement, _ labels: [String]) -> Bool {
    labelsMatch(controlLabels(element), labels)
}

func isButton(_ element: AXUIElement) -> Bool {
    [kAXButtonRole as String, kAXCheckBoxRole as String, "AXToggleButton"].contains(
        stringAttribute(element, kAXRoleAttribute as String))
}

func chatFindFieldSnapshot(role: String, labels: [String], placeholder: String) -> Bool {
    [kAXTextFieldRole as String, "AXSearchField"].contains(role)
        && (labelsMatch(labels, chatFindLabels) || labelsMatch([placeholder], chatFindPlaceholders))
}

func chatFindField(_ element: AXUIElement) -> Bool {
    let role = stringAttribute(element, kAXRoleAttribute as String)
    guard [kAXTextFieldRole as String, "AXSearchField"].contains(role) else { return false }
    return chatFindFieldSnapshot(role: role, labels: controlLabels(element),
                                 placeholder: stringAttribute(element, "AXPlaceholderValue"))
}

func toggleSelection(_ element: AXUIElement) -> Bool? {
    guard let value = attribute(element, kAXValueAttribute as String) as? NSNumber,
          value.intValue == 0 || value.intValue == 1 else { return nil }
    return value.intValue == 1
}

func activateChatScopeWithKeyboard(_ button: AXUIElement, app: AXUIElement,
                                    window: AXUIElement, pid: pid_t) -> Bool {
    guard isButton(button), hasExactLabel(button, chatScopeLabels),
          isVisible(button, window: window, viewportInset: 0),
          let buttonWindow = attribute(button, kAXWindowAttribute as String),
          CFGetTypeID(buttonWindow) == AXUIElementGetTypeID(), CFEqual(buttonWindow, window),
          sameFocusedWindow(app, window: window, pid: pid) else { return false }
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(button, kAXFocusedAttribute as CFString, &settable) == .success,
          settable.boolValue,
          AXUIElementSetAttributeValue(button, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else { return false }
    Thread.sleep(forTimeInterval: 0.1)
    guard sameFocusedWindow(app, window: window, pid: pid),
          let focused = attribute(app, kAXFocusedUIElementAttribute as String),
          CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, button),
          let down = CGEvent(keyboardEventSource: nil, virtualKey: 49, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 49, keyDown: false) else { return false }
    // Space activates the focused native scope button. The source query is
    // written later through AXValue, only to the verified chat-find field.
    down.postToPid(pid)
    up.postToPid(pid)
    return true
}

func focusedChatField(app: AXUIElement, window: AXUIElement, thread: String,
                      excluding: Set<String>, until deadline: Date) -> (AXUIElement, AXUIElement)? {
    guard Date() < deadline,
          let raw = attribute(app, kAXFocusedUIElementAttribute as String),
          CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    let field = raw as! AXUIElement
    guard chatFindField(field),
          (attribute(field, kAXEnabledAttribute as String) as? Bool) != false,
          isVisible(field, window: window, viewportInset: 0),
          let fieldWindow = attribute(field, kAXWindowAttribute as String),
          CFGetTypeID(fieldWindow) == AXUIElementGetTypeID(), CFEqual(fieldWindow, window) else { return nil }
    var element = field
    for _ in 0..<24 {
        guard Date() < deadline else { return nil }
        if stringAttribute(element, kAXRoleAttribute as String) == "AXWebArea" {
            let surface = SurfaceSnapshot(url: stringAttribute(element, "AXURL"),
                                          document: stringAttribute(element, "AXDocument"))
            // The first document boundary must itself be the native app,
            // never an embedded browser that happens to share its window.
            guard focusedFindCandidate(fieldMatches: true, windowMatches: true, surface: surface,
                                        thread: thread, excluding: excluding) else { return nil }
            return (field, element)
        }
        guard let parent = attribute(element, kAXParentAttribute as String),
              CFGetTypeID(parent) == AXUIElementGetTypeID() else { return nil }
        element = parent as! AXUIElement
    }
    return nil
}

func focusedInside(_ root: AXUIElement, app: AXUIElement) -> Bool {
    guard let value = attribute(app, kAXFocusedUIElementAttribute as String),
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return false }
    var element = value as! AXUIElement
    for _ in 0..<32 {
        if CFEqual(element, root) { return true }
        // A browser embedded in the native page has its own document scope.
        if stringAttribute(element, kAXRoleAttribute as String) == "AXWebArea" { return false }
        guard let parent = attribute(element, kAXParentAttribute as String),
              CFGetTypeID(parent) == AXUIElementGetTypeID() else { return false }
        element = parent as! AXUIElement
    }
    return false
}

func focusNativeDocument(_ root: AXUIElement, app: AXUIElement, window: AXUIElement,
                         pid: pid_t, excluding: Set<String>) -> Bool {
    guard sameFocusedWindow(app, window: window, pid: pid) else { return false }
    if focusedInside(root, app: app) { return true }
    var candidates = [root]
    let composers = walk(root, within: 0.7, excluding: excluding, stayInDocument: true) {
        stringAttribute($0, kAXRoleAttribute as String) == kAXTextAreaRole as String
            && hasExactLabel($0, ["Work with Codex", "和 Codex 一起工作", "與 Codex 協作"])
    }
    if composers.complete && composers.matches.count == 1 { candidates.append(composers.matches[0]) }
    for candidate in candidates {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(candidate, kAXFocusedAttribute as CFString, &settable) == .success,
              settable.boolValue, sameFocusedWindow(app, window: window, pid: pid),
              AXUIElementSetAttributeValue(candidate, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
        else { continue }
        Thread.sleep(forTimeInterval: 0.1)
        if sameFocusedWindow(app, window: window, pid: pid) && focusedInside(root, app: app) { return true }
    }
    return false
}

func openNativeFind(_ root: AXUIElement, app: AXUIElement, window: AXUIElement,
                    pid: pid_t, excluding: Set<String>) -> Bool {
    // The native menu may initially select browser search. No query is written
    // until the explicit chat scope and its labelled field are confirmed below.
    if let bar = attribute(app, kAXMenuBarAttribute as String), CFGetTypeID(bar) == AXUIElementGetTypeID() {
        let commands = walk(bar as! AXUIElement, within: 0.7, excluding: excluding) { element in
            stringAttribute(element, kAXRoleAttribute as String) == kAXMenuItemRole as String
                && normalized(stringAttribute(element, "AXMenuItemCmdChar")) == "f"
                && (attribute(element, "AXMenuItemCmdModifiers") as? NSNumber)?.intValue == 0
                && (attribute(element, kAXEnabledAttribute as String) as? Bool) == true
                && hasExactLabel(element, ["Find", "Find…", "Find...", "查找", "查找…", "查找...", "尋找", "尋找…"])
        }
        if commands.complete && commands.matches.count == 1,
           sameFocusedWindow(app, window: window, pid: pid),
           AXUIElementPerformAction(commands.matches[0], kAXPressAction as CFString) == .success { return true }
    }
    // A shortcut is a fallback only after focus is proven inside the native
    // document. Events target Codex's PID, never the user's other applications.
    guard focusNativeDocument(root, app: app, window: window, pid: pid, excluding: excluding),
          let down = CGEvent(keyboardEventSource: nil, virtualKey: 3, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 3, keyDown: false),
          sameFocusedWindow(app, window: window, pid: pid), focusedInside(root, app: app) else { return false }
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.postToPid(pid)
    up.postToPid(pid)
    return true
}

func uniqueSearchCount(_ text: String) -> Bool {
    let patterns = [#"^1\s*/\s*1\s+results?$"#, #"^1\s*个结果[，,]\s*共\s*1\s*个结果$"#,
                    #"^1\s*/\s*1\s*個結果$"#]
    return patterns.contains { normalized(text).range(of: $0, options: .regularExpression) != nil }
}

func hasUniqueChatResult(_ input: AXUIElement, excluding: Set<String>, until deadline: Date) -> Bool {
    if (attribute(input, "AXElementBusy") as? Bool) == true { return false }
    var element = input
    for _ in 0..<5 {
        guard Date() < deadline else { return false }
        guard let raw = attribute(element, kAXParentAttribute as String),
              CFGetTypeID(raw) == AXUIElementGetTypeID() else { return false }
        element = raw as! AXUIElement
        if stringAttribute(element, kAXRoleAttribute as String) == "AXWebArea" { return false }
        let controls = walk(element, within: max(0, min(0.25, deadline.timeIntervalSinceNow)), excluding: excluding, stayInDocument: true) { item in
            (isButton(item) && (hasExactLabel(item, nextResultLabels) || hasExactLabel(item, previousResultLabels)))
                || (stringAttribute(item, kAXRoleAttribute as String) == kAXStaticTextRole as String
                    && uniqueSearchCount(stringAttribute(item, kAXValueAttribute as String)))
        }
        if controls.complete {
            let next = controls.matches.filter { isButton($0) && hasExactLabel($0, nextResultLabels) }
            let previous = controls.matches.filter { isButton($0) && hasExactLabel($0, previousResultLabels) }
            let counts = controls.matches.filter { stringAttribute($0, kAXRoleAttribute as String) == kAXStaticTextRole as String }
            if next.count == 1 && previous.count == 1 { return counts.count == 1 }
        }
    }
    return false
}

func findInCurrentChat(_ root: AXUIElement, request: NavigationRequest, excluding: Set<String>,
                       app: AXUIElement, window: AXUIElement, pid: pid_t, until commandDeadline: Date) -> Never {
    let method = "native_accessibility_find"
    let contextual = request.anchors.isEmpty && request.short_text != nil
    guard let query = (contextual ? request.context_anchors : request.anchors)?.first,
          query.count >= 8 else { respond("source_unsearchable", method: method) }
    var diagnostics: [String: Any] = ["find_triggered": false, "chat_scope_found": false,
                                     "chat_scope_pressed": false, "find_input_found": false,
                                     "query_written": false, "find_stage": 1, "contextual_search": contextual]
    func checkFocus() {
        if !sameFocusedWindow(app, window: window, pid: pid) { respond("focus_changed", method: method) }
        if Date() >= commandDeadline {
            respond(diagnostics["query_written"] as? Bool == true ? "search_requested" : "find_unavailable",
                    diagnostics: diagnostics, method: method)
        }
    }
    checkFocus()
    var scopes = walk(root, within: 0.6, excluding: excluding, stayInDocument: true) {
        isButton($0) && hasExactLabel($0, chatScopeLabels)
    }
    guard scopes.complete else { respond("find_unavailable", diagnostics: diagnostics, method: method) }
    if scopes.matches.isEmpty {
        diagnostics["find_stage"] = 2
        guard openNativeFind(root, app: app, window: window, pid: pid, excluding: excluding) else {
            respond("find_unavailable", diagnostics: diagnostics, method: method)
        }
        diagnostics["find_triggered"] = true
        diagnostics["find_stage"] = 3
        let deadline = min(Date().addingTimeInterval(2), commandDeadline)
        repeat {
            checkFocus()
            scopes = walk(root, within: min(0.6, max(0, deadline.timeIntervalSinceNow)), excluding: excluding, stayInDocument: true) {
                isButton($0) && hasExactLabel($0, chatScopeLabels)
            }
            if scopes.complete && scopes.matches.count == 1 { break }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline
    }
    guard scopes.complete, scopes.matches.count == 1 else { respond("find_unavailable", diagnostics: diagnostics, method: method) }
    diagnostics["chat_scope_found"] = true
    diagnostics["find_stage"] = 4
    checkFocus()
    guard AXUIElementPerformAction(scopes.matches[0], kAXPressAction as CFString) == .success else {
        respond("find_unavailable", diagnostics: diagnostics, method: method)
    }
    diagnostics["chat_scope_pressed"] = true
    diagnostics["find_stage"] = 5
    let fieldDeadline = min(Date().addingTimeInterval(4), commandDeadline)
    var input: AXUIElement?
    var findRoot = root
    var scannedNodes = -1
    var keyboardAttempted = false
    repeat {
        Thread.sleep(forTimeInterval: 0.1)
        checkFocus()
        guard Date() < fieldDeadline else { break }
        // Scope changes remount and auto-focus the native input. Prefer that
        // explicit control over traversing the entire growing transcript.
        if let focused = focusedChatField(app: app, window: window, thread: request.thread_id,
                                           excluding: excluding, until: min(Date().addingTimeInterval(0.4), fieldDeadline)) {
            input = focused.0
            findRoot = focused.1
            diagnostics["focused_find_field"] = true
            break
        }
        var searchRoots: [AXUIElement] = []
        var ancestor = scopes.matches[0]
        for _ in 0..<4 {
            guard let raw = attribute(ancestor, kAXParentAttribute as String),
                  CFGetTypeID(raw) == AXUIElementGetTypeID() else { break }
            ancestor = raw as! AXUIElement
            let role = stringAttribute(ancestor, kAXRoleAttribute as String)
            if role == "AXWebArea" || role == kAXWindowRole as String { break }
            searchRoots.append(ancestor)
        }
        searchRoots.append(findRoot)
        let scanDeadline = min(Date().addingTimeInterval(0.8), fieldDeadline)
        if let selected = toggleSelection(scopes.matches[0]) { diagnostics["chat_scope_selected"] = selected }
        else { diagnostics.removeValue(forKey: "chat_scope_selected") }
        let scopeSelected = diagnostics["chat_scope_selected"] as? Bool
        // Search the identified find bar before the full transcript. A local
        // complete scan can identify its one field even while history grows.
        for searchRoot in searchRoots {
            guard Date() < scanDeadline else { break }
            var fieldCount = 0, namedCount = 0, browserCount = 0
            let fields = walk(searchRoot, within: max(0, min(0.35, scanDeadline.timeIntervalSinceNow)), excluding: excluding, stayInDocument: true) { element in
                let role = stringAttribute(element, kAXRoleAttribute as String)
                guard [kAXTextFieldRole as String, "AXSearchField"].contains(role) else { return false }
                fieldCount += 1
                let labels = controlLabels(element)
                let placeholder = stringAttribute(element, "AXPlaceholderValue")
                let isChat = chatFindFieldSnapshot(role: role, labels: labels, placeholder: placeholder)
                if labelsMatch(labels, browserFindLabels) || labelsMatch([placeholder], browserFindPlaceholders) { browserCount += 1 }
                if isChat { namedCount += 1 }
                return isChat && (attribute(element, kAXEnabledAttribute as String) as? Bool) != false
                    && isVisible(element, window: window, viewportInset: 0)
            }
            // Preserve real scan evidence instead of an expired empty pass.
            if fields.complete || fields.visited > scannedNodes {
                scannedNodes = fields.visited
                diagnostics["search_candidates"] = fields.matches.count
                diagnostics["find_fields"] = fieldCount
                diagnostics["chat_named_fields"] = namedCount
                diagnostics["browser_named_fields"] = browserCount
                diagnostics["field_scan_complete"] = fields.complete
                diagnostics["field_read_errors"] = fields.readErrors
                diagnostics["field_nodes"] = fields.visited
            }
            if fields.complete && fields.matches.count == 1 && scopeSelected != false {
                input = fields.matches[0]
                break
            }
        }
        if input != nil { break }
        if !keyboardAttempted && diagnostics["field_scan_complete"] as? Bool == true {
            keyboardAttempted = true
            diagnostics["scope_keyboard_attempted"] = true
            checkFocus()
            let refreshed = walk(findRoot, within: max(0, min(0.6, fieldDeadline.timeIntervalSinceNow)),
                                 excluding: excluding, stayInDocument: true) { isButton($0) && hasExactLabel($0, chatScopeLabels) }
            if refreshed.complete && refreshed.matches.count == 1 {
                scopes = refreshed
                diagnostics["scope_keyboard_activated"] = activateChatScopeWithKeyboard(
                    scopes.matches[0], app: app, window: window, pid: pid)
            } else { diagnostics["scope_keyboard_activated"] = false }
        }
    } while Date() < fieldDeadline
    guard let input else { respond("find_unavailable", diagnostics: diagnostics, method: method) }
    diagnostics["find_input_found"] = true
    diagnostics["find_stage"] = 6
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(input, kAXValueAttribute as CFString, &settable) == .success,
          settable.boolValue else { respond("find_unavailable", diagnostics: diagnostics, method: method) }
    checkFocus()
    diagnostics["find_stage"] = 7
    guard AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, "" as CFString) == .success else {
        respond("find_unavailable", diagnostics: diagnostics, method: method)
    }
    Thread.sleep(forTimeInterval: 0.2)
    checkFocus()
    diagnostics["find_stage"] = 8
    guard chatFindField(input), AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, query as CFString) == .success,
          stringAttribute(input, kAXValueAttribute as String) == query else {
        respond("find_unavailable", diagnostics: diagnostics, method: method)
    }
    diagnostics["query_written"] = true
    diagnostics["find_stage"] = 9
    // The native search debounces for 150ms, loads virtualized history, and
    // scrolls its active match. Do not send Return: that advances to next match.
    let deadline = min(Date().addingTimeInterval(3), commandDeadline)
    var stableUnique = 0
    repeat {
        Thread.sleep(forTimeInterval: 0.2)
        checkFocus()
        if chatFindField(input), stringAttribute(input, kAXValueAttribute as String) == query,
           hasUniqueChatResult(input, excluding: excluding, until: deadline) { stableUnique += 1 }
        else { stableUnique = 0 }
        if stableUnique >= 2 && visibleOriginal(findRoot, request: request, excluding: excluding,
                                               app: app, focusedWindow: window, pid: pid, until: deadline) {
            respond("located", verified: true, method: method)
        }
        if contextual && stableUnique >= 2
            && revealShortSource(findRoot, request: request, query: query, app: app,
                                 window: window, pid: pid, excluding: excluding, until: deadline) {
            respond("located", verified: true, method: method)
        }
    } while Date() < deadline
    if contextual && stableUnique >= 2 { respond("context_revealed", diagnostics: diagnostics, method: method) }
    respond("search_requested", diagnostics: diagnostics, method: method)
}

func navigate(_ request: NavigationRequest) -> Never {
    guard AXIsProcessTrusted() else { respond("accessibility_required") }
    let commandDeadline = Date().addingTimeInterval(15)
    guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex").first
    else { respond("app_not_running") }
    if request.scope == "current_window" {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == running.processIdentifier
        else { respond("focus_changed") }
    } else {
        guard let url = URL(string: "codex://threads/\(request.thread_id)"), NSWorkspace.shared.open(url)
        else { respond("navigation_failed") }
        running.activate(options: [.activateAllWindows])
    }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 0.2)
    guard let rawWindow = attribute(app, kAXFocusedWindowAttribute as String),
          CFGetTypeID(rawWindow) == AXUIElementGetTypeID() else { respond("chat_unverified") }
    let focusedWindow = rawWindow as! AXUIElement
    guard sameFocusedWindow(app, window: focusedWindow, pid: running.processIdentifier) else { respond("focus_changed") }
    // Electron documents this opt-in for third-party assistive software. It
    // expands the web accessibility tree; it grants no system permission.
    // Reached only through the user's explicit node click, never self-tests.
    let manualAccessibility = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
    if manualAccessibility { Thread.sleep(forTimeInterval: 0.15) }
    let excluded = Set(request.excluded_origins ?? Array(defaultExcludedOrigins))
    var surface: ChatSurface?
    var diagnostics: [String: Any] = [:]
    let deadline = min(Date().addingTimeInterval(5), commandDeadline)
    repeat {
        if request.scope == "current_window" && !sameFocusedWindow(app, window: focusedWindow, pid: running.processIdentifier) {
            respond("focus_changed")
        }
        surface = nativeChatRoot(app, window: focusedWindow, request: request, excluding: excluded,
                              until: deadline, diagnostics: &diagnostics)
        diagnostics["manual_accessibility"] = manualAccessibility
        if surface == nil { Thread.sleep(forTimeInterval: 0.15) }
    } while surface == nil && Date() < deadline
    guard let surface else { respond(diagnostics["window_conflict"] as? Bool == true ? "chat_mismatch" : "chat_unverified", diagnostics: diagnostics) }
    let root = surface.root
    if surface.useFind {
        findInCurrentChat(root, request: request, excluding: excluded, app: app,
                          window: focusedWindow, pid: running.processIdentifier, until: commandDeadline)
    }
    let scan = walk(root, within: max(0, min(2, commandDeadline.timeIntervalSinceNow)), excluding: excluded, stayInDocument: true) { navigationPosition($0) == request.user_position }
    guard scan.complete else { respond("navigation_failed") }
    guard !scan.matches.isEmpty else { respond("rail_unavailable") }
    guard scan.matches.count == 1 else { respond("ambiguous_target") }
    guard sameFocusedWindow(app, window: focusedWindow, pid: running.processIdentifier) else { respond("focus_changed") }
    guard AXUIElementPerformAction(scan.matches[0], kAXPressAction as CFString) == .success
    else { respond("navigation_failed") }
    // The native rail reveals virtualized history asynchronously.
    let revealDeadline = min(Date().addingTimeInterval(4), commandDeadline)
    repeat {
        guard sameFocusedWindow(app, window: focusedWindow, pid: running.processIdentifier) else { respond("focus_changed") }
        if visibleOriginal(root, request: request, excluding: excluded, app: app,
                           focusedWindow: focusedWindow, pid: running.processIdentifier, until: revealDeadline) { respond("located", verified: true) }
        Thread.sleep(forTimeInterval: 0.2)
    } while Date() < revealDeadline
    respond("turn_revealed")
}

let arguments = Set(CommandLine.arguments.dropFirst())
if arguments == ["--test-surface-selection"] {
    let target = "11111111-1111-4111-8111-111111111111"
    let other = "22222222-2222-4222-8222-222222222222"
    let native = SurfaceSnapshot(url: "https://chatgpt.com/local/\(target)", document: "")
    let map = SurfaceSnapshot(url: "http://127.0.0.1:18766/\(target)/live-panel.html", document: "")
    let choose: ([SurfaceSnapshot], Bool) -> Int? = { selectSurface($0, thread: target, excluding: defaultExcludedOrigins, complete: $1) }
    precondition(choose([map, native], true) == 1)
    precondition(choose([SurfaceSnapshot(url: "app://-/", document: "app://-/local/\(target)")], true) == 0)
    precondition(choose([SurfaceSnapshot(url: "app://-/local/\(other)", document: "")], true) == nil)
    precondition(choose([SurfaceSnapshot(url: "app://-/", document: "")], true) == nil)
    precondition(choose([SurfaceSnapshot(url: native.url, document: "", focused: false)], true) == nil)
    precondition(choose([native, native], true) == nil)
    precondition(choose([native], false) == nil)
    precondition(choose([SurfaceSnapshot(url: "", document: map.url)], true) == nil)
    precondition(choose([SurfaceSnapshot(url: "https://example.test/?mention=\(target)", document: "")], true) == nil)
    precondition(choose([SurfaceSnapshot(url: "app://-/local/\(other)#\(target)", document: "")], true) == nil)
    precondition(choose([SurfaceSnapshot(url: "app://-/local/prefix-\(target)", document: "")], true) == nil)
    precondition(choose([SurfaceSnapshot(url: "app://-/local/\(other)", document: "app://-/local/\(target)")], true) == nil)
    let generic = SurfaceSnapshot(url: "app://-/", document: "")
    precondition(selectSurface([generic], thread: target, excluding: defaultExcludedOrigins,
                              complete: true, windowMatchesThread: true) == 0)
    precondition(selectSurface([generic, generic], thread: target, excluding: defaultExcludedOrigins,
                              complete: true, windowMatchesThread: true) == nil)
    let current = SurfaceSnapshot(url: "app://-/", document: "", targetButtons: 1, railButtons: 8, railScanComplete: true)
    let chooseCurrent: ([SurfaceSnapshot], Bool, Bool) -> Int? = {
        selectCurrentSurface($0, thread: target, excluding: defaultExcludedOrigins, window: generic,
                             complete: $1, appIsFrontmost: $2)
    }
    precondition(chooseCurrent([map, current], true, true) == 1)
    precondition(chooseCurrent([current], true, false) == nil)
    precondition(chooseCurrent([current, current], true, true) == nil)
    precondition(chooseCurrent([current, SurfaceSnapshot(url: "app://-/", document: "", railScanComplete: false)], true, true) == nil)
    precondition(chooseCurrent([current], false, true) == nil)
    precondition(chooseCurrent([SurfaceSnapshot(url: current.url, document: "", targetButtons: 2, railButtons: 8, railScanComplete: true)], true, true) == nil)
    precondition(chooseCurrent([SurfaceSnapshot(url: "app://-/local/\(other)", document: "", targetButtons: 1, railButtons: 8, railScanComplete: true)], true, true) == nil)
    precondition(selectCurrentSurface([current], thread: target, excluding: defaultExcludedOrigins,
                                     window: SurfaceSnapshot(url: "app://-/local/\(other)", document: ""),
                                     complete: true, appIsFrontmost: true) == nil)
    precondition(railPosition("跳转到用户消息 12，已收藏此轮对话") == 12)
    precondition(railPosition("跳至使用者訊息 12") == 12)
    precondition(railPosition("Jump to user message 12") == 12)
    precondition(railPosition("用户消息 1 of 20") == nil)
    let chooseSearch: ([SurfaceSnapshot], Bool) -> Int? = {
        selectSearchSurface($0, thread: target, excluding: defaultExcludedOrigins, window: generic, complete: $1)
    }
    let searchOnly = SurfaceSnapshot(url: "app://-/index.html?initialRoute=local", document: "", railScanComplete: true)
    precondition(chooseSearch([map, searchOnly], true) == 1)
    precondition(chooseSearch([searchOnly], false) == nil)
    precondition(chooseSearch([searchOnly, searchOnly], true) == nil)
    precondition(chooseSearch([generic], true) == nil)
    precondition(chooseSearch([SurfaceSnapshot(url: "", document: "", railScanComplete: true)], true) == nil)
    precondition(chooseSearch([SurfaceSnapshot(url: "https://chatgpt.com/", document: "", railScanComplete: true)], true) == nil)
    precondition(chooseSearch([SurfaceSnapshot(url: "app://-/local/\(other)", document: "", railScanComplete: true)], true) == nil)
    precondition(uniqueSearchCount("1 / 1 results"))
    precondition(uniqueSearchCount("1 个结果，共 1 个结果"))
    precondition(uniqueSearchCount("1 / 1 個結果"))
    precondition(!uniqueSearchCount("1 / 2 results"))
    precondition(!uniqueSearchCount("1 / 1+ results"))
    precondition(!uniqueSearchCount("some text 1 / 1 results"))
    // Real Chromium controls may expose the label on an associated static
    // text node, or expose only the exact placeholder during a scope change.
    precondition(chatFindFieldSnapshot(role: "AXTextField", labels: ["", "在聊天中查找"], placeholder: ""))
    precondition(chatFindFieldSnapshot(role: "AXTextField", labels: [], placeholder: "搜索聊天…"))
    precondition(chatFindFieldSnapshot(role: "AXTextField", labels: [], placeholder: "Search chat…"))
    precondition(chatFindFieldSnapshot(role: "AXSearchField", labels: ["Find in chat"], placeholder: ""))
    precondition(!chatFindFieldSnapshot(role: "AXTextArea", labels: ["Work with Codex"], placeholder: "Search chat…"))
    precondition(!chatFindFieldSnapshot(role: "AXTextField", labels: ["Find in browser page"], placeholder: "Search browser page…"))
    precondition(!chatFindFieldSnapshot(role: "AXTextField", labels: ["Find in file"], placeholder: "Find in file…"))
    precondition(!chatFindFieldSnapshot(role: "AXTextField", labels: ["Find in chat settings"], placeholder: ""))
    precondition(!chatFindFieldSnapshot(role: "AXTextField", labels: ["在页面中查找"], placeholder: "在页面中查找…"))
    precondition(labelsMatch(["在页面中查找"], browserFindLabels))
    precondition(contextTextMatches("已写好并编译成", query: "已写好并编译成实验版本，定位过程不调用模型"))
    precondition(!contextTextMatches("实验版本", query: "已写好并编译成实验版本，定位过程不调用模型"))
    precondition(!contextTextMatches("继续", query: "继续推进短消息定位"))
    precondition(focusedFindCandidate(fieldMatches: true, windowMatches: true, surface: generic,
                                      thread: target, excluding: defaultExcludedOrigins))
    precondition(!focusedFindCandidate(fieldMatches: true, windowMatches: false, surface: generic,
                                       thread: target, excluding: defaultExcludedOrigins))
    precondition(!focusedFindCandidate(fieldMatches: false, windowMatches: true, surface: generic,
                                       thread: target, excluding: defaultExcludedOrigins))
    precondition(!focusedFindCandidate(fieldMatches: true, windowMatches: true, surface: map,
                                       thread: target, excluding: defaultExcludedOrigins))
    precondition(!focusedFindCandidate(fieldMatches: true, windowMatches: true,
                                       surface: SurfaceSnapshot(url: "https://chatgpt.com/", document: ""),
                                       thread: target, excluding: defaultExcludedOrigins))
    precondition(!focusedFindCandidate(fieldMatches: true, windowMatches: true,
                                       surface: SurfaceSnapshot(url: "app://-/local/\(other)", document: ""),
                                       thread: target, excluding: defaultExcludedOrigins))
    respond("self_test_passed")
}
if arguments.contains("--validate-request") || arguments.contains("--navigate") {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 8192,
          let request = try? JSONDecoder().decode(NavigationRequest.self, from: data),
          (try? request.validate()) != nil else { respond("invalid_request") }
    if arguments == ["--validate-request"] { respond("valid_request") }
    guard arguments == ["--navigate"] else { respond("invalid_request") }
    navigate(request)
}

// Only reached when the user manually opens the built app for initial setup.
guard arguments.isEmpty else { respond("invalid_request") }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let alert = NSAlert()
alert.messageText = "Understanding Map 本机定位辅助程序"
alert.informativeText = "此程序由你点击地图节点触发，通过系统辅助功能操作 Codex 原生进度导航，不调用 AI。\n\n请在系统设置 → 隐私与安全性 → 辅助功能中允许此程序，然后手动运行 start-native-navigation.command。原生定位仍需在你的电脑上验证。"
alert.addButton(withTitle: "显示辅助功能授权提示")
alert.addButton(withTitle: "退出")
if alert.runModal() == .alertFirstButtonReturn {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
}
