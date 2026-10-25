/**
 * Translate a whole note between Nomad and Manta page geometry.
 *
 * A note is reshaped, in place, for whichever device it's open on. The whole
 * note is rebuilt from scratch each time: no provenance stamps, no incremental
 * sync, so deletions and edits carry over naturally. The rule of use is
 * "translate when you switch devices". See runTranslation for the in-place
 * replacement and backup.
 *
 * Two Nomad pages share one Manta page, in one of two layouts:
 *
 *   Manta landscape (2560x1920): split by a vertical fold into two 1280x1920
 *     slots. Nomad page scale 0.9117.
 *   Manta portrait (1920x2560): split by a horizontal line into two 1920x1280
 *     slots. Nomad page scale 0.6838, centred with margins left and right.
 *
 * Nomad page k lives in slot k % 2 of Manta page floor(k / 2). Both directions
 * use the same layout and its exact inverse, so a round trip is lossless.
 *
 * It must run on the device that will be written on: createNote makes pages
 * sized for the device it runs on, so "to Nomad" on a Manta would produce
 * Manta-sized pages.
 *
 * Everything is carried: strokes (with pressure and pen data), pictures,
 * shapes, stars, text boxes, titles and links (re-attached to their strokes),
 * and keywords. Links to a page of the same note are re-pointed. A note with
 * anything else is left untouched (see uncarried). Migration's own page
 * outlines are recognised and dropped.
 */

import {Dimensions, PixelRatio} from 'react-native';
import {
  PluginManager,
  PluginCommAPI,
  PluginFileAPI,
  PluginNoteAPI,
  FileUtils,
  Element,
  type Point,
} from 'sn-plugin-lib';
import {Report, unwrap, brief, type Size} from './report';

export const NOMAD_PAGE: Size = {width: 1404, height: 1872};
export const MANTA_PORTRAIT: Size = {width: 1920, height: 2560};
export const MANTA_LANDSCAPE: Size = {width: 2560, height: 1920};

/** Generated images live here, NOT in MyStyle/, where every PNG becomes a template. */
/*
 * Everything the plugin keeps lives in one visible, plainly named folder:
 *
 *   EXPORT/Migration/
 *     backups/          originals, when "Backup before change?" is on
 *     rendering-N.png   built-in template images, only during a translation
 *                       (custom templates are used straight from MyStyle/)
 *     settings/         "backup-off" marker
 *     translating.note  only while a translation runs
 *
 * EXPORT syncs, so backups travel between devices. The name avoids < and >,
 * which Windows and Drive clients reject in file names. (The plugin was
 * "Nomad ↔ Manta" with folder EXPORT/Nomad-Manta before being named Migration;
 * its pluginID never changed, and must not: userData tags are stored per ID.)
 */
const WORK_DIR = '/storage/emulated/0/EXPORT/Migration';
const BACKUP_DIR = `${WORK_DIR}/backups`;
/** Where earlier versions kept the backup setting. Still honoured. */
const OLD_WORK_DIRS = [
  '/storage/emulated/0/EXPORT/Nomad-Manta',
  '/storage/emulated/0/EXPORT/NoteTranslate',
];

const PLAIN = 'style_white';

/**
 * Per-page stroke summaries (thickness, stored geometry, pen data, picture
 * tags) for the original and the translation, logged with every report. They
 * re-read both notes, so they're off for normal use.
 */
const DIAGNOSTICS = false;

/*
 * Background pictures are named "tpl=<template name>=<note>-p<k>.png".
 *
 * Picture elements only *reference* a PNG on the device; the image does not
 * travel inside the .note (the Nomad got "[1211] PNG file does not exist" for
 * every background generated on the Manta). Encoding the template name in the
 * file name lets the Nomad side recover it and use the real template natively
 * instead of a picture.
 */
const BG_TAG = 'tpl=';

const MYSTYLE = '/storage/emulated/0/MyStyle/';

/*
 * Background pictures are tagged in userData with the template they show.
 *
 * The file path can't carry it: the editor embeds a picture's image IN the
 * note, and reading the note back gives a fresh temporary extraction path
 * (/storage/emulated/0/.data/plugin/<timestamp>.png) every time, on both
 * devices. Seen in the host logs; it's why v0.0.22–v0.0.34 never recognised a
 * template on the Nomad. The path parsing below stays as a fallback.
 */
const BG_USERDATA = 'NMBG:';
/** Marks the page outlines Migration draws on the Manta. */
const OUTLINE_USERDATA = 'NMOUTLINE';

/** Is this picture element one of our page backgrounds? Returns its template if known. */
function backgroundOf(el: any, L?: Layout): {is: boolean; template?: string} {
  if (el?.type !== Element.TYPE_PICTURE) {
    return {is: false};
  }
  if (typeof el.userData === 'string' && el.userData.startsWith(BG_USERDATA)) {
    return {is: true, template: el.userData.slice(BG_USERDATA.length) || undefined};
  }
  const fromPath = templateFromBg(el.picture?.picturePath);
  if (fromPath) {
    return {is: true, template: fromPath};
  }
  // Untagged, but exactly fills a page slot: a background from an older build.
  if (L && el.picture?.rect) {
    const r = el.picture.rect;
    const w = L.nomad.width * L.scale;
    const h = L.nomad.height * L.scale;
    const near = (a: number, b: number) => Math.abs(a - b) <= 2;
    for (const {ox, oy} of L.slots) {
      if (near(r.left, ox) && near(r.top, oy) && near(r.right, ox + w) && near(r.bottom, oy + h)) {
        return {is: true};
      }
    }
  }
  return {is: false};
}

/**
 * Template name from a background picture's path: the MyStyle file itself
 * (MyStyle/5mm.png -> user_5mm) or a rendered image named tpl=<name>=….png.
 */
function templateFromBg(path: unknown): string | undefined {
  if (typeof path !== 'string') {
    return undefined;
  }
  if (path.startsWith(MYSTYLE) && /\.png$/i.test(path)) {
    return `user_${path.slice(MYSTYLE.length).replace(/\.png$/i, '')}`;
  }
  const file = path.slice(path.lastIndexOf('/') + 1);
  if (!file.startsWith(BG_TAG)) {
    return undefined;
  }
  const end = file.indexOf('=', BG_TAG.length);
  return end > 0 ? decodeURIComponent(file.slice(BG_TAG.length, end)) : undefined;
}

/**
 * A template name -> something createNote accepts on THIS device: a built-in
 * style name, or the absolute path of a MyStyle PNG that exists here.
 */
async function resolveTemplate(name: string | undefined): Promise<string | undefined> {
  if (!name || name === 'style_white') {
    return undefined;
  }
  if (name.startsWith('user_')) {
    const path = `${MYSTYLE}${name.slice('user_'.length)}.png`;
    return (await FileUtils.exists(path).catch(() => false)) ? path : undefined;
  }
  return name.startsWith('style_') ? name : undefined;
}

// Page outlines on the Manta, same look as before: dark gray, finest line.
const OUTLINE_PEN_COLOR = 0x9d;
const OUTLINE_PEN_TYPE = 10;
const OUTLINE_PEN_WIDTH = 100;

const same = (a: Size, b: Size) => a.width === b.width && a.height === b.height;
const isNomad = (s: Size) => same(s, NOMAD_PAGE);
const isManta = (s: Size) => same(s, MANTA_PORTRAIT) || same(s, MANTA_LANDSCAPE);

export type Format = 'Nomad' | 'Manta';
const formatOf = (s: Size): Format | undefined =>
  isNomad(s) ? 'Nomad' : isManta(s) ? 'Manta' : undefined;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export type Slot = {ox: number; oy: number};

export type Layout = {
  manta: Size;
  nomad: Size;
  /** true = landscape Manta, vertical fold; false = portrait, horizontal line. */
  vertical: boolean;
  scale: number;
  slots: [Slot, Slot];
};

/** Where the two Nomad pages sit on one Manta page. */
export function planLayout(manta: Size, nomad: Size): Layout {
  const vertical = manta.width > manta.height;
  const slotW = vertical ? manta.width / 2 : manta.width;
  const slotH = vertical ? manta.height : manta.height / 2;
  const scale = Math.min(slotW / nomad.width, slotH / nomad.height);
  const pw = nomad.width * scale;
  const ph = nomad.height * scale;
  const slot = (i: number): Slot => ({
    ox: (vertical ? i * slotW : 0) + (slotW - pw) / 2,
    oy: (vertical ? 0 : i * slotH) + (slotH - ph) / 2,
  });
  return {manta, nomad, vertical, scale, slots: [slot(0), slot(1)]};
}

/** Nomad page coordinates -> Manta page coordinates. */
export function toMantaPoint(p: Point, L: Layout, slot: number): Point {
  const {ox, oy} = L.slots[slot];
  return {x: Math.round(ox + p.x * L.scale), y: Math.round(oy + p.y * L.scale)};
}

