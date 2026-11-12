type Cron = {
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  weekdays: number[];
  isEitherDay: boolean;
};

const partPattern = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/;

const dayMs = 24 * 60 * 60 * 1000;

// The days and weekdays of the calendar repeat after this many days: 400 years.
const maxDays = 146_097;

const parseField = (field: string, min: number, max: number) => {
  const values = new Set<number>();
  for (const text of field.split(",")) {
    const match = partPattern.exec(text);
    if (!match) return undefined;
    const [, first, last, step] = match;
    if (first !== undefined && last === undefined && step !== undefined) return undefined;
    const start = first === undefined ? min : Number(first);
    const end = first === undefined ? max : Number(last ?? first);
    const stride = step === undefined ? 1 : Number(step);
    if (start < min || end > max || start > end || stride < 1) return undefined;
    for (let value = start; value <= end; value += stride) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
};

const parseCron = (schedule: string): Cron | undefined => {
  const fields = schedule.trim().split(/\s+/);
  const [minute, hour, day, month, weekday] = fields;
  if (fields.length !== 5 || !minute || !hour || !day || !month || !weekday) return undefined;
  const minutes = parseField(minute, 0, 59);
  const hours = parseField(hour, 0, 23);
  const days = parseField(day, 1, 31);
  const months = parseField(month, 1, 12);
  const weekdays = parseField(weekday, 0, 6);
  if (!minutes || !hours || !days || !months || !weekdays) return undefined;
  const isEitherDay = !day.startsWith("*") && !weekday.startsWith("*");
  return { minutes, hours, days, months, weekdays, isEitherDay };
};

const matchesDay = (cron: Cron, date: Date) => {
  if (!cron.months.includes(date.getUTCMonth() + 1)) return false;
  const isInDays = cron.days.includes(date.getUTCDate());
  const isInWeekdays = cron.weekdays.includes(date.getUTCDay());
  return cron.isEitherDay ? isInDays || isInWeekdays : isInDays && isInWeekdays;
};

// undefined: the schedule is not valid, or it names a date that does not exist.
export const nextCronTime = (schedule: string, after: Date): Date | undefined => {
  const cron = parseCron(schedule);
  if (!cron) return undefined;
  const firstDay = Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate());
  for (let offset = 0; offset <= maxDays; offset++) {
    const date = new Date(firstDay + offset * dayMs);
    if (!matchesDay(cron, date)) continue;
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const time = date.getTime() + (hour * 60 + minute) * 60_000;
        if (time > after.getTime()) return new Date(time);
      }
    }
  }
  return undefined;
};

export const isCronSchedule = (schedule: string) =>
  nextCronTime(schedule, new Date(0)) !== undefined;
