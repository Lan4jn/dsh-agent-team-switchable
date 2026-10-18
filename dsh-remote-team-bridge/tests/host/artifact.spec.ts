import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, chmod, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectArtifacts,
  verifyArtifacts,
  validateScopedDiff,
  ArtifactError,
} from '../../src/host/artifact.ts'

describe('artifact collector and verifier (Task 10)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'artifact-test-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('rejects an artifact whose bytes do not match its digest', async () => {
    const subDir = join(root, 'dist')
    await mkdir(subDir, { recursive: true })
    const filePath = join(subDir, 'app.bin')
    await writeFile(filePath, 'hello world content')

    const listing = await collectArtifacts({
      root,
      paths: ['dist/app.bin'],
      platform: { os: 'linux', arch: 'arm64' },
    })

    expect(listing.files[0]).toMatchObject({
      path: 'dist/app.bin',
      os: 'linux',
      arch: 'arm64',
      size: 19,
      executable: false,
    })
    expect(listing.files[0].sha256).toMatch(/^[0-9a-f]{64}$/)

    // Tampered digest should fail verification with DIGEST_MISMATCH
    await expect(
      verifyArtifacts(root, [{ ...listing.files[0], sha256: '0'.repeat(64) }]),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })

    // Correct digest passes
    await expect(verifyArtifacts(root, [listing.files[0]])).resolves.toBe(true)
  })

  it('records executable permission bit', async () => {
    const scriptPath = join(root, 'run.sh')
    await writeFile(scriptPath, '#!/bin/sh\necho ok')
    await chmod(scriptPath, 0o755)

    const listing = await collectArtifacts({
      root,
      paths: ['run.sh'],
      platform: { os: 'darwin', arch: 'arm64' },
    })

    expect(listing.files[0].executable).toBe(true)
  })

  it('rejects path escape attempts (../x or absolute paths)', async () => {
    await expect(
      collectArtifacts({
        root,
        paths: ['../escape.txt'],
        platform: { os: 'linux', arch: 'x64' },
      }),
    ).rejects.toMatchObject({ code: 'PATH_ESCAPE' })

    await expect(
      collectArtifacts({
        root,
        paths: ['/etc/passwd'],
        platform: { os: 'linux', arch: 'x64' },
      }),
    ).rejects.toMatchObject({ code: 'PATH_ESCAPE' })
  })

  it('rejects symbolic links via lstat check', async () => {
    const targetFile = join(root, 'target.txt')
    const linkFile = join(root, 'link.txt')
    await writeFile(targetFile, 'target content')
    await symlink(targetFile, linkFile)

    await expect(
      collectArtifacts({
        root,
        paths: ['link.txt'],
        platform: { os: 'linux', arch: 'x64' },
      }),
    ).rejects.toMatchObject({ code: 'SYMLINK_REJECTED' })
  })

  it('rejects files exceeding quota/max file size', async () => {
    const bigPath = join(root, 'big.dat')
    await writeFile(bigPath, 'A'.repeat(100))

    await expect(
      collectArtifacts({
        root,
        paths: ['big.dat'],
        platform: { os: 'linux', arch: 'x64' },
        maxFileBytes: 50,
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  })

  it('validates diffs strictly within write_scopes', () => {
    const validDiff = `--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new`
    expect(validateScopedDiff(validDiff, ['src/index.ts', 'src/types.ts'])).toBe(true)

    const outOfScopeDiff = `--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-old\n+new`
    expect(() => validateScopedDiff(outOfScopeDiff, ['src/'])).toThrowError(
      expect.objectContaining({ code: 'DIFF_SCOPE_VIOLATION' }),
    )
  })
})
