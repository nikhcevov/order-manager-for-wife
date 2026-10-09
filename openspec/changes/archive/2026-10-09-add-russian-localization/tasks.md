# Tasks

## 1. Localization foundation

- [x] 1.1 Add `i18next` and `react-i18next` to `apps/web/package.json`; verify `npm install` updates `package-lock.json` and `npm run typecheck -w apps/web` passes
- [x] 1.2 Create the `apps/web/src/i18n/catalogs/{en,ru}/` areas with the English catalog as the key-shape source and each Russian area checked against its English counterpart by `assertCatalogCovers`; verify `npm run typecheck` fails when a Russian key is deleted and passes when it is restored
- [x] 1.3 Create `apps/web/src/i18n/index.ts` initializing i18next synchronously (`initAsync: false`) with the `ru`/`ru-*`, `uk`, `be`, `kk`, `ky`, `uz`, `tg` → Russian rule and English for everything else, setting `document.documentElement.lang`; verify the dev app renders English with `lang="en"` when no Telegram object is present, and Russian with `lang="ru"` when a `ru` language code is injected
- [x] 1.4 Extend `apps/web/src/telegram.ts` to expose the client-reported language code with a minimal type; verify `npm run typecheck` passes and that changing the injected language code changes the resolved locale
- [x] 1.5 Move `money`, `date`, `priceInput`, and `toMinor` from `apps/web/src/api.ts` into `apps/web/src/i18n/format.ts` bound to the resolved language, updating every import; verify `npm run typecheck` passes and that formatting a sample amount and timestamp yields Russian and English conventions respectively
- [x] 1.6 Document the language rule in README (Telegram setup): the interface follows the Telegram client language, with the locale mapping table; verify the documented mapping matches the implemented one

## 2. Errors and statuses

- [x] 2.1 Add the error catalog and a `describeError` helper (code lookup, `details` interpolation, server-message fallback, generic message for non-API failures such as an offline fetch); verify that the codes extracted from `apps/api/src` are all present in the catalog
- [x] 2.2 Map `invalid_input` field issues onto localized field text; verify a product submission with an invalid field shows localized text rather than the server sentence
- [x] 2.3 Replace `statusLabels` and `methodLabel` with catalog-backed accessors covering every `Status` and `Method` value; verify `npm run typecheck` fails if a union member has no catalog entry
- [x] 2.4 Route `App.tsx` failure surfaces (`setError`, `setLoginError`) through `describeError` and move the inlined shortage interpolation into the helper; verify in the browser that a stock conflict on a Russian launch reads Russian and still names each affected product with its requested and available quantity

## 3. Customer workspace

- [x] 3.1 Translate `ui.tsx` primitives and the catalog and selection screens (`Catalog`, `ProductDetail`, `SelectionEditor`, `Empty`, `Lines`, `OrderCard`, `Quantity`, `Gallery`, `Media`); verify both languages in the browser with no English text on Russian screens
- [x] 3.2 Translate the order, payment, evidence, and package screens (`OrderDetail`, `GroupDetail`) including notices, confirmation prompts, and status text; verify both languages in the browser, including an expired, cancelled, and rejected-payment order
- [x] 3.3 Convert the customer count-bearing strings (`paid item(s)`, `nonpaid order(s)`, `held order(s)`, `uploaded screenshot(s)`) to plural forms; verify counts of 1, 2, 4, and 5 read correctly in Russian and 1 and 2 read correctly in English

## 4. Seller workspace

- [x] 4.1 Translate `SellerProducts` and `ProductEditor` including draft and publication actions, field labels, placeholders, and validation messages; verify both languages in the browser, including a save failure
- [x] 4.2 Translate `SellerQueue` and `ChangeReview` including comparison headings, settlement prompts, and resolution confirmations; verify both languages in the browser for a pending change request
- [x] 4.3 Translate `SellerGroups` including shipment filters, packing-list text, method selection, and shipment confirmations; verify both languages in the browser, including the missing-delivery-code confirmation
- [x] 4.4 Convert the seller count-bearing strings (`private draft(s)`, `selected draft(s)`, `paid item(s)`, `order(s)`) to plural forms; verify counts of 1, 2, 4, and 5 read correctly in Russian and 1 and 2 read correctly in English

## 5. Shell and accessible text

- [x] 5.1 Translate the `App.tsx` shell: tabs for both workspaces, header and cart button, page titles, empty states, success notices, and footer; verify both languages in the browser for customer and seller modes
- [x] 5.2 Translate the launch, loading, expired, and denied screens; verify that a Russian launch shows Russian on the loading screen before the session resolves and on the session-expired and launch-refused screens
- [x] 5.3 Audit and translate every attribute and dialog string: 13 alternative texts, 6 placeholders, 6 confirmation prompts, and 10 success notices; verify a grep for remaining English prose in the web sources returns nothing outside user- or operator-supplied content

## 6. Typography and document presentation

- [x] 6.1 Move the body font from `DM Sans` to the already-loaded `Manrope` in `apps/web/src/styles.css`; verify Latin and Cyrillic in one line render in a single typeface in both languages on customer and seller screens
- [x] 6.2 Add `text-transform: uppercase` to `.eyebrow` and change eyebrow literals to natural case; verify eyebrow captions render uppercase in both languages
- [x] 6.3 Verify `index.html` keeps `lang="en"` as the pre-script default and the brand title is unchanged, while the runtime document language matches the resolved language

## 7. Integration verification

- [x] 7.1 Sweep every customer and seller screen in both languages using a locally signed fixture launch, confirming no screen mixes languages, money and dates match the presented language, and no untranslated string remains
- [x] 7.2 Confirm the API behavior suite is unaffected and the workspaces still compile and build by running `npm run typecheck`, `npm test`, and `npm run build`

## Workflow follow-up

- Archive the change once review and verification are satisfied; the archived result creates the `ui-localization` capability spec.
