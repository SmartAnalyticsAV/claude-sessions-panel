export type SessionsPanelState = 'waiting' | 'busy' | 'idle' | 'other'

export type SessionsPanelRow = {
  id: string
  name: string
  project: string
  state: SessionsPanelState
  since: number
  via: string
  isSelf: boolean
  // The desktop app's own id (local_…), where the app runs the session.
  appId?: string
}

export type SessionsPanelLimits = {
  at: number
  windows: { kind: string; percentUsed: number; resetsAt?: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    'sessions-panel': {
      rows: SessionsPanelRow[]
      error: string | null
      limits: SessionsPanelLimits | null
    }
  }
}
