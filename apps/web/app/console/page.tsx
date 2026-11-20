import { redirect } from "next/navigation"

// The console's functions moved into /dashboard: the wiki tabs became the
// graph and its detail panel, and the memory-layer tabs became the advanced
// section there. A redirect rather than a deletion so existing bookmarks and
// links keep working.
export default function ConsoleRedirect(): never {
	redirect("/dashboard")
}
