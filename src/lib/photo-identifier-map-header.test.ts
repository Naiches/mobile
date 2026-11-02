// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

describe('photo identifier map request', () => {
  test('uses the canonical device id required by the production endpoint', () => {
    const start = api.indexOf('export async function fetchPhotoBackupIdentifierMap');
    const end = api.indexOf('export async function photoBackupClearAssociation', start);
    const body = api.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('const deviceHeader = await deviceIdHeader(getDeviceId);');
    expect(body).toMatch(/photo-backup\/identifiers'[\s\S]+true,\s*deviceHeader/);
  });
});