/** Manta page coordinates -> Nomad page coordinates. */
export function toNomadPoint(p: Point, L: Layout, slot: number): Point {
  const {ox, oy} = L.slots[slot];
  return {x: Math.round((p.x - ox) / L.scale), y: Math.round((p.y - oy) / L.scale)};
}

/**
 * Which slot a stroke belongs to, from its mean position along the split axis.
 * Mean rather than first point, so a stroke that merely starts near the fold
 * isn't misfiled; whole strokes are never torn in two.
 */
export function slotOf(pts: Point[], L: Layout): number {
  if (L.vertical) {
    const mean = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    return mean < L.manta.width / 2 ? 0 : 1;
  }
  const mean = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return mean < L.manta.height / 2 ? 0 : 1;
}

type Rect = {left: number; top: number; right: number; bottom: number};

function rectToManta(r: Rect, L: Layout, slot: number): Rect {
  const a = toMantaPoint({x: r.left, y: r.top}, L, slot);
  const b = toMantaPoint({x: r.right, y: r.bottom}, L, slot);
  return {left: a.x, top: a.y, right: b.x, bottom: b.y};
}

function rectToNomad(r: Rect, L: Layout, slot: number): Rect {
  const a = toNomadPoint({x: r.left, y: r.top}, L, slot);
  const b = toNomadPoint({x: r.right, y: r.bottom}, L, slot);
  return {left: a.x, top: a.y, right: b.x, bottom: b.y};
}

