// Settings were named MDBRAIN_* before the SQRRL rename (2026-11-20). An
// entry point imports this first, so a machine still configured with the old
// names (a Mac agent, an MCP config) keeps working: each MDBRAIN_X is copied
// to SQRRL_X unless SQRRL_X is already set. No dependencies, so it runs
// before any module that reads the environment at import time.

const OLD = "MDBRAIN_"
const NEW = "SQRRL_"

/** Copies MDBRAIN_* to SQRRL_* where the new name is unset. Returns the
 *  names it copied (for a startup note). */
export function applyLegacyEnv(
	env: Record<string, string | undefined> = process.env,
): string[] {
	const copied: string[] = []
	for (const [k, v] of Object.entries(env)) {
		if (!k.startsWith(OLD) || v === undefined) continue
		const name = NEW + k.slice(OLD.length)
		if (env[name] !== undefined) continue
		env[name] = v
		copied.push(name)
	}
	return copied
}

applyLegacyEnv()
