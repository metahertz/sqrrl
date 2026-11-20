import { redirect } from "next/navigation"

// The graph is now one view within /dashboard rather than a page of its own.
export default function GraphRedirect(): never {
	redirect("/dashboard")
}
