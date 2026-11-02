export interface ComparePhotoSource {
  localIdentifier?: string;
  sourceUri?: string;
}

export function pickerPhotoSource(asset: { assetId?: string | null; uri?: string | null }): ComparePhotoSource | null {
  const localIdentifier = typeof asset.assetId === 'string' && asset.assetId.trim() ? asset.assetId.trim() : undefined;
  const sourceUri = typeof asset.uri === 'string' && asset.uri.trim() ? asset.uri.trim() : undefined;
  if (!localIdentifier && !sourceUri) return null;
  return {
    ...(localIdentifier ? { localIdentifier } : {}),
    ...(sourceUri ? { sourceUri } : {}),
  };
}

/** A picker copy is a file URI on iOS; never pass ph:// or network URLs to ImageIO. */
export function sourcePathFromUri(uri: string | undefined): string | null {
  if (!uri?.startsWith('file://')) return null;
  const encodedPath = uri.slice('file://'.length).split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(encodedPath);
  } catch {
    return encodedPath;
  }
}
