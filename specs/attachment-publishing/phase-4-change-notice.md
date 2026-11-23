# Phase 4: Change notice

Part of [Publishing attachments](design.md). Ships in any release after phases
2 and 3. Beta while the feature is.

Editing an attachment doesn't touch the notes that reference it (P2 §8). This
phase tells the author when a published file changes, so they don't have to
remember to republish.

## 1. Change notice

- [ ] **Track references.** After each successful publish, keep in memory, per
      profile, which published notes reference each attachment vault path
      (from the queued notes' `AttachmentRef[]`, P2 §3). It isn't persisted: it
      is rebuilt by the next publish after Obsidian starts.
- [ ] **Watch.** On a vault `modify` event (`src/main.ts`) for a file that has a
      hash-cache entry (P2 §6), debounced 5 s per file.
- [ ] **Notify.** If any currently published note references it, show
      "`song.mp3` changed. 3 published notes use it." with a **Republish them**
      button.
- [ ] **Republish them** calls `publishNotes` with those notes for that profile,
      so it takes the publish lock (P2 §1) and shows the busy notice if a
      publish is already running.
- [ ] With several profiles referencing the file, one notice per profile, naming
      the profile.
- [ ] No notice when the attachment mode is `off`, or the file is now excluded
      or no longer allowed.

## 2. Tests

- [ ] Several `modify` events within 5 s produce one notice.
- [ ] A file no published note references produces no notice.
- [ ] **Republish them** publishes exactly the referencing notes, and is refused
      while a publish runs.
- [ ] End-to-end (sandbox `random` only): publish a note with an mp3, edit the
      mp3, click **Republish them**. The note records a new revision with the
      new bytes.
- [ ] `docs/publishing-model.md` describes the notice.

## Done when

- [ ] Every box in §1–§2 is ticked.
- [ ] The end-to-end check passes on the sandbox site.
