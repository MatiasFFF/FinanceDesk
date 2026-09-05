# Prototype Instructions

## Mandatory execution discipline

- Prioritize the user's explicitly requested real functionality and the shortest usable end-to-end path.
- Absolutely prohibit unnecessary review, audit, approval gates, engineering infrastructure, fallbacks, compatibility work, abstraction, refactoring, and expansion. Do none of them unless they are genuinely indispensable to the current explicit requirement, preventing real data loss, or the minimum verification needed to prove that requirement works.
- Never use those activities to replace, delay, or dilute functional construction. If one is truly necessary, explain its concrete necessity and smallest possible scope to the user before doing it.
- Before running any test, check, or listener, tell the user exactly what will run and why. If work is blocked, report the concrete blocker once instead of retrying mechanically.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Durable FinanceDesk decisions

- The only valid project path is `/Users/matias/Project/FinanceDesk`; do not recreate or use `FinanceSystem`.
- Work local-first. Keep the localhost prototype and standalone HTML usable; do not configure GitHub, Vercel, or the custom domain until the user approves the local result.
- 当前只把本地服务与功能做精；微信小程序、真实银行/税务/其他业务系统连接、外部账号密码、联网 API 和上传外部平台均延后，不纳入当前完成度。开发时允许研究 GitHub、下载开源依赖；产品资料处理应在本地，不依赖联网识别。
- Support normal responsive browser layouts on macOS, Windows, iPad, and mobile. The earlier 4:3 request was accidental and was explicitly withdrawn.
- Use the selected Claude-like visual language: warm off-white, terracotta, deep brown, and sage; keep the UI concise, attractive, and practical, without filler copy.
- Preserve capability while keeping the interface simple and clear. Show only information and actions needed for the current decision; remove unnecessary buttons, repeated status blocks, filler explanations, and implementation terminology from existing screens as well as new work. Reuse existing entry points, reveal necessary low-frequency details on demand, and do not default to adding more tabs, panels, or controls. Simplification must not discard financial evidence, required confirmations, or unsaved input.
- 每轮整合后按当前本地功能范围汇报完成度区间、实际新增能力、验证层级和主要剩余项，第一阶段单列；旧的“完整 Markdown”比例仅作历史，不将延后范围或测试通过率纳入当前完成度。
- 功能建设优先；新增功能仅做必要验证，每轮整合集中验收一次；已通过且未变更的部分不重复核验，只因新变化、失败或明确风险补查。
- The selected product anatomy combines three views in one workflow: monthly close overview, batch reconciliation workspace, and single-transaction evidence review.
- Visible controls must produce meaningful state changes and complete real local data flows; do not present a decorative shell as finished functionality. External bank, tax, and AI integrations must be labeled as later-stage capabilities rather than simulated as connected.
- UI quality and functional completeness are the highest product priorities. Keep large-screen layouts polished and responsive, align foundation-data forms precisely, and remove rough, doubled, fuzzy, or cheap-looking borders and spacing.
- A newly created workspace must start as a neutral financial workspace. Fitness-specific modules such as members, coaches, packages, and verification may appear only when the user selects an applicable template or enables them; workspace modules must be configurable rather than locked in.
- Charts of accounts, accounting roles, business terminology, and industry rules must be editable per workspace instead of being permanently tied to the fitness-studio example.
- For visual acceptance, use the user's current single-screen browser setup; the earlier iPad split-screen setup has been closed. Only this control task may use Computer Use, and implementation tasks must never use it.
- 总控专注任务分工、进度、Computer Use 验收和整合；代码与文档写入优先分配给实施任务，避免总控上下文膨胀。
- Keep the repository on the single `main` branch. Do not create or retain additional branches or worktrees; parallel implementation tasks share the current checkout, and the control task alone commits and pushes their completed changes.
- The current control task is `01a06f58-c143-7271-9178-dc127f858264` (`FinanceDesk｜总控`). On 2026-09-05 the user explicitly authorized archiving the previous FinanceDesk tasks and opening three new sidebar-visible optimization tasks. Those tasks are implementation tasks, share this saved project on `main`, and must follow their assigned file boundaries; do not substitute internal subagents for them. Only the control task coordinates shared-file changes, Computer Use, commits, and pushes.
