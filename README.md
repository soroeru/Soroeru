# formfill-assistant

formfill-assistant is a Chrome extension for user-confirmed form filling.

The project starts as a personal tool for reducing repetitive form entry on websites and contract-related forms. It detects fields on the current web page, suggests values from a locally managed profile, and lets the user explicitly choose what to fill.

The extension does **not** aim to automatically submit forms, create accounts, modify contracts, or complete transactions without user confirmation.

## Motivation

Many web forms ask for the same information repeatedly: name, email address, phone number, address, company name, billing information, department name, and other profile or contract-related data.

Existing browser autofill and password managers are useful, but they are often optimized for a fixed set of personal fields such as login credentials, addresses, and payment information. This project explores a more flexible model:

- user-defined profile fields
- site-specific field history
- dynamic field schemas
- explicit user confirmation before filling
- local-first storage

The initial goal is simple: build a working Chrome extension that I can personally use and iterate on.

## Product Principles

- Start with a small, usable Chrome extension.
- Prefer user-confirmed assistance over autonomous automation.
- Do not auto-submit forms.
- Do not bypass CAPTCHA, bot detection, rate limits, or access controls.
- Do not store passwords or credit card information in the initial version.
- Keep user data local in the initial version.
- Avoid backend services until they are clearly necessary.
- Prefer deterministic, inspectable form-matching logic before introducing AI.
- Treat personal and contract-related data as sensitive by default.

## Initial Scope: v0.1

v0.1 is a local-first Chrome extension for personal use.

Planned features:

- Manage basic profile fields locally.
  - full name
  - email address
  - phone number
  - postal code
  - address
  - company name
  - department name
  - other manually defined fields
- Detect form fields on the current web page.
- Analyze `input`, `textarea`, and `select` elements.
- Infer field meaning from attributes and surrounding text.
  - `autocomplete`
  - `name`
  - `id`
  - `placeholder`
  - associated `label`
  - nearby text
- Show fill suggestions to the user.
- Fill fields only after explicit user action.
- Record which URL used which profile fields.
- Provide an extension options page for managing profile data and settings.

## Out of Scope for v0.1

The following are intentionally excluded from the first version:

- automatic form submission
- automatic account registration
- automatic address changes across multiple websites
- automatic contract modification
- password manager functionality
- credit card storage
- cloud sync
- Google Drive / Dropbox integration
- backend API server
- mobile apps
- iOS app autofill
- Android Autofill Service
- BYOC deployment
- Terraform automation
- Cloudflare Browser Run integration
- autonomous browser AI agents

## Architecture

```text
Chrome Extension
├── content script
│   ├── detect form elements
│   ├── infer field types
│   ├── render suggestion UI
│   └── fill selected values into the page
│
├── background service worker
│   ├── extension event handling
│   └── message passing
│
├── options page
│   ├── manage profile fields
│   ├── manage custom field definitions
│   └── view site-field history
│
└── local storage
    ├── profile data
    ├── field definitions
    └── site-field history
```

## Candidate Tech Stack

- TypeScript
- Chrome Extension Manifest V3
- HTML / CSS
- React or Vanilla TypeScript for extension UI
- `chrome.storage.local` or IndexedDB for local storage
- Web Crypto API for future local encryption
- Playwright for future end-to-end testing

## Field Detection Strategy

v0.1 should start with rule-based field detection.

Examples:

- `autocomplete="email"` -> email address
- `autocomplete="tel"` -> phone number
- `name` or `id` contains `email` -> email address
- `name` or `id` contains `tel` / `phone` -> phone number
- `placeholder` contains `住所` -> address
- `label` contains `会社名` -> company name
- `label` contains `部署` -> department name
- `name` or `id` contains `zip` / `postal` -> postal code

The goal is not perfect automatic classification. The first goal is to produce useful suggestions while keeping the user in control.

## Dynamic Schema Direction

A key long-term idea is dynamic schema management.

Different websites and business forms require different fields. Instead of hard-coding all possible fields, the extension should eventually allow users to add new field types when unknown fields are encountered.

Example flow:

1. The extension detects an unknown form field.
2. The user selects or creates a field definition, such as `法人番号`, `請求先住所`, or `契約担当者名`.
3. The extension stores the mapping.
4. Similar fields can use the same mapping in the future.

This allows the product to grow from personal autofill assistance toward contract and business-form support without requiring a fixed universal schema from the beginning.

## Security and Privacy

This project handles sensitive information. The initial security posture is intentionally conservative.

v0.1 security principles:

- Store data locally only.
- Do not send profile data to external servers.
- Do not store passwords.
- Do not store credit card information.
- Do not automatically click submit buttons.
- Fill only fields selected by the user.
- Keep permissions as narrow as possible.
- Avoid collecting telemetry in the initial version.

Future security considerations:

- local encryption
- encrypted export/import
- client-side encrypted cloud backup
- explicit permission model per site
- audit log for filled fields
- safe handling of business and contract data

## Roadmap

### v0.1: Personal Chrome Extension

- Local profile management
- Rule-based form detection
- User-confirmed filling
- Site-field history
- Options page

### v0.2: Dynamic Fields

- Custom field definitions
- Unknown field classification UI
- Reusable field mappings
- Improved Japanese and English form support

### v0.3: Quality and Testing

- Better handling of dynamic forms and SPAs
- More robust label and nearby-text extraction
- End-to-end tests with fixture pages
- Regression tests for field detection rules

### v0.4: Backup and Portability

- Export/import
- Encrypted local backup
- Evaluation of Google Drive / Dropbox backup

### Future

- Firefox extension
- Safari Web Extension
- Android Autofill Service
- iOS Safari Extension
- Business and contract-form assistance
- Form field audit and checklist generation
- Cloud-based form analysis for testing only
- Optional BYOC architecture exploration

## Development Status

This project is in the initial planning and implementation stage.

The immediate objective is to complete a small Chrome extension that is useful for personal repetitive form entry.

## License

TBD
