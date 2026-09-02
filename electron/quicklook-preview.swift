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

final class PreviewPanelController: NSObject, NSApplicationDelegate, QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    private let item: PreviewItem
    private var previewPanel: QLPreviewPanel?

    private func forwardKey(_ key: String) {
        let payload: [String: String] = ["key": key, "path": item.url.path]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let line = String(data: data, encoding: .utf8) else { return }
        print(line)
        fflush(stdout)
    }

    init(url: URL) {
        item = PreviewItem(url: url)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Accessory policy keeps this helper out of the Dock while QLPreviewPanel
        // supplies the same native Quick Look chrome used by macOS preview flows.
        NSApp.setActivationPolicy(.accessory)

        guard let panel = QLPreviewPanel.shared() else {
            fputs("Quick Look preview panel is unavailable\n", stderr)
            NSApp.terminate(nil)
            return
        }
        previewPanel = panel;
        panel.dataSource = self
        panel.delegate = self
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.fullScreenAuxiliary, .canJoinAllSpaces]
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        panel.reloadData()

        NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            guard let self else { return event }
            if event.keyCode == 49 {
                self.forwardKey(" ")
                return nil
            }
            switch event.keyCode {
            case 126: self.forwardKey("ArrowUp")
            case 125: self.forwardKey("ArrowDown")
            case 123: self.forwardKey("ArrowLeft")
            case 124: self.forwardKey("ArrowRight")
            default: break
            }
            return event
        }
    }

    func numberOfPreviewItems(in panel: QLPreviewPanel) -> Int { 1 }

    func previewPanel(_ panel: QLPreviewPanel, previewItemAt index: Int) -> QLPreviewItem {
        item
    }

    func previewPanelWillClose(_ panel: QLPreviewPanel) {
        NSApp.terminate(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
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
