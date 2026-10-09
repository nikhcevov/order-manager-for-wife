# Design

## Context

See proposal.md for motivation. Current state that shapes the approach:

- Every user-visible string is an inline literal in five web modules: `App.tsx` (shell, tabs, launch and failure screens), `customer.tsx` (catalog, cart, order and package detail), `seller.tsx` (product editor, payment and change queues), `ui.tsx` (shared primitives), and `api.ts` (status and method labels plus the formatters).
- The API returns an English `error.message`, which `App.tsx` renders verbatim through `setError` and `setLoginError`. Each failure also carries a stable machine-readable `error.code` that the client already branches on, plus structured `details` (shortages, product id, reserved/stock, totals).
- `money`, `date`, `priceInput`, and `toMinor` call `Intl` with an `undefined` locale, so they follow the device locale rather than the interface language.
- `<html lang="en">` is static. `.eyebrow` has no `text-transform`, so eyebrow captions are hardcoded in capitals.
- Body text uses `DM Sans`, which ships no Cyrillic subset; headings use `Manrope`, which covers `cyrillic` and `cyrillic-ext`. Both load from one Google Fonts request.
- `index.html` loads `telegram-web-app.js` synchronously in `<head>` before the module script, so `window.Telegram.WebApp.initDataUnsafe` — the same object field the existing auth path already depends on for `initData` — is populated before the first render.
- The API behavior suite asserts only that `error.message` is a string. The web workspace has no test harness.

Hard constraint: the launch, loading, expired, and denied screens render before any session exists, so the language must be known before the first render, without a session.

## Goals / Non-Goals

**Goals:**

- One language for the whole app, decided before the first render, in both the customer and seller workspaces.
- Server failures readable in the resolved language, keeping the machine-readable code as the contract.
- Correct grammatical number forms, locale-correct money and date presentation, one typeface covering both scripts.
- A missing or stale translation is a build error, not a silent English fallback.

**Non-Goals:**

- No language switcher and no persisted preference; the spec forbids both.
- No server-side message catalog and no `Accept-Language` handling; the API is unchanged.
- No translation of operator- or user-supplied content (`paymentInstructions`, product names and comments, order references, delivery codes, customer names) or of the shop's brand name.
- No third language, and no frontend test harness.

## Decisions

**1. Language comes from the Telegram client, resolved on the client.**
`telegram.ts` exposes the client-reported language code, and the i18n module resolves Russian or English from it at module initialization.
Alternative considered: the API parses `user.language_code` during launch validation and returns `language` on the session response. Rejected — it has no consumer. Server-produced text needs no language decision under decision 5, and the pre-session screens have no session to carry a language, so a client-side resolution would be required regardless. Two sources could then disagree, and the verified one would win over a client value that selects a translation only.

**2. `i18next` with `react-i18next`.**
Alternatives: `react-intl` (ICU is capable, but needs message extraction tooling and is heavier for a two-locale, one-file-per-locale shape); `@lingui` (compile-time macros mean a new babel/vite build step); a hand-rolled dictionary (zero dependencies, but it still needs plural selection — eight count-bearing strings across two languages — and interpolation, which is exactly what `Intl.PluralRules`-backed `i18next` already provides).

**3. Catalogs are TypeScript modules, and each translated area is compile-time checked against English.**
`en` is the key-shape source. Every Russian area calls `assertCatalogCovers<typeof en, typeof ru>()`, a type-level check that reports each key English defines but Russian omits; plural suffixes collapse onto their shared stem, so Russian may carry `_few` and `_many` forms that English does not need. The English catalog is also the source of `CustomTypeOptions.resources`, so every `t('area.key')` literal is checked against it — confirmed working, including plural stems and interpolation options.
The alternative — annotating `ru` with `typeof en` — cannot work, because an exact structural match forbids the extra Russian plural forms. JSON catalogs would have neither parity nor key checking, and the most likely defect class with roughly 380 keys is a silently untranslated string that falls back to English unnoticed.

**4. Synchronous initialization (`initAsync: false`).**
The first render is already localized; there is no flash of English on a Russian device and no need for a loading gate around the provider. React suspense is disabled for the same reason.

