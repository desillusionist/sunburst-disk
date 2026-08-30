import Cocoa
import Foundation
import QuickLookUI

final class PreviewItem: NSObject, QLPreviewItem {
    let url: URL

    init(url: URL) {
        self.url = url
    }

    var previewItemURL: URL? { url }
    var previewItemTitle: String? { url.lastPathComponent }
}

final class PreviewWindowController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let item: PreviewItem
    private var window: NSWindow!
    private var preview: QLPreviewView!

    init(url: URL) {
        item = PreviewItem(url: url)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = NSRect(x: 0, y: 0, width: 860, height: 640)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Quick Look — Sunburst Disk"
        window.minSize = NSSize(width: 420, height: 320)
        window.delegate = self
        window.center()

        preview = QLPreviewView(frame: frame, style: .normal)
        preview.autostarts = true
        preview.shouldCloseWithWindow = true
        preview.previewItem = item
        window.contentView = preview
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        preview.refreshPreviewItem()
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }
}

guard let argument = CommandLine.arguments.dropFirst().first, !argument.isEmpty else {
    fputs("Quick Look path is required\n", stderr)
    exit(64)
}

let url = URL(fileURLWithPath: argument)
guard FileManager.default.fileExists(atPath: url.path) else {
    fputs("Quick Look path does not exist\n", stderr)
    exit(66)
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let controller = PreviewWindowController(url: url)
application.delegate = controller
application.run()
