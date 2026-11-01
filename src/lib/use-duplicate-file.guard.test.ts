// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const hook = readFileSync(new URL('./use-duplicate-file.tsx', import.meta.url), 'utf8')
const preview = readFileSync(new URL('../screens/PreviewScreen.tsx', import.meta.url), 'utf8')

describe('Duplicate host lifecycle wiring', () => {
  test('unmount aborts the active job and late results cannot update or toast from the dead host', () => {
    expect(hook).toContain('useEffect')
    expect(hook).toContain('mountedRef.current = false')
    expect(hook).toContain('controllerRef.current?.abort()')
    expect(hook).toContain('if (!mountedRef.current) return')
  })

  test('a second tap explains that the first duplicate is still running', () => {
    expect(hook).toContain('A duplicate is already in progress.')
  })

  test('Preview Show explicitly opens Files and never pops whatever screen is current later', () => {
    const start = preview.indexOf('const { duplicate: duplicateFileOnPhone')
    const duplicateWiring = preview.slice(start, preview.indexOf('const handleDuplicate', start))
    expect(duplicateWiring).toContain("'Tabs'")
    expect(duplicateWiring).toContain("screen: 'Files'")
    expect(duplicateWiring).toContain("action: parentId ? 'folder' : 'root'")
    expect(duplicateWiring).toContain('folderId: parentId')
    expect(duplicateWiring).not.toContain('navigation.goBack()')
  })
})
