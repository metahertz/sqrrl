// Inline stroke icons for the console (24px grid, currentColor), so the UI
// needs no icon dependency. Paths follow the common outline-icon idiom.

type IconProps = { size?: number; className?: string }

function make(paths: string[]) {
	return function Icon({ size = 16, className }: IconProps) {
		return (
			<svg
				width={size}
				height={size}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth={1.8}
				strokeLinecap="round"
				strokeLinejoin="round"
				className={className}
				aria-hidden="true"
			>
				{paths.map((d) => (
					<path key={d} d={d} />
				))}
			</svg>
		)
	}
}

export const IconActivity = make(["M3 12h4l3-8 4 16 3-8h4"])
export const IconHome = make(["M3 10.5 12 3l9 7.5", "M5 9.5V21h14V9.5"])
export const IconSparkle = make([
	"M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z",
	"M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
])
export const IconGraph = make([
	"M6 6m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0",
	"M18 8m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0",
	"M10 18m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0",
	"M8.3 7.1l7.4.7M7.2 8.3l2 7.3M16.3 9.8l-4.6 6.3",
])
export const IconCheck = make(["M4 12.5l5 5L20 6.5"])
export const IconTask = make([
	"M9 11l3 3 8-8",
	"M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9",
])
export const IconCalendar = make([
	"M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z",
	"M16 3v4M8 3v4M4 11h16",
])
export const IconUsers = make([
	"M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
	"M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2",
	"M16 3.1a4 4 0 0 1 0 7.8M21 21v-2a4 4 0 0 0-3-3.9",
])
export const IconHash = make(["M5 9h14M5 15h14M11 4L7 20M17 4l-4 16"])
export const IconNote = make([
	"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z",
	"M14 3v5h5M9 13h6M9 17h4",
])
export const IconSettings = make([
	"M12 15a3 3 0 1 0 0-6a3 3 0 0 0 0 6z",
	"M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3a1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8a1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
])
export const IconSearch = make([
	"M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0",
	"M21 21l-4.3-4.3",
])
export const IconPlus = make(["M12 5v14M5 12h14"])
export const IconX = make(["M18 6L6 18M6 6l12 12"])
export const IconExternal = make([
	"M14 4h6v6M20 4l-9 9",
	"M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
])
export const IconRefresh = make(["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"])
export const IconSun = make([
	"M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
	"M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
])
export const IconMoon = make(["M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"])
export const IconLink = make([
	"M10 14a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1 1",
	"M14 10a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1-1",
])
export const IconTrash = make([
	"M4 7h16M10 11v6M14 11v6",
	"M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
])
export const IconHistory = make([
	"M3 12a9 9 0 1 0 3-6.7L3 8",
	"M3 3v5h5",
	"M12 7v5l3 3",
])
export const IconEdit = make(["M4 20h4L19 9l-4-4L4 16z", "M14 6l4 4"])
export const IconFocus = make([
	"M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
	"M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3",
])
export const IconBook = make([
	"M4 19.5A2.5 2.5 0 0 1 6.5 17H20",
	"M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
	"M9 7h7M9 11h5",
])
export const IconKey = make([
	"M15 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
	"M12.2 9.8L3 19v2h3v-2h2v-2h2l2.2-2.2",
])
