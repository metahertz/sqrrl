import { describe, expect, it } from "vitest"
import { mergeRedactions, redactionCount, redactSecrets } from "./redact.js"

// Every secret here is made up.
describe("redactSecrets", () => {
	it("redacts a user:password pair, keeping the user", () => {
		const r = redactSecrets("connect as mdb_user:Xy7pLm2Ka9Zr then load")
		expect(r.text).toBe(
			"connect as mdb_user:[REDACTED:user-colon-password] then load",
		)
		// Ordinary prose with a colon after "user" stays.
		for (const clean of [
			"user:alice",
			"Login:Monday",
			"username: Kai Smith",
			"user: see notes2026",
		])
			expect(redactSecrets(clean).text).toBe(clean)
	})

	it("finds nothing in text it already redacted", () => {
		const once = redactSecrets(
			"mongodb+srv://svc:Zx9Qw8Er7Ty6@c0.example.net mdb_user:Xy7pLm2Ka9Zr token=abcdef123456",
		)
		expect(redactSecrets(once.text).found).toEqual({})
	})

	it("redacts meeting passcodes", () => {
		const r = redactSecrets("Meeting ID: 912 3456\nPasscode: 884213")
		expect(r.text).toBe("Meeting ID: 912 3456\nPasscode: [REDACTED:assignment]")
	})

	it("redacts the password in any scheme's URI, keeping user and host", () => {
		const r = redactSecrets(
			"prod: mongodb+srv://app-web:Xq7pLm2Ka9Zr@cluster0.abcde.mongodb.net/?appName=x\n" +
				"cache redis://default:hunter2hunter@10.0.0.5:6379",
		)
		expect(r.text).toBe(
			"prod: mongodb+srv://app-web:[REDACTED:uri-password]@cluster0.abcde.mongodb.net/?appName=x\n" +
				"cache redis://default:[REDACTED:uri-password]@10.0.0.5:6379",
		)
		expect(r.found).toEqual({ "uri-password": 2 })
	})

	it("redacts the user@password shape of the leaked note title", () => {
		const r = redactSecrets("bakeoff-web@Ab3dEfGh1jKl")
		expect(r.text).toBe("bakeoff-web@[REDACTED:user-at-password]")
	})

	it("leaves emails, handles and ordinary text alone", () => {
		const clean = [
			"Mail dana@example.com or dana@company.co.uk about it",
			"ping @Kai2024 in #eng",
			"me@MongoDB2026.com is not a password",
			"password reset is scheduled for Friday",
			"the token ring network",
			"high-level well-known state-of-the-art",
			"see https://docs.example.com:8443/path",
		]
		for (const text of clean) {
			const r = redactSecrets(text)
			expect(r.text, text).toBe(text)
			expect(r.found, text).toEqual({})
		}
	})

	it("redacts known key shapes", () => {
		const cases: Array<[string, string]> = [
			["AKIAABCDEFGHIJKLMNOP", "aws-access-key"],
			[`ghp_${"a1".repeat(18)}`, "github-token"],
			["xoxb-1234567890-abcdefghij", "slack-token"],
			[`sk-ant-${"x9".repeat(15)}`, "llm-api-key"],
			[`AIza${"B".repeat(35)}`, "google-api-key"],
			[`al-${"Q7".repeat(22)}`, "voyage-key"],
			["eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4", "jwt"],
			["Ab1cD-eF2gH-iJ3kL-mN4oP-qR5sT", "app-password"],
		]
		for (const [secret, kind] of cases) {
			const r = redactSecrets(`key is ${secret} ok`)
			expect(r.text, kind).toBe(`key is [REDACTED:${kind}] ok`)
			expect(r.found, kind).toEqual({ [kind]: 1 })
		}
	})

	it("redacts assignments, keeping the variable name", () => {
		const r = redactSecrets(
			'DB_PASSWORD=s3cr3tvalue\napi_key: "abcd1234efgh"\nclient-secret = zzzzzzzz',
		)
		expect(r.text).toBe(
			'DB_PASSWORD=[REDACTED:assignment]\napi_key: "[REDACTED:assignment]"\nclient-secret = [REDACTED:assignment]',
		)
		expect(r.found).toEqual({ assignment: 3 })
		const env = redactSecrets(
			"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG\nMONGO_PASS: abcdef12",
		)
		expect(env.text).toBe(
			"AWS_SECRET_ACCESS_KEY=[REDACTED:assignment]\nMONGO_PASS: [REDACTED:assignment]",
		)
	})

	it("redacts a whole PEM private key block", () => {
		const pem =
			"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAA\n-----END OPENSSH PRIVATE KEY-----"
		const r = redactSecrets(`deploy key:\n${pem}\nthanks`)
		expect(r.text).toBe("deploy key:\n[REDACTED:private-key]\nthanks")
	})

	it("counts and merges findings", () => {
		const a = redactSecrets("x://u:pw123456@h and AKIAABCDEFGHIJKLMNOP")
		expect(redactionCount(a.found)).toBe(2)
		expect(mergeRedactions({ "uri-password": 1 }, a.found)).toEqual({
			"uri-password": 2,
			"aws-access-key": 1,
		})
	})
})
