# Tasks

## 1. Remove the native MainButton plumbing

- [x] 1.1 In `apps/web/src/telegram.ts`, delete `useNativePrimary`, remove `MainButton` from the `TelegramWebApp` interface, and reduce the native button type to the members `BackButton` uses; verify `npm run typecheck -w apps/web` passes.
- [x] 1.2 In `apps/web/src/ui.tsx`, remove the `useNativePrimary(...)` call from `Primary` while keeping its signature (`children`, `onClick`, `disabled`, `busy`) and in-page button; verify `npm run typecheck -w apps/web` passes and `grep -rn "MainButton\|useNativePrimary" apps/web/src` returns no matches.

## 2. Build verification

- [x] 2.1 Run `npm run build -w apps/web`, confirm it succeeds, and confirm the built bundle references nothing named `MainButton` (`grep -rn "MainButton" apps/web/dist` returns no matches).

## Workflow follow-up

- Verify live in Telegram: open the Mini App and confirm the native bottom bar is absent on product detail and the cart, and that the in-page primary buttons still work.
- Archive the change after live verification.
