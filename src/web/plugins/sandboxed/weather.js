// The forecast for where this browser is. A place the member types is the fallback, kept in this browser.
const root = ink.root;
document.documentElement.style.height = "100%";
document.body.style.height = "100%";
document.body.style.margin = "0";
document.body.style.padding = "0";
root.style.height = "100%";
root.style.boxSizing = "border-box";
root.style.display = "flex";
root.style.flexDirection = "column";
root.style.padding = "12px 14px 10px";
root.style.color = "inherit";
root.style.font = "inherit";

const view = document.createElement("div");
view.style.display = "flex";
view.style.flexDirection = "column";
view.style.flex = "1";
view.style.minHeight = "0";
view.style.gap = "8px";

const form = document.createElement("form");
form.style.display = "none";
form.style.gap = "6px";
const input = document.createElement("input");
input.setAttribute("aria-label", "Place");
input.placeholder = "A city, or a latitude and longitude";
input.style.flex = "1";
input.style.minWidth = "0";
const button = document.createElement("button");
button.type = "button";
button.textContent = "Show";
form.append(input, button);

const elsewhere = document.createElement("button");
elsewhere.type = "button";
elsewhere.textContent = "Somewhere else";
elsewhere.hidden = true;
elsewhere.style.alignSelf = "flex-start";
elsewhere.style.flex = "none";
elsewhere.style.marginTop = "10px";
root.append(view, form, elsewhere);

const SAID = { 0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Rime fog", 51: "Drizzle", 53: "Drizzle", 55: "Drizzle", 61: "Rain", 63: "Rain", 65: "Rain", 71: "Snow", 73: "Snow", 75: "Snow", 80: "Showers", 81: "Showers", 82: "Showers", 95: "Thunderstorm" };
/** Zones that keep Fahrenheit. Canada and Mexico share the America/ prefix and use Celsius. */
const FAHRENHEIT_ZONE = /^(America\/(Adak|Anchorage|Boise|Chicago|Denver|Detroit|Indiana|Juneau|Kentucky|Los_Angeles|Menominee|Metlakatla|New_York|Nome|North_Dakota|Phoenix|Puerto_Rico|Sitka|St_Thomas|Virgin|Yakutat)|Pacific\/Honolulu)/;
const FAHRENHEIT_COUNTRY = /^(US|BS|KY|LR|PW|FM|MH)$/;

let round = 0;
/** "c" or "f" once the member picks. Null until then, and the place decides. */
let chosen = null;
let forecast = null;

function prefersF(zone, country) {
  if (typeof country === "string") return FAHRENHEIT_COUNTRY.test(country);
  return typeof zone === "string" && FAHRENHEIT_ZONE.test(zone);
}

function unit() {
  if (chosen === "c" || chosen === "f") return chosen;
  return forecast && prefersF(forecast.zone, forecast.country) ? "f" : "c";
}

function degrees(celsius) {
  const n = unit() === "f" ? (celsius * 9) / 5 + 32 : celsius;
  return Math.round(n);
}

function kind(code) {
  if (code === 0) return "clear";
  if (code === 1 || code === 2) return "partly";
  if (code === 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 95) return "storm";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  return "cloud";
}

function icon(code) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", SAID[code] ?? "Weather");
  svg.style.display = "block";
  svg.style.flex = "none";
  const add = (tag, attrs) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
    svg.append(el);
  };
  const sun = (cx, cy, r) => {
    add("circle", { cx, cy, r, fill: "currentColor" });
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      add("line", {
        x1: cx + Math.cos(angle) * (r + 1.6),
        y1: cy + Math.sin(angle) * (r + 1.6),
        x2: cx + Math.cos(angle) * (r + 4),
        y2: cy + Math.sin(angle) * (r + 4),
        stroke: "currentColor",
        "stroke-width": "1.7",
        "stroke-linecap": "round",
      });
    }
  };
  const cloud = (cx, cy) => {
    add("circle", { cx: cx - 3.2, cy, r: "3.3", fill: "currentColor" });
    add("circle", { cx: cx + 2.4, cy: cy - 1.4, r: "4.2", fill: "currentColor" });
    add("circle", { cx: cx + 6, cy: cy + 0.6, r: "2.8", fill: "currentColor" });
    add("rect", { x: cx - 6, y: cy, width: "14", height: "4.2", fill: "currentColor" });
  };
  const which = kind(code);
  if (which === "clear") sun(12, 12, 3.6);
  else if (which === "partly") {
    sun(8, 8, 2.4);
    cloud(11, 14);
  } else if (which === "fog") {
    add("path", { d: "M3 7h18M5 12h14M4 17h16", stroke: "currentColor", "stroke-width": "2.2", fill: "none", "stroke-linecap": "round" });
  } else if (which === "snow") add("path", { d: "M12 3v18M5 7l14 10M19 7L5 17", stroke: "currentColor", "stroke-width": "1.8", fill: "none", "stroke-linecap": "round" });
  else if (which === "storm") add("path", { d: "M13 1.5 6 13h6l-1.2 9.5L19 10h-6.2L13 1.5z", fill: "currentColor" });
  else if (which === "rain") {
    cloud(10, 8);
    add("path", { d: "M7 16l-1.2 5M12 16l-1.2 5M17 16l-1.2 5", stroke: "currentColor", "stroke-width": "1.8", fill: "none", "stroke-linecap": "round" });
  } else cloud(9, 11);
  return svg;
}

