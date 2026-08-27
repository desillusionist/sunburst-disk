import CoreServices
import Foundation

private let watchPath = CommandLine.arguments.dropFirst().first ?? ""

if watchPath.isEmpty {
    FileHandle.standardError.write(Data("watch path is required\n".utf8))
    exit(64)
}

let callback: FSEventStreamCallback = { _, clientCallBackInfo, eventCount, eventPaths, eventFlags, eventIds in
    guard eventCount > 0 else { return }
    let paths = eventPaths.assumingMemoryBound(to: UnsafePointer<CChar>.self)
    let output = FileHandle.standardOutput

    for index in 0..<eventCount {
        let path = String(cString: paths[index])
        let payload: [String: Any] = [
            "path": path,
            "flags": Int(eventFlags[index]),
            "eventId": Int(eventIds[index])
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { continue }
        output.write(data)
        output.write(Data([0x0A]))
    }
}

let pathsToWatch = [watchPath] as CFArray
let flags = FSEventStreamCreateFlags(
    kFSEventStreamCreateFlagFileEvents
    | kFSEventStreamCreateFlagWatchRoot
    | kFSEventStreamCreateFlagNoDefer
)

var context = FSEventStreamContext(
    version: 0,
    info: nil,
    retain: nil,
    release: nil,
    copyDescription: nil
)

let stream = FSEventStreamCreate(
    nil,
    callback,
    &context,
    pathsToWatch,
    FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
    0.25,
    flags
)

guard let stream else {
    FileHandle.standardError.write(Data("could not create FSEventStream\n".utf8))
    exit(1)
}

let queue = DispatchQueue(label: "com.sunburstdisk.fsevents-watcher")
FSEventStreamSetDispatchQueue(stream, queue)

guard FSEventStreamStart(stream) else {
    FileHandle.standardError.write(Data("could not start FSEventStream\n".utf8))
    exit(1)
}

dispatchMain()
