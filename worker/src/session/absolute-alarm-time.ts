// Container persists absolute Date schedules at whole-second precision by flooring.
export const absoluteAlarmDate = (instant: string | number): Date =>
  new Date(
    Math.ceil((typeof instant === "string" ? Date.parse(instant) : instant) / 1_000) * 1_000,
  );

export const matchesPersistedAlarmSecond = (scheduledSecond: number, instant: string): boolean => {
  const millis = Date.parse(instant);
  return (
    scheduledSecond === Math.floor(millis / 1_000) ||
    scheduledSecond === absoluteAlarmDate(instant).getTime() / 1_000
  );
};
