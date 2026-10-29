import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionsPanelLimits, SessionsPanelRow, SessionsPanelState } from '../types'
import { agentsArgv, APP_ID, cacheDirOf, changesOf, continueUrlOf, detailOf, formatAge, groupRows, limitRows, rowOf, stateOf } from './sessions'
import type { Agent, AppSession, ControlEvent, Platform, Registry } from './sessions'

const PANE = 'sessions-panel'
const TITLE = 'Сессии'
const TICK_MS = 3000
// `claude agents --json` starts the CLI: once per LIST_EVERY ticks, or sooner
// when a registry file comes or goes.
const LIST_EVERY = 5
// Synthesized bells shipped with the mod: a clip must be the plugin's own file.
const SOUND_WAITING = 'sounds/waiting.wav'
const SOUND_FINISHED = 'sounds/finished.wav'
// Shared by every session the mod runs in, in the platform's cache folder: one
// of them plays the sounds, and `claude agents --json` is fetched once for all.
const CACHE_NAME = 'sessions-panel'
const ALIVE_MS = 10_000
const CACHE_MS = 12_000
// Time stamps under the person's prompts: on unless `/sessions-time off` stored false.
const TIME_KEY = 'timestamps'

type AgentsCache = { at: number; files: string; agents: Agent[] }

const rows = atom({ plugin: 'sessions-panel', key: 'rows' } as const, [])
const error = atom({ plugin: 'sessions-panel', key: 'error' } as const, null)
const limits = atom({ plugin: 'sessions-panel', key: 'limits' } as const, null)

async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

async function collect(
  $: EngineInterface,
  home: string,
  selfId: string,
  agents: readonly Agent[],
): Promise<SessionsPanelRow[]> {
  return Promise.all(
    agents.map(async agent => {
      const reg = await readJson<Registry>($, `${home}/.claude/sessions/${agent.pid}.json`)
      const ev = await readJson<ControlEvent>($, `${home}/.claude-control/events/${agent.pid}.json`)
      let mtime: number | undefined
      if (ev?.event === 'PermissionRequest' && ev.transcript_path) {
        mtime = await $.fs.stat(ev.transcript_path).then(
          stat => stat.mtimeMs,
          () => undefined,
        )
      }

      return rowOf(agent, reg, stateOf(agent, reg, ev, mtime), selfId)
    }),
  )
}

// The desktop app keeps a file per session it runs, two folders deep. Each file
// is read once: what it names does not change, so only new ones are read later.
async function scanAppSessions(
  $: EngineInterface,
  root: string,
  seen: Set<string>,
  appIds: Map<string, string>,
): Promise<void> {
  const dirs = async (path: string) =>
    (await $.fs.list(path).catch(() => [])).filter(entry => entry.kind === 'dir').map(entry => `${path}/${entry.name}`)
  for (const account of await dirs(root)) {
    for (const folder of await dirs(account)) {
      for (const entry of await $.fs.list(folder).catch(() => [])) {
        const path = `${folder}/${entry.name}`
        if (!entry.name.startsWith('local_') || !entry.name.endsWith('.json') || seen.has(path)) continue
        seen.add(path)
        const app = await readJson<AppSession>($, path)
        if (app?.cliSessionId && app.sessionId && APP_ID.test(app.sessionId)) appIds.set(app.cliSessionId, app.sessionId)
      }
    }
  }
}

// '29.10 18:52' in the computer's own time zone; Date's fields if Intl is missing.
function stampOf(ms: number): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .format(ms)
      .replace(',', '')
  } catch {
    const d = new Date(ms)
    const two = (n: number) => String(n).padStart(2, '0')
    return `${two(d.getDate())}.${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`
  }
}

type Where = { platform: Platform; home: string; dir: string }

// HOME on macOS and Linux, USERPROFILE on Windows, where OS is Windows_NT.
async function whereOf($: EngineInterface): Promise<Where> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const platform: Platform =
    (await $.env.get('OS')) === 'Windows_NT'
      ? 'windows'
      : (await $.fs.exists('/System/Library/CoreServices'))
        ? 'mac'
        : 'linux'
  const dir = cacheDirOf(
    platform,
    home,
    CACHE_NAME,
    await $.env.get('LOCALAPPDATA'),
    await $.env.get('XDG_CACHE_HOME'),
  )

  return { platform, home, dir }
}