**5. Server failures are described from their code, not their sentence.**
`api.ts` stays transport-only and throws the same `ApiError(status, code, message, details)` it does today, with one addition: a rejected `fetch` is converted at that boundary into `ApiError(0, 'network', …)`, so a transport failure carries a code like every other failure. A `describeError` helper in the i18n layer returns localized text: it prefers a catalog entry for the code, interpolates `details`, maps `invalid_input` field issues to field-specific text, falls back to the server `message` for an unmapped code, and maps the client-only `network` and `request_failed` codes (a response with no machine-readable code, such as an error page from a proxy) to localized text. The shortage interpolation currently inlined in `App.tsx` moves into that helper.
Messages produced on the client rather than by the API — local form validation and the private-image load failure — are localized where they are thrown and reach the surface unchanged, because the helper returns a non-API error's own message. A completeness check keeps the code map in step with the API source.
Rationale: the codes are already the contract the client branches on, and the server keeps a single canonical message. The cost is a client-side list of codes, which the compiler cannot verify against the server; unmapped codes degrade to the server sentence rather than to an empty error.

**6. Formatting moves to the i18n layer, bound to the resolved language.**
`money`, `date`, `priceInput`, and `toMinor` move out of `api.ts` into `i18n/format.ts` and pass the resolved locale to `Intl`. The minor-unit arithmetic is untouched: the fraction digits still derive from the configured currency, and now do so through a fixed locale rather than the device's, so the digit count — and therefore the minor-unit value stored for a given typed price — is identical in both languages. Displayed totals differ only in presentation, never in value. Russian presentation uses `ru-RU` and English uses `en-US`, chosen explicitly so the result never depends on the device locale.

**7. Statuses and methods become catalog keys.**
The exported `statusLabels` record and `methodLabel` function become `statusLabel()` and `methodLabel()` accessors over catalog keys, so badges and package headings translate with everything else.

**8. Count-bearing strings use i18next plural forms.**
The eight `(s)` literals (`paid item(s)`, `nonpaid order(s)`, `private draft(s)`, `uploaded screenshot(s)`, and the rest) become counted keys with `_one`/`_few`/`_many`/`_other` forms as each language requires.

**9. The body font becomes `Manrope`.**
It is already loaded for headings and covers Cyrillic, so no new request is added. A per-glyph fallback stack (`DM Sans` for Latin, another family for Cyrillic) was rejected because it mixes typefaces inside a single line such as a Russian sentence containing an order reference.

**10. Eyebrow captions are stored in natural case.**
`.eyebrow` gains `text-transform: uppercase`, so Russian captions are not authored in capitals and the rendered result is unchanged.

**11. The document language follows the resolved language.**
`document.documentElement.lang` is set during initialization; `index.html` keeps `lang="en"` as the pre-script default.

## Risks / Trade-offs

- **A forgotten key silently renders English.** → `ru` is typed against the en catalog and i18next key typing makes it a typecheck failure; the final sweep checks every screen in both languages.
- **Roughly 380 keys is a mechanical diff, and strings hidden in attributes are easy to miss** (13 alternative texts, 6 placeholders, 6 confirmation prompts, 10 success notices). → Task list is split per module, and the browser pass covers every screen in both languages rather than a sample.
- **The client-reported language can be tampered with.** → It selects a translation only; authorization, pricing, and stock are untouched, so no security boundary moves.
- **The language could in principle be unavailable at first render on some client.** → `initDataUnsafe` is parsed from the same payload the existing auth path already requires synchronously for `initData`, so the assumption is already load-bearing; a real-client launch check is part of verification.
- **Body-font swap changes English typography.** → Intentional and verified visually; one fewer font request overall.
- **Russian money and date presentation differs from what users see today.** → Required by the spec; the arithmetic behind the displayed values is unchanged.
- **No frontend test harness.** → Verification is browser-based on both workspaces in both languages; the API suite is unaffected because the API does not change, and it remains the only automated gate.

## Migration Plan

- No data, schema, or API change, so there is nothing to backfill or sequence. The API serves the built frontend from the same image, so one image deploy ships both halves; the README's manual app-only update path applies unchanged.
- Rollback is a revert of the commit or a repin of the previous image digest. No state was upgraded, so there is no compatibility window to respect.

## Open Questions

- Whether a third language is wanted later. The catalog layout supports adding one, and no requirement is written for it now.
