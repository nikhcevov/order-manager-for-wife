# Proposal

## Why

The shop serves a Russian-speaking household and its Russian-speaking customers, yet every user-visible string is inline English JSX and roughly 55 server error messages are rendered verbatim in English. Customers must read English to reserve an order, submit payment evidence, and understand why a reservation expired; the seller must read English to review payments and ship packages. Telegram already supplies each user's language on every launch, so the app can present Russian by default without adding a language picker or storing a preference.

## What Changes

- Add a frontend localization layer (`i18next` + `react-i18next`) with typed English and Russian catalogs, where the English catalog remains the source of key shape.
- Translate every user-visible string across both workspaces: catalog, cart, order and package detail, product editor, payment and change queues, tabs, buttons, notices, confirmation dialogs, `aria-label`s, placeholders, empty states, and the `statusLabels`/`methodLabel` maps.
- Present server failures in the active language by mapping the stable machine-readable `error.code` (35 distinct codes) on the client and interpolating the accompanying `details` (shortages, product id, reserved/stock, totals); zod `invalid_input` field issues map by field. The server's English `message` remains the fallback for any unmapped code.
- Resolve the UI language from the language code the Telegram client reports for the current user, read before the first render so launch, loading, and session-failure screens are localized too, and without a session or stored preference. `ru` and its regional variants, plus `uk`, `be`, `kk`, `ky`, `uz`, and `tg`, resolve to Russian; every other value and a missing value resolve to English.
- Replace the eight `(s)` plural hacks with real plural forms so both languages inflect correctly (Russian needs one/few/many forms).
- Format money and dates in the active language instead of the device locale, and set the document language so assistive technology and hyphenation follow the resolved language.
- Move the body font off `DM Sans`, which ships no Cyrillic subset, to the already-loaded `Manrope`, which covers Cyrillic; no new font request is introduced.
- Store eyebrow labels in natural case and uppercase them in CSS instead of hardcoding capital letters in each string.

No existing behavior is removed, and the API is unchanged: the English error `message` stays on the wire and remains the fallback for any code without localized text.

## Capabilities

### New Capabilities
- `ui-localization`: resolving the Mini App language from verified Telegram launch data, presenting every customer and seller string in Russian or English, presenting server failures by their stable code, and formatting money and dates in the active language.

### Modified Capabilities
None. No existing spec pins the session response shape or the language of user-visible text, so no requirement in `telegram-access` or elsewhere changes.

## Impact

- `apps/web/src`: new `i18n/` module (initialization, typed `en`/`ru` catalogs, locale-bound formatters, error descriptions); all of `App.tsx`, `customer.tsx`, `seller.tsx`, `ui.tsx`, and the user-facing strings in `api.ts` routed through the catalogs; `telegram.ts` extended to expose the client-reported language; `index.html` and `styles.css` for the `lang` attribute, eyebrow casing, and body font.
- `apps/api/src`: unchanged. Language resolution stays client-side because the launch, loading, and session-failure screens render before any session exists, and no server-produced text needs a localization decision.
- Dependencies: `i18next` and `react-i18next` added to the web workspace. No API dependency changes.
- Verification: the API behavior suite is untouched because the API does not change; the Mini App has no unit-test harness, so both languages are verified in a browser across customer and seller screens.
