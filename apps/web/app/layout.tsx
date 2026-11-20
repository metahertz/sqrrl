import type { Metadata } from "next"
import type { ReactNode } from "react"
import "./globals.css"

const title = "SQRRL | Squirrel away what you know"
const description =
	"A self-hosted second brain: notes, meetings, Slack and mail squirreled away into one cited wiki, so nothing is lost when the next squirrel comes along."
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3040"
const socialImage = "/opengraph-image"

export const metadata: Metadata = {
	metadataBase: new URL(siteUrl),
	title,
	description,
	openGraph: {
		title,
		description,
		url: siteUrl,
		siteName: title,
		images: [
			{
				url: socialImage,
				width: 1200,
				height: 630,
				alt: "SQRRL squirrels away notes, meetings, Slack and mail into one cited wiki.",
			},
		],
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title,
		description,
		images: [socialImage],
	},
}

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	)
}
