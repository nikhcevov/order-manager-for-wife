# Design

## Context

`Primary` (`apps/web/src/ui.tsx:10-13`) renders an in-page `.primary.wide` button and, as a side effect, shows Telegram's native MainButton through `useNativePrimary` (`apps/web/src/telegram.ts:46-57`). The native button is a single app-level control whose label, enabled state, and visibility are driven by whichever `Primary` is mounted; on unmount the hook hides it. `BackButton` (native header back navigation) is driven separately by `useTelegram` (`telegram.ts:34-39`) and is unaffected.

See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**
- Remove Telegram's native MainButton from the Mini App entirely.
- Leave every in-page primary action button in place, unchanged.
- Remove the plumbing that exists only for the MainButton.

**Non-Goals:**
- Relocating, restyling, or making sticky any in-page primary button.
- Removing the `.page-footer` text (`App.tsx:100`) — out of scope for this change.
- Changing `BackButton`, theme handling, or safe-area handling.

## Decisions

- **Delete `useNativePrimary` rather than leave a no-op.** The hook has no other caller; a no-op would be dead weight. `Primary` keeps its signature (`children`, `onClick`, `disabled`, `busy`) and its in-page rendering; only the hook call is removed.
- **Shrink the native-button type to `show | hide | onClick | offClick`** (the members `BackButton` uses) and drop `MainButton` from `TelegramWebApp`, so the type stops describing a control the app no longer drives.
- **Accept the below-the-fold cost on product detail and the cart** (product decision: remove only, minimal). The primary action is reachable by scrolling rather than always on screen.
- **Keep `.content` bottom padding on `env(safe-area-inset-bottom)`** so device insets are still respected without the bar.

*Alternatives considered:* keep the native MainButton and drop the in-page button (rejected — no primary action outside Telegram or in local development); make the in-page button `position: sticky` (rejected — recreates the fixed bottom bar this change removes).

## Risks / Trade-offs

- **Reachability.** Users lose the always-visible primary action; on product detail and the cart they must scroll to the bottom. Accepted by the product owner.
- **Verification is live-only.** The native bar cannot be reproduced in a plain browser: `telegram-web-app.js` no-ops outside Telegram and `telegram.ts:18` reads `window.Telegram?.WebApp` once at import. Verification is performed inside Telegram — the bottom bar must be absent on product detail and the cart and the in-page buttons must still work. No permanent automated test is added; the repo has no browser harness and building one is out of scope.
