// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Each screen renders the Duplicate progress sheet at most once per render
// branch: a second render stacks a second modal that stays at 0%.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const count = (file: string) =>
  (readFileSync(new URL(file, import.meta.url), 'utf8').match(/\{duplicateProgressSheet\}/g) ?? []).length

describe('Duplicate progress sheet render sites', () => {
  test('FilesScreen renders it exactly once', () => {
    expect(count('../screens/FilesScreen.tsx')).toBe(1)
  })
  test('PreviewScreen renders it once per return branch (media + document), never twice in a row', () => {
    const src = readFileSync(new URL('../screens/PreviewScreen.tsx', import.meta.url), 'utf8')
    expect(count('../screens/PreviewScreen.tsx')).toBe(2)
    expect(src).not.toMatch(/\{duplicateProgressSheet\}\s*\n\s*\{duplicateProgressSheet\}/)
  })
})
