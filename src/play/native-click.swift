import CoreGraphics
import Darwin
import Foundation

let source = CGEventSource(stateID: .hidSystemState)
func reply(_ text: String) {
  FileHandle.standardOutput.write(Data("\(text)\n".utf8))
}

if CommandLine.arguments.contains("--probe") {
  let permitted = CGPreflightPostEventAccess()
  reply(permitted ? "ready" : "unavailable")
  exit(permitted ? 0 : 2)
}

guard CGPreflightPostEventAccess() else {
  reply("unavailable")
  exit(2)
}

while let line = readLine() {
  let values = line.split(whereSeparator: { $0 == " " || $0 == "\t" }).compactMap { Double($0) }
  guard values.count >= 2 else {
    reply("error")
    continue
  }

  let point = CGPoint(x: values[0], y: values[1])
  let moved = CGEvent(
    mouseEventSource: source,
    mouseType: .mouseMoved,
    mouseCursorPosition: point,
    mouseButton: .left,
  )
  moved?.post(tap: .cghidEventTap)
  usleep(20_000)

  let down = CGEvent(
    mouseEventSource: source,
    mouseType: .leftMouseDown,
    mouseCursorPosition: point,
    mouseButton: .left,
  )
  down?.post(tap: .cghidEventTap)
  usleep(45_000)

  let up = CGEvent(
    mouseEventSource: source,
    mouseType: .leftMouseUp,
    mouseCursorPosition: point,
    mouseButton: .left,
  )
  up?.post(tap: .cghidEventTap)
  usleep(20_000)
  reply("ok")
}
