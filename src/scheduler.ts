function zonedDateParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

/** Calculates the next local wall-clock occurrence, preserving the requested time across DST. */
export function nextDailyOccurrence(timeZone: string, localTime: string, after = new Date()): Date {
  if (!/^\d{2}:\d{2}$/.test(localTime)) throw new Error("Daily time must use HH:mm format.");
  const [hour, minute] = localTime.split(":").map(Number);
  if (hour > 23 || minute > 59) throw new Error("Daily time must be a valid 24-hour time.");
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(after); }
  catch { throw new Error("Use a valid IANA timezone, such as America/Los_Angeles."); }
  const localNow = zonedDateParts(after, timeZone);
  const baseDay = Date.UTC(localNow.year, localNow.month - 1, localNow.day);
  for (let offset = 0; offset < 3; offset += 1) {
    const day = new Date(baseDay + offset * 86_400_000);
    const target = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute };
    let candidate = Date.UTC(target.year, target.month - 1, target.day, hour, minute);
    for (let i = 0; i < 3; i += 1) {
      const observed = zonedDateParts(new Date(candidate), timeZone);
      const desiredAsUtc = Date.UTC(target.year, target.month - 1, target.day, hour, minute);
      const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
      candidate += desiredAsUtc - observedAsUtc;
    }
    if (candidate > after.getTime()) return new Date(candidate);
  }
  throw new Error("Could not calculate the next daily run time.");
}