/** Outline of each Nomad page on the Manta page, sharing the fold line. */
export function outlineSegments(L: Layout): [Point, Point][] {
  const w = L.nomad.width * L.scale;
  const h = L.nomad.height * L.scale;
  const cx = (x: number) => Math.min(Math.max(Math.round(x), 0), L.manta.width - 1);
  const cy = (y: number) => Math.min(Math.max(Math.round(y), 0), L.manta.height - 1);
  const segs: [Point, Point][] = [];
  const seen = new Set<string>();
  const add = (a: Point, b: Point) => {
    const key = [a.x, a.y, b.x, b.y].join(',');
    const rev = [b.x, b.y, a.x, a.y].join(',');
    if (!seen.has(key) && !seen.has(rev)) {
      seen.add(key);
      segs.push([a, b]);
    }
  };
  for (const {ox, oy} of L.slots) {
    const l = cx(ox);
    const r = cx(ox + w);
    const t = cy(oy);
    const b = cy(oy + h);
    add({x: l, y: t}, {x: r, y: t});
    add({x: r, y: t}, {x: r, y: b});
    add({x: l, y: b}, {x: r, y: b});
    add({x: l, y: t}, {x: l, y: b});
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type Direction = 'toManta' | 'toNomad';

export type Plan = {
  direction: Direction;
  srcPath: string;
  srcPages: number;
  srcSize: Size;
  /** The device we're running on. */
  device: Format;
};

/** What the open note is, and what device this is — for enabling the buttons. */
export async function describeOpenNote(): Promise<{format?: Format; device?: Format}> {
  const out: {format?: Format; device?: Format} = {};
  try {
    const path = unwrap(await PluginCommAPI.getCurrentFilePath(), 'getCurrentFilePath');
    out.format = formatOf(await pageSize(path, 0));
  } catch {
    // No note open, or no permission yet.
  }
  const d = await detectDevice(new Report());
  out.device = d === '?' ? undefined : d;
  return out;
}

async function totalPages(path: string): Promise<number> {
  const v: any = unwrap(
    await PluginFileAPI.getNoteTotalPageNum(path),
    'getNoteTotalPageNum',
  );
  return typeof v === 'number' ? v : Number(v?.totalPage ?? 0);
}

/**
 * Which device are we on?
 *
 * NOT getPageDisplaySize(): that is the page's current on-screen size including
 * zoom — a Nomad note viewed on a landscape Manta reports 2560x3414.
 *
 * The physical screen's long side doesn't change with zoom or rotation:
 * Nomad 1872px, Manta 2560px. getDeviceType() (4 = A6X2 Nomad, 5 = A5X2 Manta)
 * is logged alongside as a cross-check; both devices report model "Supernote
 * Nomad" at the firmware level, so it isn't trusted on its own yet.
 */
async function detectDevice(report: Report): Promise<'Nomad' | 'Manta' | '?'> {
  const s = Dimensions.get('screen');
  const longPx = Math.round(Math.max(s.width, s.height) * PixelRatio.get());
  const bySize = Math.abs(longPx - 2560) < 40 ? 'Manta' : Math.abs(longPx - 1872) < 40 ? 'Nomad' : '?';
  let byType = '?';
  try {
    const t = await PluginManager.getDeviceType();
    byType = t === 5 ? 'Manta' : t === 4 ? 'Nomad' : `type ${t}`;
  } catch (e: any) {
    byType = `error: ${e?.message ?? e}`;
  }
  report.add('this device', `${bySize} (screen long side ${longPx}px; getDeviceType: ${byType})`);
  return bySize;
}

async function pageSize(path: string, page: number): Promise<Size> {
  return unwrap(await PluginFileAPI.getPageSize(path, page), 'getPageSize');
}

/**
 * Work out which way to translate, from what this device is and what the open
 * note is. Returns undefined (with an explanation in the report) if neither
 * direction applies here.
 */
export async function planTranslation(
  report: Report,
  direction: Direction,
): Promise<Plan | undefined> {
  report.heading('NOTE');

  let srcPath: string;
  let srcSize: Size;
  let srcPages: number;
  try {
    srcPath = unwrap(await PluginCommAPI.getCurrentFilePath(), 'getCurrentFilePath');
    srcPages = await totalPages(srcPath);
    srcSize = await pageSize(srcPath, 0);
  } catch (e: any) {
    report.add('ABORTED', e?.message ?? String(e), true);
    return undefined;
  }

  report.add('note', srcPath);
  report.add('pages', String(srcPages));
  report.add('page size', `${srcSize.width} x ${srcSize.height}`);
  const device = await detectDevice(report);
  const format = formatOf(srcSize);
  const want: Format = direction === 'toManta' ? 'Nomad' : 'Manta';
  report.add('direction', direction === 'toManta' ? 'Nomad -> Manta' : 'Manta -> Nomad');

  if (device === '?' || !format) {
    report.add('nothing to do', 'Unrecognised page or device size.', true);
    return undefined;
  }
  if (format !== want) {
    report.add('nothing to do', `This is already a ${format} note.`, true);
    return undefined;
  }
  // Only translate INTO this device's format: createNote makes pages sized for
  // the device it runs on. (Building the other format from a copied "shell"
  // note worked in v0.0.23 but was dropped as not worth the complexity.)
  const target: Format = direction === 'toManta' ? 'Manta' : 'Nomad';
  if (target !== device) {
    report.add('nothing to do', `Open this note on the ${target} to translate it there.`, true);
    return undefined;
  }
  return {direction, srcPath, srcPages, srcSize, device};
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/** "/x/Meeting.note" -> {dir: "/x", base: "Meeting"} */
function baseName(path: string): {dir: string; base: string} {
  const slash = path.lastIndexOf('/');
  return {dir: path.slice(0, slash), base: path.slice(slash + 1).replace(/\.note$/i, '')};
}

const exists = (p: string) => FileUtils.exists(p).catch(() => false);

/** "2026-10-24 1930" */
function stamp(): string {
  const d = new Date();
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}${z(d.getMinutes())}`;
}

/**
 * Grow a fresh note to `want` pages, page k with template `templateFor(k)`.
 *
 * The SDK doesn't say whether insertNotePage inserts before or after `page`,
 * so both conventions are tried, appending at `have` first. With per-page
 * templates the order matters; runTranslation reads every page's template
 * back into the report so a misplaced page would show.
 */
async function ensurePages(
  report: Report,
  path: string,
  want: number,
  templateFor: (page: number) => string = () => PLAIN,
): Promise<boolean> {
  let have = await totalPages(path);
  while (have < want) {
    let grew = false;
    const wanted = templateFor(have);
    for (const template of wanted === PLAIN ? [PLAIN] : [wanted, PLAIN]) {
      for (const page of [have, have - 1]) {
        try {
          unwrap(
            await PluginFileAPI.insertNotePage({notePath: path, page, template}),
            'insertNotePage',
          );
          const now = await totalPages(path);
          if (now > have) {
            if (template !== wanted) {
              report.add(`page ${have} template`, `${wanted} refused — plain`, true);
            }
            have = now;
            grew = true;
            break;
          }
        } catch {
          // Try the other index convention, then plain.
        }
      }
      if (grew) {
        break;
      }
    }
    if (!grew) {
      report.add('add pages failed', `stuck at ${have} of ${want}`, true);
      return false;
    }
  }
  return true;
}

async function readElements(path: string, page: number): Promise<any[]> {
  const els = unwrap(await PluginFileAPI.getElements(page, path), 'getElements');
  return Array.isArray(els) ? els : [];
}

async function recycleAll(els: any[]): Promise<void> {
  for (const el of els) {
    await el?.recycle?.().catch?.(() => {});
  }
}

/** Copy one stroke with its points remapped. */
/**
 * How much bigger a stroke's stored geometry is than the page it's shown on.
 *
 * A page can be stored at a different internal size from the one it's
 * displayed at: a Nomad note can contain a page stored at Manta size, shown
 * scaled down. Every stroke on it reports that internal size as its EMR extent
 * (maxX/maxY — e.g. 21633x16224 rather than the Nomad's 15819x11864), and the
 * editor stores thickness in those internal units: a 500 pen is saved as 683.
 * Points come back already in displayed-page pixels, but thickness does not,
 * so it has to be divided by this factor. Found when one such page arrived on
 * the Manta 1.3675x (= 1920/1404) too heavy.
 *
 * EMR is 8.45 units per pixel on both devices, so a page's expected long-side
 * extent is longSidePx * 8.45 (Nomad 15819, Manta 21632).
 */
function storedScale(src: any, page: Size): number {
  const actual = Math.max(src?.maxX ?? 0, src?.maxY ?? 0);
  const expected = Math.max(page.width, page.height) * (21632 / 2560);
  if (!actual || !expected) {
    return 1;
  }
  const f = actual / expected;
  // Only correct for a genuinely different page geometry; ignore noise.
  return f > 0.5 && f < 2 && Math.abs(f - 1) > 0.02 ? f : 1;
}

/**
 * Fill an empty ElementDataAccessor in one native call. setRange works on an
 * empty accessor (verified on device); per-item add() is kept as a fallback.
 */
async function fillAccessor<T>(
  accessor: any,
  values: T[],
  report: Report,
  what: string,
): Promise<boolean> {
  if (values.length === 0) {
    return true;
  }
  try {
    await accessor.setRange(0, values.length - 1, values);
    if ((await accessor.size()) === values.length) {
      return true;
    }
  } catch {
    // Fall through to the slow path.
  }
  try {
    for (let i = 0; i < values.length; i++) {
      await accessor.add(i, values[i]);
    }
    return (await accessor.size()) === values.length;
  } catch (e: any) {
    report.add(`${what} fill failed`, e?.message ?? String(e), true);
    return false;
  }
}

/** Every value in an ElementDataAccessor, or [] if it's empty or unreadable. */
async function readAll<T>(acc: any): Promise<T[]> {
  try {
    const n = acc ? await acc.size() : 0;
    return n > 0 ? await acc.getRange(0, n) : [];
  } catch {
    return [];
  }
}

/**
 * Copy one stroke with its points remapped.
 *
 * Alongside points, a stroke carries per-point pen data: pressure, pen angle
 * (on the element), marker direction, and a draw flag. These describe the pen
 * at each point, not positions on the page, so they're copied unchanged.
 * v0.0.25 measured strokes written by hand carrying all three of the latter;
 * dropping them made those strokes (only) render differently after a
 * translation — the "random" line-weight changes.
 */
async function copyStroke(
  report: Report,
  src: any,
  map: (p: Point) => Point,
  pts: Point[],
  /** Displayed size of the page the source stroke is on. */
  srcPage: Size,
): Promise<any | undefined> {
  const pressures = await readAll<number>(src.stroke.pressures);
  const angles = await readAll<Point>(src.angles);
  const markDir = await readAll<Point>(src.stroke.markPenDirection);
  const flagDraw = await readAll<boolean>(src.stroke.flagDraw);

  const dst: any = unwrap(
    await PluginCommAPI.createElement(Element.TYPE_STROKE),
    'createElement',
  );
  dst.layerNum = Math.min(Math.max(src.layerNum ?? 0, 0), 3);
  // Line width follows the PEN, not the page scale: a 0.5 pen reads as 0.5 on
  // whichever device the note lands on, as if written there. (v0.0.27–38 scaled
  // width with the writing; pen-true weight felt more natural.) Only the stored
  // page-geometry difference is corrected — see storedScale.
  dst.thickness = Math.max(1, Math.round(src.thickness / storedScale(src, srcPage)));
  dst.stroke.penColor = src.stroke.penColor;
  dst.stroke.penType = src.stroke.penType;

  const ok = await fillAccessor(dst.stroke.points, pts.map(map), report, 'points');
  for (const [acc, values, what] of [
    [dst.stroke.pressures, pressures, 'pressures'],
    [dst.angles, angles, 'angles'],
    [dst.stroke.markPenDirection, markDir, 'marker direction'],
    [dst.stroke.flagDraw, flagDraw, 'draw flags'],
  ] as [any, any[], string][]) {
    if (values.length && acc) {
      await fillAccessor(acc, values, report, what);
    }
  }
  if (!ok) {
    await dst.recycle?.();
    return undefined;
  }
  return dst;
}

async function makePicture(path: string, rect: Rect): Promise<any> {
  const el: any = unwrap(
    await PluginCommAPI.createElement(Element.TYPE_PICTURE),
    'createElement(PICTURE)',
  );
  el.layerNum = 0;
  el.picture = {picturePath: path, rect};
  return el;
}

/**
 * Rendered template images made during the current translation. They only
 * need to exist while the background is inserted: the editor copies a
 * picture's image INTO the note on insert (reading it back yields a temporary
 * extraction under /.data/plugin/), so they're deleted straight after.
 */
const renders = new Map<string, string>();

/**
 * The background image for a template, for inserting as a page background.
 *
 * A custom template IS a PNG in MyStyle/ — used directly, nothing created.
 * Built-in templates (style_*) live inside the system app, not as files, so
 * they — and a custom template missing on this device — are rendered once per
 * translation into the working folder, and removed after insertion by
 * clearRenders(). No template files are left behind either way.
 */
async function templateImage(
  srcPath: string,
  page: number,
  tpl: {name: string; md5?: string},
): Promise<string> {
  if (tpl.name.startsWith('user_')) {
    const mine = `${MYSTYLE}${tpl.name.slice('user_'.length)}.png`;
    if (await exists(mine)) {
      return mine;
    }
  }
  const done = renders.get(tpl.name);
  if (done) {
    return done;
  }
  const path = `${WORK_DIR}/rendering-${renders.size}.png`;
  await FileUtils.makeDir(WORK_DIR).catch(() => false);
  unwrap(
    await PluginFileAPI.generateNoteTemplatePng(srcPath, page, path),
    'generateNoteTemplatePng',
  );
  if (!(await exists(path))) {
    throw new Error('could not render the template image');
  }
  renders.set(tpl.name, path);
  return path;
}

/** Delete this translation's rendered template images, now that they're in the note. */
async function clearRenders(): Promise<void> {
  for (const path of renders.values()) {
    await FileUtils.deleteFile(path).catch(() => false);
  }
  renders.clear();
}

// ---------------------------------------------------------------------------
// Everything else on a page: shapes, stars, text boxes, titles, links, keywords
// ---------------------------------------------------------------------------

const TEXT_TYPES = new Set([
  Element.TYPE_TEXT,
  Element.TYPE_TEXT_DIGEST_QUOTE,
  Element.TYPE_TEXT_DIGEST_CREATE,
]);

/** How one source page's content lands on its output page. */
type Mapping = {
  pt: (p: Point) => Point;
  rect: (r: Rect) => Rect;
  /** Size factor, source -> destination (0.9117 onto the Manta, its inverse back). */
  scale: number;
  /** Displayed size of the source page (for the stored-geometry correction). */
  srcPage: Size;
};

/** Drop null/undefined fields: the SDK's validators reject null for typed fields. */
function clean<T extends object>(o: T): T {
  const out: any = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== null && v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** A shape from the shape tool. Width stays pen-true, like strokes. */
async function copyGeo(src: any, M: Mapping): Promise<any> {
  const g = src.geometry ?? {};
  const el: any = unwrap(await PluginCommAPI.createElement(Element.TYPE_GEO), 'createElement(GEO)');
  el.layerNum = Math.min(Math.max(src.layerNum ?? 0, 0), 3);
  el.geometry = clean({
    ...g,
    penWidth: Math.max(100, Math.round((g.penWidth ?? 100) / storedScale(src, M.srcPage))),
    points: Array.isArray(g.points) ? g.points.map(M.pt) : g.points,
    ellipseCenterPoint: g.ellipseCenterPoint ? M.pt(g.ellipseCenterPoint) : g.ellipseCenterPoint,
    ellipseMajorAxisRadius: g.ellipseMajorAxisRadius ? g.ellipseMajorAxisRadius * M.scale : g.ellipseMajorAxisRadius,
    ellipseMinorAxisRadius: g.ellipseMinorAxisRadius ? g.ellipseMinorAxisRadius * M.scale : g.ellipseMinorAxisRadius,
    showLassoAfterInsert: false,
  });
  return el;
}

async function copyStar(src: any, M: Mapping): Promise<any> {
  const el: any = unwrap(
    await PluginCommAPI.createElement(Element.TYPE_FIVE_STAR),
    'createElement(STAR)',
  );
  el.layerNum = Math.min(Math.max(src.layerNum ?? 0, 0), 3);
  el.fiveStar = {points: (src.fiveStar?.points ?? []).map(M.pt)};
  return el;
}

/**
 * Font size scaled with the page. Text doesn't render exactly to scale, so a
 * box shrunk to 91% with a 91% font can still wrap a word (seen: "here it is!"
 * became "here it / is!"). Rounding down when shrinking gives the text a little
 * room; rounding up when growing restores the exact original on the way back.
 */
function scaleFont(size: number, scale: number): number {
  const v = size * scale;
  return Math.max(1, scale < 1 ? Math.floor(v) : Math.ceil(v - 0.01));
}

/** Text boxes remember their pre-Manta width, so widening never accumulates. */
const TEXT_USERDATA = 'NMTEXTW:';

/**
 * A text box. Font size scales with the page so the text wraps the same way.
 *
 * Auto-width boxes (textFrameWidthType 1) are sized by the editor to fit their
 * text exactly, and include padding that doesn't scale. Shrunk to 91%, the text
 * no longer quite fits and wraps (seen: a 246px "here it is!" became 225px and
 * two lines). So going onto the Manta a box gets some extra width, and records
 * its original width; coming back it gets exactly that width again.
 */
async function copyText(src: any, M: Mapping): Promise<any> {
  const el: any = unwrap(await PluginCommAPI.createElement(src.type), 'createElement(TEXT)');
  el.layerNum = 0; // text boxes must live on the main layer
  const t = src.textBox ?? {};
  const r = M.rect(t.textRect);
  const srcWidth = t.textRect ? t.textRect.right - t.textRect.left : 0;
  const ud = typeof src.userData === 'string' ? src.userData : '';
  if (M.scale < 1 && srcWidth > 0) {
    const w = r.right - r.left;
    r.right = r.left + Math.ceil(w * 1.1) + 24;
    el.userData = `${TEXT_USERDATA}${srcWidth}`;
  } else if (ud.startsWith(TEXT_USERDATA)) {
    const original = parseInt(ud.slice(TEXT_USERDATA.length), 10);
    if (original > 0) {
      r.right = r.left + original;
    }
  }
  el.textBox = clean({
    ...t,
    textRect: r,
    fontSize: t.fontSize ? scaleFont(t.fontSize, M.scale) : t.fontSize,
  });
  return el;
}

/** Title / link boxes are stored as X, Y, width, height. */
function mapBox(b: any, M: Mapping): {X: number; Y: number; width: number; height: number} {
  const r = M.rect({left: b.X, top: b.Y, right: b.X + b.width, bottom: b.Y + b.height});
  return {
    X: Math.max(0, r.left),
    Y: Math.max(0, r.top),
    width: Math.max(1, r.right - r.left),
    height: Math.max(1, r.bottom - r.top),
  };
}

/** A title or link, held until its page's strokes have their new numbers. */
type Deferred = {
  kind: 'title' | 'link';
  data: any; // a plain copy of el.title / el.link
  userData: string;
  srcPage: number;
  M: Mapping;
  /** A link to a page of this same note — added after the swap, see addSameNoteLinks. */
  sameNote?: boolean;
};

/**
 * Same-note links waiting to be added to the reopened note: built in full
 * during the translation (page, remapped strokes), inserted afterwards.
 */
type PendingLink = {page: number; userData: string; link: any};
let pendingLinks: PendingLink[] = [];

/** Element fingerprint: type, first point, point count — matched after insert. */
const sigOf = (kind: string, first: Point | undefined, n: number) =>
  `${kind}|${first ? `${Math.round(first.x)},${Math.round(first.y)}` : '-'}|${n}`;

async function sigOfElement(el: any): Promise<string | undefined> {
  if (el?.type === Element.TYPE_STROKE && el.stroke) {
    const n = await accSize(el.stroke.points);
    const [first] = n > 0 ? await el.stroke.points.getRange(0, 1) : [];
    return sigOf('stroke', first, n);
  }
  if (el?.type === Element.TYPE_GEO && el.geometry) {
    const g = el.geometry;
    const pts = Array.isArray(g.points) ? g.points : [];
    return sigOf(`geo:${g.type}`, pts[0] ?? g.ellipseCenterPoint, pts.length);
  }
  return undefined;
}

/** Everything destined for one output page. */
type PageBatch = {
  pictures: any[];
  strokes: any[];
  /** Shapes, stars, text boxes. */
  others: any[];
  outlines: any[];
  /** Titles and links, inserted once stroke numbers are known. */
  deferred: Deferred[];
  /** Source key ("<srcPage>:<numInPage>") -> fingerprint of its copy here. */
  refs: Map<string, string>;
  keywords: {text: string; slot: number}[];
};

const newBatch = (): PageBatch => ({
  pictures: [],
  strokes: [],
  others: [],
  outlines: [],
  deferred: [],
  refs: new Map(),
  keywords: [],
});

/** Keywords on one page of a note. */
async function readKeywords(path: string, page: number): Promise<string[]> {
  try {
    const v: any = unwrap(await PluginFileAPI.getKeyWords(path, [page]), 'getKeyWords');
    const list: any[] = Array.isArray(v) ? v : Array.isArray(v?.keywords) ? v.keywords : [];
    return list
      .filter(k => (k?.page ?? page) === page)
      .map(k => (typeof k === 'string' ? k : k?.keyword))
      .filter((k): k is string => typeof k === 'string' && k.length > 0);
  } catch {
    return [];
  }
}

/**
 * Which half of a Manta page each keyword came from. Keywords have no position,
 * so this rides on the page's first outline as userData:
 *   NMOUTLINE{"kw":[["pen",1],["ink",0]]}
 */
function outlineTag(keywords: {text: string; slot: number}[]): string {
  return keywords.length
    ? `${OUTLINE_USERDATA}${JSON.stringify({kw: keywords.map(k => [k.text, k.slot])})}`
    : OUTLINE_USERDATA;
}

function keywordSlots(els: any[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const el of els) {
    const u = el?.userData;
    if (el?.type !== Element.TYPE_GEO || typeof u !== 'string' || !u.startsWith(OUTLINE_USERDATA)) {
      continue;
    }
    try {
      const kw: [string, number][] = JSON.parse(u.slice(OUTLINE_USERDATA.length)).kw ?? [];
      for (const [text, slot] of kw) {
        out.set(text, [...(out.get(text) ?? []), slot]);
      }
    } catch {
      // Plain "NMOUTLINE", or an older outline: no keyword memory.
    }
  }
  return out;
}

/** Same-note page links remember their exact target across a round trip. */
const LINK_USERDATA = 'NMLINK:';

type Totals = {
  strokes: number;
  pictures: number;
  shapes: number;
  texts: number;
  titles: number;
  links: number;
  keywords: number;
  failed: number;
};

async function insertBatches(
  report: Report,
  dstPath: string,
  batches: PageBatch[],
): Promise<Totals> {
  const t: Totals = {
    strokes: 0,
    pictures: 0,
    shapes: 0,
    texts: 0,
    titles: 0,
    links: 0,
    keywords: 0,
    failed: 0,
  };
  for (let page = 0; page < batches.length; page++) {
    const b = batches[page];
    let num = 1;
    for (const [kind, list] of [
      ['pictures', b.pictures],
      ['strokes', b.strokes],
      ['shapes and text', b.others],
      ['outlines', b.outlines],
    ] as [string, any[]][]) {
      if (!list.length) {
        continue;
      }
      for (const el of list) {
        el.pageNum = page;
        el.numInPage = num++;
      }
      try {
        unwrap(await PluginFileAPI.insertElements(dstPath, page, list), `insert ${kind}`);
        if (kind === 'strokes') {
          t.strokes += list.length;
        } else if (kind === 'pictures') {
          t.pictures += list.length;
        } else if (kind === 'shapes and text') {
          for (const el of list) {
            TEXT_TYPES.has(el.type) ? t.texts++ : t.shapes++;
          }
        }
      } catch (e: any) {
        report.add(`page ${page} ${kind}`, e?.message ?? String(e), true);
        if (kind !== 'outlines') {
          t.failed += list.length;
        }
      }
      await recycleAll(list);
    }

    if (b.deferred.length) {
      // Learn the numbers the copies actually got, by fingerprint.
      const numBySig = new Map<string, number[]>();
      let readBack: any[] = [];
      try {
        readBack = await readElements(dstPath, page);
        for (const el of readBack) {
          const sig = await sigOfElement(el);
          if (sig) {
            numBySig.set(sig, [...(numBySig.get(sig) ?? []), el.numInPage]);
          }
        }
      } catch (e: any) {
        report.add(`page ${page} read back`, e?.message ?? String(e), true);
      }
      await recycleAll(readBack);
      const numFor = (key: string): number | undefined => {
        const sig = b.refs.get(key);
        const nums = sig ? numBySig.get(sig) : undefined;
        return nums?.length ? nums[0] : undefined;
      };

      const els: any[] = [];
      let unmatched = 0;
      for (const d of b.deferred) {
        const nums = (d.data.controlTrailNums ?? [])
          .map((n: number) => numFor(`${d.srcPage}:${n}`))
          .filter((n: number | undefined): n is number => {
            if (n === undefined) {
              unmatched++;
              return false;
            }
            return true;
          });
        const box = mapBox(d.data, d.M);
        const el: any = unwrap(
          await PluginCommAPI.createElement(d.kind === 'title' ? Element.TYPE_TITLE : Element.TYPE_LINK),
          `createElement(${d.kind})`,
        );
        el.layerNum = 0; // titles and links must live on the main layer
        el.pageNum = page;
        el.numInPage = num++;
        el.userData = d.userData;
        const body = clean({...d.data, ...box, page, controlTrailNums: nums});
        delete (body as any).num;
        delete (body as any).index;
        if (d.kind === 'link' && body.fontSize) {
          body.fontSize = scaleFont(body.fontSize, d.M.scale);
        }
        if (d.kind === 'title') {
          el.title = body;
        } else if (d.sameNote) {
          pendingLinks.push({page, userData: d.userData, link: body});
          await el.recycle?.();
          continue;
        } else {
          el.link = body;
        }
        els.push(el);
      }
      if (unmatched) {
        report.add(`page ${page}`, `${unmatched} title/link stroke references not matched`, true);
        t.failed += unmatched;
      }
      try {
        if (els.length) {
          unwrap(await PluginFileAPI.insertElements(dstPath, page, els), 'insert titles/links');
        }
        for (const el of els) {
          el.type === Element.TYPE_TITLE ? t.titles++ : t.links++;
        }
      } catch (e: any) {
        report.add(`page ${page} titles/links`, e?.message ?? String(e), true);
        t.failed += els.length;
      }
      await recycleAll(els);
    }

    for (const k of b.keywords) {
      try {
        unwrap(await PluginFileAPI.insertKeyWord(dstPath, page, k.text), 'insertKeyWord');
        t.keywords++;
      } catch (e: any) {
        report.add(`page ${page} keyword "${k.text}"`, e?.message ?? String(e), true);
        t.failed++;
      }
    }
  }
  return t;
}

/** Sort one source element into a page batch. Shared by both directions. */
async function collect(
  report: Report,
  el: any,
  b: PageBatch,
  srcPage: number,
  M: Mapping,
  pts: Point[] | undefined,
  linkDest: (
    link: any,
    userData: string,
  ) => {destPage: number; destPath: string; userData: string; sameNote?: boolean} | undefined,
): Promise<'ok' | 'failed' | 'ignored'> {
  const key = `${srcPage}:${el.numInPage}`;
  const t = el?.type;
  if (t === Element.TYPE_STROKE && el.stroke && pts?.length) {
    const dst = await copyStroke(report, el, M.pt, pts, M.srcPage);
    if (!dst) {
      return 'failed';
    }
    b.refs.set(key, sigOf('stroke', M.pt(pts[0]), pts.length));
    b.strokes.push(dst);
    return 'ok';
  }
  if (t === Element.TYPE_GEO) {
    if (isOurOutline(el)) {
      return 'ignored';
    }
    const dst = await copyGeo(el, M);
    const g = dst.geometry;
    const gp = Array.isArray(g.points) ? g.points : [];
    b.refs.set(key, sigOf(`geo:${g.type}`, gp[0] ?? g.ellipseCenterPoint, gp.length));
    b.others.push(dst);
    return 'ok';
  }
  if (t === Element.TYPE_FIVE_STAR) {
    b.others.push(await copyStar(el, M));
    return 'ok';
  }
  if (TEXT_TYPES.has(t) && el.textBox) {
    b.others.push(await copyText(el, M));
    return 'ok';
  }
  if (t === Element.TYPE_TITLE && el.title) {
    b.deferred.push({kind: 'title', data: {...el.title}, userData: '', srcPage, M});
    return 'ok';
  }
  if (t === Element.TYPE_LINK && el.link) {
    const data = {...el.link, controlTrailNums: [...(el.link.controlTrailNums ?? [])]};
    let userData = '';
    const moved = linkDest(el.link, el.userData ?? '');
    if (moved) {
      data.destPage = moved.destPage;
      data.destPath = moved.destPath;
      userData = moved.userData;
    }
    b.deferred.push({kind: 'link', data, userData, srcPage, M, sameNote: !!moved?.sameNote});
    return 'ok';
  }
  return 'ignored';
}

/** Where a box-like element sits, for picking its half of a Manta page. */
function centreOf(el: any): Point | undefined {
  const r =
    el?.textBox?.textRect ??
    (el?.title ? {left: el.title.X, top: el.title.Y, right: el.title.X + el.title.width, bottom: el.title.Y + el.title.height} : undefined) ??
    (el?.link ? {left: el.link.X, top: el.link.Y, right: el.link.X + el.link.width, bottom: el.link.Y + el.link.height} : undefined);
  if (r) {
    return {x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2};
  }
  const pts: Point[] | undefined = el?.geometry?.points ?? el?.fiveStar?.points;
  if (pts?.length) {
    return {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
    };
  }
  return el?.geometry?.ellipseCenterPoint;
}

function reportTotals(report: Report, t: Totals, extra: number) {
  report.heading('RESULT');
  report.add('strokes', String(t.strokes));
  report.add('pictures / backgrounds', String(t.pictures));
  report.add('shapes, text boxes', `${t.shapes}, ${t.texts}`);
  report.add('titles, links, keywords', `${t.titles}, ${t.links}, ${t.keywords}`);
  report.add('failed', String(extra + t.failed), extra + t.failed > 0);
}

/**
 * Nomad note -> Manta note. Runs on the Manta.
 * `portrait` picks the layout: false = side by side (landscape), true = stacked.
 */
async function toManta(
  report: Report,
  plan: Plan,
  dstPath: string,
  prepare: (want: number) => Promise<boolean>,
): Promise<number> {
  const {srcPath, srcPages} = plan;
  const outPages = Math.ceil(srcPages / 2);

  report.heading('BUILDING');
  if (!(await prepare(outPages))) {
    return -1;
  }
  const L = planLayout(await pageSize(dstPath, 0), plan.srcSize);
  report.add('pages', `${outPages} (from ${srcPages} Nomad pages)`);
  report.add(
    'layout',
    `${L.vertical ? 'landscape, side by side' : 'portrait, stacked'} at ${(L.scale * 100).toFixed(1)}%`,
  );

  report.heading('TRANSLATING');
  const batches: PageBatch[] = Array.from({length: outPages}, newBatch);
  let failed = 0;
  let bgMissing = 0;

  // Links to a page of this same note follow it: Nomad page k is on Manta page
  // k/2. The exact page is remembered for the trip back. They're added after
  // the swap — see addSameNoteLinks.
  const linkDest = (link: any) =>
    link?.linkType === 0 && link?.destPath === srcPath && typeof link.destPage === 'number'
      ? {
          destPage: Math.floor(link.destPage / 2),
          destPath: srcPath,
          userData: `${LINK_USERDATA}${link.destPage}`,
          sameNote: true,
        }
      : undefined;

  for (let k = 0; k < srcPages; k++) {
    const page = Math.floor(k / 2);
    const slot = k % 2;
    const b = batches[page];
    const M: Mapping = {
      pt: p => toMantaPoint(p, L, slot),
      rect: r => rectToManta(r, L, slot),
      scale: L.scale,
      srcPage: L.nomad,
    };

    // The page's own background, scaled into its slot by the same factor as the
    // writing, so the writing stays on its grid. Plain white pages need none.
    try {
      const tpl: any = unwrap(
        await PluginFileAPI.getNotePageTemplate(srcPath, k),
        'getNotePageTemplate',
      );
      if (tpl?.name && tpl.name !== PLAIN) {
        const bg = await templateImage(srcPath, k, tpl);
        const pic = await makePicture(
          bg,
          rectToManta({left: 0, top: 0, right: L.nomad.width, bottom: L.nomad.height}, L, slot),
        );
        pic.userData = `${BG_USERDATA}${tpl.name}`;
        b.pictures.push(pic);
      }
    } catch {
      bgMissing++;
    }

    for (const text of await readKeywords(srcPath, k)) {
      b.keywords.push({text, slot});
    }

    let els: any[] = [];
    try {
      els = await readElements(srcPath, k);
    } catch (e: any) {
      report.add(`Nomad page ${k}`, e?.message ?? String(e), true);
      failed++;
      continue;
    }

    for (const el of els) {
      try {
        if (el?.type === Element.TYPE_PICTURE && el.picture?.picturePath) {
          b.pictures.push(await makePicture(el.picture.picturePath, M.rect(el.picture.rect)));
          continue;
        }
        let pts: Point[] | undefined;
        if (el?.type === Element.TYPE_STROKE && el.stroke) {
          const n = await el.stroke.points.size();
          if (!n) {
            continue;
          }
          pts = await el.stroke.points.getRange(0, n);
        }
        if ((await collect(report, el, b, k, M, pts, linkDest)) === 'failed') {
          failed++;
        }
      } catch (e: any) {
        failed++;
        report.add('element failed', e?.message ?? String(e), true);
      }
    }
    report.add(`Nomad page ${k}`, `-> Manta page ${page}, ${slot ? (L.vertical ? 'right' : 'bottom') : L.vertical ? 'left' : 'top'}`);
    await recycleAll(els);
  }

  // Page outlines and the fold/divider on every output page. The first one
  // also remembers which half each keyword came from.
  const segs = outlineSegments(L);
  for (const b of batches) {
    for (let i = 0; i < segs.length; i++) {
      const [a, z] = segs[i];
      const el: any = unwrap(
        await PluginCommAPI.createElement(Element.TYPE_GEO),
        'createElement(GEO)',
      );
      el.layerNum = 0;
      el.userData = i === 0 ? outlineTag(b.keywords) : OUTLINE_USERDATA;
      el.geometry = {
        penColor: OUTLINE_PEN_COLOR,
        penType: OUTLINE_PEN_TYPE,
        penWidth: OUTLINE_PEN_WIDTH,
        type: 'straightLine',
        points: [a, z],
      };
      b.outlines.push(el);
    }
  }

  const t = await insertBatches(report, dstPath, batches);
  await clearRenders();
  reportTotals(report, t, failed);
  report.add('backgrounds not captured', String(bgMissing), bgMissing > 0);
  return failed + t.failed;
}

/** Manta note -> Nomad note. Runs on the Nomad. Layout follows each Manta page. */
async function toNomad(
  report: Report,
  plan: Plan,
  dstPath: string,
  prepare: (want: number) => Promise<boolean>,
): Promise<number> {
  const {srcPath, srcPages} = plan;
  // Layout uses the standard Nomad page; the output is checked to match it.
  const nomad = NOMAD_PAGE;

  // Read everything first, so we know whether the very last half is empty and
  // can drop it rather than leaving a trailing blank page.
  type Item = {page: number; slot: number; L: Layout; el: any; pts?: Point[]};
  const items: Item[] = [];
  const pageEls: any[][] = [];
  const keywords: {page: number; slot: number; text: string}[] = [];
  let failed = 0;

  report.heading('BUILDING');
  for (let j = 0; j < srcPages; j++) {
    let els: any[] = [];
    let L: Layout;
    try {
      const size = await pageSize(srcPath, j);
      if (!isManta(size)) {
        report.add(`Manta page ${j}`, `unexpected size ${size.width}x${size.height}`, true);
        failed++;
        continue;
      }
      L = planLayout(size, nomad);
      els = await readElements(srcPath, j);
    } catch (e: any) {
      report.add(`Manta page ${j}`, e?.message ?? String(e), true);
      failed++;
      continue;
    }
    pageEls.push(els);

    const halfOf = (p: Point | undefined) =>
      !p ? 0 : L.vertical ? (p.x < L.manta.width / 2 ? 0 : 1) : p.y < L.manta.height / 2 ? 0 : 1;

    for (const el of els) {
      if (el?.type === Element.TYPE_STROKE && el.stroke) {
        const n = await el.stroke.points.size();
        if (!n) {
          continue;
        }
        const pts: Point[] = await el.stroke.points.getRange(0, n);
        items.push({page: j, slot: slotOf(pts, L), L, el, pts});
      } else if (el?.type === Element.TYPE_PICTURE && el.picture?.picturePath) {
        if (backgroundOf(el, L).is) {
          // One of our scaled backgrounds — replaced by the real template.
          continue;
        }
        const r = el.picture.rect;
        items.push({page: j, slot: halfOf({x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2}), L, el});
      } else if (el?.type === Element.TYPE_GEO && isOurOutline(el)) {
        continue;
      } else {
        items.push({page: j, slot: halfOf(centreOf(el)), L, el});
      }
    }

    // Keywords go back to the half they came from, if remembered.
    const memory = keywordSlots(els);
    for (const text of await readKeywords(srcPath, j)) {
      const slots = memory.get(text);
      const slot = slots?.length ? slots.shift()! : 0;
      keywords.push({page: j, slot, text});
    }

    report.add(
      `Manta page ${j}`,
      `${L.vertical ? 'landscape' : 'portrait'} -> Nomad pages ${j * 2} + ${j * 2 + 1}`,
    );
  }

  // Keep every pair intact so pages stay aligned on the next round trip; only a
  // final empty half is dropped.
  let outPages = srcPages * 2;
  const used = (i: number) =>
    items.some(it => it.page * 2 + it.slot === i) ||
    keywords.some(k => k.page * 2 + k.slot === i);
  if (outPages > 1 && !used(outPages - 1)) {
    outPages -= 1;
  }
  if (!(await prepare(outPages))) {
    return -1;
  }
  report.add('pages', `${outPages} (from ${srcPages} Manta pages)`);

  const batches: PageBatch[] = Array.from({length: outPages}, newBatch);
  let missingImages = 0;

  // Same-note page links: back to the exact Nomad page if remembered, else the
  // first page of the pair.
  const linkDest = (link: any, userData: string) => {
    if (!(link?.linkType === 0 && link?.destPath === srcPath && typeof link.destPage === 'number')) {
      return undefined;
    }
    const remembered = userData.startsWith(LINK_USERDATA)
      ? parseInt(userData.slice(LINK_USERDATA.length), 10)
      : NaN;
    const dest = Number.isFinite(remembered) ? remembered : link.destPage * 2;
    return {destPage: Math.min(dest, outPages - 1), destPath: srcPath, userData: '', sameNote: true};
  };

  for (const it of items) {
    const target = it.page * 2 + it.slot;
    if (target >= outPages) {
      continue;
    }
    const M: Mapping = {
      pt: p => toNomadPoint(p, it.L, it.slot),
      rect: r => rectToNomad(r, it.L, it.slot),
      scale: 1 / it.L.scale,
      srcPage: it.L.manta,
    };
    try {
      if (it.el?.type === Element.TYPE_PICTURE) {
        const path = it.el.picture.picturePath;
        // A missing file would fail the whole page's picture insert (1211).
        if (!(await FileUtils.exists(path).catch(() => false))) {
          missingImages++;
          continue;
        }
        batches[target].pictures.push(await makePicture(path, M.rect(it.el.picture.rect)));
      } else if ((await collect(report, it.el, batches[target], it.page, M, it.pts, linkDest)) === 'failed') {
        failed++;
      }
    } catch (e: any) {
      failed++;
      report.add('element failed', e?.message ?? String(e), true);
    }
  }
  for (const k of keywords) {
    const target = Math.min(k.page * 2 + k.slot, outPages - 1);
    batches[target].keywords.push({text: k.text, slot: 0});
  }

  const t = await insertBatches(report, dstPath, batches);
  for (const els of pageEls) {
    await recycleAll(els);
  }

  reportTotals(report, t, failed);
  report.add('image files not on this device', String(missingImages), missingImages > 0);
  return failed + t.failed;
}

/**
 * Translate the open note IN PLACE.
 *
 * A note's page size is fixed when it's created, so it can't be reshaped where
 * it stands. Instead:
 *
 *   1. build the translation in "<name> (translating).note" beside it
 *   2. if keepBackup, copy the original into EXPORT/Migration/backups/
 *   3. delete the original, rename the new note into its place
 *   4. the caller reopens it with PluginFileAPI.openFile when the panel closes
 *
 * Returns true only if the original was actually replaced.
 *
 * Ordering is chosen so a failure at any step leaves the content somewhere
 * safe: nothing is deleted until the translation is complete with zero failures,
 * and if the final rename fails the report says exactly where the note is.
 */
// ---------------------------------------------------------------------------
// Diagnostics: stroke attributes before and after
// ---------------------------------------------------------------------------

const accSize = async (a: any): Promise<number> => {
  try {
    return a ? await a.size() : 0;
  } catch {
    return -1;
  }
};

/**
 * Summarise every stroke in a note: pen type/colour, thickness, and which of
 * the per-point data arrays it carries. Used to compare a translation with its
 * source — copyStroke only copies points and pressures.
 */
async function strokeStats(report: Report, label: string, path: string): Promise<void> {
  // Per page: thickness groups, plus the EMR extent (maxX/maxY) the editor
  // records on each stroke — suspected of driving a 1920/1404 thickness rescale
  // that the Nomad's editor applied to plugin-inserted strokes on one page.
  report.heading(`STROKES — ${label}`);
  let pages = 0;
  try {
    pages = await totalPages(path);
  } catch {}
  for (let p = 0; p < pages; p++) {
    let els: any[] = [];
    try {
      els = await readElements(path, p);
    } catch {
      continue;
    }
    const thick = new Map<number, number>();
    const extent = new Map<string, number>();
    let n = 0;
    let withPen = 0;
    const tags: string[] = [];
    let pics = 0;
    for (const el of els) {
      if (el?.type === Element.TYPE_PICTURE) {
        pics++;
        if (typeof el.userData === 'string' && el.userData) {
          tags.push(el.userData);
        }
      }
      if (el?.type !== Element.TYPE_STROKE || !el.stroke) {
        continue;
      }
      n++;
      thick.set(el.thickness, (thick.get(el.thickness) ?? 0) + 1);
      const ext = `${el.maxX}x${el.maxY}`;
      extent.set(ext, (extent.get(ext) ?? 0) + 1);
      if ((await accSize(el.angles)) > 0) {
        withPen++;
      }
    }
    await recycleAll(els);
    if (!n && !pics) {
      continue;
    }
    const fmt = (m: Map<any, number>) => [...m].map(([k, c]) => `${k}×${c}`).join(' ');
    report.add(
      `page ${p}`,
      `${n} strokes · thickness ${fmt(thick)} · maxX×maxY ${fmt(extent)} · pen data ${withPen}` +
        (pics ? ` · pictures ${pics}, tags [${tags.join(', ')}]` : ''),
    );
  }
}

/**
 * Which template the Nomad pages should use, recovered from the background
 * pictures toManta left behind. One template for the whole note: that covers
 * the normal case, and differing pages are reported rather than guessed at.
 */
/**
 * The template for each Nomad page, from the background tags on the Manta
 * pages: Nomad page 2j + slot gets the background in that slot of Manta page j.
 * Pages without a known template are plain.
 */
async function nomadTemplates(report: Report, plan: Plan): Promise<string[]> {
  const out: string[] = [];
  const seen = new Map<string, string | undefined>();
  for (let j = 0; j < plan.srcPages; j++) {
    try {
      const size = await pageSize(plan.srcPath, j);
      const L = planLayout(size, NOMAD_PAGE);
      const els = await readElements(plan.srcPath, j);
      for (const el of els) {
        const name = backgroundOf(el, L).template;
        const r = el.picture?.rect;
        if (!name || !r) {
          continue;
        }
        const cx = (r.left + r.right) / 2;
        const cy = (r.top + r.bottom) / 2;
        const slot = L.vertical ? (cx < L.manta.width / 2 ? 0 : 1) : cy < L.manta.height / 2 ? 0 : 1;
        if (!seen.has(name)) {
          seen.set(name, await resolveTemplate(name));
        }
        out[j * 2 + slot] = seen.get(name) ?? PLAIN;
      }
      await recycleAll(els);
    } catch {
      // A page we can't read just contributes nothing here.
    }
  }
  if (!seen.size) {
    report.add('template', 'none recorded — plain');
  }
  for (const [name, resolved] of seen) {
    report.add('template', resolved ? `${name} -> ${resolved}` : `${name} not on this device — plain`, !resolved);
  }
  return Array.from({length: plan.srcPages * 2}, (_, k) => out[k] ?? PLAIN);
}

/** Each page's template as the note now records it, for the report. */
async function reportPageTemplates(report: Report, path: string): Promise<void> {
  const names: string[] = [];
  const pages = await totalPages(path).catch(() => 0);
  for (let p = 0; p < pages; p++) {
    try {
      names.push(unwrap(await PluginFileAPI.getNotePageTemplate(path, p), 'getNotePageTemplate')?.name ?? '?');
    } catch {
      names.push('?');
    }
  }
  report.add('page templates', names.join(', '));
}

/**
 * Add the same-note links to the translated note, once it's open in the editor.
 *
 * A link stores hidden IDs for its target note and page (destFileId,
 * destPageId), looked up from destPath when it's inserted. Neither earlier
 * moment gives the right answer:
 *   - inserted into the note being built, they point at THAT file (v0.0.40–41)
 *   - re-pointed to the note's own path before the swap, the lookup finds the
 *     original's old pages (v0.0.43: "The link target doesn't exist")
 *   - modified in the original after the swap, the editor saved its stale copy
 *     back over page 1 (v0.0.42, Nomad)
 *
 * So they're added last, through the editor (insertPageElements acts on the
 * open note), and saved with saveCurrentNote. The note's own pages exist by
 * then, so the lookup is right, and the editor's copy is never out of date.
 *
 * The strokes a link covers keep their numbers through the swap — the note is
 * copied byte for byte — so controlTrailNums is already correct.
 */
export const hasSameNoteLinks = () => pendingLinks.length > 0;

/** Give up on the pending links, reporting how many were lost. */
export async function dropSameNoteLinks(report: Report): Promise<number> {
  const n = pendingLinks.length;
  pendingLinks = [];
  report.add('same-note links', `${n} not added — the note didn't reopen in time`, true);
  return n;
}

/**
 * Wait until the editor shows the translated note, with no timers.
 *
 * openFile hides the plugin view itself, and React Native pauses its timers
 * while the view is hidden — so v0.0.44's 2 s setTimeout never fired, and the
 * links were never added. Native calls still go through, so this polls the open
 * page's shape (portrait or landscape; its size includes zoom, but its shape
 * doesn't) until it matches the translation, then settles a moment longer.
 */
/** Wait without timers (they're paused while the view is hidden): poll a native call. */
async function pause(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await PluginCommAPI.getCurrentPageNum().catch(() => undefined);
  }
}

export async function waitForOpen(report: Report, portrait: boolean): Promise<boolean> {
  const start = Date.now();
  let seen = '';
  let ok = false;
  while (Date.now() - start < 15000) {
    try {
      const s = unwrap(await PluginCommAPI.getPageDisplaySize(), 'getPageDisplaySize');
      seen = `${s?.width}x${s?.height}`;
      if (s?.width && s?.height && s.height > s.width === portrait) {
        ok = true;
        break;
      }
    } catch {}
  }
  // The shape flips ~1.7 s before the editor has loaded the page's elements
  // (v0.0.45: insert at +1.5 s failed with 502), so settle longer.
  const settle = Date.now();
  await pause(2500);
  report.add('editor shows new note', ok ? `after ${settle - start} ms (${seen})` : `not seen (last ${seen})`, !ok);
  return ok;
}

export async function addSameNoteLinks(report: Report, path: string): Promise<number> {
  const todo = pendingLinks;
  pendingLinks = [];
  if (!todo.length) {
    return 0;
  }
  report.heading('SAME-NOTE LINKS');
  let added = 0;
  let failed = 0;
  const byPage = new Map<number, PendingLink[]>();
  for (const l of todo) {
    byPage.set(l.page, [...(byPage.get(l.page) ?? []), l]);
  }
  for (const [page, links] of byPage) {
    let num = 1;
    try {
      const els = await readElements(path, page);
      for (const el of els) {
        num = Math.max(num, (el.numInPage ?? 0) + 1);
      }
      await recycleAll(els);
    } catch {}
    const els: any[] = [];
    for (const l of links) {
      const el: any = unwrap(await PluginCommAPI.createElement(Element.TYPE_LINK), 'createElement(link)');
      el.layerNum = 0;
      el.pageNum = page;
      el.numInPage = num++;
      el.userData = l.userData;
      el.link = {...l.link, destPath: path};
      els.push(el);
    }
    // 502 ("corresponding element not found") means the editor hasn't loaded
    // the page's strokes yet; a failed insert changes nothing, so retry.
    const start = Date.now();
    let tries = 0;
    for (;;) {
      tries++;
      try {
        unwrap(await PluginCommAPI.insertPageElements(els, page, 0), 'insertPageElements');
        added += els.length;
        report.add(`page ${page} links`, `${els.length} added (try ${tries}, ${Date.now() - start} ms)`);
        break;
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (msg.includes('[502]') && Date.now() - start < 12000) {
          await pause(1000);
          continue;
        }
        failed += els.length;
        report.add(`page ${page} links`, `${msg} (try ${tries})`, true);
        break;
      }
    }
    await recycleAll(els);
  }
  try {
    unwrap(await PluginNoteAPI.saveCurrentNote(), 'saveCurrentNote');
  } catch (e: any) {
    report.add('save', e?.message ?? String(e), true);
  }
  // What the note now holds, to confirm the page IDs resolved.
  for (const page of byPage.keys()) {
    try {
      const after = await readElements(path, page);
      for (const el of after) {
        if (el?.type === Element.TYPE_LINK && el.link?.linkType === 0) {
          report.add(`  link p${page}`, brief(el.link).slice(0, 400));
        }
      }
      await recycleAll(after);
    } catch {}
  }
  report.add('same-note links', `${added} added after reopen${failed ? `, ${failed} failed` : ''}`, failed > 0);
  return failed;
}

/** Is this geometry element one of the page outlines Migration draws? */
function isOurOutline(el: any): boolean {
  if (typeof el?.userData === 'string' && el.userData.startsWith(OUTLINE_USERDATA)) {
    return true;
  }
  // Outlines from before they were tagged (pre-v0.0.39): a dark-gray straight
  // line. Width isn't checked — it comes back rescaled on pages stored at a
  // different size (100 reads as 97) — and colour only where it's readable.
  const g = el?.geometry;
  const straight =
    g?.type === 'straightLine' || el?.recognizeResult?.predict_name === 'straightLine';
  return straight && (g?.penColor === undefined || g.penColor === OUTLINE_PEN_COLOR);
}

/** Element types Migration knows how to carry. */
const CARRIED = new Set<number>([
  Element.TYPE_STROKE,
  Element.TYPE_PICTURE,
  Element.TYPE_GEO,
  Element.TYPE_FIVE_STAR,
  Element.TYPE_TEXT,
  Element.TYPE_TEXT_DIGEST_QUOTE,
  Element.TYPE_TEXT_DIGEST_CREATE,
  Element.TYPE_TITLE,
  Element.TYPE_LINK,
]);

/**
 * Anything in the note that a translation can't carry over.
 *
 * Translating replaces the note, so anything not carried would be LOST from
 * it — not merely skipped. Every element type the SDK documents is carried
 * (strokes, pictures, shapes, stars, text boxes, titles, links; keywords are
 * per page). This guards against anything else, and returns a description
 * like "3 unknown items", or undefined if everything can travel.
 */
async function uncarried(plan: Plan): Promise<string | undefined> {
  const types = new Map<number, number>();
  for (let p = 0; p < plan.srcPages; p++) {
    let els: any[] = [];
    try {
      els = await readElements(plan.srcPath, p);
    } catch {
      continue;
    }
    for (const el of els) {
      if (!CARRIED.has(el?.type)) {
        types.set(el?.type, (types.get(el?.type) ?? 0) + 1);
      }
    }
    await recycleAll(els);
  }
  const n = [...types.values()].reduce((a, b) => a + b, 0);
  if (!n) {
    return undefined;
  }
  return `${n === 1 ? 'an item' : `${n} items`} of a kind it doesn't know (type ${[...types.keys()].join(', ')})`;
}

export async function runTranslation(
  report: Report,
  plan: Plan,
  opts: {portrait?: boolean; keepBackup: boolean},
): Promise<boolean> {
  const {srcPath} = plan;
  const {dir, base} = baseName(srcPath);
  pendingLinks = [];
  const blocked = await uncarried(plan);
  if (blocked) {
    report.add(
      'NOT TRANSLATED',
      `This note has ${blocked}, which Migration can't carry yet — translating ` +
        `would lose them. Nothing was changed.`,
      true,
    );
    return false;
  }

  // Build in the working folder; fall back to beside the original if
  // createNote isn't allowed there.
  await FileUtils.makeDir(WORK_DIR).catch(() => false);
  const tempCandidates = [`${WORK_DIR}/translating.note`, `${dir}/${base} (translating).note`];
  let tempPath = tempCandidates[0];

  try {
    for (const t of tempCandidates) {
      // A temp file left by an interrupted run would make createNote fail (1202).
      if (await exists(t)) {
        await FileUtils.deleteFile(t);
      }
    }
    const toManta_ = plan.direction === 'toManta';

    // Manta pages are built plain, with scaled background pictures per slot.
    // Nomad pages can use the real template natively at full size.
    const templates = toManta_ ? [] : await nomadTemplates(report, plan);
    let template = templates[0] ?? PLAIN;
    const isPortrait = toManta_ ? !!opts.portrait : true;
    const create = async (path: string) => {
      try {
        unwrap(
          await PluginFileAPI.createNote({notePath: path, template, mode: 0, isPortrait}),
          'createNote',
        );
      } catch (e: any) {
        if (template === PLAIN) {
          throw e;
        }
        report.add('template', `${template} refused (${e?.message ?? e}) — using plain`, true);
        template = PLAIN;
        unwrap(
          await PluginFileAPI.createNote({notePath: path, template, mode: 0, isPortrait}),
          'createNote',
        );
      }
    };
    try {
      await create(tempCandidates[0]);
    } catch (e: any) {
      report.add('temp in working folder', `${e?.message ?? e} — building beside the note`, true);
      tempPath = tempCandidates[1];
      await create(tempPath);
    }
    report.add('built in', tempPath);
    const prepare = (want: number) =>
      ensurePages(report, tempPath, want, k => (k === 0 ? template : templates[k] ?? PLAIN));

    const failed = toManta_
      ? await toManta(report, plan, tempPath, prepare)
      : await toNomad(report, plan, tempPath, prepare);

    if (!toManta_) {
      await reportPageTemplates(report, tempPath);
    }

    if (DIAGNOSTICS) {
      await strokeStats(report, 'original', plan.srcPath);
      await strokeStats(report, 'translated', tempPath);
    }

    report.heading('REPLACING');
    if (failed !== 0) {
      pendingLinks = [];
      report.add(
        'NOT REPLACED',
        `the translation had problems, so your note was left as it was. ` +
          `The partial result is in "${tempPath}".`,
        true,
      );
      return false;
    }

    if (opts.keepBackup) {
      await FileUtils.makeDir(WORK_DIR).catch(() => false);
      await FileUtils.makeDir(BACKUP_DIR).catch(() => false);
      const backupPath = `${BACKUP_DIR}/${base} ${stamp()}.note`;
      const ok = await FileUtils.copyFile(srcPath, backupPath).catch(() => false);
      if (!ok || !(await exists(backupPath))) {
        report.add(
          'NOT REPLACED',
          'could not make the backup, so your note was left as it was',
          true,
        );
        await FileUtils.deleteFile(tempPath).catch(() => false);
        return false;
      }
      report.add('backup', backupPath);
    } else {
      report.add('backup', 'off');
    }

    // Prefer overwriting the note's contents in place: to Drive that's an
    // ordinary edit of one file. Delete + rename can look like "deleted" plus
    // "new file", which risks sync conflicts. Verified by md5.
    const wantMd5 = await FileUtils.getFileMD5(tempPath).catch(() => '');
    let placed =
      !!wantMd5 &&
      (await FileUtils.copyFile(tempPath, srcPath).catch(() => false)) &&
      (await FileUtils.getFileMD5(srcPath).catch(() => '')) === wantMd5;

    if (placed) {
      report.add('replaced by', 'overwrite in place');
    } else {
      const deleted = await FileUtils.deleteFile(srcPath).catch(() => false);
      if (!deleted || (await exists(srcPath))) {
        report.add(
          'NOT REPLACED',
          `could not replace the original. The translation is in "${tempPath}".`,
          true,
        );
        return false;
      }
      placed = await FileUtils.renameToFile(tempPath, srcPath).catch(() => false);
      if (!placed || !(await exists(srcPath))) {
        placed = await FileUtils.copyFile(tempPath, srcPath).catch(() => false);
      }
      if (!placed || !(await exists(srcPath))) {
        report.add(
          'IMPORTANT',
          `the original was removed but the translation could not be moved into its place. ` +
            `It is safe in "${tempPath}"` +
            (opts.keepBackup ? ', and the original is in EXPORT/Migration/backups.' : '.'),
          true,
        );
        return false;
      }
      report.add('replaced by', 'delete + rename');
    }
    await FileUtils.deleteFile(tempPath).catch(() => false);
    report.add('replaced', srcPath);
  } catch (e: any) {
    report.add('ABORTED', e?.message ?? String(e), true);
    return false;
  } finally {
    // In case a translation stopped before its backgrounds were inserted.
    await clearRenders();
  }
  report.add('next', 'Tap Close to open the translated note.');
  return true;
}

/**
 * Reopen the translated note so the editor shows it.
 *
 * The editor works on a private copy (note_internal_cache/) and reloadFile()
 * reloads from that copy, not from disk — v0.0.18 called it and nothing
 * changed. openFile goes through the normal open path. Doing this promptly also
 * matters for safety: if the stale editor were written on, it would save the old
 * page layout back over the translation when closed.
 */
export async function reopen(path: string): Promise<string> {
  try {
    unwrap(await PluginFileAPI.openFile(path, 0), 'openFile');
    return 'ok';
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}



// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/*
 * FileUtils has no text read/write, so the one setting is stored as the
 * presence of a marker directory. Backups are ON unless the marker exists.
 */
const NO_BACKUP_MARKER = `${WORK_DIR}/settings/backup-off`;
const OLD_NO_BACKUP_MARKERS = OLD_WORK_DIRS.map(d => `${d}/settings/backup-off`);

export async function getKeepBackup(): Promise<boolean> {
  for (const m of [NO_BACKUP_MARKER, ...OLD_NO_BACKUP_MARKERS]) {
    if (await exists(m)) {
      return false;
    }
  }
  return true;
}

export async function setKeepBackup(on: boolean): Promise<void> {
  // Any choice made now replaces ones stored by earlier versions.
  for (const m of OLD_NO_BACKUP_MARKERS) {
    await FileUtils.deleteDir(m).catch(() => false);
  }
  if (on) {
    await FileUtils.deleteDir(NO_BACKUP_MARKER).catch(() => false);
  } else {
    await FileUtils.makeDir(WORK_DIR).catch(() => false);
    await FileUtils.makeDir(`${WORK_DIR}/settings`).catch(() => false);
    await FileUtils.makeDir(NO_BACKUP_MARKER).catch(() => false);
  }
}