function hourLabel(time) {
  const hour = Number(time.slice(11, 13));
  if (!Number.isFinite(hour)) return "";
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${shown}${hour < 12 ? "am" : "pm"}`;
}

function coming(body) {
  const hourly = body.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return [];
  const there = typeof body.timezone === "string" ? new Date().toLocaleString("sv-SE", { timeZone: body.timezone, hourCycle: "h23" }).replace(" ", "T").slice(0, 16) : "";
  const rows = hourly.time.map((time, i) => ({
    time,
    temp: hourly.temperature_2m?.[i],
    code: hourly.weather_code?.[i],
    rain: hourly.precipitation_probability?.[i],
  }));
  const ahead = there ? rows.filter((row) => row.time >= there) : rows;
  return (ahead.length ? ahead : rows).slice(0, 8).filter((row) => typeof row.temp === "number");
}

function units() {
  const group = document.createElement("div");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Temperature unit");
  group.style.display = "flex";
  group.style.gap = "2px";
  group.style.alignItems = "center";
  for (const [id, label] of [["c", "C"], ["f", "F"]]) {
    if (group.childElementCount) {
      const slash = document.createElement("span");
      slash.textContent = "/";
      slash.setAttribute("aria-hidden", "true");
      slash.style.opacity = "0.45";
      group.append(slash);
    }
    const pick = document.createElement("button");
    pick.type = "button";
    pick.textContent = label;
    pick.setAttribute("aria-label", label === "C" ? "Celsius" : "Fahrenheit");
    pick.setAttribute("aria-pressed", unit() === id ? "true" : "false");
    pick.style.border = "0";
    pick.style.padding = "2px 4px";
    pick.style.background = "none";
    pick.style.color = "inherit";
    pick.style.font = "inherit";
    pick.style.fontWeight = unit() === id ? "700" : "450";
    pick.style.opacity = unit() === id ? "1" : "0.55";
    pick.addEventListener("click", () => {
      chosen = id;
      void ink.storage.set("unit", id);
      paint();
    });
    group.append(pick);
  }
  return group;
}

function paint() {
  view.replaceChildren();
  if (!forecast) return;
  const now = forecast.current;
  const head = document.createElement("div");
  head.style.display = "flex";
  head.style.justifyContent = "space-between";
  head.style.alignItems = "flex-start";
  head.style.gap = "8px";
  const summary = document.createElement("p");
  summary.setAttribute("role", "status");
  summary.style.margin = "0";
  const temp = document.createElement("span");
  temp.style.display = "block";
  temp.style.fontSize = "34px";
  temp.style.lineHeight = "1";
  temp.style.fontWeight = "560";
  temp.textContent = now ? `${degrees(now.temperature_2m)}°` : "";
  const detail = document.createElement("span");
  detail.style.display = "block";
  detail.style.marginTop = "6px";
  detail.textContent = now ? `${SAID[now.weather_code] ?? "Weather"} · ${forecast.label}` : forecast.label;
  summary.append(temp, detail);
  head.append(summary, units());
  const list = document.createElement("ol");
  list.setAttribute("aria-label", "Next hours");
  list.style.display = "flex";
  list.style.gap = "4px";
  list.style.margin = "8px 0 0";
  list.style.padding = "0";
  list.style.listStyle = "none";
  for (const row of forecast.hours) {
    const item = document.createElement("li");
    item.style.flex = "1";
    item.style.minWidth = "0";
    item.style.display = "flex";
    item.style.flexDirection = "column";
    item.style.alignItems = "center";
    item.style.gap = "3px";
    item.style.fontSize = "11px";
    const when = document.createElement("span");
    when.textContent = hourLabel(row.time);
    const reading = document.createElement("span");
    reading.textContent = `${degrees(row.temp)}°`;
    item.append(when, icon(row.code), reading);
    if (typeof row.rain === "number" && row.rain >= 40) {
      const chance = document.createElement("span");
      chance.textContent = `${Math.round(row.rain)}%`;
      item.append(chance);
    }
    list.append(item);
  }
  view.append(head, list);
  form.style.display = "none";
  elsewhere.hidden = false;
}

function ask() {
  view.replaceChildren();
  const copy = document.createElement("p");
  copy.style.margin = "0";
  copy.textContent = "Weather uses this browser's location for the forecast here.";
  const use = document.createElement("button");
  use.type = "button";
  use.textContent = "Use my location";
  use.addEventListener("click", () => {
    use.disabled = true;
    void ink.place(true).then((place) => {
      use.disabled = false;
      if (isHere(place)) return load(place.latitude, place.longitude, null, null);
      copy.textContent = "This browser won't share its location. Type a place instead.";
    });
  });
  view.append(copy, use);
  form.style.display = "flex";
  elsewhere.hidden = true;
}

function isHere(place) {
  return place && typeof place.latitude === "number" && typeof place.longitude === "number";
}

function placeName(lat, lon) {
  return fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`)
    .then((res) => res.json())
    .then((body) => ({
      name: body.city || body.locality || body.principalSubdivision || null,
      country: typeof body.countryCode === "string" ? body.countryCode : null,
    }))
    .catch(() => ({ name: null, country: null }));
}

