// Reads Calendar.app events through EventKit and prints them as sqrrl raw
// items, one per occurrence. Run by sqrrl-calendar-sync.sh, which compiles
// it on first use; nothing here talks to the network.
//
//   sqrrl-calendar-export --from 2026-11-01T00:00:00Z --to 2026-11-08T00:00:00Z
//       [--calendars "Work,Team"] [--include-declined] [--include-all-day]
//   sqrrl-calendar-export --list-calendars
//
// Prints {"window":{"from","to"},"items":[...]} on stdout. Every event that
// STARTS in [from, to) is included, so the server can treat the window as
// complete and retire events that have gone. Exit 3 means no calendar access.
//
// The text of each item ends with "\n\nNotes:\n" and the invite's notes:
// the server's meeting distiller splits on exactly that marker.

import EventKit
import Foundation

func fail(_ message: String, _ code: Int32) -> Never {
	FileHandle.standardError.write(Data((message + "\n").utf8))
	exit(code)
}

let args = Array(CommandLine.arguments.dropFirst())
func value(_ flag: String) -> String? {
	guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
	return args[i + 1]
}
let isoOut = ISO8601DateFormatter()
isoOut.formatOptions = [.withInternetDateTime]
let isoIn = ISO8601DateFormatter()
isoIn.formatOptions = [.withInternetDateTime]

// --- access -----------------------------------------------------------------

let store = EKEventStore()
let done = DispatchSemaphore(value: 0)
var granted = false
var accessError: Error?
if #available(macOS 14.0, *) {
	store.requestFullAccessToEvents { ok, err in
		granted = ok
		accessError = err
		done.signal()
	}
} else {
	store.requestAccess(to: .event) { ok, err in
		granted = ok
		accessError = err
		done.signal()
	}
}
done.wait()
if !granted {
	fail(
		"no calendar access\(accessError.map { " (\($0.localizedDescription))" } ?? ""): "
			+ "allow it in System Settings -> Privacy & Security -> Calendars", 3)
}

// --- calendars --------------------------------------------------------------

let allCalendars = store.calendars(for: .event)
if args.contains("--list-calendars") {
	for c in allCalendars.sorted(by: { $0.title < $1.title }) {
		let kind: String
		switch c.type {
		case .local: kind = "local"
		case .calDAV: kind = "caldav"
		case .exchange: kind = "exchange"
		case .subscription: kind = "subscription"
		case .birthday: kind = "birthday"
		@unknown default: kind = "other"
		}
		print("\(c.title)\t\(c.source.title)\t\(kind)")
	}
	exit(0)
}

guard let fromText = value("--from"), let from = isoIn.date(from: fromText),
	let toText = value("--to"), let to = isoIn.date(from: toText), from < to
else {
	fail("usage: sqrrl-calendar-export --from ISO --to ISO [--calendars A,B]", 2)
}

