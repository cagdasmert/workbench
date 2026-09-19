# Copy to folder — image viewer

**Date:** 2026-08-21
**Status:** approved design, not yet planned
**Contract impact:** SDK 1.6 → 1.7, additive. First write primitive in the app.

## Problem

The image viewer browses a folder but cannot get files out of it. Users want to select one
or more images and copy them somewhere — a common triage flow (cull a shoot, pull the keepers
into an `Exports` folder) that currently requires leaving the app for Finder.

The blocker is not UI. `PluginContext.fs` is read-only end to end: `pickFile`, `pickDirectory`,
`readDir`, `readFile`, backed by two read-grant sets in `packages/main/src/fs-broker.ts`.
Nothing in the stack can write a byte. This design adds that capability and the enforcement
that keeps it narrow.

## Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| D1 | Additive SDK bump to 1.7 | Shell-owned copy command (puts viewer behaviour in the shell) |
| D2 | Separate write-grant set; a read grant never authorizes a write | Reuse `grantedDirs` (silently makes every browsed folder writable) |
| D3 | Recent folders are a shortcut to the *dialog*, not to the grant | Persisting write grants across sessions |
| D4 | Never overwrite; auto-rename `name-1`, `name-2` | Overwrite, or prompt per collision |
| D5 | Plugin-rendered context menu inside the panel | New menu contribution point in the SDK |
| D6 | Destination deny-list, enforced in main | Trusting the dialog alone as the grant |

D6 was added during security review (see "Risks"). D3 means a remembered folder still costs
one dialog confirmation per session; that is the price of grants never outliving the session
that created them.

## Contract — SDK 1.7

Added to `PluginContext.fs`. Nothing existing changes shape.

```ts
/**
 * Grants write access to the chosen directory for this session. Separate from
 * `pickDirectory` on purpose: browsing a folder must never make it writable.
 * `defaultPath` only positions the dialog — it is not a grant and confers nothing.
 */
pickDirectoryForWrite(defaultPath?: string): Promise<string | undefined>;

/**
 * Copies one file into a directory granted by `pickDirectoryForWrite`. Never
 * overwrites: on a name collision the copy lands as `name-1.ext`, `name-2.ext`.
 * Returns the name actually written.
 */
copyFile(sourcePath: string, destDir: string): Promise<CopyResult>;

export interface CopyResult {
  /** Basename actually written, which differs from the source on collision. */
  name: string;
  renamed: boolean;
}
```

`CopyResult` is a plain serializable object (invariant 2). One file per call — the plugin
loops and owns concurrency, matching the `readDir` precedent that recursion is the plugin's
decision, not the host's.

New permission string: `fs:write:user-selected`, declared in `plugin.json`.

Layers to touch, in order: `packages/plugin-sdk/src/index.ts` → `packages/plugin-host/src/bridge.ts`
→ `packages/plugin-host/src/host.ts` → `packages/preload/src/index.ts` → `packages/main/src/fs-broker.ts`.

## Enforcement

`fs-broker.ts` gains `grantedWriteDirs`, holding symlink-resolved paths, session-only,
never persisted. `copyFile` checks, in order, and refuses on the first failure:

1. **Plugin permission.** The calling plugin declares `fs:write:user-selected`. Modelled on
   `net-broker.ts`, which resolves the caller's manifest and checks its declarations. `fs` has
   no per-plugin check today; a write primitive is where that starts.
2. **Source readable.** Existing `assertReadable`, unchanged.
3. **Destination granted.** `realpath(destDir)` sits inside `grantedWriteDirs`.
4. **Destination not deny-listed.** See below.
5. **Copy with `COPYFILE_EXCL`**, retrying `name-1`… `name-N` on `EEXIST`, capped at 100.

### `COPYFILE_EXCL` is a security control, not a convenience

Verified empirically on this machine (macOS, APFS). A symlink planted at the destination
filename, pointing outside the destination folder:

