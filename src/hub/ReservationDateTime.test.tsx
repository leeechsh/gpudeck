// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ReservationDateTime } from './ReservationDateTime'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('uses explicit 00–23 hours, preserves minutes and date, and disables controls while submitting', async () => {
  const host=document.createElement('div'), root=createRoot(host), change=vi.fn()
  try {
    await act(async()=>root.render(<ReservationDateTime label="开始时间" name="startsAt" value="2026-10-01T23:47" disabled={false} onChange={change}/>))
    expect(host.querySelector('input[type="datetime-local"]')).toBeNull()
    const hour=host.querySelector('select')!
    expect(Array.from(hour.options).map(option=>option.text)).toEqual(Array.from({length:24},(_, i)=>String(i).padStart(2,'0')))
    expect(hour.value).toBe('23')
    await act(async()=>{hour.value='00';hour.dispatchEvent(new Event('change',{bubbles:true}))})
    expect(change).toHaveBeenLastCalledWith('2026-10-01T00:47')
    const minute=host.querySelectorAll('select')[1]
    await act(async()=>{minute.value='30';minute.dispatchEvent(new Event('change',{bubbles:true}))})
    expect(change).toHaveBeenLastCalledWith('2026-10-01T23:30')
    await act(async()=>root.render(<ReservationDateTime label="开始时间" name="startsAt" value="2026-10-01T23:47" disabled={true} onChange={change}/>))
    expect(host.querySelector('fieldset')!.disabled).toBe(true)
    expect(hour.matches(':disabled')).toBe(true)
  } finally {await act(async()=>root.unmount())}
})
