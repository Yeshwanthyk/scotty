// Drive one running app through the macOS accessibility tree, the way a person would: find an
// element by its accessibility identifier (a Rune element's `.key(...)`), press it, type into the
// app, and find its window for a screenshot. Needs the Accessibility permission for the app this
// runs under. Usage: ax <pid> tree | has <id> | wait <id> [seconds] | gone <id> [seconds]
//                    | press <id> | type <text> | key <combo> | window | front | place | covered
import AppKit
import ApplicationServices

func fail(_ why: String) -> Never {
  FileHandle.standardError.write((why + "\n").data(using: .utf8)!)
  exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3, let pid = pid_t(args[1]) else {
  fail("usage: ax <pid> tree|has|wait|gone|press|type|key|window|front|place|covered [arg]")
}
guard AXIsProcessTrusted() else { fail("ax: no Accessibility permission for this process's app") }
let app = AXUIElementCreateApplication(pid)

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}

func text(_ el: AXUIElement, _ name: String) -> String {
  (attr(el, name) as? String) ?? ""
}

func frame(_ el: AXUIElement) -> String {
  var point = CGPoint.zero
  var size = CGSize.zero
  if let p = attr(el, kAXPositionAttribute) { AXValueGetValue(p as! AXValue, .cgPoint, &point) }
  if let s = attr(el, kAXSizeAttribute) { AXValueGetValue(s as! AXValue, .cgSize, &size) }
  return "\(Int(point.x)),\(Int(point.y)) \(Int(size.width))x\(Int(size.height))"
}

func walk(_ el: AXUIElement, _ depth: Int, _ visit: (AXUIElement, Int) -> Bool) -> Bool {
  if visit(el, depth) { return true }
  for child in (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
    if walk(child, depth + 1, visit) { return true }
  }
  return false
}

func find(_ id: String) -> AXUIElement? {
  var hit: AXUIElement?
  _ = walk(app, 0) { el, _ in
    if text(el, kAXIdentifierAttribute) == id { hit = el; return true }
    return false
  }
  return hit
}

func until(_ seconds: Double, _ check: () -> Bool) -> Bool {
  let end = Date().addingTimeInterval(seconds)
  while Date() < end {
    if check() { return true }
    usleep(100_000)
  }
  return check()
}

// Virtual key codes for the keys a drive names.
let codes: [String: CGKeyCode] = [
  "return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53, "left": 123, "right": 124,
  "down": 125, "up": 126, "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8,
  "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
  "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "]": 30, "o": 31,
  "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, ",": 43, "\\": 42, "n": 45,
  "m": 46,
]

func post(_ code: CGKeyCode, _ flags: CGEventFlags, unicode: String? = nil) {
  for down in [true, false] {
    guard let ev = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { continue }
    ev.flags = flags
    if let u = unicode {
      let chars = Array(u.utf16)
      ev.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
    }
    ev.postToPid(pid)
    usleep(12_000)
  }
}

