// @ts-nocheck
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('the setup wizard no longer renders full-screen tour cards', () => {
  const screen = readFileSync(join(import.meta.dir, '../screens/FirstRunSetupScreen.tsx'), 'utf8');
  expect(screen).not.toContain('first-run-tour');
  expect(screen).not.toContain('TOUR_SCREENS');
  expect(screen).not.toContain("'tour-drive'");
  expect(screen.match(/await coachMarks\.start\(\)/g)).toHaveLength(2);
  expect(screen).toContain('busyRef.current');
  expect(screen).not.toContain('void setup.skip()');

  const context = readFileSync(join(import.meta.dir, 'coach-marks-context.tsx'), 'utf8');
  expect(context).not.toContain('targetsRef.current = {};');

  const overlay = readFileSync(join(import.meta.dir, '../components/first-run/CoachMarks.tsx'), 'utf8');
  expect(overlay).toContain('readyLayout === bubbleLayoutKey');
  expect(overlay).toContain('bubbleMeasuredLayout === bubbleLayoutKey');
  expect(overlay).toContain('availableAbove');
  expect(overlay).toContain('useLayoutEffect');
  expect(overlay).toContain('layoutSignature');
  expect(overlay).toContain('navigateTo, step, layoutSignature]');
  expect(overlay).toContain('maxHeight');
  expect(overlay).toContain("'equal-five'");
  expect(overlay).toContain('actionInFlightRef.current');

  const app = readFileSync(join(import.meta.dir, '../App.tsx'), 'utf8');
  expect(app).toContain("params: { action: 'root' }");

  const photos = readFileSync(join(import.meta.dir, '../screens/PhotosScreen.tsx'), 'utf8');
  expect(photos).toContain("coach.state.step === 'photos'");
});
