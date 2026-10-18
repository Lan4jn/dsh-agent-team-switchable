function slugPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function bridgeTeamName(
  host: string,
  task: string,
  random: (size: number) => Uint8Array,
): string {
  const suffix = Buffer.from(random(2)).toString('hex')
  const hostPart = slugPart(host)
  const taskPart = slugPart(task)
  const prefix = hostPart && taskPart
    ? `bridge-${hostPart}-${taskPart}`
    : hostPart
      ? `bridge-${hostPart}`
      : taskPart
        ? `bridge-${taskPart}`
        : 'bridge-team'
  const maxBodyLength = 32 - 1 - suffix.length
  const body = prefix.slice(0, maxBodyLength).replace(/-+$/g, '')
  return `${body}-${suffix}`
}

export function withinQuota(active: number, limit: number): boolean {
  return active < limit
}

export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(value) || value.includes('\\')) return false
  const parts = value.split('/')
  return parts.every(part => part !== '..' && part !== '.' && part.length > 0)
}
