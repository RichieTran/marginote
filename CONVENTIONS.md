# Global conventions

You are building a Chrome Extension called Marginote. These conventions apply
to every prompt in this series:

- **Stack:** Vanilla JS (ES modules), HTML, CSS. No frameworks, no build step,
  no TypeScript. All Chrome APIs via Manifest V3.
- **Code style:** Async/await over promises. Small focused functions. JSDoc
  comments on exported functions. No external runtime dependencies.
- **Data model versioning:** All data stored in `chrome.storage.local`
  includes a top-level `schemaVersion` integer (start at 1). The storage
  utility exposes a `migrate()` function that runs on load and handles missing
  fields on older records by filling them with defaults rather than failing.
  When later prompts add new fields, bump `schemaVersion` and extend
  `migrate()`.
- **Error handling:** User-facing errors (save failures, quota exceeded, etc.)
  surface as small non-blocking toasts in the popup/dashboard and
  `console.warn` in content scripts. Never swallow errors silently. Wrap every
  `chrome.storage` call in `try/catch`.

## Cascade rules (important, apply consistently)

- Deleting a project prompts the user to choose: delete all its annotations,
  or move them to the "General" project. Default selection is
  **"move to General."**
- Deleting a subgroup never deletes its annotations; they become ungrouped
  within the same project.

## Storage

Use `chrome.storage.local`. Request the `unlimitedStorage` permission in the
manifest so users aren't capped at 10MB.

## Testing checkpoint

After each prompt, manually verify the feature on at least three different
site types: a static article (e.g., a Wikipedia page), a dynamic SPA
(e.g., a GitHub file view), and a news site with heavy CSS (e.g.,
nytimes.com). Note any failures in a `TESTING.md` file.

## Styling

All injected content-script CSS is scoped with a `marginote-` class prefix
and uses `all: initial` on root containers to avoid host-page style bleed.
