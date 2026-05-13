# Chrome Extension Design

This document owns Chrome extension architecture and design decisions.

It should describe how the extension is structured and how data flows between
extension components. It should not duplicate product requirements from
[`requirements.md`](requirements.md) or implementation conventions from
[`development.md`](development.md).

## 1. Architecture Overview

Write the high-level component map for the Manifest V3 extension.

## 2. Manifest V3 And Permissions

List requested permissions, host access, and which extension component uses
each permission.

Security justification for permissions belongs in [`security.md`](security.md).

## 3. Content Script Responsibilities

Describe what the content script may detect, render, and fill on host pages.

## 4. Background Service Worker

Describe event handling, lifecycle constraints, and message routing owned by
the background service worker.

## 5. Options Page

Describe profile management, settings, and site-field history concerns owned by
the options page.

## 6. Storage Abstraction

Describe the extension-level storage boundary and expected data flow.

Concrete file layout and implementation rules belong in
[`development.md`](development.md).

## 7. Message Passing

Describe message types, ownership boundaries, and expected request / response
patterns between extension components.

## 8. UI Injection Guidelines

Describe how injected UI should avoid interfering with host pages and user
judgment.

## 9. Manual-Step Handling

Describe extension-level behavior when CAPTCHA, MFA, terms confirmation, final
submission, or similar human steps are detected.
