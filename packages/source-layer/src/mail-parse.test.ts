import { describe, expect, it } from "vitest"
import {
	bulkReason,
	type MailRecord,
	mailToRawItem,
	parseAddress,
	parseHeaders,
	stripQuoted,
	threadRoot,
} from "./mail-parse.js"

const H = (lines: string[]) => lines.join("\r\n")
const SELF = ["owner@corp.test"]

function record(extra: Partial<MailRecord> = {}): MailRecord {
	return {
		mailbox: "inbox",
		messageId: "<m2@corp.test>",
		subject: "Re: OIDC cutover",
		sender: "Kai Tester <Kai@corp.test>",
		dateReceived: "2026-11-17T10:05:00Z",
		dateSent: "2026-11-17T10:00:00Z",
		headers: H([
			"Message-ID: <m2@corp.test>",
			"In-Reply-To: <m1@corp.test>",
			"References: <m1@corp.test>",
			"Subject: Re: OIDC cutover",
		]),
		content:
			"Agreed, cutover on the 28th. Ana owns rollback.\n\nOn Mon, 16 Nov 2026 at 09:00, Test Owner <owner@corp.test> wrote:\n> Can we cut over on the 28th?",
		to: [{ name: "Test Owner", address: "owner@corp.test" }],
		cc: [{ name: "Ana Example", address: "ana@corp.test" }],
		...extra,
	}
}

describe("headers and addresses", () => {
	it("unfolds continuation lines and keeps repeats", () => {
		const h = parseHeaders(
			"References: <a@x>\r\n <b@x>\r\nReceived: one\r\nReceived: two",
		)
		expect(h.get("references")).toEqual(["<a@x> <b@x>"])
		expect(h.get("received")).toEqual(["one", "two"])
	})

	it("parses named, quoted and bare addresses", () => {
		expect(parseAddress('"Tester, Kai" <Kai@X.test>')).toEqual({
			name: "Tester, Kai",
			email: "kai@x.test",
		})
		expect(parseAddress("kai@x.test")).toEqual({ email: "kai@x.test" })
		expect(parseAddress("kai@x.test <kai@x.test>")).toEqual({
			email: "kai@x.test",
		})
		expect(parseAddress("not an address")).toBeUndefined()
	})

	it("threads on the References root, else In-Reply-To, else itself", () => {
		expect(
			threadRoot(
				record(),
				parseHeaders("References: <Root@x> <m1@x>\nIn-Reply-To: <m1@x>"),
			),
		).toBe("root@x")
		expect(threadRoot(record(), parseHeaders("In-Reply-To: <m1@x>"))).toBe(
			"m1@x",
		)
		expect(
			threadRoot(record({ messageId: "<Solo@x>" }), parseHeaders("")),
		).toBe("solo@x")
	})
})

describe("bulkReason", () => {
	const reason = (headers: string[], extra: Partial<MailRecord> = {}) =>
		bulkReason(record(extra), parseHeaders(H(headers)))
	it("drops lists, unsubscribe mail, bulk precedence and no-reply senders", () => {
		expect(reason(["List-Id: <eng.lists.x>"])).toBe("bulk")
		expect(reason(["List-Unsubscribe: <mailto:u@x>"])).toBe("bulk")
		expect(reason(["Precedence: bulk"])).toBe("bulk")
		expect(reason([], { sender: "GitHub <notifications@github.com>" })).toBe(
			"bulk",
		)
		expect(reason([], { sender: "no-reply@vendor.test" })).toBe("bulk")
		expect(reason(["Auto-Submitted: auto-replied"])).toBe("bulk")
	})

	it("drops calendar invitations, which the calendar connector covers", () => {
		expect(
			reason([
				"Content-Type: multipart/mixed; boundary=x",
				"Content-Type: text/calendar; method=REQUEST",
			]),
		).toBe("calendar")
		expect(
			reason([], {
				subject: "Invitation: Standup @ Mon 9am (owner@corp.test)",
			}),
		).toBe("calendar")
	})

	it("keeps mail a person wrote, and everything you sent except auto-replies", () => {
		expect(reason([])).toBeUndefined()
		expect(reason(["List-Id: <x>"], { mailbox: "sent" })).toBeUndefined()
		expect(reason(["Auto-Submitted: auto-replied"], { mailbox: "sent" })).toBe(
			"bulk",
		)
		expect(
			reason([], { sender: "Reply Guy <replyguy@corp.test>" }),
		).toBeUndefined()
	})
})

describe("stripQuoted", () => {
	it("cuts Gmail, Outlook and forwarded history and drops quoted lines", () => {
		expect(
			stripQuoted(
				"New text\n\nOn Mon, Nov 16, 2026 at 9:00 AM Kai <k@x>\nwrote:\n> old",
			),
		).toBe("New text")
		expect(
			stripQuoted(
				"Reply\n\nFrom: Kai Tester\nSent: Monday\nTo: me\nSubject: x\nold",
			),
		).toBe("Reply")
		expect(
			stripQuoted("FYI\n---------- Forwarded message ---------\nFrom: a"),
		).toBe("FYI")
		expect(stripQuoted("Top\n> quoted\nmore")).toBe("Top\nmore")
		expect(stripQuoted("Line\n________________________________\nFrom: x")).toBe(
			"Line",
		)
	})
})

describe("mailToRawItem", () => {
	it("builds a thread-keyed item with you as me and quotes removed", () => {
		const out = mailToRawItem(record(), SELF)
		if ("skip" in out) throw new Error(out.skip)
		expect(out.root).toBe("m1@corp.test")
		expect(out.item).toMatchObject({
			source: "email",
			sourceId: "m2@corp.test",
			kind: "email",
			title: "Re: OIDC cutover",
			unit: "email:m1@corp.test",
			thread: "m1@corp.test",
			occurredAt: "2026-11-17T10:00:00Z",
			author: "Kai Tester",
			participants: ["kai@corp.test", "owner@corp.test", "ana@corp.test"],
			metadata: {
				from: { name: "Kai Tester", email: "kai@corp.test" },
				to: [{ name: "Test Owner", email: "owner@corp.test", self: true }],
				fromSelf: false,
				inReplyTo: "m1@corp.test",
			},
		})
		expect(out.item.text).toBe(
			"From: Kai Tester <kai@corp.test>\nTo: me\nCc: Ana Example <ana@corp.test>\nSubject: Re: OIDC cutover\n\nAgreed, cutover on the 28th. Ana owns rollback.",
		)
	})

	it("stores a message identically whether it was read from Inbox or Sent", () => {
		const inbox = mailToRawItem(record(), SELF)
		const sent = mailToRawItem(
			record({ mailbox: "sent", dateReceived: "2026-11-17T11:00:00Z" }),
			SELF,
		)
		expect(inbox).toEqual(sent)
	})

	it("skips bulk, id-less and empty mail with a reason", () => {
		expect(
			mailToRawItem(record({ headers: H(["List-Id: <x>"]) }), SELF),
		).toEqual({ skip: "bulk" })
		expect(
			mailToRawItem(record({ messageId: undefined, headers: "" }), SELF),
		).toEqual({ skip: "no-id" })
		expect(mailToRawItem(record({ content: "> only quoted" }), SELF)).toEqual({
			skip: "empty",
		})
	})
})
