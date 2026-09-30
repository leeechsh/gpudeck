export type DetailTabPermission = 'overview' | 'processes' | 'terminal' | 'history' | 'gpu' | 'cpu' | 'connection'

export function canViewDetailTab(tab: DetailTabPermission, hubMode: boolean, hubAdmin: boolean) {
  if (!hubMode || hubAdmin) return true
  return tab !== 'terminal' && tab !== 'connection'
}
