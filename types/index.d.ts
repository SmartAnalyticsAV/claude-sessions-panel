export type SessionsPaneState = 'waiting' | 'busy' | 'idle' | 'other'

export type SessionsPaneRow = {
  id: string
  name: string
  project: string
  state: SessionsPaneState
  since: number
  via: string
  isSelf: boolean
}

export type SessionsPaneLimits = {
  at: number
  windows: { kind: string; percentUsed: number; resetsAt?: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    'sessions-pane': {
      rows: SessionsPaneRow[]
      error: string | null
      limits: SessionsPaneLimits | null
    }
  }
}
