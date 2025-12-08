# Repository Guidelines

## Project Structure & Module Organization
- `src/index.tsx`: Koishi plugin entry; registers the `comfy` command, validates config, and orchestrates workflow execution plus optional LLM prompt shaping.
- `src/ComfyUINode.ts`: HTTP/WebSocket client for ComfyUI (queueing, history, image retrieval, interrupts). Keep network changes isolated here.
- `src/sample-workflow.json`: Example workflow; the string `114514.1919810` is replaced with the user prompt at runtime—preserve this placeholder in new samples.
- Generated outputs live in `lib/` and `dist/` (both git-ignored). Type declarations emit to `lib/` via `tsconfig.json`. `.editorconfig` defines shared spacing/line endings.

## Build, Test, and Development Commands
- `npm install`: Install dependencies for local editing and type-checking.
- `npx tsc -p tsconfig.json`: Type-check and emit `.d.ts` to `lib/` (no JS build; Koishi will compile at runtime/publish time).
- Local plugin test: link or copy this package into a Koishi bot, add a valid `workflowJSON`, `picOutputNodeID`, and ComfyUI endpoint, then run `comfy <prompt>` to verify end-to-end.

## Coding Style & Naming Conventions
- Follow `.editorconfig`: 2-space indentation, LF endings, UTF-8, trim trailing whitespace, final newline.
- Target ES2022 modules; prefer `async/await` and early returns for error handling.
- Use camelCase for config keys and method names; keep command keywords lowercase (e.g., `comfy`).
- When extending schemas, mirror existing `Schema.object` patterns and supply defaults/descriptions for Koishi UI clarity.
- Favor explicit typing over `any` for new surfaces (request/response shapes, workflow nodes).

## Testing Guidelines
- No automated test suite yet; smoke-test against a running ComfyUI server. Verify queueing, progress, and image retrieval for at least one workflow using `src/sample-workflow.json`.
- When changing WebSocket or request flow, test both secure (`https`/`wss`) and insecure modes, and validate SFW filtering paths if LLM is enabled.
- Capture console output for execution progress; attach logs in PRs when fixing runtime issues.

## Commit & Pull Request Guidelines
- Existing history uses short imperative subjects (e.g., `update 1.0.0`); keep messages concise and action-oriented.
- For PRs, include: summary of changes, test notes (commands run and environment), Koishi/ComfyUI versions, and screenshots or returned filenames if image output is affected.
- Reference related issues when applicable; highlight any config changes or new required secrets.

## Security & Configuration Tips
- Never commit API keys for LLM providers; load them via Koishi config or environment. Avoid printing prompts/keys in logs unless debugging locally.
- When enabling `isSecureConnection`, ensure endpoints support `https`/`wss`; avoid mixed-content setups in production bots.
