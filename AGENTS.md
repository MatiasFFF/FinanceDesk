# Prototype Instructions

## Mandatory execution discipline

- Prioritize the user's explicitly requested real functionality and the shortest usable end-to-end path.
- Absolutely prohibit unnecessary review, audit, approval gates, engineering infrastructure, fallbacks, compatibility work, abstraction, refactoring, and expansion. Do none of them unless they are genuinely indispensable to the current explicit requirement, preventing real data loss, or the minimum verification needed to prove that requirement works.
- Never use those activities to replace, delay, or dilute functional construction. If one is truly necessary, explain its concrete necessity and smallest possible scope to the user before doing it.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Durable FinanceDesk decisions

- The only valid project path is `/Users/matias/Project/FinanceDesk`; do not recreate or use `FinanceSystem`.
- Work local-first. Keep the localhost prototype and standalone HTML usable; do not configure GitHub, Vercel, or the custom domain until the user approves the local result.
- Support normal responsive browser layouts on macOS, Windows, iPad, and mobile. The earlier 4:3 request was accidental and was explicitly withdrawn.
- Use the selected Claude-like visual language: warm off-white, terracotta, deep brown, and sage; keep the UI concise, attractive, and practical, without filler copy.
- The selected product anatomy combines three views in one workflow: monthly close overview, batch reconciliation workspace, and single-transaction evidence review.
- Visible controls must produce meaningful state changes and complete real local data flows; do not present a decorative shell as finished functionality. External bank, tax, and AI integrations must be labeled as later-stage capabilities rather than simulated as connected.
- For visual acceptance, use the user's existing localhost page in the iPad split-screen Edge setup. Do not open extra browser windows on the Mac unless the user explicitly asks.
- This task is the control task. Do not create the three separate, sidebar-visible implementation tasks until the user explicitly confirms the migration and local state are OK; do not substitute internal subagents for those tasks.
