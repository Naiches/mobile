/**
 * photo-sources: the account preference `photo_sources` (which sources the
 * Photos tab shows). Saved through the preferences API like `photo_previews`,
 * so every device on the account sees the same choice.
 *
 * Stored shape: { camera_roll: { enabled, devices: 'all' | [deviceFolderId] }, folders: [folderId] }
 * Ids only: folder names are encrypted and never stored here.
 */
import { getPreferenceValueStrict, setPreferenceValue } from './api';
import { DEFAULT_PHOTO_SOURCES, type PhotoSources } from './photo-source-filter';

export { DEFAULT_PHOTO_SOURCES } from './photo-source-filter';
export type { PhotoSources } from './photo-source-filter';

export const PHOTO_SOURCES_PREFERENCE_KEY = 'photo_sources';

function idList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function defaults(): PhotoSources {
  return { cameraRoll: { ...DEFAULT_PHOTO_SOURCES.cameraRoll }, folders: [] };
}

/** Lenient parse: every invalid field falls back to its default. */
export function parsePhotoSources(raw: unknown): PhotoSources {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return defaults(); }
  }
  const d = defaults();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return d;
  const o = value as Record<string, unknown>;
  const cr = typeof o.camera_roll === 'object' && o.camera_roll !== null && !Array.isArray(o.camera_roll)
    ? (o.camera_roll as Record<string, unknown>)
    : {};
  return {
    cameraRoll: {
      enabled: typeof cr.enabled === 'boolean' ? cr.enabled : d.cameraRoll.enabled,
      devices: cr.devices === 'all' ? 'all' : (idList(cr.devices) ?? 'all'),
    },
    folders: idList(o.folders) ?? [],
  };
}

/** Throws when the server cannot be asked; the defaults only when the value is unset. */
export async function loadPhotoSources(): Promise<PhotoSources> {
  return parsePhotoSources(await getPreferenceValueStrict(PHOTO_SOURCES_PREFERENCE_KEY));
}

export async function savePhotoSources(sources: PhotoSources): Promise<void> {
  await setPreferenceValue(PHOTO_SOURCES_PREFERENCE_KEY, {
    camera_roll: { enabled: sources.cameraRoll.enabled, devices: sources.cameraRoll.devices },
    folders: sources.folders,
  });
}

export function withFolderAdded(sources: PhotoSources, folderId: string): PhotoSources {
  if (sources.folders.includes(folderId)) return sources;
  return { ...sources, folders: [...sources.folders, folderId] };
}

export function withFolderRemoved(sources: PhotoSources, folderId: string): PhotoSources {
  return { ...sources, folders: sources.folders.filter((id) => id !== folderId) };
}

export function withCameraRollEnabled(sources: PhotoSources, enabled: boolean): PhotoSources {
  return { ...sources, cameraRoll: { ...sources.cameraRoll, enabled } };
}

/**
 * Tick or untick one device. Ticking every device collapses to 'all', so a
 * device added later joins on its own.
 */
export function withDeviceToggled(sources: PhotoSources, deviceId: string, allDeviceIds: string[]): PhotoSources {
  const current = sources.cameraRoll.devices === 'all' ? allDeviceIds : sources.cameraRoll.devices;
  const next = current.includes(deviceId) ? current.filter((id) => id !== deviceId) : [...current, deviceId];
  const everyone = allDeviceIds.length > 0 && allDeviceIds.every((id) => next.includes(id));
  return { ...sources, cameraRoll: { ...sources.cameraRoll, devices: everyone ? 'all' : next } };
}
