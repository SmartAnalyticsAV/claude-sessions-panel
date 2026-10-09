import { expect, mock, test } from 'claude-code/testing'

import { agentsArgv, barOf, cacheDirOf, changesOf, detailOf, formatAge, formatLeft, groupRows, limitRows, rowOf, stateOf } from '../hooks/sessions'
import type { Agent } from '../hooks/sessions'
import type { On } from 'claude-code'

const NOW = 1_800_000_000_000
const HOME = '/home/test'
const busy: Agent = { pid: 11, sessionId: 's-busy', name: 'shop-api-9f', cwd: '/w/shop-api', status: 'busy', startedAt: NOW - 3_600_000 }
const idle: Agent = { pid: 12, sessionId: 's-idle', name: 'Черновик', cwd: '/w/Wiki', status: 'idle', startedAt: NOW - 600_000 }
const stale: Agent = { pid: 13, sessionId: 's-old', cwd: '/w/Reports', status: 'idle', startedAt: NOW - 3 * 86_400_000 }

test('PermissionRequest без движения транскрипта – ждёт решения, с движением – работает', async () => {
  const ev = { event: 'PermissionRequest', ts: 1_000, transcript_path: '/t.jsonl' }
  expect(stateOf(busy, { status: 'busy' }, ev, 1_000_400)).toBe('waiting')
  expect(stateOf(busy, { status: 'busy' }, ev, undefined)).toBe('waiting')
  expect(stateOf(busy, { status: 'busy' }, ev, 1_005_000)).toBe('busy')
  expect(stateOf(busy, { status: 'idle' }, ev, undefined)).toBe('idle')
  expect(stateOf(busy, { status: 'busy' }, { event: 'Stop', ts: 1_000 }, undefined)).toBe('busy')
  expect(stateOf(busy, { status: 'paused' }, undefined, undefined)).toBe('other')
})

test('возраст и подпись строки', async () => {
  expect(formatAge(30_000)).toBe('сейчас')
  expect(formatAge(5 * 60_000)).toBe('5 мин')
  expect(formatAge(3 * 3_600_000)).toBe('3 ч')
  expect(formatAge(2 * 86_400_000)).toBe('2 дн')
  const base = { id: 'x', state: 'idle', since: NOW - 120_000, via: 'desktop', isSelf: false } as const
  expect(detailOf({ ...base, name: 'billing-service-64', project: 'Billing_Service' }, NOW)).toBe('2 мин · desktop')
  expect(detailOf({ ...base, name: 'Черновик статьи', project: 'Wiki' }, NOW)).toBe('Wiki · 2 мин · desktop')
})

const PANE_PROPS = {
  title: 'Сессии',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

test('группы идут по срочности, давно свободные свёрнуты', async () => {
  const rows = [
    rowOf(busy, { status: 'busy', statusUpdatedAt: NOW - 60_000, entrypoint: 'claude-vscode' }, 'waiting', 's-idle'),
    rowOf(idle, { status: 'idle', name: 'Черновик статьи', statusUpdatedAt: NOW - 120_000 }, 'idle', 's-idle'),
    rowOf(stale, undefined, 'idle', 's-idle'),
  ]
  expect(rows[0]?.via).toBe('vscode')
  expect(rows[1]?.isSelf).toBe(true)
  expect(rows[2]?.name).toBe('Reports')

  const groups = groupRows(rows, NOW)
  expect(groups.map(group => group.state)).toEqual(['waiting', 'idle'])
  expect(groups[1]?.rows.map(row => row.id)).toEqual(['s-idle'])
  expect(groups[1]?.folded).toBe(1)
})

// Answers what the engine answers in a session: the files, `claude agents`,
// the pane and the sounds; `alive` are other sessions running the mod.
function engine(on: On, files: Record<string, string>, agents: Agent[], alive: string[] = []) {
  const toasts: string[] = []
  const sounds: unknown[] = []
  const runs: string[][] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', ($, e) => {
    sounds.push(e)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 's-idle' }))
  on('fs.list', ($, e) => {
    const entry = (name: string) => ({ name, kind: 'file' as const, size: 1, mtimeMs: NOW, isLink: false })
    if (e.path.endsWith('/alive')) return { value: ['s-idle', ...alive].map(entry) }
    return { value: agents.map(agent => entry(`${agent.pid}.json`)) }
  })
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify(agents), stderr: '' } }
  })
  on('fs.read', ($, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: NOW, isLink: false } }))
  // '/System/Library/CoreServices' is how the mod tells macOS from Linux
  on('fs.exists', ($, e) => ({ value: e.path === '/System/Library/CoreServices' || files[e.path] !== undefined }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))

  return { toasts, sounds, runs }
}