let verb = args[2]
let arg = args.count > 3 ? args[3] : ""
switch verb {
case "tree":
  _ = walk(app, 0) { el, depth in
    let id = text(el, kAXIdentifierAttribute)
    let name = [text(el, kAXTitleAttribute), text(el, kAXDescriptionAttribute)].first { !$0.isEmpty } ?? ""
    if !id.isEmpty || !name.isEmpty {
      print("\(String(repeating: "  ", count: depth))\(text(el, kAXRoleAttribute)) \(id) \"\(name)\" @\(frame(el))")
    }
    return false
  }
case "has":
  exit(find(arg) == nil ? 1 : 0)
case "wait":
  let seconds = args.count > 4 ? Double(args[4]) ?? 20 : 20
  if !until(seconds, { find(arg) != nil }) { fail("ax: \(arg) did not appear in \(Int(seconds)) s") }
case "gone":
  let seconds = args.count > 4 ? Double(args[4]) ?? 20 : 20
  if !until(seconds, { find(arg) == nil }) { fail("ax: \(arg) still shows after \(Int(seconds)) s") }
case "press":
  guard let el = find(arg) else { fail("ax: no element \(arg)") }
  let result = AXUIElementPerformAction(el, kAXPressAction as CFString)
  if result != .success { fail("ax: press \(arg) refused (\(result.rawValue))") }
case "type":
  for ch in arg {
    if ch == "\n" { post(codes["return"]!, []) } else { post(0, [], unicode: String(ch)) }
  }
case "key":
  // cmd+shift+] style: modifiers then one key.
  var flags: CGEventFlags = []
  var key = ""
  for part in arg.lowercased().split(separator: "+").map(String.init) {
    switch part {
    case "cmd": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "opt": flags.insert(.maskAlternate)
    case "ctrl": flags.insert(.maskControl)
    default: key = part
    }
  }
  guard let code = codes[key] else { fail("ax: unknown key \(key)") }
  post(code, flags)
case "window":
  // The app's largest on-screen window: its CGWindowID and bounds, for screencapture -l.
  let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  let mine = list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
  let area = { (w: [String: Any]) -> Double in
    let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
    return (b["Width"] ?? 0) * (b["Height"] ?? 0)
  }
  guard let win = mine.max(by: { area($0) < area($1) }), let id = win[kCGWindowNumber as String] as? Int else {
    fail("ax: pid \(pid) has no window on screen")
  }
  let b = win[kCGWindowBounds as String] as? [String: Double] ?? [:]
  print("\(id) \(Int(b["X"] ?? 0)) \(Int(b["Y"] ?? 0)) \(Int(b["Width"] ?? 0)) \(Int(b["Height"] ?? 0))")
case "front":
  guard let running = NSRunningApplication(processIdentifier: pid) else { fail("ax: no process \(pid)") }
  running.activate()
  if !until(5, { NSWorkspace.shared.frontmostApplication?.processIdentifier == pid }) { fail("ax: pid \(pid) did not come to the front") }
case "place":
  // Move the app's window to the top left of a display where no other app's window overlaps it,
  // without taking focus from the person at the Mac. Rune builds no frame for a covered window,
  // so a drive needs it uncovered. Fails when every display is taken.
  guard let win = (attr(app, kAXWindowsAttribute) as? [AXUIElement])?.first,
    let s = attr(win, kAXSizeAttribute) else { fail("ax: pid \(pid) has no window") }
  var size = CGSize.zero
  AXValueGetValue(s as! AXValue, .cgSize, &size)
  let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  let others = list.filter { ($0[kCGWindowLayer as String] as? Int) == 0 && ($0[kCGWindowOwnerPID as String] as? Int32) != pid }.map { w -> CGRect in
    let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
    return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
  }
  let primary = NSScreen.screens.first?.frame.height ?? 0
  // visibleFrame is bottom-left based; window positions are top-left based from the primary display.
  let spots = NSScreen.screens.map { screen -> CGRect in
    let v = screen.visibleFrame
    return CGRect(x: v.minX, y: primary - v.maxY, width: v.width, height: v.height)
  }
  guard let spot = spots.first(where: { area in
    let r = CGRect(origin: area.origin, size: size)
    return area.contains(r) && !others.contains { $0.intersects(r) }
  }) else { fail("ax: no display has room for a \(Int(size.width))x\(Int(size.height)) window clear of other apps") }
  var origin = spot.origin
  guard let value = AXValueCreate(.cgPoint, &origin),
    AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, value) == .success
  else { fail("ax: could not move the window") }
  print("\(Int(origin.x)) \(Int(origin.y))")
case "covered":
  // Other apps' windows in front of this app's largest window, one per line; exit 1 when any.
  let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  let rect = { (w: [String: Any]) -> CGRect in
    let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
    return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
  }
  let normal = list.filter { ($0[kCGWindowLayer as String] as? Int) == 0 }
  let mine = normal.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }
  guard let win = mine.max(by: { rect($0).width * rect($0).height < rect($1).width * rect($1).height }),
    let at = normal.firstIndex(where: { ($0[kCGWindowNumber as String] as? Int) == (win[kCGWindowNumber as String] as? Int) })
  else { fail("ax: pid \(pid) has no window on screen") }
  // The list runs front to back.
  let above = normal[..<at].filter { ($0[kCGWindowOwnerPID as String] as? Int32) != pid && rect($0).intersects(rect(win)) }
  for w in above { print("\(w[kCGWindowOwnerName as String] ?? "?") \(rect(w))") }
  exit(above.isEmpty ? 0 : 1)
default:
  fail("ax: unknown verb \(verb)")
}
