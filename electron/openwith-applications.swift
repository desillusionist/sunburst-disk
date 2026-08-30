import AppKit
import Foundation

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    fputs("Usage: openwith-applications <path>\n", stderr)
    exit(2)
}

let fileURL = URL(fileURLWithPath: arguments[1]).standardizedFileURL
let applications = NSWorkspace.shared.urlsForApplications(toOpen: fileURL)
var seen = Set<String>()
for application in applications {
    let path = application.standardizedFileURL.path
    if seen.insert(path).inserted {
        print(path)
    }
}
