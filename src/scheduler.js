export function localScheduleDate(now = new Date()) {
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return { date, time };
}

export function isScheduleDue(config, lastRunDay, now = new Date()) {
  if (!config.enabled || !config.live) return false;
  const current = localScheduleDate(now);
  return current.time >= config.time && lastRunDay !== current.date;
}
