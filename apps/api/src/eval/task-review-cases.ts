// Hand-written task/evidence pairs for the task-review judge. Positives are
// finished (done) or no longer needed (dropped); hard negatives look close:
// plans, promises, partial progress, another owner, another thing.
// All evidence is dated after the task, as gatherEvidence guarantees.

import type { JudgeEvidence, JudgeTask } from "@sqrrl/source-layer"

export type Expect = "done" | "dropped" | "none"
export interface EvalCase {
	name: string
	task: JudgeTask
	evidence: Array<
		Omit<JudgeEvidence, "key" | "kind"> & { kind?: "raw" | "page" }
	>
	expect: Expect
}

const T = (title: string, owner = "me", dueDate?: string): JudgeTask => ({
	title,
	owner,
	createdAt: "2026-11-02T09:00:00Z",
	...(dueDate ? { dueDate } : {}),
})
const slack = (author: string, text: string, day = "2026-11-10") => ({
	source: "slack",
	title: "#team",
	author,
	text,
	occurredAt: `${day}T10:00:00Z`,
})
const mail = (
	author: string,
	title: string,
	text: string,
	day = "2026-11-10",
) => ({
	source: "email",
	title,
	author,
	text,
	occurredAt: `${day}T10:00:00Z`,
})
const meeting = (
	title: string,
	start: string,
	notes: string,
	removed = false,
) => ({
	kind: "page" as const,
	slug: `meetings/${title.toLowerCase().replace(/\W+/g, "-")}`,
	source: "meeting",
	title,
	text: `Meeting scheduled for ${start.slice(0, 16).replace("T", " ")}${removed ? " — REMOVED from the calendar (cancelled)" : ""}.\n\n${notes}`,
	occurredAt: start,
})
const note = (title: string, text: string, day = "2026-11-10") => ({
	kind: "page" as const,
	slug: `sources/notes/${title.toLowerCase().replace(/\W+/g, "-")}`,
	source: "wiki page",
	title,
	text,
	occurredAt: `${day}T10:00:00Z`,
})

