# Chrome Extension Design

This document owns Chrome extension architecture and design decisions.

It should describe how the extension is structured and how data flows between
extension components. It should not duplicate product requirements from
[`requirements.md`](requirements.md) or implementation conventions from
[`development.md`](development.md).

## 1. Architecture Overview

v0.1 is a Chrome Extension Manifest V3 application with four main boundaries:

```text
Chrome Extension
├── content script
│   ├── detects form elements on the active page
│   ├── classifies fields with local rules
│   ├── detects manual-step states
│   ├── renders suggestion and guidance UI
│   └── fills only user-selected values
│
├── background service worker
│   ├── handles extension events
│   ├── coordinates message passing
│   └── avoids storing page-specific state in memory as the source of truth
│
├── options page
│   ├── manages local profile fields
│   ├── manages custom field definitions
│   └── shows site-field history
│
└── storage boundary
    ├── profile data
    ├── field definitions
    └── site-field history
```

The content script owns page interaction. The options page owns user-managed
data. Shared logic such as field classification, storage access, and message
types should be isolated so it can be tested outside a live browser page.

## 2. Manifest V3 And Permissions

The repository does not yet contain a `manifest.json`. When it is added, keep
permissions narrow and document each one in this section.

Expected permission direction for v0.1:

| Permission / Access | Expected Use | Owner |
| --- | --- | --- |
| `storage` | Store profile fields, custom definitions, settings, and site-field history locally. | Options page and storage abstraction |
| `activeTab` or narrow host access | Let the content script inspect and fill the current user-selected page. | Content script |
| `scripting` if needed | Inject or register content scripts only when static manifest registration is not enough, such as runtime opt-in for selected tabs. | Background service worker |

Avoid broad host permissions unless the implementation cannot work without
them. If broad access becomes necessary, document the user benefit, the
security tradeoff, and the alternatives considered.

Security justification for permissions belongs in [`security.md`](security.md).

## 3. Content Script Responsibilities

The content script may:

- scan the current DOM for visible `input`, `textarea`, and `select` elements;
- collect field metadata such as `autocomplete`, `name`, `id`, `placeholder`,
  label text, and nearby visible text;
- run or call deterministic field classification rules;
- detect conservative signs of manual-step states;
- render extension-owned suggestion and guidance UI;
- fill selected values into selected fields after explicit user action;
- re-scan after user-driven page changes or dynamic form updates.

The content script must not:

- submit forms automatically;
- click final action buttons automatically;
- check terms, consent, or contract agreement boxes automatically;
- attempt CAPTCHA, MFA, bot-detection, paywall, or access-control bypass;
- store profile data directly without going through the storage boundary;
- inject broad global CSS likely to alter the host page.

## 4. Background Service Worker

The background service worker should stay small. It may own extension lifecycle
events, action clicks, tab-related coordination, and message routing between the
content script, options page, and storage boundary.

Manifest V3 service workers can be suspended and restarted by Chrome. Do not
use the background worker's in-memory variables as durable state. Profile data,
settings, custom definitions, and site-field history must live in local storage
through a small storage abstraction.

The background service worker should not make network calls for profile data in
v0.1.

## 5. Options Page

The options page is the user's control surface for local data. It should let the
user:

- create, edit, and delete basic profile fields;
- define additional custom fields when a website asks for data not covered by
  the basic profile;
- review and clear site-field history;
- adjust extension settings that affect suggestion behavior;
- understand that data is local and that passwords and credit cards are not
  supported in v0.1.

The options page should avoid real user data in examples, screenshots, tests,
or committed fixtures.

## 6. Storage Abstraction

Storage access should be behind a small abstraction rather than scattered
through content script and UI code. The abstraction should own serialization,
schema versioning direction, and future migration points.

Expected data groups:

- profile fields: user-managed values used for suggestions;
- field definitions: built-in and custom mappings from field types to labels
  and matching rules;
- site-field history: local record of URL or origin patterns and field types
  used there;
- settings: user preferences that affect suggestion and UI behavior.

Use `chrome.storage.local` or IndexedDB for v0.1 unless the implementation
finds a concrete reason to choose otherwise. Future encryption with Web Crypto
API can be added behind the same boundary.

Concrete file layout and implementation rules belong in
[`development.md`](development.md).

## 7. Message Passing

Message passing should keep ownership boundaries explicit. Prefer typed
request / response payloads once TypeScript is introduced.

Expected message categories:

- scan request: ask a content script to scan the current page;
- scan result: return detected fields, confidence, and manual-step signals;
- suggestion request: ask for profile values that may match detected fields;
- fill request: fill only the user-selected field/value pairs;
- history update: record local site-field usage after user-confirmed filling;
- settings/profile update notification: tell active extension views to refresh
  cached data.

Messages should not carry more profile data than needed. Page-derived text
should be treated as untrusted input.

## 8. UI Injection Guidelines

Injected UI should be easy to distinguish from the host page and should not
break page layout. Prefer an isolated root element, scoped class names, and
minimal CSS. If Shadow DOM is used, document the reason and test it against
fixture pages.

The UI should:

- show suggestions before filling;
- make the user action required for filling explicit;
- avoid covering important page controls;
- avoid imitating host page submit or confirmation controls;
- provide guidance when a manual step is detected;
- let the user dismiss or re-open the assistant;
- avoid large overlays unless the user explicitly opens them.

The UI must not hide CAPTCHA, MFA, consent, or final confirmation controls.

## 9. Manual-Step Handling

When CAPTCHA, MFA, terms confirmation, identity verification, file upload
confirmation, final submission, or similar human steps are detected, the
extension should pause filling for that step and guide the user.

Expected behavior:

1. mark the detected state as requiring user action;
2. avoid filling or clicking controls related to that state;
3. show a short explanation in the injected UI;
4. let the user complete the step directly on the page;
5. offer a re-scan action or automatically re-scan after a clear user-driven
   page update;
6. resume suggestions only for ordinary remaining fields.

Manual-step handling should improve user experience without attempting to
circumvent site protections.