test('мод читает реестр и события Claude Control и показывает, кто ждёт решения', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  const files: Record<string, string> = {
    [`${HOME}/.claude/sessions/11.json`]: JSON.stringify({ status: 'busy', name: 'shop-api-9f', statusUpdatedAt: NOW - 60_000, entrypoint: 'claude-vscode' }),
    [`${HOME}/.claude/sessions/12.json`]: JSON.stringify({ status: 'idle', name: 'Черновик статьи', statusUpdatedAt: NOW - 120_000, entrypoint: 'claude-desktop' }),
    [`${HOME}/.claude-control/events/11.json`]: JSON.stringify({ event: 'PermissionRequest', ts: NOW / 1000, transcript_path: '/t/11.jsonl' }),
  }
  const { toasts } = engine(on, files, [busy, idle, stale])

  await $.session.start({ cwd: '/w/Wiki', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'sessions-panel', surface, component: 'Pane', requestId: 'sessions-panel', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /Ждут решения: 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'shop-api-9f' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Черновик статьи (эта)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /без дела дольше 12 ч/ })).toBeDefined()
    await ui.unmount()
  }
  expect(toasts).toEqual([])
})

test('сессия ждёт решения, потом заканчивает работу – по звуку и уведомлению на каждое', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  const files: Record<string, string> = {
    [`${HOME}/.claude/sessions/11.json`]: JSON.stringify({ status: 'busy', name: 'shop-api-9f', statusUpdatedAt: NOW - 60_000 }),
    [`${HOME}/.claude/sessions/12.json`]: JSON.stringify({ status: 'idle', name: 'Черновик статьи', statusUpdatedAt: NOW - 120_000 }),
  }
  const { toasts, sounds } = engine(on, files, [busy, idle])

  await $.session.start({ cwd: '/w/Wiki', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(sounds).toEqual([])

  files[`${HOME}/.claude-control/events/11.json`] = JSON.stringify({ event: 'PermissionRequest', ts: NOW / 1000 + 3, transcript_path: '/t/11.jsonl' })
  await clock.advance(3000)
  expect(toasts).toEqual(['shop-api-9f: ждёт решения'])
  expect(sounds.length).toBe(1)
  expect(JSON.stringify(sounds[0])).toContain('sounds/waiting.wav')

  await clock.advance(3000)
  expect(sounds.length).toBe(1)

  files[`${HOME}/.claude/sessions/11.json`] = JSON.stringify({ status: 'idle', name: 'shop-api-9f', statusUpdatedAt: NOW + 9000 })
  files[`${HOME}/.claude-control/events/11.json`] = JSON.stringify({ event: 'Stop', ts: NOW / 1000 + 9 })
  await clock.advance(3000)
  expect(toasts).toEqual(['shop-api-9f: ждёт решения', 'shop-api-9f: закончила работу'])
  expect(sounds.length).toBe(2)
  expect(JSON.stringify(sounds[1])).toContain('sounds/finished.wav')
})

test('звенит одна сессия из нескольких, список сессий берётся из общего кэша', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  const files: Record<string, string> = {
    [`${HOME}/.claude/sessions/11.json`]: JSON.stringify({ status: 'busy', name: 'shop-api-9f', statusUpdatedAt: NOW - 60_000 }),
    [`${HOME}/${'Library/Caches/sessions-panel'}/agents.json`]: JSON.stringify({ at: NOW - 1000, files: '11.json', agents: [busy] }),
  }
  // 'a-first' sorts before 's-idle': that session plays the sounds, not this one.
  const { toasts, sounds, runs } = engine(on, files, [busy], ['a-first'])

  await $.session.start({ cwd: '/w/Wiki', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(runs).toEqual([])

  files[`${HOME}/.claude-control/events/11.json`] = JSON.stringify({ event: 'PermissionRequest', ts: NOW / 1000 + 3, transcript_path: '/t/11.jsonl' })
  await clock.advance(3000)
  expect(toasts).toEqual(['shop-api-9f: ждёт решения'])
  expect(sounds).toEqual([])
})

test('переходы: ждёт решения, закончила работу, без первой проверки', async () => {
  const row = (id: string, state: 'waiting' | 'busy' | 'idle', isSelf = false) =>
    ({ id, name: id, project: 'p', state, since: NOW, via: '', isSelf }) as const
  const fresh = [row('a', 'waiting'), row('b', 'idle'), row('c', 'idle'), row('d', 'idle', true), row('e', 'busy')]
  expect(changesOf(undefined, fresh)).toEqual({ waiting: [], finished: [] })

  const prev = new Map([['a', 'busy'], ['b', 'busy'], ['c', 'idle'], ['d', 'busy'], ['e', 'idle']] as const)
  const changes = changesOf(prev, fresh)
  expect(changes.waiting.map(r => r.id)).toEqual(['a'])
  expect(changes.finished.map(r => r.id)).toEqual(['b', 'd'])
  expect(changesOf(new Map([['d', 'idle']] as const), [row('d', 'waiting', true)]).waiting.map(r => r.id)).toEqual(['d'])
  expect(changesOf(new Map([['b', 'waiting']] as const), fresh).finished.map(r => r.id)).toEqual(['b'])
})

test('лимиты: порядок, подписи, цвет по порогам, время до сброса', async () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  const rows = limitRows(
    [
      { kind: 'seven_day', percentUsed: 92.5, resetsAt: iso(NOW + (3 * 24 + 4) * 3_600_000) },
      { kind: 'five_hour', percentUsed: 41, resetsAt: iso(NOW + 130 * 60_000) },
      { kind: 'spend_limit', percentUsed: 75 },
    ],
    NOW,
  )
  expect(rows.map(r => r.label)).toEqual(['Сессия', 'Неделя', 'spend_limit'])
  expect(rows.map(r => r.color)).toEqual(['success', 'error', 'warning'])
  expect(rows.map(r => r.percent)).toEqual([41, 93, 75])
  expect(rows[0]?.reset).toBe('сброс через 2 ч 10 мин')
  expect(rows[1]?.reset).toBe('сброс через 3 дн 4 ч')
  expect(rows[2]?.reset).toBe('')
  expect(barOf(41)).toBe('████░░░░░░')
  expect(barOf(130)).toBe('██████████')
  expect(formatLeft(-1)).toBe('уже прошёл')
  expect(formatLeft(90_000)).toBe('через 2 мин')
})

test('лимиты из ответа любой сессии попадают в общий файл и на панель', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  const files: Record<string, string> = {
    [`${HOME}/.claude/sessions/12.json`]: JSON.stringify({ status: 'idle', name: 'Черновик статьи', statusUpdatedAt: NOW - 120_000 }),
  }
  engine(on, files, [idle])
  on('session.measure', ($, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/w/Wiki', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(files[`${HOME}/Library/Caches/sessions-panel/limits.json`]).toBeUndefined()

  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 41, resetsAt: new Date(NOW + 130 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 18 },
    ],
    changed: ['rateLimits'],
  })
  await clock.advance(3000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'sessions-panel', surface, component: 'Pane', requestId: 'sessions-panel', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'Лимиты' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '41%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '18%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Сессия' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'сброс через 2 ч 10 мин' })).toBeDefined()
    await ui.unmount()
  }
})

