const berlinHour = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  hour: '2-digit',
  hourCycle: 'h23',
});

export function isFinanceCronWindow(mode: 'sync' | 'verify', now = new Date()): boolean {
  return berlinHour.format(now) === (mode === 'sync' ? '13' : '14');
}
