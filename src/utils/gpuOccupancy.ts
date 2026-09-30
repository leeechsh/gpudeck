import type { GpuMetric, Snapshot } from '../types/models'
import { acceleratorDeviceName } from './accelerator'
import { gpuMemoryPercent, isGpuAvailable, isIgnoredSystemGpuProcess } from './gpu'

export interface GpuOccupancyUser {
  username: string
  gpuCount: number
}

export interface GpuOccupancyModel {
  name: string
  total: number
  available: number
}

export interface GpuOccupancySummary {
  total: number
  available: number
  occupied: number
  users: GpuOccupancyUser[]
  models: GpuOccupancyModel[]
}

function usableGpu(gpu: GpuMetric) {
  return isGpuAvailable(gpu) && gpu.healthStatus !== '维护中' && gpu.healthStatus !== '不可用'
}

function activeGpuProcesses(snapshot: Snapshot, gpu: GpuMetric) {
  return snapshot.processes.filter((process) => process.gpuUuid === gpu.uuid && !isIgnoredSystemGpuProcess(process))
}

function isFreeGpu(snapshot: Snapshot, gpu: GpuMetric) {
  return usableGpu(gpu) && activeGpuProcesses(snapshot, gpu).length === 0 && gpuMemoryPercent(gpu) < 1
}

export function summarizeGpuOccupancy(snapshots: Snapshot[]): GpuOccupancySummary {
  const userGpuIds = new Map<string, Set<string>>()
  const models = new Map<string, GpuOccupancyModel>()
  let total = 0
  let available = 0
  let occupied = 0

  for (const snapshot of snapshots) {
    for (const gpu of snapshot.gpus) {
      if (!usableGpu(gpu)) continue
      total += 1
      const modelName = acceleratorDeviceName(gpu.name).trim() || '未知型号'
      const model = models.get(modelName) ?? { name: modelName, total: 0, available: 0 }
      model.total += 1
      const free = isFreeGpu(snapshot, gpu)
      if (free) {
        available += 1
        model.available += 1
      } else {
        occupied += 1
      }
      models.set(modelName, model)

      for (const process of activeGpuProcesses(snapshot, gpu)) {
        const username = process.username.trim()
        if (!username) continue
        const gpuIds = userGpuIds.get(username) ?? new Set<string>()
        gpuIds.add(gpu.uuid)
        userGpuIds.set(username, gpuIds)
      }
    }
  }

  const users = [...userGpuIds.entries()]
    .map(([username, gpuIds]) => ({ username, gpuCount: gpuIds.size }))
    .sort((left, right) => right.gpuCount - left.gpuCount || left.username.localeCompare(right.username))

  return {
    total,
    available,
    occupied,
    users,
    models: [...models.values()].sort((left, right) => right.total - left.total || left.name.localeCompare(right.name)),
  }
}
