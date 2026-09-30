import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../types/models'
import { GpuOccupancyPanel } from './GpuOccupancyPanel'

const snapshot: Snapshot = {
  serverId: 'server-1', hostname: 'server-1', username: 'viewer', osId: 'linux', osName: 'Linux', timestamp: 1, status: 'online', acceleratorVendor: 'nvidia',
  system: { cpuModel: 'CPU', cpuUtilization: 0, currentUserCpuUtilization: 0, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 0, memoryTotalBytes: 1, swapUsedBytes: 0, swapTotalBytes: 0 },
  gpus: [
    { index: 0, uuid: 'gpu-0', name: 'NVIDIA L40S', utilization: 90, memoryUtilization: 40, memoryUsedMb: 400, memoryTotalMb: 1000, temperatureCelsius: 40, powerWatts: 0 },
    { index: 1, uuid: 'gpu-1', name: 'NVIDIA L40S', utilization: 0, memoryUtilization: 0, memoryUsedMb: 0, memoryTotalMb: 1000, temperatureCelsius: 40, powerWatts: 0 },
  ],
  processes: [{ gpuUuid: 'gpu-0', gpuIndex: 0, pid: 1, parentPid: 0, username: 'alice', command: 'train', memoryUsedMb: 400, smUtilization: 90, cpuPercent: 0, elapsed: '1h', isCurrentUser: false, isGroupLeader: true }],
  cpuProcesses: [], processesSampled: true, nvidiaSmi: 'available',
}

describe('GpuOccupancyPanel', () => {
  it('renders sorted user occupancy and free capacity', () => {
    const markup = renderToStaticMarkup(<GpuOccupancyPanel snapshots={{ [snapshot.serverId]: snapshot }} />)

    expect(markup).toContain('GPU 占用总览')
    expect(markup).toContain('1 / 2')
    expect(markup).toContain('alice')
    expect(markup).toContain('L40S')
  })
})
