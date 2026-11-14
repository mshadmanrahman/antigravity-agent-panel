import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import WebKit

private let hudPort: UInt16 = 47812
private let collapsedHeight: CGFloat = 66
private let expandedHeight: CGFloat = 290
private let miniWidth: CGFloat = 112
private let miniHeight: CGFloat = 64
private let gapAboveChatbox: CGFloat = 12

final class HudPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private var panel: HudPanel!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var serverProcess: Process?
    private var pollTimer: Timer?

    private var isExpanded = false
    private var isMinimized = false
    private var manuallyHidden = false
    private var keepVisibleEverywhere = UserDefaults.standard.bool(forKey: "keepVisibleEverywhere")
    private var isDragging = false

    private var cachedPid: pid_t = 0
    private var cachedChatCard: AXUIElement?
    private var lastAxSearch = Date.distantPast
    private var lastReportedModel = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        startBackendIfNeeded()
        setupStatusItem()
        setupPanel()
        observeApps()

        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.18, repeats: true) { [weak self] _ in
            self?.syncWindowPosition()
        }
        syncWindowPosition()
    }

    func applicationWillTerminate(_ notification: Notification) {
        pollTimer?.invalidate()
        if let proc = serverProcess, proc.isRunning {
            proc.terminate()
        }
    }

    // MARK: - Backend discovery & lifecycle

    private func resolveNodeBinary() -> String {
        let candidates = ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            return c
        }
        return "/usr/bin/env"
    }

    private func resolveMainMjs() -> String? {
        if let env = ProcessInfo.processInfo.environment["AGENT_PANEL_MAIN"],
           FileManager.default.fileExists(atPath: env) {
            return env
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/.gemini/config/plugins/antigravity-agent-panel/sidecars/agent_panel/main.mjs",
            "\(home)/VibeCoding/_opensource/antigravity-agent-panel/sidecars/agent_panel/main.mjs",
        ]
        for c in candidates where FileManager.default.fileExists(atPath: c) {
            return c
        }
        return nil
    }

    private func isPortReachable(_ port: UInt16) -> Bool {
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/panel") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 0.5
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                ok = true
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 0.7)
        return ok
    }

    private func startBackendIfNeeded() {
        if isPortReachable(hudPort) { return }
        guard let mainMjs = resolveMainMjs() else { return }

        let proc = Process()
        let node = resolveNodeBinary()
        if node.hasSuffix("/env") {
            proc.executableURL = URL(fileURLWithPath: node)
            proc.arguments = ["node", mainMjs]
        } else {
            proc.executableURL = URL(fileURLWithPath: node)
            proc.arguments = [mainMjs]
        }
        var env = ProcessInfo.processInfo.environment
        for key in [
            "ANTIGRAVITY_LS_ADDRESS",
            "ANTIGRAVITY_CSRF_TOKEN",
            "ANTIGRAVITY_LS_VERSION",
            "ANTIGRAVITY_CONVERSATION_ID",
            "ANTIGRAVITY_TRAJECTORY_ID",
            "ANTIGRAVITY_PROJECT_ID"
        ] {
            env.removeValue(forKey: key)
        }
        env["AGENT_PANEL_STANDALONE"] = "1"
        env["PORT"] = "\(hudPort)"
        proc.environment = env
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            serverProcess = proc
        } catch {
            NSLog("[ElementalHUD] Failed to spawn node backend: \(error)")
        }
    }

    // MARK: - Status bar menu

    private lazy var statusIcon: NSImage = makeStatusIcon()

    private func makeStatusIcon() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let img = NSImage(size: size, flipped: true) { _ in
            NSColor.labelColor.setFill()
            let rects: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [
                (14, 2, 1, 3),   // sparkle vertical
                (13, 3, 3, 1),   // sparkle horizontal
                (7, 3, 2, 1),    // sprite tip
                (5, 4, 6, 1),    // crown
                (4, 5, 8, 2),    // upper head
                (3, 7, 10, 5),   // torso
                (1, 9, 2, 2),    // left arm
                (13, 9, 2, 2),   // right arm
                (4, 12, 8, 1),   // lower body
                (5, 13, 2, 2),   // left foot
                (9, 13, 2, 2)    // right foot
            ]
            for (x, y, w, h) in rects {
                NSRect(x: x, y: y, width: w, height: h).fill()
            }
            if let ctx = NSGraphicsContext.current?.cgContext {
                ctx.clear(CGRect(x: 5, y: 8, width: 1.5, height: 2.5))
                ctx.clear(CGRect(x: 9.5, y: 8, width: 1.5, height: 2.5))
            }
            return true
        }
        img.isTemplate = true
        return img
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        updateStatusButton()
        rebuildMenu()
    }

    private func updateStatusButton() {
        if let btn = statusItem?.button {
            let isHiddenOrMini = manuallyHidden || isMinimized
            btn.title = ""
            btn.image = statusIcon
            btn.imagePosition = .imageOnly
            btn.appearsDisabled = isHiddenOrMini
            btn.toolTip = isHiddenOrMini ? "Elemental Agent minimized/hidden (click to resume)" : "Elemental Agent"
        }
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        let isHiddenOrMini = manuallyHidden || isMinimized
        let toggleItem = NSMenuItem(
            title: isHiddenOrMini ? "Resume Agent Bar" : "Hide Agent Bar",
            action: #selector(toggleVisible),
            keyEquivalent: ""
        )
        toggleItem.target = self
        menu.addItem(toggleItem)

        let pinItem = NSMenuItem(
            title: "Keep Visible Outside Antigravity",
            action: #selector(toggleKeepVisible),
            keyEquivalent: ""
        )
        pinItem.state = keepVisibleEverywhere ? .on : .off
        pinItem.target = self
        menu.addItem(pinItem)

        let resetItem = NSMenuItem(
            title: "Snap to Chatbox Width",
            action: #selector(resetOffset),
            keyEquivalent: ""
        )
        resetItem.target = self
        menu.addItem(resetItem)

        let openItem = NSMenuItem(
            title: "Open Full Panel in Browser",
            action: #selector(openFullInBrowser),
            keyEquivalent: ""
        )
        openItem.target = self
        menu.addItem(openItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Quit Elemental Agent", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    @objc private func toggleVisible() {
        if manuallyHidden || isMinimized {
            manuallyHidden = false
            isMinimized = false
            webView?.evaluateJavaScript(
                "document.getElementById('hud-mini')?.classList.add('hidden'); document.getElementById('hud-bar')?.classList.remove('hidden');",
                completionHandler: nil
            )
        } else {
            manuallyHidden = true
        }
        updateStatusButton()
        rebuildMenu()
        syncWindowPosition()
    }

    @objc private func toggleKeepVisible() {
        keepVisibleEverywhere.toggle()
        UserDefaults.standard.set(keepVisibleEverywhere, forKey: "keepVisibleEverywhere")
        rebuildMenu()
        syncWindowPosition()
    }

    @objc private func resetOffset() {
        UserDefaults.standard.removeObject(forKey: "customDx")
        UserDefaults.standard.removeObject(forKey: "customDy")
        cachedChatCard = nil
        manuallyHidden = false
        updateStatusButton()
        rebuildMenu()
        syncWindowPosition()
    }

    @objc private func openFullInBrowser() {
        if let url = URL(string: "http://127.0.0.1:\(hudPort)/") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

    // MARK: - Panel and WKWebView

    private func setupPanel() {
        let initial = NSRect(x: 200, y: 200, width: 768, height: collapsedHeight)
        panel = HudPanel(
            contentRect: initial,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.hidesOnDeactivate = false

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "hud")
        webView = WKWebView(frame: initial, configuration: config)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        panel.contentView = webView

        loadHudWhenReady(retriesLeft: 20)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        lastReportedModel = ""
        syncSelectedModelFromChatCard()
    }

    private func loadHudWhenReady(retriesLeft: Int) {
        if isPortReachable(hudPort) || retriesLeft <= 0 {
            if let url = URL(string: "http://127.0.0.1:\(hudPort)/hud") {
                webView.load(URLRequest(url: url))
            }
            return
        }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self else { return }
            let ready = self.isPortReachable(hudPort)
            DispatchQueue.main.async {
                if ready {
                    if let url = URL(string: "http://127.0.0.1:\(hudPort)/hud") {
                        self.webView.load(URLRequest(url: url))
                    }
                } else {
                    self.loadHudWhenReady(retriesLeft: retriesLeft - 1)
                }
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }

        if type == "expand" {
            isExpanded = (body["expanded"] as? Bool) ?? false
            let targetHeight = isExpanded ? expandedHeight : collapsedHeight
            var frame = panel.frame
            frame.size.height = targetHeight
            panel.setFrame(frame, display: true, animate: true)
            return
        }

        if type == "minimize" {
            isExpanded = false
            isMinimized = (body["minimized"] as? Bool) ?? true
            updateStatusButton()
            rebuildMenu()
            syncWindowPosition()
            return
        }

        if type == "hide" {
            isExpanded = false
            manuallyHidden = true
            updateStatusButton()
            rebuildMenu()
            panel.orderOut(nil)
            return
        }

        if type == "startDrag", let event = NSApp.currentEvent {
            isDragging = true
            let base = defaultAnchorFrame(forHeight: panel.frame.height)
            panel.performDrag(with: event)
            isDragging = false
            if let anchor = base {
                let dx = panel.frame.origin.x - anchor.origin.x
                let dy = panel.frame.origin.y - anchor.origin.y
                UserDefaults.standard.set(Double(dx), forKey: "customDx")
                UserDefaults.standard.set(Double(dy), forKey: "customDy")
            }
        }
    }

    // MARK: - Antigravity window & chatbox AX tracking

    private func observeApps() {
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(syncWindowPosition),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )
    }

    private func axRect(of el: AXUIElement) -> CGRect? {
        var posRef: AnyObject?
        var sizeRef: AnyObject?
        guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let p = posRef, let s = sizeRef else {
            return nil
        }
        var pt = CGPoint.zero
        var sz = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &pt),
              AXValueGetValue(s as! AXValue, .cgSize, &sz) else {
            return nil
        }
        return CGRect(origin: pt, size: sz)
    }

    private func findMessageInputCard(in axWin: AXUIElement) -> AXUIElement? {
        func findInput(_ el: AXUIElement, depth: Int) -> AXUIElement? {
            if depth > 40 { return nil }
            var roleRef: AnyObject?
            AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleRef)
            if (roleRef as? String) == "AXTextArea" {
                var descRef: AnyObject?
                AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &descRef)
                if (descRef as? String) == "Message input" {
                    return el
                }
            }
            var kidsRef: AnyObject?
            AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kidsRef)
            if let kids = kidsRef as? [AXUIElement] {
                for k in kids {
                    if let hit = findInput(k, depth: depth + 1) { return hit }
                }
            }
            return nil
        }

        guard let inputEl = findInput(axWin, depth: 0),
              let inputRect = axRect(of: inputEl),
              inputRect.width > 240 else {
            return nil
        }

        // Walk ancestors up to the rounded chatbox card wrapper (~10px wider than textarea).
        var cur = inputEl
        var bestCard = inputEl
        for _ in 0..<7 {
            var parRef: AnyObject?
            guard AXUIElementCopyAttributeValue(cur, kAXParentAttribute as CFString, &parRef) == .success,
                  let par = parRef else { break }
            let parEl = par as! AXUIElement
            if let r = axRect(of: parEl),
               r.width >= inputRect.width,
               r.width <= inputRect.width + 24,
               r.height >= inputRect.height + 24,
               r.height < 520 {
                bestCard = parEl
            }
            cur = parEl
        }
        return bestCard
    }

    private func syncSelectedModelFromChatCard() {
        guard let card = cachedChatCard else { return }
        var kidsRef: AnyObject?
        guard AXUIElementCopyAttributeValue(card, kAXChildrenAttribute as CFString, &kidsRef) == .success,
              let kids = kidsRef as? [AXUIElement] else { return }
        for k in kids {
            var roleRef: AnyObject?
            AXUIElementCopyAttributeValue(k, kAXRoleAttribute as CFString, &roleRef)
            guard (roleRef as? String) == "AXPopUpButton" else { continue }
            var descRef: AnyObject?
            AXUIElementCopyAttributeValue(k, kAXDescriptionAttribute as CFString, &descRef)
            let desc = descRef as? String ?? ""
            let prefix = "Select model, current: "
            if desc.hasPrefix(prefix) {
                let modelName = String(desc.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
                if !modelName.isEmpty && modelName != lastReportedModel {
                    lastReportedModel = modelName
                    if let data = try? JSONSerialization.data(withJSONObject: [modelName]),
                       let arrJson = String(data: data, encoding: .utf8),
                       let inner = arrJson.dropFirst().dropLast() as Substring? {
                        webView?.evaluateJavaScript("window.__apSetSelectedModel && window.__apSetSelectedModel(\(inner));", completionHandler: nil)
                    }
                }
                return
            }
        }
    }

    private func liveChatCardCGRect(winCGRect: CGRect, app: NSRunningApplication?) -> CGRect? {
        guard let app else { return nil }
        if app.processIdentifier != cachedPid {
            cachedPid = app.processIdentifier
            cachedChatCard = nil
            let axApp = AXUIElementCreateApplication(cachedPid)
            AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        }

        if let card = cachedChatCard,
           let r = axRect(of: card),
           r.width >= 320,
           r.height >= 40,
           r.origin.x >= winCGRect.minX - 10,
           r.maxX <= winCGRect.maxX + 10 {
            return r
        }

        let now = Date()
        if now.timeIntervalSince(lastAxSearch) < 0.7 { return nil }
        lastAxSearch = now
        cachedChatCard = nil

        let axApp = AXUIElementCreateApplication(cachedPid)
        AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        var winsRef: AnyObject?
        AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winsRef)
        let wins = (winsRef as? [AXUIElement]) ?? []
        for w in wins {
            if let card = findMessageInputCard(in: w), let r = axRect(of: card) {
                cachedChatCard = card
                return r
            }
        }
        return nil
    }

    private func antigravityInfo() -> (app: NSRunningApplication?, cgRect: CGRect, appKitRect: NSRect)? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              !NSScreen.screens.isEmpty else {
            return nil
        }

        var bestCG: CGRect?
        var bestArea: CGFloat = 0
        var bestPid: pid_t = 0

        for w in list {
            let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
            let layer = (w[kCGWindowLayer as String] as? Int) ?? -1
            guard layer == 0, owner.localizedCaseInsensitiveContains("Antigravity") else { continue }
            guard let boundsDict = w[kCGWindowBounds as String] as? [String: Any],
                  let cgRect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { continue }
            if cgRect.width < 320 || cgRect.height < 240 { continue }
            let area = cgRect.width * cgRect.height
            if area > bestArea {
                bestArea = area
                bestCG = cgRect
                if let pidNum = w[kCGWindowOwnerPID as String] as? pid_t {
                    bestPid = pidNum
                }
            }
        }

        guard let cg = bestCG, let primary = NSScreen.screens.first else { return nil }
        let pH = primary.frame.height
        let appKit = NSRect(x: cg.origin.x, y: pH - (cg.origin.y + cg.height), width: cg.width, height: cg.height)
        let app = bestPid > 0 ? NSRunningApplication(processIdentifier: bestPid) : nil
        return (app, cg, appKit)
    }

    private func defaultAnchorFrame(forHeight height: CGFloat) -> NSRect? {
        guard let info = antigravityInfo(),
              let primaryHeight = NSScreen.screens.first?.frame.height else {
            return nil
        }

        let win = info.appKitRect
        let topLimit = win.maxY - 68.0 - height

        if let cardCG = liveChatCardCGRect(winCGRect: info.cgRect, app: info.app) {
            if isMinimized {
                let rightMargin = win.maxX - cardCG.maxX
                let x = rightMargin >= miniWidth + 14.0 ? cardCG.maxX + 12.0 : win.maxX - miniWidth - 16.0
                let cardBottomAppKit = primaryHeight - cardCG.maxY
                let y = rightMargin >= miniWidth + 14.0 ? cardBottomAppKit + 6.0 : win.origin.y + 18.0
                return NSRect(x: x, y: y, width: miniWidth, height: miniHeight)
            }
            let cardTopAppKitY = primaryHeight - cardCG.origin.y
            let y = min(topLimit, cardTopAppKitY + gapAboveChatbox)
            return NSRect(x: cardCG.origin.x, y: y, width: cardCG.width, height: height)
        }

        if isMinimized {
            return NSRect(x: win.maxX - miniWidth - 18.0, y: win.origin.y + 20.0, width: miniWidth, height: miniHeight)
        }

        let sidebarOffset: CGFloat = win.width > 920 ? 224 : 0
        let hudWidth = min(768.0, max(460.0, win.width - sidebarOffset - 36.0))
        let chatCenterX = win.origin.x + sidebarOffset + (win.width - sidebarOffset) / 2.0
        let x = chatCenterX - hudWidth / 2.0
        let y = min(topLimit, win.origin.y + 118.0)
        return NSRect(x: x, y: y, width: hudWidth, height: height)
    }

    @objc private func syncWindowPosition() {
        if isDragging { return }
        if manuallyHidden {
            panel.orderOut(nil)
            return
        }

        let frontName = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
        let antigravityActive = frontName.localizedCaseInsensitiveContains("Antigravity")
        let agInfo = antigravityInfo()

        if !keepVisibleEverywhere && (!antigravityActive || agInfo == nil) {
            panel.orderOut(nil)
            return
        }

        let height = isMinimized ? miniHeight : (isExpanded ? expandedHeight : collapsedHeight)
        if let anchor = defaultAnchorFrame(forHeight: height) {
            syncSelectedModelFromChatCard()
            let dx = isMinimized ? 0 : CGFloat(UserDefaults.standard.double(forKey: "customDx"))
            let dy = isMinimized ? 0 : CGFloat(UserDefaults.standard.double(forKey: "customDy"))
            let next = NSRect(
                x: round(anchor.origin.x + dx),
                y: round(anchor.origin.y + dy),
                width: round(anchor.size.width),
                height: round(anchor.size.height)
            )
            if panel.frame != next {
                panel.setFrame(next, display: true)
            }
        }

        if !panel.isVisible {
            panel.orderFrontRegardless()
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