| destination | without `EXCL` | with `EXCL` |
|---|---|---|
| symlink to a file outside the grant | **copied — target file destroyed** | refused `EEXIST` |
| dangling symlink outside the grant | **copied — file created outside the grant** | refused `EEXIST` |

Without the flag, a plain copy follows the symlink and writes through it, escaping the write
grant entirely. `O_CREAT|O_EXCL` is defined to fail on a symlink even a dangling one, which is
what closes it. **The auto-rename loop must therefore never fall back to a non-exclusive copy
on its final attempt** — it gives up instead. A test asserts the refusal directly rather than
trusting the flag.

### Destination deny-list

The dialog is the grant, but a user can be walked into granting somewhere harmful, and
`defaultPath` lets a plugin position that dialog. Write grants are refused for these paths and
everything inside them, checked after realpath:

- `~/Library/Application Support/Workbench/` — **the plugin directory.** M4 loads plugins from
  here. Without this entry, a plugin with write access can install another plugin that runs on
  next launch. This is the entry that matters most.
- `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons` — login persistence
- `~/.ssh`, `~/.aws`, `~/.gnupg` — credentials
- `~/.config`, and the dotfiles `~/.zshrc`, `~/.zprofile`, `~/.bashrc`, `~/.profile` — shell startup
- `/Applications`, and the running app bundle
- The home directory **itself** (children are fine) — a grant that broad is almost never intended

The deny-list is a backstop for a mis-clicked dialog, not the primary control; the grant set is.

## Plugin

**Selection.** A `Set<string>` of paths beside the existing `index`, which keeps meaning "what
is on the stage". Click selects one, cmd-click toggles, shift-click extends from the anchor,
cmd-A selects all. Selected thumbs get a ring; the strip header shows "3 selected".

**Invoking.** `onContextMenu` on the grid opens an absolutely-positioned menu: **Copy to folder…**,
a divider, then up to 8 recent folders by basename (full path as `title`). A **Copy to…** toolbar
button appears whenever the selection is non-empty and opens the same menu. Right-clicking an
unselected thumb selects it first, matching Finder.

**Recents.** `ctx.storage` key `recentCopyTargets`, `string[]`, MRU, capped at 8. Choosing an
entry calls `pickDirectoryForWrite(thatPath)` so the dialog opens at that folder. A folder is
recorded only after a copy into it succeeds.

**Reporting.** `ctx.ui.notify` summarises: `4 copied to Exports · 1 renamed`. Any failure is
reported with its message and does not abort the remaining files; a partial copy is still
reported honestly (`3 copied · 1 failed`). Copies run through a 4-slot queue, reusing the
concurrency cap already proven for thumbnails.

## Testing

**`packages/plugin-host/src/host.test.ts`** — the two new methods reach the bridge and return
unchanged; disposal still unwinds in reverse.

**`packages/main/src/fs-broker.test.ts`** (new, and where the value is):

- write to a directory that was never granted → denied
- write to a directory granted for *reading* only → denied
- plugin without `fs:write:user-selected` → denied
- **symlinked destination filename escaping the grant → denied, and the outside file is byte-identical afterwards**
- dangling symlink at the destination → denied
- collision → `photo-1.png` written, `photo.png` untouched
- deny-listed destination (plugin directory) → denied
- `dest/../../etc` → denied

## Out of scope

No move or cut, no delete, no drag-and-drop, no progress UI, no cross-plugin copy command, no
recursive folder copy. Six plugins exist and one needs writing; generalise when a second does.

## Known limitations

- **TOCTOU on the destination directory.** `destDir` is resolved at check time; a local attacker
  able to swap that directory for a symlink between check and copy could redirect the write.
  Closing it needs directory-handle-relative writes, which Node does not expose. Accepted for a
  local single-user app, recorded here so it is a decision rather than an oversight.
- **Write grants are directory-recursive.** Granting a folder grants its subtrees. The deny-list
  covers the known-dangerous cases; it is not exhaustive.
- Copies preserve source mode bits, so an executable source stays executable at the destination.
