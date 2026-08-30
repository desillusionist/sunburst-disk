import AppKit
import Foundation
import QuickLookUI

final class PreviewItem: NSObject, QLPreviewItem {
    let url: URL

    init(url: URL) {
        self.url = url
        super.init()
    }

    var previewItemURL: URL? { url }
    var previewItemTitle: String? { url.lastPathComponent }
}

final class PreviewPanelController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let item: PreviewItem
    private var panel: NSPanel!
    private var preview: QLPreviewView!

    init(url: URL) {
        item = PreviewItem(url: url)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = NSRect(x: 0, y: 0, width: 860, height: 640)
        panel = NSPanel(
            contentRect: frame,
            styleMask: [.titled, .closable, .resizable, .nonactivatingPanel, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        panel.title = "Quick Look — Sunburst Disk"
        panel.minSize = NSSize(width: 420, height: 320)
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.level = .floating
        panel.collectionBehavior = [.fullScreenAuxiliary, .canJoinAllSpaces]
        panel.delegate = self
        panel.center()

        preview = QLPreviewView(frame: frame, style: .normal)
        preview.autostarts = true
        preview.shouldCloseWithWindow = true
        preview.previewItem = item
        panel.contentView = preview

        // Keep the helper as an accessory process and order the nonactivating
        // panel above the current Sunburst Disk window without stealing focus.
        NSApp.setActivationPolicy(.accessory)
        panel.orderFrontRegardless()
        preview.refreshPreviewItem()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }
}

guard let argument = CommandLine.arguments.dropFirst().first, !argument.isEmpty else {
    fputs("Quick Look path is required\n", stderr)
    exit(64)
}

let url = URL(fileURLWithPath: argument).standardizedFileURL
guard FileManager.default.fileExists(atPath: url.path) else {
    fputs("Quick Look path does not exist\n", stderr)
    exit(66)
}

let application = NSApplication.shared
let controller = PreviewPanelController(url: url)
application.delegate = controller
application.run()
