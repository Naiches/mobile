// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { pickerPhotoSource, sourcePathFromUri } from './photo-preview-source';

describe('pickerPhotoSource', () => {
  test('keeps the readable picker copy even when PhotoKit provides an id', () => {
    expect(pickerPhotoSource({ assetId: 'limited-library-id', uri: 'file:///tmp/picked%20photo.jpg' })).toEqual({
      localIdentifier: 'limited-library-id',
      sourceUri: 'file:///tmp/picked%20photo.jpg',
    });
  });

  test('accepts a picker copy without an asset id', () => {
    expect(pickerPhotoSource({ assetId: null, uri: 'file:///tmp/photo.jpg' })).toEqual({
      sourceUri: 'file:///tmp/photo.jpg',
    });
  });

  test('rejects an asset with neither a readable copy nor an id', () => {
    expect(pickerPhotoSource({ assetId: null, uri: '' })).toBeNull();
  });
});

describe('sourcePathFromUri', () => {
  test('turns an encoded file URI into a native filesystem path', () => {
    expect(sourcePathFromUri('file:///tmp/picked%20photo.jpg')).toBe('/tmp/picked photo.jpg');
  });

  test('does not hand non-file URLs to the native filesystem reader', () => {
    expect(sourcePathFromUri('ph://asset')).toBeNull();
  });
});