// Holidays and birthdays are subscriptions, not meetings: skipped unless named.
let calendars: [EKCalendar]
if let wanted = value("--calendars") {
	let names = Set(wanted.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
	calendars = allCalendars.filter { names.contains($0.title) }
	if calendars.isEmpty { fail("none of the calendars \(wanted) exist; see --list-calendars", 2) }
} else {
	calendars = allCalendars.filter { $0.type != .subscription && $0.type != .birthday }
}
let includeDeclined = args.contains("--include-declined")
let includeAllDay = args.contains("--include-all-day")

// --- mapping ----------------------------------------------------------------

func email(_ p: EKParticipant) -> String? {
	let s = p.url.absoluteString
	guard s.lowercased().hasPrefix("mailto:") else { return nil }
	let address = String(s.dropFirst(7)).removingPercentEncoding ?? String(s.dropFirst(7))
	return address.isEmpty ? nil : address.lowercased()
}

func person(_ p: EKParticipant) -> [String: Any] {
	var out: [String: Any] = [:]
	if let n = p.name, !n.isEmpty { out["name"] = n }
	if let e = email(p) { out["email"] = e }
	switch p.participantStatus {
	case .accepted: out["status"] = "accepted"
	case .declined: out["status"] = "declined"
	case .tentative: out["status"] = "tentative"
	case .pending: out["status"] = "pending"
	default: out["status"] = "unknown"
	}
	switch p.participantRole {
	case .required: out["role"] = "required"
	case .optional: out["role"] = "optional"
	case .chair: out["role"] = "chair"
	case .nonParticipant: out["role"] = "non-participant"
	default: break
	}
	switch p.participantType {
	case .person: out["type"] = "person"
	case .room: out["type"] = "room"
	case .resource: out["type"] = "resource"
	case .group: out["type"] = "group"
	default: out["type"] = "unknown"
	}
	if p.isCurrentUser { out["self"] = true }
	return out
}

func label(_ a: [String: Any]) -> String {
	(a["name"] as? String) ?? (a["email"] as? String) ?? "unknown"
}

let callPattern = try! NSRegularExpression(
	pattern: #"https://[^\s<>"']*(zoom\.us/j/|meet\.google\.com/|teams\.microsoft\.com/l/meetup-join|webex\.com/)[^\s<>"']*"#,
	options: [.caseInsensitive])

/** The meeting link, without its query string: Zoom puts the passcode there. */
func conferenceUrl(_ ev: EKEvent) -> String? {
	var candidates: [String] = []
	if let u = ev.url?.absoluteString { candidates.append(u) }
	for text in [ev.location, ev.notes].compactMap({ $0 }) {
		let range = NSRange(text.startIndex..., in: text)
		if let m = callPattern.firstMatch(in: text, range: range), let r = Range(m.range, in: text) {
			candidates.append(String(text[r]))
		}
	}
	guard let first = candidates.first(where: { callPattern.firstMatch(in: $0, range: NSRange($0.startIndex..., in: $0)) != nil }) ?? candidates.first
	else { return nil }
	return first.components(separatedBy: "?").first
}

/** Invites from Outlook and Google carry HTML; keep the words. */
func plainNotes(_ raw: String?) -> String {
	guard var s = raw, !s.isEmpty else { return "" }
	if s.contains("<") && s.contains(">") {
		s = s.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
		s = s.replacingOccurrences(of: "</p>", with: "\n", options: .caseInsensitive)
		s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
		for (entity, char) in [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'")] {
			s = s.replacingOccurrences(of: entity, with: char)
		}
	}
	s = s.replacingOccurrences(of: "\r\n", with: "\n")
	s = s.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
	s = s.trimmingCharacters(in: .whitespacesAndNewlines)
	return s.count > 8000 ? String(s.prefix(8000)) + " …" : s
}

func localText(_ d: Date, _ tz: TimeZone?) -> String {
	let f = DateFormatter()
	f.locale = Locale(identifier: "en_GB")
	f.timeZone = tz ?? TimeZone.current
	f.dateFormat = "yyyy-MM-dd HH:mm"
	return f.string(from: d)
}

// --- export -----------------------------------------------------------------

let predicate = store.predicateForEvents(withStart: from, end: to, calendars: calendars)
var items: [[String: Any]] = []
for ev in store.events(matching: predicate) {
	// Overlapping events come back too; only those starting here belong to
	// this window, or a long event would be claimed by two windows.
	guard let start = ev.startDate, let end = ev.endDate, start >= from, start < to else { continue }
	if ev.isAllDay && !includeAllDay { continue }
	let attendees = (ev.attendees ?? []).map(person).sorted {
		(($0["email"] as? String) ?? label($0)) < (($1["email"] as? String) ?? label($1))
	}
	if !includeDeclined,
		attendees.contains(where: { ($0["self"] as? Bool) == true && ($0["status"] as? String) == "declined" })
	{ continue }

	let series = ev.calendarItemExternalIdentifier ?? ev.eventIdentifier ?? UUID().uuidString
	// occurrenceDate is the slot's original start, so moving one occurrence
	// of a series keeps its identity.
	let sourceId = "\(series)|\(isoOut.string(from: ev.occurrenceDate ?? start))"
	let title = (ev.title?.isEmpty == false ? ev.title! : "Untitled meeting")
	let tz = ev.timeZone
	let organizer = ev.organizer.map(person)
	let call = conferenceUrl(ev)
	let status: String
	switch ev.status {
	case .canceled: status = "cancelled"
	case .tentative: status = "tentative"
	default: status = "confirmed"
	}

	var meta: [String: Any] = [
		"start": isoOut.string(from: start),
		"end": isoOut.string(from: end),
		"calendar": ev.calendar.title,
		"status": status,
		"attendees": attendees,
	]
	if ev.isAllDay { meta["allDay"] = true }
	if let tz { meta["timeZone"] = tz.identifier }
	if let loc = ev.location, !loc.isEmpty { meta["location"] = loc }
	if let organizer { meta["organizer"] = organizer }
	if ev.hasRecurrenceRules { meta["recurring"] = true; meta["seriesId"] = series }
	if let call { meta["conferenceUrl"] = call }

	var lines = [
		"Meeting: \(title)",
		"When: \(localText(start, tz)) – \(localText(end, tz))\(tz.map { " (\($0.identifier))" } ?? "")",
	]
	if let loc = ev.location, !loc.isEmpty { lines.append("Where: \(loc)") }
	lines.append("Calendar: \(ev.calendar.title)")
	if let organizer { lines.append("Organizer: \(label(organizer))") }
	let people = attendees.filter { ($0["type"] as? String) != "room" && ($0["type"] as? String) != "resource" }
	if !people.isEmpty {
		lines.append("Attendees: " + people.map { "\(label($0)) (\(($0["status"] as? String) ?? "unknown"))" }.joined(separator: ", "))
	}
	if status == "cancelled" { lines.append("Status: cancelled") }
	if let call { lines.append("Call: \(call)") }
	var text = lines.joined(separator: "\n")
	let notes = plainNotes(ev.notes)
	if !notes.isEmpty { text += "\n\nNotes:\n" + notes }

	var item: [String: Any] = [
		"source": "calendar",
		"sourceId": sourceId,
		"kind": "event",
		"title": title,
		"text": text,
		"unit": sourceId,
		"occurredAt": isoOut.string(from: start),
		"channel": ev.calendar.title,
		"participants": people.map(label),
		"metadata": meta,
	]
	if let organizer { item["author"] = label(organizer) }
	if ev.hasRecurrenceRules { item["thread"] = series }
	items.append(item)
}

let body: [String: Any] = [
	"window": ["from": isoOut.string(from: from), "to": isoOut.string(from: to)],
	"items": items,
]
let data = try! JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
