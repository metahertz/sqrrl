// The SQRRL mark: a bold line squirrel, for squirreling knowledge away (and
// for "oh look, a squirrel"). Thick lines and no tile, because it is shown
// at 16-32px where detail is lost. It draws in the accent color, so it
// follows the theme; app/icon.svg is the same drawing in fixed amber.

export const BRAND = "SQRRL"
export const TAGLINE = "Squirrel it away now. Find it again later."

export function SqrrlMark({ size = 26 }: { size?: number }) {
	return (
		<svg
			className="mdb-brand-mark"
			width={size}
			height={size}
			viewBox="5 4 57 57"
			aria-hidden="true"
		>
			<g
				fill="none"
				stroke="currentColor"
				strokeWidth="6.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M38 52C53 53 59 41 57 27C55 14 44 8 37 12C31 16 33 25 40 23" />
				<path d="M10 28C10 22 14 18 19 17L23 11L27 18C30 20 31 25 30 29C35 33 38 40 37 46C36 51 33 53 29 53H18C15 49 15 43 17 38C16 35 17 33 18 32C14 32 11 31 10 28Z" />
			</g>
			<circle cx="19" cy="24" r="2.6" fill="currentColor" />
		</svg>
	)
}
