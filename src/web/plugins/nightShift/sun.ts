// Sunrise and sunset from a place, without asking the browser where it is. The formula is the one
// suncalc uses: the sun's mean anomaly, its ecliptic longitude, and the hour angle at the horizon.
const RAD = Math.PI / 180;
const DAY = 86_400_000;
const J1970 = 2440588;
const J2000 = 2451545;
const toDays = (ms: number) => ms / DAY - 0.5 + J1970 - J2000;
const fromDays = (days: number) => (days + J2000 + 0.5 - J1970) * DAY;

export type Sun = { rise: number; set: number } | "day" | "night";

/** Sunrise and sunset as epoch milliseconds, or a day the sun never sets or never rises. */
export function sunTimes(lat: number, lon: number, when: Date): Sun {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const n = Math.round(toDays(when.getTime()) - 0.0009 - lw / (2 * Math.PI));
  const mean = 0.0009 + lw / (2 * Math.PI) + n;
  const M = RAD * (357.5291 + 0.98560028 * mean);
  const L = M + RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + RAD * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(L) * Math.sin(RAD * 23.4397));
  const cosH = (Math.sin(RAD * -0.833) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosH < -1) return "day";
  if (cosH > 1) return "night";
  const w = Math.acos(cosH);
  const transit = (angle: number) => fromDays(0.0009 + (angle + lw) / (2 * Math.PI) + n + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L));
  return { rise: transit(-w), set: transit(w) };
}

/** Whether `when` is after sunset or before sunrise at that place. A polar day is daytime, a polar night is night. */
export function isNight(lat: number, lon: number, when: Date): boolean {
  const times = sunTimes(lat, lon, when);
  if (times === "day") return false;
  if (times === "night") return true;
  const t = when.getTime();
  return t < times.rise || t >= times.set;
}
