# ui-localization Specification

## Purpose
Presents the Mini App in the language each Telegram user actually reads, resolving Russian or English from the language the Telegram client reports for that user, and keeps every user-visible string, server failure, quantity label, and formatted amount consistent with that language.

## Requirements

### Requirement: Language resolution from the Telegram client
The system SHALL resolve the Mini App language from the language code the Telegram client reports for the current user, before any screen is presented. Russian SHALL be selected for `ru` and its regional variants, and for `uk`, `be`, `kk`, `ky`, `uz`, and `tg`. English SHALL be selected for every other value and when no language code is reported.

#### Scenario: Russian-speaking launch
- **WHEN** the client reports `ru` or `ru-RU` for the current user
- **THEN** the app presents its interface in Russian

#### Scenario: Listed neighbouring locale
- **WHEN** the client reports `uk`, `be`, `kk`, `ky`, `uz`, or `tg` for the current user
- **THEN** the app presents its interface in Russian

#### Scenario: Unlisted locale
- **WHEN** the client reports `en`, `en-GB`, `de`, or any other unlisted value for the current user
- **THEN** the app presents its interface in English

#### Scenario: No language code
- **WHEN** the client reports no language code for the current user
- **THEN** the app presents its interface in English and starts normally

#### Scenario: Language known before a session exists
- **WHEN** the app renders its launch, loading, or session-failure screen and no session has been established
- **THEN** those screens are already presented in the resolved language

### Requirement: No manual language selection or stored preference
The system SHALL resolve the language on every launch from verified launch data. It SHALL NOT require, prompt for, or persist a manual language choice, and it SHALL NOT keep a language preference across launches.

#### Scenario: Separate sessions of the same user
- **WHEN** a user closes the Mini App and later reopens it from Telegram
- **THEN** the language is resolved again from that launch rather than recalled from a previous visit

#### Scenario: No language controls are presented
- **WHEN** a customer or seller opens any screen
- **THEN** no language selector or language-setting control is offered

### Requirement: Complete presentation in the resolved language
Every user-visible string in the customer and seller workspaces SHALL be presented in the resolved language, including navigation and tabs, actions, statuses, notices, prompts, form fields, empty and error states, and image alternative text. No screen SHALL mix the two languages. The shop's brand name and user- or operator-supplied content SHALL retain their original text in both languages.

#### Scenario: Customer workspace in Russian
- **WHEN** the app is presented in Russian
- **THEN** catalog, cart, order detail, payment submission, and package screens show Russian navigation, actions, statuses, notes, and prompts

#### Scenario: Seller workspace in Russian
- **WHEN** the app is presented in Russian and the user is a seller
- **THEN** product preparation, publication, payment review, change review, and shipment screens show Russian navigation, actions, statuses, notes, and prompts

#### Scenario: Prompt and label text
- **WHEN** the app is presented in either language
- **THEN** confirmation prompts, form labels, placeholders, image alternative text, and empty states appear in that same language

### Requirement: Server failures are presented in the resolved language
The system SHALL present a server failure in the resolved language by using the machine-readable error code returned with the failure and the accompanying structured details, rather than displaying the server's own sentence. When a code has no text in the resolved language, the system SHALL fall back to the server-provided message. Conflict feedback SHALL continue to name the affected product and the requested and available quantities.

#### Scenario: Stock conflict in Russian
- **WHEN** a reservation fails with a stock-conflict code while the app is presented in Russian
- **THEN** the customer reads a Russian explanation naming each affected product with its requested and available quantity

#### Scenario: Expired reservation
- **WHEN** an order action fails because the payment deadline passed
- **THEN** the customer reads the failure in the resolved language and is told to create a new order

#### Scenario: Field validation failure
- **WHEN** a submission is rejected because a submitted field is invalid
- **THEN** the app names the offending field and the problem in the resolved language

#### Scenario: Unrecognised code
- **WHEN** a failure carries a code the app has no text for
- **THEN** the app shows the server-provided message rather than an empty or garbled error

### Requirement: Grammatically correct quantity text
Quantity-dependent text SHALL use the resolved language's grammatical number forms, including the distinct Russian forms for one, few, and many. Parenthetical or bracketed plural markers SHALL NOT be used.

#### Scenario: Russian quantity forms
- **WHEN** the app is presented in Russian and a count of one, two to four, and five or more is shown
- **THEN** each count is labelled with its own correct Russian form

#### Scenario: English quantity forms
- **WHEN** the app is presented in English and a count of one and of several is shown
- **THEN** each count is labelled with the matching English singular or plural form

### Requirement: Money and dates follow the resolved language
Monetary and date values SHALL be formatted using the conventions of the resolved language, including digit grouping, decimal separator, currency symbol or code placement, and date and time presentation, independently of the device locale.

#### Scenario: Russian formatting on a non-Russian device
- **WHEN** the app is presented in Russian on a device whose own locale is not Russian
- **THEN** amounts and timestamps use Russian conventions, such as a space as the digit-group separator and a comma as the decimal separator

#### Scenario: English formatting
- **WHEN** the app is presented in English on a device whose own locale is not English
- **THEN** amounts and timestamps use English conventions

#### Scenario: Configured currency is preserved
- **WHEN** any amount is shown in either language
- **THEN** it is denominated in the shop's configured currency and its minor units are unchanged

### Requirement: Document language matches the presented language
The document's declared language SHALL match the resolved language so that assistive technology announces content in the correct language and text is hyphenated and laid out for that language.

#### Scenario: Russian document language
- **WHEN** the app is presented in Russian
- **THEN** the document declares Russian as its language

#### Scenario: English document language
- **WHEN** the app is presented in English
- **THEN** the document declares English as its language

### Requirement: Text renders consistently in both scripts
Latin and Cyrillic text SHALL be rendered with the application's chosen typefaces so that no string mixes typefaces mid-word or mid-line, in either language.

#### Scenario: Mixed-script line in Russian
- **WHEN** the app is presented in Russian and a line combines Cyrillic words with Latin values such as an order reference, a price, or a Telegram username
- **THEN** the whole line is rendered with one consistent typeface

#### Scenario: Cyrillic availability
- **WHEN** the app is presented in Russian
- **THEN** headings and body text both render Cyrillic without falling back to an unselected font
