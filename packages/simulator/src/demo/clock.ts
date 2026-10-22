import { localParts, zonedTime } from '@lw/domain';

/**
 * Scenario time → real time. A demo project is written as working days (0 = the day it started)
 * and hours of the day, with a "present" (day 3 at 2:02 PM, say). The present lands on the most
 * recent working day whose present hour has already passed, so every piece of history is in the
 * past and live activity carries on from the real now.
 */
export class DemoClock {
  /** Local calendar date of the present day. */
  private readonly anchor: { year: number; month: number; day: number };

  constructor(
    readonly timezone: string,
    readonly presentDay: number,
    readonly presentHour: number,
    now = Date.now(),
  ) {
    let t = now;
    for (let i = 0; i < 10; i++) {
      const p = localParts(t, timezone);
      const workday = p.weekday >= 1 && p.weekday <= 5;
      const presentToday = zonedTime(p.year, p.month, p.day, presentHour, timezone);
      if (workday && presentToday <= now) {
        this.anchor = { year: p.year, month: p.month, day: p.day };
        return;
      }
      t = zonedTime(p.year, p.month, p.day, 12, timezone) - 24 * 3_600_000;
    }
    const p = localParts(now, timezone);
    this.anchor = { year: p.year, month: p.month, day: p.day };
  }

  /** The instant of scenario `day` at local `hour` (fractional hours allowed). */
  at(day: number, hour: number): number {
    let offset = day - this.presentDay;
    let d = new Date(Date.UTC(this.anchor.year, this.anchor.month - 1, this.anchor.day));
    const step = offset < 0 ? -1 : 1;
    while (offset !== 0) {
      d = new Date(d.getTime() + step * 86_400_000);
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) offset -= step;
    }
    return zonedTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, this.timezone);
  }

  iso(day: number, hour: number): string {
    return new Date(this.at(day, hour)).toISOString();
  }

  /** The scenario's present as a real instant. */
  get present(): number {
    return this.at(this.presentDay, this.presentHour);
  }
}

/** `dpos` from the prototype: day + (hour − 8) / 10, back to a day and an hour. */
export const fromPos = (x: number): [number, number] => {
  const day = Math.floor(x + 1e-9);
  return [day, 8 + (x - day) * 10];
};
