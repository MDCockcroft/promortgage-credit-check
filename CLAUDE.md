# Persistent memory (Obsidian vault)

Cross-session memory for this project lives in the Obsidian vault:
`~/vault/Projects/Promortgage-system/` (hub: `promortgage-system.md`; durable
decisions: `architecture/decisions.md`). Vault-wide rules: `~/vault/CLAUDE.md`.

3-layer context rule — cheapest first, read source last:
1. **Graph** — `graphify query "<question>"` for code structure.
2. **Vault** — `architecture/decisions.md` + recent `~/vault/logs/*-promortgage-*.md`
   for decisions, context, and progress.
3. **Source** — read raw files only when editing, or when layers 1–2 fall short.

Session commands (real slash commands): `/mem-resume` at start, `/mem-save` at end.
The vault holds durable decisions + logs; **live status stays in this repo's own
docs** (never copy it into the vault). Never put secrets/PII in the vault
(iCloud-synced).
The graphify Obsidian export lives at `~/vault/graphify/promortgage-credit-check/`
(auto-generated — refresh with
`graphify export obsidian --dir ~/vault/graphify/promortgage-credit-check`).
