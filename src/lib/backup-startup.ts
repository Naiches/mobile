/**
 * Starts backup work without making a toggle, wizard step, or permission
 * callback wait for server preparation. The task is invoked immediately so
 * native startup is not delayed by another event-loop turn; every rejection
 * is observed by the caller-provided status/error handler.
 */
export function launchBackupWork(
  task: () => Promise<void>,
  onError: (error: unknown) => void,
): void {
  try {
    void task().catch(onError);
  } catch (error) {
    onError(error);
  }
}

/**
 * PhotoKit scanning is local and must not depend on creating/listing the
 * encrypted Drive destination. Invoke the engine first, then prepare the
 * destination concurrently. Native waits for and is woken by folder config.
 */
export function startPhotoBackupBeforeDestinationPreparation(options: {
  startEngine: (isCurrent: () => boolean) => Promise<void>;
  prepareDestination: () => Promise<string>;
  configureDestination: (folderId: string) => Promise<void>;
  isCurrent?: () => boolean;
  onError: (error: unknown) => void;
}): void {
  const isCurrent = options.isCurrent ?? (() => true);
  launchBackupWork(async () => {
    if (!isCurrent()) return;
    await options.startEngine(isCurrent);
  }, options.onError);
  launchBackupWork(async () => {
    if (!isCurrent()) return;
    const folderId = await options.prepareDestination();
    if (!isCurrent()) return;
    await options.configureDestination(folderId);
  }, options.onError);
}

/**
 * Prepare a category destination without allowing an obsolete toggle intent
 * to configure or bind native backup after the switch has since changed.
 */
export async function prepareCategoryBackupForIntent(options: {
  prepareDestination: () => Promise<string>;
  configureDestination: (folderId: string) => Promise<void>;
  bindNative: () => Promise<void>;
  isCurrent?: () => boolean;
}): Promise<boolean> {
  const isCurrent = options.isCurrent ?? (() => true);
  if (!isCurrent()) return false;
  const folderId = await options.prepareDestination();
  if (!isCurrent()) return false;
  await options.configureDestination(folderId);
  if (!isCurrent()) return false;
  await options.bindNative();
  return isCurrent();
}

export type PreparedCategory = 'contacts' | 'calendar';

/**
 * A persisted refusal tile can be visible before its native manager has been
 * rebound on launch. "Back up anyway" therefore prepares/binds first, then
 * forwards the one-run force flag and finally refreshes visible progress.
 */
export async function runPreparedCategoryBackup(
  kind: PreparedCategory,
  options: { force: boolean },
  deps: {
    prepare: (kind: PreparedCategory) => Promise<void>;
    run: (kind: PreparedCategory, options: { force: boolean }) => Promise<void>;
    refresh: () => Promise<void>;
  },
): Promise<void> {
  await deps.prepare(kind);
  await deps.run(kind, options);
  await deps.refresh();
}
