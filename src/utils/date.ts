const LOOKBACK_DAYS = 14

export function currentDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function computeFromDate(lastSyncDate: string): string {
  const d = new Date(lastSyncDate)
  d.setDate(d.getDate() - LOOKBACK_DAYS)
  return d.toISOString().slice(0, 10)
}
