# Baseline Commit Decisions

Decision date: 2026-07-20 (Europe/Berlin)

These decisions finalize the seven nonblocking items identified in `SAFE_BASELINE_REVIEW.md`. They preserve the current project work as a pre-security baseline and do not assert that the preserved behavior is correct.

| Item | Decision | Reason |
| --- | --- | --- |
| `services/discord-bot/.env` | Keep and commit the tracked placeholder-only template in the existing project-source/configuration baseline group. Do not rename it during baseline preservation. | The working tree and inspected committed revisions contain placeholders only. Real local credentials belong in the already-ignored `.env.local`. Renaming the tracked template would require a separate consumer/documentation migration and would change the baseline rather than preserve it. |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` | Commit the three complete reviewed working-tree files in the existing project-source/configuration baseline group. Do not reconstruct or split them during this preservation task. | Their changes are mixed by intent, but the lockfile represents the complete current manifest/workspace state. Reconstructing or partially editing dependency metadata would alter the preserved baseline. Future work should separate Discord scripts, lint orchestration, the `undici` override, and catalog cleanup. |
| `apps/stage-tamagotchi/src/preload/{beat-sync.ts,index.ts,shared.ts}` | Accept and commit the tracked deletions together with `src/preload/renderer.cjs`, the shared preload loader, window wiring, sandbox paths, storage implementations, configuration, and focused tests. | Current references use the replacement sandbox-compatible CJS preload boundary. Committing only the deletions or only the replacements would leave an incomplete Electron refactor. |
| `design-qa.md` | Deliberately exclude this untracked file from the baseline commits and leave it as a local-only QA artifact. | Its evidence references point to machine-local `/private/tmp` screenshots that are not part of the repository. Committing the report without durable evidence would create nonportable documentation; rewriting it without the evidence owner would be speculative. |
| `security_best_practices_report.md` | Commit it with the separately identifiable previous-security-task baseline group. | It is the audit context used to identify that group, contains no credential signature, and is useful for the subsequent security review. It remains separate from general feature commits. |
| `.agents/skills/airi-chat-experience/**` | Commit the complete skill as repository-level agent tooling. | It is AIRI-specific, internally complete, and useful to contributors performing reproducible chat research, implementation, and review. It contains no machine state or generated output. |
| Discord launcher source and documentation | Commit `scripts/airi-discord-dashboard-window/**` source/docs, `scripts/airi-discord-launcher-app/README.md`, `scripts/dev-airi-discord.command`, their focused tests, and repository documentation references in the tooling baseline group. | Repository tests and contributor docs reference this maintained source. Generated `.app` bundles, runtime state, logs, Desktop aliases, and secrets remain ignored or absent. |

## Commit grouping adjustment

The detailed groups from `SAFE_BASELINE_REVIEW.md` are consolidated into five preservation commits to keep the task reviewable without editing application behavior:

1. Git hygiene, contributor guidance, baseline reports, and these decisions.
2. Existing project source, configuration, manifests, lockfile, and non-security documentation.
3. Existing tests and test infrastructure not already inseparable from the security-task group.
4. Separately identifiable previous security-task source, tests, configuration, and report.
5. Approved repository-level agent/launcher tooling plus the final baseline commit report.

Files are assigned once. When a file mixes multiple intents, it stays intact in the smallest coherent baseline group rather than being rewritten solely to manufacture commit boundaries.