export const CASES: EvalCase[] = [
	// ---- recurring: one occurrence closes nothing; stopping it drops it
	{
		name: "recurring 1:1 held once",
		task: T("Hold weekly 1:1s with Ravi"),
		evidence: [
			note(
				"Ravi 1x1",
				"Notes from a 1x1 with Ravi covering GTM, community and training.",
			),
		],
		expect: "none",
	},
	{
		name: "recurring report sent once",
		task: T("Send the platform status report every Friday", "Kai"),
		evidence: [
			slack(
				"Kai",
				"sent this week's platform status report to the leads channel",
			),
		],
		expect: "none",
	},
	{
		name: "recurring stopped",
		task: T("Hold weekly 1:1s with Ravi"),
		evidence: [
			mail(
				"Ravi",
				"1:1s",
				"Now that I've moved to the sales org, let's stop our weekly 1:1s — my new manager will take them over.",
			),
		],
		expect: "dropped",
	},
	// ---- done
	{
		name: "deck sent by mail",
		task: T("Send the pricing deck to Adyen", "me", "2026-11-07"),
		evidence: [
			mail(
				"me",
				"Pricing deck",
				"Hi Sam, sent the pricing deck over this morning — attached again here for convenience.",
			),
		],
		expect: "done",
	},
	{
		name: "exporter fixed in slack",
		task: T("Fix the Prometheus exporter scrape", "Kai"),
		evidence: [
			slack("Kai", "exporter scrape is fixed, dashboards are green again"),
		],
		expect: "done",
	},
	{
		name: "customer meeting happened",
		task: T("Hold the quarterly review with Volvo"),
		evidence: [
			meeting(
				"Volvo quarterly review",
				"2026-11-12T14:00:00Z",
				"Attendees: Erik (Volvo), me. Walked through Q3 usage and renewal timeline.",
			),
		],
		expect: "done",
	},
	{
		name: "event feedback covers item",
		task: T("Collect feedback from the Berlin meetup"),
		evidence: [
			note(
				"Berlin meetup retro",
				"Feedback from the Berlin meetup: 14 responses collected via the form. Top asks: more hands-on labs, shorter keynotes.",
			),
		],
		expect: "done",
	},
	{
		name: "contract signed",
		task: T("Get the NDA signed with Acme", "Ana"),
		evidence: [
			mail(
				"Ana",
				"Re: NDA",
				"The NDA with Acme is countersigned, PDF is in the legal folder.",
			),
		],
		expect: "done",
	},
	{
		name: "booked venue",
		task: T("Book a venue for the December workshop", "Ana"),
		evidence: [
			slack(
				"Ana",
				"Booked the Kings Cross room for the Dec 9 workshop, confirmation came through",
			),
		],
		expect: "done",
	},
	{
		name: "PR merged",
		task: T("Merge the retry fix for the ingest worker", "Lee"),
		evidence: [
			slack(
				"Lee",
				"retry fix for the ingest worker is merged and deployed to prod",
			),
		],
		expect: "done",
	},
	{
		name: "invoice paid",
		task: T("Pay the Hetzner invoice"),
		evidence: [
			mail(
				"Hetzner Billing",
				"Payment received",
				"Thank you, we have received your payment for invoice R0012345.",
			),
		],
		expect: "done",
	},
	{
		name: "intro made",
		task: T("Introduce Priya to the Stripe team"),
		evidence: [
			mail(
				"me",
				"Intro: Priya <> Stripe",
				"Priya, meet Jordan from Stripe. Jordan, Priya leads partnerships at our side. I'll let you two take it from here.",
			),
		],
		expect: "done",
	},
	{
		name: "ticked in note",
		task: T("Renew the domain names"),
		evidence: [
			note(
				"Admin checklist",
				"- [x] Renew the domain names (done 9 Nov, 2 years)\n- [ ] Update the billing card",
			),
		],
		expect: "done",
	},
	{
		name: "reply sent",
		task: T("Reply to Tom about the conference talk"),
		evidence: [
			mail(
				"me",
				"Re: conference talk",
				"Hi Tom, thanks for the invite — yes, happy to give the talk on the 3rd. Will send the abstract by Friday.",
			),
		],
		expect: "done",
	},
	{
		name: "decision made",
		task: T("Decide on the CRM vendor", "me"),
		evidence: [
			note(
				"Ops weekly",
				"Decision: we're going with HubSpot for the CRM; contract starts in January.",
			),
		],
		expect: "done",
	},
	// ---- dropped
	{
		name: "workshop cancelled",
		task: T("Book a venue for the customer workshop", "Ana"),
		evidence: [
			mail(
				"Ana",
				"Workshop",
				"Update: the customer workshop is cancelled; it moves to a virtual session in Q1, so no venue needed.",
			),
		],
		expect: "dropped",
	},
	{
		name: "meeting removed",
		task: T("Prepare agenda for the Adyen sync"),
		evidence: [meeting("Adyen sync", "2026-11-11T10:00:00Z", "", true)],
		expect: "dropped",
	},
	{
		name: "superseded",
		task: T("Migrate the wiki to Confluence"),
		evidence: [
			note(
				"Tooling decision",
				"We decided against moving to Confluence — staying on the self-hosted wiki for good.",
			),
		],
		expect: "dropped",
	},
	{
		name: "customer churned",
		task: T("Send renewal quote to Globex"),
		evidence: [
			mail(
				"Sales Ops",
				"Globex",
				"FYI Globex have confirmed they will not renew; please stop any renewal work.",
			),
		],
		expect: "dropped",
	},
	{
		name: "someone else did it",
		task: T("Ask legal about the DPA wording"),
		evidence: [
			slack(
				"Ana",
				"no need to ping legal on the DPA — they already approved the wording yesterday",
			),
		],
		expect: "dropped",
	},
	// ---- none: plans, promises, partial, mentions, recurring
	{
		name: "promise not completion",
		task: T("Send the pricing deck to Adyen"),
		evidence: [
			mail(
				"me",
				"Pricing deck",
				"Hi Sam, I'll send the pricing deck by Friday once finance signs off.",
			),
		],
		expect: "none",
	},
	{
		name: "next week",
		task: T("Write the Q4 newsletter", "Lee"),
		evidence: [
			slack(
				"Lee",
				"I'll write the Q4 newsletter next week once the numbers are in",
			),
		],
		expect: "none",
	},
	{
		name: "partial progress",
		task: T("Migrate all dashboards to Grafana 11", "Kai"),
		evidence: [
			slack(
				"Kai",
				"migrated 3 of the 12 dashboards to Grafana 11 so far, rest tomorrow",
			),
		],
		expect: "none",
	},
	{
		name: "just a mention",
		task: T("Fix the Prometheus exporter scrape", "Kai"),
		evidence: [
			slack(
				"Lee",
				"anyone know if the Prometheus exporter scrape is still flaky?",
			),
		],
		expect: "none",
	},
	{
		name: "upcoming meeting",
		task: T("Hold the quarterly review with Volvo"),
		evidence: [
			meeting(
				"Volvo quarterly review",
				"2026-11-25T14:00:00Z",
				"Attendees: Erik (Volvo), me.",
			),
		],
		expect: "none",
	},
	{
		name: "different customer",
		task: T("Send the pricing deck to Adyen"),
		evidence: [
			mail(
				"me",
				"Pricing deck",
				"Hi Maria, sent the pricing deck to Klarna this morning.",
			),
		],
		expect: "none",
	},
	{
		name: "different item",
		task: T("Book a venue for the December workshop", "Ana"),
		evidence: [
			slack("Ana", "booked flights for the December workshop speakers"),
		],
		expect: "none",
	},
	{
		name: "blocked",
		task: T("Get the NDA signed with Acme", "Ana"),
		evidence: [
			mail(
				"Ana",
				"Re: NDA",
				"Acme legal pushed back on clause 7 again; still not signed.",
			),
		],
		expect: "none",
	},
	{
		name: "question",
		task: T("Renew the domain names"),
		evidence: [
			mail(
				"Registrar",
				"Renewal reminder",
				"Your domains expire in 30 days. Renew now to avoid interruption.",
			),
		],
		expect: "none",
	},
	{
		name: "draft only",
		task: T("Reply to Tom about the conference talk"),
		evidence: [
			note(
				"Drafts",
				"Draft reply to Tom about the talk — need to check dates before sending.",
			),
		],
		expect: "none",
	},
	{
		name: "postponed not cancelled",
		task: T("Book a venue for the customer workshop", "Ana"),
		evidence: [
			mail(
				"Ana",
				"Workshop",
				"The customer workshop is postponed to February, we'll still need a venue then.",
			),
		],
		expect: "none",
	},
	{
		name: "request repeated",
		task: T("Pay the Hetzner invoice"),
		evidence: [
			mail(
				"Hetzner Billing",
				"Payment reminder",
				"Invoice R0012345 is overdue. Please pay within 7 days.",
			),
		],
		expect: "none",
	},
	{
		name: "intent to decide",
		task: T("Decide on the CRM vendor"),
		evidence: [
			note(
				"Ops weekly",
				"CRM: shortlist is HubSpot and Pipedrive; decision at next week's ops meeting.",
			),
		],
		expect: "none",
	},
]
