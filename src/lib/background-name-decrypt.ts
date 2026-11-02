import type { BatchNameItem, BatchNameResult } from '../../modules/beebeeb-crypto/src/BeebeebCrypto';

export interface DecryptedNameBatchItem {
  item: BatchNameItem;
  result: BatchNameResult;
}

const BACKGROUND_NAME_BATCH_SIZE = 100;

/** Background metadata work yields before every bounded native batch. */
export async function decryptNamesInBackground(
  items: readonly BatchNameItem[],
  decryptBatch: (batch: BatchNameItem[]) => Promise<BatchNameResult[]>,
  apply: (item: BatchNameItem, result: BatchNameResult) => void,
  cancelled: () => boolean,
  yieldToBrowsing: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
  applyBatch?: (items: DecryptedNameBatchItem[]) => void,
): Promise<number> {
  let applied = 0;
  for (let start = 0; start < items.length; start += BACKGROUND_NAME_BATCH_SIZE) {
    await yieldToBrowsing();
    if (cancelled()) break;
    const batch = items.slice(start, start + BACKGROUND_NAME_BATCH_SIZE);
    const results = await decryptBatch(batch);
    if (cancelled()) break;
    const ready: DecryptedNameBatchItem[] = [];
    results.forEach((result, index) => {
      if (!result || result.error || !result.name) return;
      const item = batch[index];
      if (!item) return;
      ready.push({ item, result });
      applied++;
    });
    if (applyBatch) applyBatch(ready);
    else ready.forEach(({ item, result }) => apply(item, result));
  }
  return applied;
}
