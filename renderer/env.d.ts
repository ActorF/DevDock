import type { DockApi } from '../shared/types'

declare global {
  interface Window { dock: DockApi }
}

export {}
