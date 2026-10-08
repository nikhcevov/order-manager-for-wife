# Proposal

## Why

Screens that render the `Primary` component draw Telegram's native MainButton as a fixed bottom bar *in addition to* the in-page primary button, so the same action ("Add to cart", "Review current prices", "Submit evidence for review", ...) appears twice. The duplicate bar is visual noise, and because it shows and hides as the active route changes, the visible page height jumps during navigation.

## What Changes

- Delete `useNativePrimary` in `apps/web/src/telegram.ts` and stop calling it from `Primary` in `apps/web/src/ui.tsx`.
- Keep every in-page primary action button exactly where it is — no layout, copy, or CSS changes.
- Drop the now-unused `MainButton` member from the `TelegramWebApp` type and shrink the native button type to the members `BackButton` actually uses.
- No breaking API, data, or configuration changes.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- None. No requirement text changes. `telegram-access` → *Telegram-native mobile presentation* still holds: the app keeps back navigation and clear primary actions (now in-page only) and no longer overlaps Telegram controls at the bottom. This change therefore sets `skip_specs: true`.

## Impact

- Frontend only: `apps/web/src/telegram.ts`, `apps/web/src/ui.tsx`. Nothing else imports `useNativePrimary` or `MainButton`.
- No API, database, migration, dependency, or configuration changes.
- Affected screens (the 9 in-page primary buttons): product detail, cart / edit-order selection editor, order detail, group detail, product editor, seller products, seller queue change review.
- Accepted trade-off: the primary action is no longer always on screen; on product detail and the cart it sits at the end of the page and may require scrolling to reach.
- Verification constraint: the native bar exists only inside Telegram and is absent in a plain browser, so removal is verified live in Telegram rather than in a browser.
