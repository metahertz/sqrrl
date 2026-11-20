import { redirect } from "next/navigation"

// SQRRL is the console; / opens it.
export default function Home(): never {
	redirect("/dashboard")
}
