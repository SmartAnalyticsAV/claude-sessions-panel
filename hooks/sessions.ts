import type { SessionsPaneRow, SessionsPaneState } from '../types'

// One entry of `claude agents --json`.
export type Agent = {
  pid: number
  sessionId: string
  name?: string
  cwd: string
  status: string
  startedAt: number
}

// ~/.claude/sessions/<pid>.json: the engine's own registry, updated live.
export type Registry = {
  status?: string
  name?: string
  statusUpdatedAt?: number
  entrypoint?: string
}

// ~/.claude-control/events/<pid>.json: the last hook event Claude Control saw.
export type ControlEvent = {
  event?: string
  ts?: number
  transcript_path?: string
}

// The event's `ts` is whole seconds, so a transcript write within that second
// still belongs to the request itself.
const GRACE_MS = 1000

export const IDLE_FOLD_MS = 12 * 60 * 60 * 1000

export const GROUPS: readonly {
  state: SessionsPaneState
  title: string
  glyph: string
  color: string
}[] = [
  { state: 'waiting', title: 'Ждут решения', glyph: '●', color: 'warning' },
  { state: 'busy', title: 'Работают', glyph: '●', color: 'success' },
  { state: 'other', title: 'Другое', glyph: '◌', color: 'subtle' },
  { state: 'idle', title: 'Свободны', glyph: '○', color: 'inactive' },
]

const VIA: Record<string, string> = {
  'claude-desktop': 'desktop',
  'claude-vscode': 'vscode',
  cli: 'терминал',
}

export function projectOf(cwd: string): string {
  return cwd.split('/').filter(Boolean).at(-1) ?? cwd
}

// A busy session whose last event is PermissionRequest waits for a decision
// until the transcript moves on: an answered request appends the tool result.
export function stateOf(
  agent: Agent,
  reg: Registry | undefined,
  ev: ControlEvent | undefined,
  transcriptMtimeMs: number | undefined,
): SessionsPaneState {
  const status = reg?.status ?? agent.status
  if (status === 'idle') return 'idle'
  if (status !== 'busy') return 'other'
  if (ev?.event !== 'PermissionRequest' || ev.ts === undefined) return 'busy'
  if (transcriptMtimeMs !== undefined && transcriptMtimeMs > ev.ts * 1000 + GRACE_MS) return 'busy'

  return 'waiting'
}

export function rowOf(
  agent: Agent,
  reg: Registry | undefined,
  state: SessionsPaneState,
  selfId: string,
): SessionsPaneRow {
  const project = projectOf(agent.cwd)

  return {
    id: agent.sessionId,
    name: reg?.name || agent.name || project,
    project,
    state,
    since: reg?.statusUpdatedAt ?? agent.startedAt,
    via: VIA[reg?.entrypoint ?? ''] ?? reg?.entrypoint ?? '',
    isSelf: agent.sessionId === selfId,
  }
}

// The project is left out where the session's name already says it.
export function detailOf(row: SessionsPaneRow, now: number): string {
  const norm = (s: string) => s.toLowerCase().replaceAll('_', '-')
  const parts = norm(row.name).includes(norm(row.project)) ? [] : [row.project]
  parts.push(formatAge(now - row.since))
  if (row.via !== '') parts.push(row.via)

  return parts.join(' · ')
}

export function formatAge(ms: number): string {
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'сейчас'
  if (min < 60) return `${min} мин`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} ч`

  return `${Math.floor(hours / 24)} дн`
}

// Rows of each state, newest change first; idle ones quiet for longer than
// IDLE_FOLD_MS are only counted.
export function groupRows(rows: readonly SessionsPaneRow[], now: number) {
  return GROUPS.map(group => {
    const own = rows
      .filter(row => row.state === group.state)
      .sort((a, b) => b.since - a.since)
    const shown =
      group.state === 'idle' ? own.filter(row => now - row.since < IDLE_FOLD_MS) : own

    return { ...group, rows: shown, folded: own.length - shown.length, total: own.length }
  }).filter(group => group.total > 0)
}

// Sessions that changed state since the last check: started waiting for a
// decision, or went idle after working (a turn ended). Nothing is reported on
// the first check, when there is no `prev`.
export function changesOf(
  prev: ReadonlyMap<string, SessionsPaneState> | undefined,
  fresh: readonly SessionsPaneRow[],
) {
  const known = prev === undefined ? [] : fresh.filter(row => prev.has(row.id))
  const waiting = known.filter(row => row.state === 'waiting' && prev?.get(row.id) !== 'waiting')
  const finished = known.filter(row => {
    const was = prev?.get(row.id)
    return row.state === 'idle' && (was === 'busy' || was === 'waiting')
  })

  return { waiting, finished }
}

const LIMIT_LABELS: Record<string, string> = {
  five_hour: 'Сессия',
  seven_day: 'Неделя',
}

// The 5-hour window first, then the week, then any other window as named.
export function limitRows(windows: readonly { kind: string; percentUsed: number; resetsAt?: string }[], now: number) {
  const order = (kind: string) => (kind === 'five_hour' ? 0 : kind === 'seven_day' ? 1 : 2)

  return [...windows]
    .sort((a, b) => order(a.kind) - order(b.kind))
    .map(window => {
      const resetsAt = window.resetsAt === undefined ? NaN : Date.parse(window.resetsAt)

      return {
        kind: window.kind,
        label: LIMIT_LABELS[window.kind] ?? window.kind,
        percent: Math.round(window.percentUsed),
        bar: barOf(window.percentUsed),
        color: window.percentUsed >= 90 ? 'error' : window.percentUsed >= 70 ? 'warning' : 'success',
        reset: Number.isNaN(resetsAt) ? '' : `сброс ${formatLeft(resetsAt - now)}`,
      }
    })
}

export function barOf(percent: number, cells = 10): string {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))

  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

export function formatLeft(ms: number): string {
  if (ms <= 0) return 'уже прошёл'
  const min = Math.ceil(ms / 60000)
  if (min < 60) return `через ${min} мин`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `через ${hours} ч ${min % 60} мин`

  return `через ${Math.floor(hours / 24)} дн ${hours % 24} ч`
}
