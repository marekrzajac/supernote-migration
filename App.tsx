/**
 * Migration (Nomad ↔ Manta) — Supernote plugin UI.
 *
 * Buttons only: the two directions, plus a "Backup before change?" toggle that
 * is solid black when on. Each device translates only INTO its own format, so
 * the direction that doesn't apply here is dimmed. Manta output is always side
 * by side in landscape (the stacked portrait layout is still supported by
 * lib/translate.ts, just not offered).
 *
 * The plugin window is always full screen — the host gives plugins no way to
 * ask for a smaller one (registerButtonRes rejects showData) — but it is
 * translucent, so the root is transparent and only the card is drawn. Tapping
 * outside the card closes it.
 *
 * While translating, a cover over the card says so; errors stay on the cover
 * until tapped. The plugin isn't restarted between openings (it's hidden and
 * shown), so everything is reset when its sidebar button is pressed.
 *
 * Every run's full report still goes to the log for debugging:
 *   adb -s <serial> logcat -s ReactNativeJS:V
 *
 * Flat black-on-white, no animation — e-ink.
 *
 * @format
 */

import React, {useCallback, useEffect, useState} from 'react';
import {StyleSheet, Text, Pressable} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';

import {Report, ensurePermission, PERM_READ, PERM_WRITE, PERM_DELETE} from './lib/report';
import {
  planTranslation,
  runTranslation,
  describeOpenNote,
  getKeepBackup,
  setKeepBackup,
  reopen,
  addSameNoteLinks,
  waitForOpen,
  hasSameNoteLinks,
  dropSameNoteLinks,
  setUpNewPages,
  type Direction,
  type Format,
} from './lib/translate';

const WHY = 'Translating reshapes the open note, replacing the file.';

/** What the cover over the card is showing, if anything. */
type Cover = {kind: 'busy'; text: string} | {kind: 'message'; text: string} | null;

