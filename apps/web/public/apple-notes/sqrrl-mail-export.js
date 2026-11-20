#!/usr/bin/osascript -l JavaScript
// Reads Mail.app's Inbox and Sent mailboxes for a date range and prints the
// messages as JSON for /v1/raw/mail. Run by sqrrl-mail-sync.sh.
//
//   osascript -l JavaScript sqrrl-mail-export.js --from ISO --to ISO [--accounts "Work,Personal"]
//
// Thin on purpose: headers, plain-text content, recipients and mailbox go to
// the server, which drops bulk mail, strips quotes and threads. Nothing here
// talks to the network. The first run from Terminal makes macOS ask whether
// Terminal may control Mail (System Settings -> Privacy & Security ->
// Automation).

function run(argv) {
	const arg = (flag) => {
		const i = argv.indexOf(flag)
		return i >= 0 ? argv[i + 1] : undefined
	}
	const from = new Date(arg("--from"))
	const to = new Date(arg("--to"))
	if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to)
		throw new Error(
			"usage: sqrrl-mail-export.js --from ISO --to ISO [--accounts A,B]",
		)
	const only = (arg("--accounts") || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)

	const Mail = Application("Mail")
	const iso = (d) =>
		d && !Number.isNaN(new Date(d).getTime())
			? new Date(d).toISOString()
			: undefined
	const tryGet = (fn, fallback) => {
		try {
			const v = fn()
			return v === null || v === undefined ? fallback : v
		} catch (e) {
			return fallback
		}
	}

	const selfAddresses = []
	const messages = []
	for (const account of Mail.accounts()) {
		if (!tryGet(() => account.enabled(), true)) continue
		const accountName = tryGet(() => account.name(), "")
		if (only.length && !only.includes(accountName)) continue
		for (const a of tryGet(() => account.emailAddresses(), []))
			selfAddresses.push(String(a).toLowerCase())

		for (const box of tryGet(() => account.mailboxes(), [])) {
			const name = tryGet(() => box.name(), "")
			const kind = /^inbox$/i.test(name)
				? "inbox"
				: /^sent( mail| messages| items)?$/i.test(name)
					? "sent"
					: null
			if (!kind) continue
			const spec = box.messages.whose({
				_and: [
					{ dateReceived: { _greaterThan: from } },
					{ dateReceived: { _lessThan: to } },
				],
			})
			// One Apple event per property for the whole set, not per message:
			// fetching message by message is what makes Mail scripting slow.
			const ids = tryGet(() => spec.messageId(), [])
			if (!ids.length) continue
			const col = (fn) =>
				tryGet(
					fn,
					ids.map(() => undefined),
				)
			const subjects = col(() => spec.subject())
			const senders = col(() => spec.sender())
			const received = col(() => spec.dateReceived())
			const sent = col(() => spec.dateSent())
			const headers = col(() => spec.allHeaders())
			const contents = col(() => spec.content())
			const toAddr = col(() => spec.toRecipients.address())
			const toName = col(() => spec.toRecipients.name())
			const ccAddr = col(() => spec.ccRecipients.address())
			const ccName = col(() => spec.ccRecipients.name())
			const files = col(() => spec.mailAttachments.name())
			const people = (addrs, names) =>
				(addrs || []).map((address, j) => ({
					address: String(address),
					name: names && names[j] ? String(names[j]) : undefined,
				}))
			for (let i = 0; i < ids.length; i++) {
				messages.push({
					mailbox: kind,
					account: accountName,
					messageId: ids[i],
					subject: subjects[i],
					sender: senders[i],
					dateReceived: iso(received[i]),
					dateSent: iso(sent[i]),
					headers: headers[i],
					content: contents[i],
					to: people(toAddr[i], toName[i]),
					cc: people(ccAddr[i], ccName[i]),
					attachments: (files[i] || []).map(String),
				})
			}
		}
	}
	return JSON.stringify({
		window: { from: from.toISOString(), to: to.toISOString() },
		selfAddresses: [...new Set(selfAddresses)],
		messages,
	})
}