// Limits are the account's, reported with each response of any session: the
// newest reading is kept in the shared folder for every session's panel.
async function saveLimits($: EngineInterface, path: string, windows: SessionsPanelLimits['windows']) {
  if (windows.length === 0) return
  const at = await $.clock.now()
  await $.fs.write(path, JSON.stringify({ at, windows: windows.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })) }))
}

export const register: Register = on => {
  // Fires after every turn of a session, not only when a window moved: each
  // reading is saved, so the panel's 'обновлено' is the last check.
  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0) {
      const { dir } = await whereOf($)
      await saveLimits($, `${dir}/limits.json`, e.rateLimits)
    }

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sessions',
      description: 'Открыть панель сессий Claude Code',
    })
    await $.command.register({
      name: 'sessions-time',
      description: 'Метки времени под промптами: on, off или пусто – узнать состояние',
    })

    const { platform, home, dir } = await whereOf($)
    const selfId = await $.session.id()
    let agents: Agent[] = []
    let files = ''
    let tick = 0
    let isRunning = false
    let prev: Map<string, SessionsPanelState> | undefined
    const appRoot = platform === 'mac' ? `${home}/Library/Application Support/Claude/claude-code-sessions` : undefined
    const seenAppFiles = new Set<string>()
    const appIds = new Map<string, string>()
    if (!(await $.fs.exists(`${dir}/limits.json`))) {
      await saveLimits($, `${dir}/limits.json`, (await $.session.usage()).rateLimits)
    }

    // Each session checks in on every tick; the one with the smallest id among
    // those seen lately plays the sounds, so an event chimes once, not per session.
    const isLeader = async (now: number) => {
      await $.fs.write(`${dir}/alive/${selfId}`, String(now))
      const alive = (await $.fs.list(`${dir}/alive`))
        .filter(entry => now - entry.mtimeMs < ALIVE_MS)
        .map(entry => entry.name)
        .sort()

      return alive[0] === selfId
    }

    const loadAgents = async (now: number, names: string): Promise<Agent[]> => {
      const cache = await readJson<AgentsCache>($, `${dir}/agents.json`)
      if (cache !== undefined && cache.files === names && now - cache.at < CACHE_MS) {
        return cache.agents
      }
      const out = await $.process.run(agentsArgv(platform), { timeoutMs: 15000 })
      if (out.exitCode !== 0) throw new Error(out.stderr.trim() || `exit ${out.exitCode}`)
      const listed = JSON.parse(out.stdout) as Agent[]
      await $.fs.write(`${dir}/agents.json`, JSON.stringify({ at: now, files: names, agents: listed }))

      return listed
    }

    const refresh = async () => {
      if (isRunning) return
      isRunning = true
      try {
        const now = await $.clock.now()
        const isLead = await isLeader(now)
        const names = (await $.fs.list(`${home}/.claude/sessions`))
          .map(entry => entry.name)
          .filter(name => name.endsWith('.json'))
          .sort()
          .join(',')
        if (tick % LIST_EVERY === 0 || names !== files) {
          agents = await loadAgents(now, names)
          files = names
        }
        tick += 1

        const listed = await collect($, home, selfId, agents)
        if (appRoot !== undefined && listed.some(row => row.via === 'desktop' && !appIds.has(row.id))) {
          await scanAppSessions($, appRoot, seenAppFiles, appIds)
        }
        const fresh = listed.map(row => {
          const appId = appIds.get(row.id)
          return appId === undefined ? row : { ...row, appId }
        })
        const changes = changesOf(prev, fresh)
        for (const row of changes.waiting) {
          if (!row.isSelf) $.ui.toast(`${row.name}: ждёт решения`)
        }
        for (const row of changes.finished) $.ui.toast(`${row.name}: закончила работу`)
        // One chime per tick, a decision before a finished turn: clips are not
        // queued, two would sound together.
        const sound =
          changes.waiting.length > 0 ? SOUND_WAITING : changes.finished.length > 0 ? SOUND_FINISHED : undefined
        if (sound !== undefined && isLead) void $.audio.play({ asset: sound }).catch(() => undefined)
        prev = new Map(fresh.map(row => [row.id, row.state]))

        const waitingCount = fresh.filter(row => row.state === 'waiting' && !row.isSelf).length
        $.ui.status(waitingCount > 0 ? `Ждут решения: ${waitingCount}` : undefined)

        const latest = await readJson<SessionsPanelLimits>($, `${dir}/limits.json`)
        await update($, limits, () => latest ?? null)
        await update($, rows, () => fresh)
        await update($, error, () => null)
      } catch (err) {
        await update($, error, () => String(err instanceof Error ? err.message : err))
      } finally {
        isRunning = false
      }
    }

    void refresh()
    $.clock.every(TICK_MS, () => void refresh())
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return { text: opened.isPlaced ? 'Панель сессий открыта.' : 'Панель сессий не открылась.' }
  })

  // Only what the person typed: not slash commands, notifications or peers.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    const isTyped = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (isTyped && !e.text.trimStart().startsWith('/') && !('drop' in result) && (await $.store.get(TIME_KEY)) !== false) {
      $.ui.log(`🕒 ${stampOf(await $.clock.now())}`)
    }

    return result
  })

  on('command.run', { command: 'sessions-time' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') await $.store.set(TIME_KEY, arg === 'on')
    else if (arg !== '') return { text: 'Укажи on или off: /sessions-time on' }
    const isOn = (await $.store.get(TIME_KEY)) !== false

    return { text: isOn ? 'Метки времени под промптами включены.' : 'Метки времени под промптами выключены.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, rows)
    const failed = await read($, error)
    const usage = await read($, limits)
    const now = await $.clock.now()
    const groups = groupRows(list, now)
    const windows = usage === null ? [] : limitRows(usage.windows, now)

    return (
      <Box flexDirection="column">
        {windows.length > 0 && usage !== null && (
          <Box key="limits" flexDirection="column" marginBottom={1}>
            <Box>
              <Text bold>Лимиты</Text>
              <Text dimColor>
                {' · обновлено '}
                {now - usage.at < 60000 ? 'только что' : `${formatAge(now - usage.at)} назад`}
              </Text>
            </Box>
            {windows.map(window => (
              <Box key={window.kind} flexDirection="column">
                <Box>
                  <Box width={8}>
                    <Text>{window.label}</Text>
                  </Box>
                  {window.isReset ? (
                    <Text dimColor>окно сброшено</Text>
                  ) : (
                    <>
                      <Text color={window.color}>{window.bar} </Text>
                      <Text bold color={window.color}>
                        {window.percent}%
                      </Text>
                    </>
                  )}
                </Box>
                {window.reset !== '' && (
                  <Box paddingLeft={2}>
                    <Text dimColor wrap="truncate-end">
                      {window.reset}
                    </Text>
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        )}
        {failed !== null && <Text color="error">Не удалось получить сессии: {failed}</Text>}
        {list.length === 0 && failed === null && <Text dimColor>Ищу сессии…</Text>}
        {groups.map(group => (
          <Box key={group.state} flexDirection="column" marginBottom={1}>
            <Text bold color={group.color}>
              {group.title}: {group.total}
            </Text>
            {group.rows.map(row => (
              <Box key={row.id}>
                <Text color={group.color}>{group.glyph} </Text>
                {row.appId !== undefined && !row.isSelf ? (
                  <Button
                    key={`open-${row.id}`}
                    plain
                    label={row.name}
                    onPress={() => void $.process.run(['open', continueUrlOf(row.appId ?? '')], { timeoutMs: 5000 }).catch(() => undefined)}
                  />
                ) : (
                  <Text bold={row.isSelf} wrap="truncate-end">
                    {row.isSelf ? `${row.name} (эта)` : row.name}
                  </Text>
                )}
                <Text dimColor wrap="truncate-end">
                  {' · '}
                  {detailOf(row, now)}
                </Text>
              </Box>
            ))}
            {group.folded > 0 && <Text dimColor>и ещё {group.folded} без дела дольше 12 ч</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}