function App(): React.JSX.Element {
  const [format, setFormat] = useState<Format | undefined>();
  const [device, setDevice] = useState<Format | undefined>();
  const [keepBackup, setKeepBackupState] = useState(true);
  const [cover, setCover] = useState<Cover>(null);

  /** Fresh state for each opening — the note may be a different one. */
  const refresh = useCallback(async () => {
    setCover(null);
    const r = new Report();
    await ensurePermission(r, PERM_READ, 'FILE:READ', WHY);
    setKeepBackupState(await getKeepBackup().catch(() => true));
    const d = await describeOpenNote();
    setFormat(d.format);
    setDevice(d.device);
    console.log(`[OPEN] note format ${d.format ?? '?'}, device ${d.device ?? '?'}`);
  }, []);

  useEffect(() => {
    refresh();
    const sub = PluginManager.registerButtonListener({onButtonPress: () => refresh()});
    return () => sub.remove();
  }, [refresh]);

  const busy = cover?.kind === 'busy';

  const close = useCallback(() => {
    if (!busy) {
      PluginManager.closePluginView();
    }
  }, [busy]);

  const toggleBackup = useCallback(async () => {
    const next = !keepBackup;
    setKeepBackupState(next);
    await setKeepBackup(next);
  }, [keepBackup]);

  const translate = useCallback(
    async (direction: Direction) => {
      if (busy) {
        return;
      }
      setCover({kind: 'busy', text: 'Translating…'});

      const report = new Report();
      report.heading('PERMISSIONS');
      const ok =
        (await ensurePermission(report, PERM_READ, 'FILE:READ', WHY)) &&
        (await ensurePermission(report, PERM_WRITE, 'FILE:WRITE', WHY)) &&
        (await ensurePermission(report, PERM_DELETE, 'FILE:DELETE', WHY));

      let message = 'Permission denied — try again and choose "Always allow".';
      if (ok) {
        const plan = await planTranslation(report, direction);
        if (plan) {
          const replaced = await runTranslation(report, plan, {portrait: false, keepBackup});
          if (replaced) {
            const res = await reopen(plan.srcPath);
            report.add('reopen', res === 'ok' ? 'opened' : res, res !== 'ok');
            // Links to the note's own pages go in through the editor once it
            // has the new note open (see addSameNoteLinks). No timers here:
            // openFile hides this view, which pauses them (see waitForOpen).
            let linkFailures = 0;
            if (res === 'ok' && hasSameNoteLinks()) {
              const portrait = direction === 'toNomad';
              if (await waitForOpen(report, portrait)) {
                linkFailures = await addSameNoteLinks(report, plan.srcPath);
              } else {
                linkFailures = await dropSameNoteLinks(report);
              }
            }
            report.log('TRANSLATE REPORT');
            if (linkFailures) {
              // openFile hid the view; bring it back to say so.
              PluginManager.showPluginView().catch(() => false);
              setCover({
                kind: 'message',
                text: `Translated, but ${linkFailures} page link${linkFailures === 1 ? '' : 's'} couldn't be added.`,
              });
              return;
            }
            if (res === 'ok') {
              setCover(null);
              PluginManager.closePluginView();
              return;
            }
            message = 'Translated. Close and reopen the note to see it.';
          } else {
            message = lastProblem(report) ?? 'Translation stopped — nothing was changed.';
          }
        } else {
          message = lastProblem(report) ?? 'Nothing to do for this note.';
        }
      }
      report.log('TRANSLATE REPORT');
      setCover({kind: 'message', text: message});
    },
    [busy, keepBackup],
  );

  /**
   * Pages added to a Manta note after it was translated get the two-page
   * layout of the page before them (see setUpNewPages).
   */
  const setUp = useCallback(async () => {
    if (busy) {
      return;
    }
    setCover({kind: 'busy', text: 'Migrating added pages…'});
    const report = new Report();
    report.heading('PERMISSIONS');
    const ok =
      (await ensurePermission(report, PERM_READ, 'FILE:READ', WHY)) &&
      (await ensurePermission(report, PERM_WRITE, 'FILE:WRITE', WHY));
    const done = ok ? await setUpNewPages(report, {keepBackup}) : undefined;
    report.log('ADDED PAGES REPORT');
    if (done !== undefined) {
      setCover(null);
      PluginManager.closePluginView();
      return;
    }
    setCover({
      kind: 'message',
      text: ok ? lastProblem(report) ?? 'Nothing was changed.' : 'Permission denied — try again and choose "Always allow".',
    });
  }, [busy, keepBackup]);

  const canToManta = device === 'Manta' && format === 'Nomad';
  const canToNomad = device === 'Nomad' && format === 'Manta';
  const canSetUp = device === 'Manta' && format === 'Manta';

  return (
    <Pressable style={styles.backdrop} onPress={close}>
      {/* Swallow taps on the card so they don't close it. */}
      <Pressable style={styles.card} onPress={() => {}}>
        <Pressable
          style={[styles.button, !canToManta && styles.disabled]}
          disabled={!canToManta || busy}
          onPress={() => translate('toManta')}>
          <Text style={styles.buttonText}>
            Nomad → Manta
          </Text>
        </Pressable>

        <Pressable
          style={[styles.button, !canToNomad && styles.disabled]}
          disabled={!canToNomad || busy}
          onPress={() => translate('toNomad')}>
          <Text style={styles.buttonText}>
            Manta → Nomad
          </Text>
        </Pressable>

        <Pressable
          style={[styles.button, !canSetUp && styles.disabled]}
          disabled={!canSetUp || busy}
          onPress={setUp}>
          <Text style={styles.buttonText}>Migrate added pages</Text>
        </Pressable>

        <Toggle
          label={`Backup before change?  ${keepBackup ? 'On' : 'Off'}`}
          on={keepBackup}
          onPress={toggleBackup}
        />

        {cover ? (
          <Pressable
            style={styles.cover}
            onPress={() => (cover.kind === 'message' ? setCover(null) : undefined)}>
            <Text style={styles.coverText}>
              {cover.text}
            </Text>
          </Pressable>
        ) : null}
      </Pressable>
    </Pressable>
  );
}

/** A button that is solid black while on. */
function Toggle(props: {label: string; on: boolean; onPress: () => void}) {
  return (
    <Pressable style={[styles.toggle, props.on && styles.toggleOn]} onPress={props.onPress}>
      <Text style={[styles.toggleText, props.on && styles.toggleTextOn]}>{props.label}</Text>
    </Pressable>
  );
}

/** The last row flagged as a problem, as a one-line message for the cover. */
function lastProblem(report: Report): string | undefined {
  const bad = [...report.rows].reverse().find(r => r.bad);
  return bad ? bad.value : undefined;
}

// Flat, high-contrast, no animation — this is an e-ink screen.
const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    width: 420,
    maxWidth: '92%',
    backgroundColor: '#ffffff',
    borderWidth: 3,
    borderColor: '#000000',
    padding: 20,
  },
  button: {
    borderWidth: 2,
    borderColor: '#000000',
    paddingVertical: 16,
    marginBottom: 12,
    alignItems: 'center',
  },
  disabled: {
    // No grays on e-ink: dashed and faded says "not on this device".
    borderStyle: 'dashed',
    opacity: 0.35,
  },
  buttonText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#000000',
  },
  toggle: {
    borderWidth: 2,
    borderColor: '#000000',
    paddingVertical: 12,
    alignItems: 'center',
  },
  toggleOn: {
    backgroundColor: '#000000',
  },
  toggleText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#000000',
  },
  toggleTextOn: {
    color: '#ffffff',
  },
  cover: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  coverText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#000000',
    textAlign: 'center',
  },
});

export default App;