test('пути и запуск claude по платформам', async () => {
  expect(cacheDirOf('mac', '/Users/a', 'x')).toBe('/Users/a/Library/Caches/x')
  expect(cacheDirOf('linux', '/home/a', 'x')).toBe('/home/a/.cache/x')
  expect(cacheDirOf('linux', '/home/a', 'x', undefined, '/tmp/cache')).toBe('/tmp/cache/x')
  expect(cacheDirOf('windows', 'C:/Users/a', 'x', 'C:/Users/a/AppData/Local')).toBe('C:/Users/a/AppData/Local/x')
  expect(cacheDirOf('windows', 'C:/Users/a', 'x')).toBe('C:/Users/a/AppData/Local/x')
  expect(agentsArgv('mac')).toEqual(['claude', 'agents', '--json'])
  expect(agentsArgv('windows')).toEqual(['cmd.exe', '/d', '/s', '/c', 'claude agents --json'])
})

test('на Windows: домашняя папка из USERPROFILE, кэш в LOCALAPPDATA, claude через cmd.exe', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const USER = 'C:/Users/test'
  mock.env(on, { USERPROFILE: USER, OS: 'Windows_NT', LOCALAPPDATA: `${USER}/AppData/Local` })
  const files: Record<string, string> = {
    [`${USER}/.claude/sessions/11.json`]: JSON.stringify({ status: 'busy', name: 'shop-api-9f', statusUpdatedAt: NOW - 60_000 }),
  }
  const { runs } = engine(on, files, [busy])

  await $.session.start({ cwd: 'C:/w', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(runs).toEqual([['cmd.exe', '/d', '/s', '/c', 'claude agents --json']])
  // On macOS, where the tests run, the engine resolves C:/... against the plugin
  // folder; on Windows it is absolute. The tail is what tells the folder chosen.
  const written = Object.keys(files)
  expect(written.some(path => path.endsWith(`${USER}/AppData/Local/sessions-panel/agents.json`))).toBe(true)
  expect(written.some(path => path.endsWith(`${USER}/AppData/Local/sessions-panel/alive/s-idle`))).toBe(true)

  const ui = await $.ui.mount({ plugin: 'sessions-panel', surface: 'desktop', component: 'Pane', requestId: 'sessions-panel', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: 'shop-api-9f' })).toBeDefined()
  await ui.unmount()
})

test('панель рисуется в терминале и в приложении', async ($, on) => {
  mock.clock(on, { now: NOW })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'sessions-panel',
      surface,
      component: 'Pane',
      requestId: 'sessions-panel',
      props: {
        title: 'Сессии',
        isFocused: false,
        bodyColumns: 40,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })
    expect(await ui.find({ type: 'Text', text: /Ищу сессии/ })).toBeDefined()
    await ui.unmount()
  }
})
