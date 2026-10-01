// Native datetime-local uses the OS locale and cannot guarantee a 24-hour clock.
// Explicit numeric options keep the booking clock consistent across browsers.
export function ReservationDateTime({ label, name, value, disabled, onChange }: {
  label: string; name: string; value: string; disabled: boolean; onChange: (value: string) => void
}) {
  const [date = '', time = '00:00'] = value.split('T')
  const [hour = '00', minute = '00'] = time.split(':')
  const update = (day: string, h: string, m: string) => onChange(day ? `${day}T${h}:${m}` : '')
  return <fieldset className="reservation-datetime" disabled={disabled}>
    <legend>{label}</legend>
    <input type="date" aria-label={`${label}日期`} value={date} required onChange={event => update(event.target.value, hour, minute)}/>
    <div className="reservation-clock">
      <select aria-label={`${label}小时（24小时制）`} value={hour} onChange={event => update(date, event.target.value, minute)}>
        {Array.from({length:24}, (_, index) => String(index).padStart(2, '0')).map(h => <option key={h} value={h}>{h}</option>)}
      </select><span aria-hidden="true">:</span>
      <select aria-label={`${label}分钟`} value={minute} onChange={event => update(date, hour, event.target.value)}>
        {Array.from({length:60}, (_, index) => String(index).padStart(2, '0')).map(m => <option key={m} value={m}>{m}</option>)}
      </select><small>24 小时制</small>
    </div>
    <input type="hidden" name={name} value={value}/>
  </fieldset>
}
