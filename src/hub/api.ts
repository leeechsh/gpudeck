export type Process = { pid: number; username: string; command: string; memoryUsedMb: number }
export type Gpu = { id: string; uuid: string; index: number; name: string; memoryTotalMb: number; memoryUsedMb?: number; utilizationPercent?: number; temperatureCelsius?: number; maintenance: boolean; missing: boolean; processes: Process[] }
export type Node = { id: string; name: string; hostname: string; lastSeenAt?: string; gpus: Gpu[] }
export type Reservation = { id: string; ownerId: string; ownerName: string; gpuIds: string[]; startsAt: string; endsAt: string; projectName: string; purpose: string; status: string; checkedInAt?: string }
export type User = { id: string; username: string; displayName: string; linuxUsername: string; role: string; concurrentGpuLimit: number; csrfToken: string; mustChangePassword: boolean }
export type AdminNode = { id: string; name: string; hostname: string; enabled: boolean; lastSeenAt?: string; createdAt: string }
export type NodeRegistration = { id: string; token: string; hubUrl: string }
export type AdminUser = { id: string; username: string; displayName: string; linuxUsername: string; role: string; concurrentGpuLimit: number; enabled: boolean; mustChangePassword: boolean }

let csrf = ''

export class HubApiError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'HubApiError' }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...init.headers } })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new HubApiError(body.error ?? `请求失败 (${response.status})`, response.status)
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

export const hubApi = {
  async login(username: string, password: string) { const data = await request<{ csrfToken: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }); csrf = data.csrfToken },
  async me() { const user = await request<User>('/auth/me'); csrf = user.csrfToken; return user },
  resources: () => request<{ nodes: Node[]; serverTime: string }>('/resources'),
  reservations: () => request<Reservation[]>('/reservations'),
  statistics: () => request<{ users: { username: string; gpuHours: number; coverageSeconds: number }[] }>('/statistics'),
  createReservation: (body: object) => request('/reservations', { method: 'POST', body: JSON.stringify(body) }),
  action: (id: string, action: 'check-in' | 'end' | 'cancel') => request(`/reservations/${id}/${action}`, { method: 'POST' }),
  adminNodes: () => request<{ nodes: AdminNode[] }>('/admin/nodes'),
  registerNode: (name: string, hostname: string) => request<NodeRegistration>('/admin/nodes', { method: 'POST', body: JSON.stringify({ name, hostname }) }),
  adminUsers: () => request<{ users: AdminUser[] }>('/admin/users'),
  syncSystemUsers: () => request<{ created: string[]; createdCount: number }>('/admin/users/sync', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) => request('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
}
