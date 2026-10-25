# Migration

*Nomad ↔ Manta*

![Two Nomad pages, with dots and a grid, become one Manta landscape page side by side, and back again](docs/migration-before-after.png)

A Supernote plugin that reshapes a note to fit whichever device you're holding.

Write on the **Nomad** (A6 X2), and Migration turns each pair of pages into one **Manta** (A5 X2)
landscape page, side by side, like an open notebook. Write more on the Manta, and Migration turns it
back into Nomad pages. Your handwriting keeps its shape, your pen keeps its weight, and your template
comes along.

## What it does

- **Two Nomad pages ⇄ one Manta page.** On the Manta, pages sit side by side at 91% of their Nomad
  size, so handwriting looks almost exactly the same physical size on both devices. A thin outline
  marks each page.
- **Reshapes the note in place.** The note keeps its name and place. Nothing is duplicated, and
  sync sees an ordinary edit.
- **Keeps your pen true.** A 0.5 line is still a 0.5 line on the other device, as if you'd written
  it there. Pressure, pen angle and pen type all carry over.
- **Brings your template.** On the Manta, each page shows its template behind the writing, lined
  up with it. Back on the Nomad, the page gets the real template again. This works for built-in
  templates and for your own templates in `MyStyle`.
- **Optional backup.** Keep a copy of the note as it was before each change.

## Using it