function load(lat, lon, label, country) {
  const mine = ++round;
  const named = label ? Promise.resolve({ name: label, country }) : placeName(lat, lon);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code,precipitation_probability&forecast_hours=12&timezone=auto`;
  return Promise.all([fetch(url).then((res) => res.json()), named])
    .then(([body, found]) => {
      if (mine !== round) return;
      const current = body.current;
      const where = found.name || label || "Here";
      if (!current) {
        view.replaceChildren();
        const missed = document.createElement("p");
        missed.setAttribute("role", "status");
        missed.textContent = `${where} has no weather just now.`;
        view.append(missed);
        return;
      }
      forecast = { label: where, country: found.country ?? country, zone: body.timezone, current, hours: coming(body) };
      paint();
    })
    .catch(() => {
      if (mine !== round) return;
      view.replaceChildren();
      const missed = document.createElement("p");
      missed.setAttribute("role", "status");
      missed.textContent = "The weather couldn't be reached just now.";
      view.append(missed);
    });
}

function lookup(named) {
  const mine = ++round;
  const pair = named.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (pair) return load(pair[1], pair[2], named, null);
  const city = named.split(",")[0].trim();
  const tried = city === named ? [named] : [named, city];
  view.replaceChildren();
  const looking = document.createElement("p");
  looking.setAttribute("role", "status");
  looking.textContent = `Looking up ${named}…`;
  view.append(looking);
  const search = (left) => {
    const name = left[0];
    return fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1`)
      .then((res) => res.json())
      .then((found) => {
        if (mine !== round) return;
        const hit = found.results?.[0];
        if (hit) return load(hit.latitude, hit.longitude, hit.name, hit.country_code ?? null);
        if (left.length > 1) return search(left.slice(1));
        looking.textContent = `No place named ${named}.`;
      })
      .catch(() => {
        if (mine === round) looking.textContent = "The weather couldn't be reached just now.";
      });
  };
  return search(tried);
}

function showNamed() {
  const named = input.value.trim();
  if (!named) return;
  void ink.storage.set("place", named);
  void lookup(named);
}
button.addEventListener("click", showNamed);
input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  showNamed();
});
elsewhere.addEventListener("click", () => {
  const hours = view.querySelector("ol");
  if (hours) hours.style.display = "none";
  form.style.display = "flex";
  input.focus();
});

void Promise.all([ink.place(), ink.storage.get("unit"), ink.storage.get("place")]).then(([place, unitKept, named]) => {
  if (unitKept === "c" || unitKept === "f") chosen = unitKept;
  if (isHere(place)) return load(place.latitude, place.longitude, null, null);
  if (typeof named === "string" && named.trim()) {
    input.value = named;
    return lookup(named.trim());
  }
  ask();
});
