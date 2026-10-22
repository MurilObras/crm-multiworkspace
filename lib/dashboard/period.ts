/** Datas do filtro são dias do workspace. O instante de corte respeita dias de 23/25h. */
export function dashboardDay(at: number, timezone: string): string {
  const p=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(at);
  return ['year','month','day'].map(k=>p.find(v=>v.type===k)!.value).join('-');
}

export function dashboardPeriod(from: string, to: string, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const localDay = (at: number) => {
    const p = formatter.formatToParts(at);
    return ['year','month','day'].map(k => p.find(v => v.type === k)!.value).join('-');
  };
  const boundary = (day: string) => {
    const noon = Date.parse(`${day}T12:00:00Z`);
    let lo = noon - 36 * 3_600_000;
    let hi = noon + 36 * 3_600_000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (localDay(mid) < day) lo = mid + 1; else hi = mid;
    }
    if (localDay(lo) !== day) throw new Error('dashboard_invalid_local_day');
    return new Date(lo).toISOString();
  };
  const nextDay = new Date(Date.parse(`${to}T12:00:00Z`) + 86_400_000).toISOString().slice(0,10);
  return { from: boundary(from), to: boundary(nextDay), timezone };
}