1. [**Download `Migration.snplg`**](https://github.com/marekrzajac/supernote-migration/releases/latest/download/Migration.snplg)
   and copy it to your device, then go to **Settings → Apps → Plugins →
   Add Plugin**. Allow the file permissions it asks for. Choose **Always allow**, or it will ask
   every time.
2. Open a note, tap the **Plugins** button in the sidebar, then choose **Migration**.
3. Tap the direction:
   - on the **Manta**, a Nomad note → **Nomad → Manta**
   - on the **Nomad**, a Manta note → **Manta → Nomad**
4. Wait a few seconds. The note reopens in its new shape.

**Backup before change?** toggles a backup of the original (solid black = on).

Each device translates *into its own* page size, so the other direction's button is greyed out.
Translate on the device you're about to write on.

### Adding pages on the Manta

Pages you add to a translated note on the Manta start out plain. Tap **Migrate added pages** to give
them the two-page layout: each half gets the template of the same half on the page before it, plus
the page outlines. It works on pages you've already written on too: the template goes behind your
writing. Those pages then come back to the Nomad as two pages with their templates.

## What travels

Everything on the page:

- **Handwriting**, with pressure, pen angle and pen type
- **Shapes** from the shape tool, and **stars**
- **Text boxes**, scaled with the page so they wrap the same way
- **Titles**, still attached to the writing they mark
- **Links**: links to another page of the same note are re-pointed to where that page now is
- **Keywords**, back on the page they came from
- Each page's **template**, including different templates on different pages
- **Blank pages** you've added

**Not yet: pictures.** A plugin can't copy a picture out of a note, so if a note contains inserted
pictures, Migration leaves it untouched and tells you, rather than lose them. The same goes for
anything else it doesn't recognise.

**Dates:** a translated note is a new file inside, so the calendar shows it on the day you
translated it. The SDK doesn't let a plugin keep the original date.

Links to a page of the same note are added a moment after the note reopens, so they can appear a
second or two after the writing. Links *from other notes* into a translated note need re-making:
the translated note is a new file inside, so their target no longer matches.

## Where it keeps things

Everything lives in one visible folder, **`EXPORT/Migration/`**:

- `backups/`: originals, when *Backup before change?* is on
- `settings/`: remembers your backup choice
- `templates/`: one image of each **built-in** template you've translated, kept for
  *Migrate added pages*. Each is made once and reused.
- a temporary `translating.note`, only during a translation

Your own templates are used straight from `MyStyle/`. Backgrounds are stored inside the note
itself, so a translated note doesn't depend on any other file.

## Syncing between devices

Migration works on the files on your device, so it works with whichever sync you use. It has been
tested with **Google Drive**. For custom templates to appear on both devices, `MyStyle` needs to sync
too. Give the sync a moment to finish before translating on the other device, to avoid conflict copies.

## Permissions

| Permission | Why |
|---|---|
| Read files | to read the note you have open |
| Write files | to write the reshaped note and backups |
| Delete files | to replace the note in place and remove temporary files |

Migration never uses the network.

## Building from source

Migration is a React Native plugin built with Supernote's
[plugin SDK](https://docs.supernote.com) (`sn-plugin-lib` 0.2.3, React Native 0.79.2).

```bash
npm install
./buildPlugin.sh            # → build/outputs/NomadManta.snplg
```

`dev.sh` builds, names the output `Migration.snplg`, and pushes it to both devices over adb. Copy
`dev.local.sh.example` to `dev.local.sh` and fill in your devices' adb serials first. Both
devices report the same model name, so `dev.sh` tells them apart by serial.

```bash
./dev.sh            # build and push to both devices
./dev.sh log manta  # stream the plugin's log
```

## Why this approach?

The dream was simpler than what Migration does: open a Nomad note on the Manta and have the editor
*show* two pages side by side, with the normal pen and toolbar, without changing the note at all.

### Some limitations we discovered

What we found while building Migration with `sn-plugin-lib` 0.2.3:

**Showing two pages side by side**
- `PluginManager.showPluginView()`: shows the plugin's own React Native view in an overlay above the
  note. It can't change how the editor lays out a page, and it's separate from the editor, so it
  can't host Supernote's pen, eraser and lasso.

**Changing a note's page size**
- `PluginFileAPI.createNote({notePath, template, mode, isPortrait})`: takes no page size; pages are
  sized for the device it runs on. So the other device's format can only be made on that device.
- `PluginFileAPI.insertNotePage({notePath, page, template})`: new pages follow the note's existing
  size, so an existing note can't be reshaped in place.

**Keeping a note's date**
- `createNote`: gives every new note a fresh `FILE_ID`, which begins with its creation time. There's
  no option to reuse the original one, so a translated note moves to the day it was translated.
- `FileUtils.copyFile` / `FileUtils.renameToFile`: replace the file, but there's no way to set a
  file's ID or dates afterwards.

**Links to pages of the same note**
- `PluginFileAPI.insertElements` / `modifyElements`: a link's hidden target file and page IDs are
  looked up from `destPath` at that moment, so a link written into the new note before it replaces
  the original points at the wrong pages.
- `PluginFileAPI.openFile` + `PluginCommAPI.insertPageElements`: what works. The links are added
  through the editor once the translated note is open. Links *from other notes* still point at the
  old `FILE_ID`.

**Copying pictures**
- `PluginFileAPI.getElements`: returns a picture's `picturePath` as an extraction under
  `/storage/emulated/0/.data/plugin/`, a folder only the note app can read.
- `PluginFileAPI.insertElements`, `PluginCommAPI.insertPageElements`,
  `PluginCommAPI.convertElement2Sticker`: all refuse that path with `[1211] PNG file does not exist`.
  So notes with inserted pictures are left untouched.

**Built-in templates on added pages**
- `PluginFileAPI.generateNoteTemplatePng`: renders a template at the size of the page it's on, so a
  Manta page can't produce a Nomad-scale image of a built-in template. Migration renders each one
  once while translating from the Nomad note, and keeps it for *Migrate added pages*.

**Noticing added pages**
- `PluginManager.registerEventListener`: offers pen-up, motion, sticker import and plugin life
  events, but no "page added" event, so laying out added pages is a button.

### What would open new possibilities

- **A side-by-side page view.** The docblock of `PluginFileAPI.getPageRotationType` (commented out in
  0.2.3) lists page types `2000` (portrait, split left/right) and `2090` (landscape, split top/bottom).
  If plugins could read and set those, two Nomad pages could simply be *shown* on the Manta, and no
  translation would be needed.
- **Keeping a note's identity when replacing it,** for example a `createNote` option that reuses an
  existing `FILE_ID`, so dates and incoming links survive.
- **Inserting a picture from another note,** for example by letting `insertElements` accept the
  `picturePath` that `getElements` returns.
- **A "page added" event** for `registerEventListener`, so new pages could get their layout
  automatically.
- **Panels for SDK plugins.** The docblock of `NativePluginManager.registerButtonRes` describes
  `showData.regionType: 1` (a centred panel), but the native method takes three arguments, and
  passing `showData` fails with `NativeArgumentsParseException`. A panel would allow a floating view
  of the facing page while writing.

## How it works

The code is in [`lib/translate.ts`](lib/translate.ts). In short:

- Plugin coordinates are screen pixels on the page (`sn-plugin-lib` > 0.1.65), so the
  transform is a scale and an offset per page slot, and its exact inverse. A round trip lands
  within a pixel and doesn't drift.
- A note's page size can't change, so the plugin builds a fresh note at the new size and copies it
  over the original.
- Each page's template is placed as a picture scaled into its slot and tagged with the template's
  name, so the other direction can apply the real template again.
- Some pages are stored internally at a different size from the one shown. Line widths on those
  pages are corrected so pens stay true.

## License

Migration is free software, released under the [MIT License](LICENSE). You're free to use,
change and share it; just keep the copyright notice with it.
