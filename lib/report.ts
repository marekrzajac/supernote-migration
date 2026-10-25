/**
 * Shared reporting helpers.
 *
 * Both the inspector and the spread builder produce a flat list of Rows, which
 * the UI renders on e-ink and which we also dump to the RN log for adb.
 */

import {PluginManager} from 'sn-plugin-lib';

/** One line of a report. */
export type Row = {
  label: string;
  value: string;
  /** Section heading rather than a value row. */
  heading?: boolean;
  /** Render as a failure. */
  bad?: boolean;
};

/**
 * Accumulates report rows. Passed down into the probe/build routines so they
 * can report progress without knowing anything about the UI.
 */
export class Report {
  rows: Row[] = [];

  add(label: string, value: string, bad = false): void {
    this.rows.push({label, value, bad});
  }

  heading(label: string): void {
    this.rows.push({label, value: '', heading: true});
  }

  /**
   * Run one step, recording either its value or its error. A failing step never
   * aborts the run — we want as much of the picture as we can get.
   */
  async probe<T>(
    label: string,
    fn: () => Promise<T>,
    render?: (v: T) => void,
  ): Promise<T | undefined> {
    try {
      const v = await fn();
      if (render) {
        render(v);
      } else {
        this.add(label, brief(v));
      }
      return v;
    } catch (e: any) {
      this.add(label, e?.message ?? String(e), true);
      return undefined;
    }
  }

  /** Dump to the RN log so `adb logcat -s ReactNativeJS:V` captures it. */
  log(title: string): void {
    const lines = this.rows.map(r =>
      r.heading ? `\n=== ${r.label} ===` : `${r.label}: ${r.value}`,
    );
    console.log(
      `\n===== ${title} =====\n` + lines.join('\n') + `\n===== END ${title} =====`,
    );
  }
}

/**
 * Permissions must be declared in PluginConfig.json "uses-permissions" AND
 * requested at runtime, every time the plugin opens. Without this, every
 * file API fails with error 1503 (read) or 1501 (write).
 *
 * hasPermission:     1 = granted, 0 = not granted
 * requestPermission: 0 = denied, 1 = allow once, 2 = always allow
 * "Allow this time only" expires when the plugin closes.
 */
export const PERM_READ = 'plugin.permission.FILE:READ';
export const PERM_WRITE = 'plugin.permission.FILE:WRITE';
export const PERM_DELETE = 'plugin.permission.FILE:DELETE';

/** Ensure one permission, prompting the user if needed. */
export async function ensurePermission(
  report: Report,
  perm: string,
  label: string,
  why: string,
): Promise<boolean> {
  try {
    const status = await PluginManager.hasPermission(perm);
    if (status === 1) {
      report.add(label, 'already granted');
      return true;
    }
    const res = await PluginManager.requestPermission(perm, why);
    const meaning =
      res === 2
        ? 'granted (always)'
        : res === 1
        ? 'granted (this time only)'
        : `DENIED (returned ${res})`;
    report.add(label, meaning, res !== 1 && res !== 2);
    return res === 1 || res === 2;
  } catch (e: any) {
    report.add(label, e?.message ?? String(e), true);
    return false;
  }
}

/**
 * Unwrap the SDK's {success, result, error} envelope.
 * Throws with the SDK's message so the caller can record it as a failed step.
 */
export function unwrap(res: any, what: string): any {
  if (res == null) {
    throw new Error(`${what}: returned ${brief(res)}`);
  }
  if (res.success === false) {
    const code = res.error?.code;
    const msg = res.error?.message ?? 'unknown error';
    throw new Error(`${what}: [${code}] ${msg}`);
  }
  // Some APIs return the payload directly rather than wrapped.
  return 'result' in res ? res.result : res;
}

/** Compact JSON that survives being read on e-ink. */
export function brief(v: unknown): string {
  if (v === null) {
    return 'null';
  }
  if (v === undefined) {
    return 'undefined';
  }
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export type Size = {width: number; height: number};

/** Page sizes the SDK recognises, for naming whatever we find. */
export const KNOWN_SIZES: {w: number; h: number; name: string}[] = [
  {w: 1404, h: 1872, name: 'A6X2/Nomad standard'},
  {w: 1872, h: 2496, name: 'A6X2 "normal max" (4/3)'},
  {w: 1920, h: 2560, name: 'A5X2/Manta standard'},
  {w: 2560, h: 3414, name: 'A5X2 "max" (4/3)'},
];

export const MACHINE_TYPES: Record<number, string> = {
  0: 'A5',
  1: 'A6',
  2: 'A6X',
  3: 'A5X',
  4: 'A6X2 (Nomad)',
  5: 'A5X2 (Manta)',
};

export const PEN_TYPES: Record<number, string> = {
  1: 'pressure pen',
  10: 'fineliner',
  11: 'marker',
  15: 'calligraphy',
};

export const PEN_COLORS: Record<number, string> = {
  0x00: 'black',
  0x9d: 'dark gray',
  0xc9: 'light gray',
  0xfe: 'white',
};

export const ELEMENT_TYPES: Record<number, string> = {
  0: 'stroke',
  100: 'title',
  200: 'picture',
  500: 'textbox',
  501: 'textbox (quote digest)',
  502: 'textbox (created digest)',
  600: 'link',
  700: 'geometry',
  800: 'five-star',
};

/** Describe a {width,height} against the sizes the SDK knows about. */
export function describeSize(w: number, h: number): string {
  for (const k of KNOWN_SIZES) {
    if (k.w === w && k.h === h) {
      return `${k.name} (portrait)`;
    }
    if (k.w === h && k.h === w) {
      return `${k.name} (landscape)`;
    }
  }
  return 'unrecognised size';
}
