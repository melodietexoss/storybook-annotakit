# Incident runbook — "an old PAT shadows every re-bake"

Extracted from SKILL §4 (v0.6.11) — situational: read when the static demo
stops publishing while a fresh re-bake works elsewhere.

A browser that EVER saved a token override keeps using it across every re-bake.

1. v0.6.7: a 401 from a SAVED token usually SELF-HEALS — the engine drops it in favor of a DIFFERENT, valid baked token (repo/labels/poll overrides survive; op + pull backoff cleared; trace = the quiet settings hint "the previously saved token was rejected (401) — publishing with this deployment's built-in token"). Fires only when the bake's token differs AND the effective endpoints match.
2. Still stuck (heal declines): override token === baked token, an endpoint redirect, or no valid bake. Symptom: red dot / 401s while a fresh re-bake works elsewhere; settings shows `tokenOverridden` + the amber warning.
3. Manual: **use baked** (drops ONLY the token override) or paste a fresh PAT (whitespace-only ignored). Verify: green dot, queue drains; a follower tab's Sync claims the lease or honestly reports it held.
4. Dev-server twin: rotate `ANNOTAKIT_GH_TOKEN` in .env → `POST /annotakit/api/gh/reload` → `gh.tokenState` leaves `rejected`; a LIVE tab self-heals on its next 401.
5. WHOLE-PAT death (API 401 "Bad credentials" + git "Invalid username or token"): rotate the origin URL, examples/nimbus/.env, AND re-bake the demo (its annotakit-gh.json embeds the token) — one missed location leaves the chain half-dead.
