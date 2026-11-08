# AI Usage Log

This file documents how AI tools contributed to Slotbook. Keep it factual and update it to reflect the actual development process before sharing the project.

## Where AI helped

AI was used as a development assistant to discuss implementation approaches, draft or review code, and think through edge cases in scheduling, booking concurrency, and time-zone handling. Suggestions were treated as starting points and reviewed against the project requirements and existing code.

## Where AI misled me

I do not have a specific verified example recorded here yet. Add one if applicable: describe the suggestion or assumption, why it was wrong for this project, and how it was corrected. Do not invent an example.

## How I checked AI output

I reviewed proposed changes in context and used the project checks where applicable:

- `pnpm test` for API and slot behavior, including concurrency, idempotency, expiry, booking conflicts, buffers, and DST cases.
- `pnpm typecheck` for TypeScript errors.
- `pnpm test:e2e` for the guest booking flow.
- Manual review of database migrations, transaction and locking behavior, and user-facing flows.

Only describe checks that were actually run for the changes in question. The presence of a test or script in the repository does not mean it was run.

## Notes to complete before sharing

- Add the AI tool(s) used, if you want to identify them.
- Replace the “no specific verified example” note with a real example if one occurred.
- Confirm which checks you personally ran and note any relevant results.
