import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../types/models'
import { summarizeGpuOccupancy } from './gpuOccupancy'

function snapshot(serverId: string, gpus: Snapshot['gpus'], processes: Snapshot['processes']): Snapshot {
  return {
    serverId,
    hostname: serverId,
    username: 'viewer',
    osId: 'linux',
    osName: 'Linux',
    timestamp: 1,
    status: 'online',
    acceleratorVendor: 'nvidia',
    system: { cpuModel: 'CPU', cpuUtilization: 0, currentUserCpuUtilization: 0, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 0, memoryTotalBytes: 1, swapUsedBytes: 0, swapTotalBytes: 1 },
    gpus,
    processes,
    cpuProcesses: [],
    processesSampled: true,
    nvidiaSmi: 'available',
  }
}

const gpu = (uuid: string, name: string, memoryUsedMb = 0) => ({
  index: Number(uuid.slice(-1)), uuid, name, utilization: 0, memoryUtilization: 0,
  memoryUsedMb, memoryTotalMb: 1000, temperatureCelsius: 40, powerWatts: 0,
})

const process = (gpuUuid: string, username: string) => ({
  gpuUuid, gpuIndex: 0, pid: username === 'alice' ? 10 : 20, parentPid: 0, username, command: 'python train.py',
  memoryUsedMb: 100, smUtilization: 90, cpuPercent: 0, elapsed: '1h', isCurrentUser: false, isGroupLeader: true,
})

describe('summarizeGpuOccupancy', () => {
  it('sorts users by unique GPU count and reports free model capacity', () => {
    const result = summarizeGpuOccupancy([
      snapshot('server-1', [gpu('gpu-0', 'NVIDIA L40S'), gpu('gpu-1', 'NVIDIA L40S'), gpu('gpu-2', 'NVIDIA RTX 4090')], [process('gpu-0', 'alice'), process('gpu-1', 'alice'), process('gpu-1', 'bob')]),
    ])

    expect(result).toMatchObject({ total: 3, available: 1, occupied: 2 })
    expect(result.users).toEqual([{ username: 'alice', gpuCount: 2 }, { username: 'bob', gpuCount: 1 }])
    expect(result.models).toEqual([
      { name: 'L40S', total: 2, available: 0 },
      { name: 'RTX 4090', total: 1, available: 1 },
    ])
  })

  it('excludes system display processes and unavailable cards', () => {
    const unavailable = { ...gpu('gpu-1', 'NVIDIA L40S'), uuid: 'unavailable-gpu-1' }
    const result = summarizeGpuOccupancy([
      snapshot('server-1', [gpu('gpu-0', 'NVIDIA L40S'), unavailable], [process('gpu-0', 'gdm')]),
    ])

    expect(result).toMatchObject({ total: 1, available: 1, occupied: 0 })
    expect(result.users).toEqual([])
  })
})
