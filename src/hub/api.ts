export type Process = { pid: number; username: string; command: string; memoryUsedMb: number }
export type Gpu = { id: string; uuid: string; index: number; name: string; memoryTotalMb: number; memoryUsedMb?: number; utilizationPercent?: number; temperatureCelsius?: number; maintenance: boolean; missing: boolean; processes: Process[] }
export type Node = { id: string; name: string; hostname: string; lastSeenAt?: string; gpus: Gpu[] }
export type Reservation = { id: string; ownerId: string; ownerName: string; gpuIds: string[]; startsAt: string; endsAt: string; projectName: string; purpose: string; status: string; checkedInAt?: string }
export type User = { id: string; username: string; displayName: string; linuxUsername: string; role: string; concurrentGpuLimit: number; csrfToken: string }

let csrf = ''

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...init.headers } })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error ?? `请求失败 (${response.status})`)
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
  logout: () => request('/auth/logout', { method: 'POST' }),
}
