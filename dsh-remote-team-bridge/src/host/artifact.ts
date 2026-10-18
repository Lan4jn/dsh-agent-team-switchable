import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'

export class ArtifactError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'ArtifactError'
  }
}

export interface ArtifactPlatform {
  readonly os: string
  readonly arch: string
}

export interface ArtifactFileMetadata {
  readonly path: string
  readonly size: number
  readonly sha256: string
  readonly executable: boolean
  readonly os: string
  readonly arch: string
}

export interface ArtifactListing {
  readonly files: ArtifactFileMetadata[]
}

export interface CollectArtifactsOptions {
  readonly root: string
  readonly paths: string[]
  readonly platform: ArtifactPlatform
  readonly maxFileBytes?: number
}

function assertPathInsideRoot(root: string, targetPath: string): string {
  if (isAbsolute(targetPath)) {
    throw new ArtifactError(`Absolute path rejected: ${targetPath}`, 'PATH_ESCAPE')
  }
  const normalized = normalize(targetPath)
  if (normalized.startsWith('..') || normalized.split(sep).includes('..')) {
    throw new ArtifactError(`Path escape rejected: ${targetPath}`, 'PATH_ESCAPE')
  }
  const resolvedRoot = resolve(root)
  const fullPath = resolve(resolvedRoot, normalized)
  if (!fullPath.startsWith(resolvedRoot + sep) && fullPath !== resolvedRoot) {
    throw new ArtifactError(`Path escapes root: ${targetPath}`, 'PATH_ESCAPE')
  }
  return fullPath
}

async function computeSha256(filePath: string): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', err => rej(err))
    stream.on('end', () => res(hash.digest('hex')))
  })
}

export async function collectArtifacts(opts: CollectArtifactsOptions): Promise<ArtifactListing> {
  const maxBytes = opts.maxFileBytes ?? 50 * 1024 * 1024
  const files: ArtifactFileMetadata[] = []

  for (const relPath of opts.paths) {
    const fullPath = assertPathInsideRoot(opts.root, relPath)
    const st = await lstat(fullPath)

    if (st.isSymbolicLink()) {
      throw new ArtifactError(`Symbolic link rejected: ${relPath}`, 'SYMLINK_REJECTED')
    }

    if (!st.isFile()) {
      throw new ArtifactError(`Not a regular file: ${relPath}`, 'NOT_A_FILE')
    }

    if (st.size > maxBytes) {
      throw new ArtifactError(`File too large (${st.size} > ${maxBytes}): ${relPath}`, 'FILE_TOO_LARGE')
    }

    const sha256 = await computeSha256(fullPath)
    const executable = (st.mode & 0o111) !== 0
    const posixRel = relative(opts.root, fullPath).split(sep).join('/')

    files.push({
      path: posixRel,
      size: st.size,
      sha256,
      executable,
      os: opts.platform.os,
      arch: opts.platform.arch,
    })
  }

  return { files }
}

export async function verifyArtifacts(
  root: string,
  files: ArtifactFileMetadata[],
): Promise<boolean> {
  for (const file of files) {
    const fullPath = assertPathInsideRoot(root, file.path)
    const st = await lstat(fullPath)

    if (st.isSymbolicLink()) {
      throw new ArtifactError(`Symbolic link rejected: ${file.path}`, 'SYMLINK_REJECTED')
    }

    const digest = await computeSha256(fullPath)
    if (digest.toLowerCase() !== file.sha256.toLowerCase()) {
      throw new ArtifactError(
        `Digest mismatch for ${file.path}: expected ${file.sha256}, got ${digest}`,
        'DIGEST_MISMATCH',
      )
    }
  }

  return true
}

export function validateScopedDiff(diff: string, writeScopes: string[]): boolean {
  const normalizedScopes = writeScopes.map(s => s.replace(/\\/g, '/'))
  const lines = diff.split('\n')

  for (const line of lines) {
    let filePath: string | null = null
    if (line.startsWith('+++ b/')) {
      filePath = line.slice(6).trim()
    } else if (line.startsWith('--- a/')) {
      filePath = line.slice(6).trim()
    }

    if (filePath && filePath !== '/dev/null') {
      const normalizedPath = filePath.replace(/\\/g, '/')
      const allowed = normalizedScopes.some(scope => {
        const cleanScope = scope.endsWith('/') ? scope.slice(0, -1) : scope
        return normalizedPath === cleanScope || normalizedPath.startsWith(cleanScope + '/')
      })

      if (!allowed) {
        throw new ArtifactError(
          `Diff path '${normalizedPath}' is outside write_scopes: ${JSON.stringify(writeScopes)}`,
          'DIFF_SCOPE_VIOLATION',
        )
      }
    }
  }

  return true
}
