const commonTimeZones = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
];

export function automationTimeZoneLabel(timeZone: string): string {
  const name = new Intl.DateTimeFormat('zh-CN', { timeZone, timeZoneName: 'long' })
    .formatToParts(new Date())
    .find((part) => part.type === 'timeZoneName')?.value;
  return `${name ?? timeZone} · ${timeZone}`;
}

export function automationTimeZoneOptions(selected: string) {
  const common = new Set([selected, ...commonTimeZones]);
  const zones = new Set([...common, ...Intl.supportedValuesOf('timeZone')]);
  return [...zones].map((timeZone) => ({
    value: timeZone,
    label: automationTimeZoneLabel(timeZone),
    section: common.has(timeZone) ? '常用时区' : '全部时区',
  }));
}
