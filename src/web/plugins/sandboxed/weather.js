// The place is kept in this browser. A plugin that runs shut off cannot write the member's settings.
const root = ink.root;
root.style.display = "flex";
root.style.flexDirection = "column";
root.style.gap = "8px";
root.style.padding = "8px 10px";
root.style.color = "inherit";
root.style.font = "inherit";

const form = document.createElement("form");
form.style.display = "flex";
form.style.gap = "6px";
const input = document.createElement("input");
input.setAttribute("aria-label", "Place");
input.placeholder = "A city";
input.value = "";
input.style.flex = "1";
input.style.minWidth = "0";
const button = document.createElement("button");
button.type = "submit";
button.textContent = "Show";
form.append(input, button);

const out = document.createElement("p");
out.setAttribute("aria-live", "polite");
out.style.margin = "0";
root.append(form, out);

const SAID = { 0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Rime fog", 51: "Drizzle", 53: "Drizzle", 55: "Drizzle", 61: "Rain", 63: "Rain", 65: "Rain", 71: "Snow", 73: "Snow", 75: "Snow", 80: "Showers", 81: "Showers", 82: "Showers", 95: "Thunderstorm" };

async function show(named) {
  out.textContent = `Looking up ${named}…`;
  const found = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(named)}&count=1`).then((res) => res.json());
  const hit = found.results?.[0];
  if (!hit) {
    out.textContent = `No place named ${named}.`;
    return;
  }
  const forecast = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m,weather_code&timezone=auto`).then((res) => res.json());
  const current = forecast.current;
  if (!current) {
    out.textContent = `${hit.name} has no weather just now.`;
    return;
  }
  out.textContent = `${hit.name}: ${Math.round(current.temperature_2m)}° ${SAID[current.weather_code] ?? "Weather"}`;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const named = input.value.trim();
  if (!named) return;
  void ink.storage.set("place", named).then(() => show(named));
});

void ink.storage.get("place").then((kept) => {
  if (typeof kept !== "string" || !kept.trim()) return;
  input.value = kept;
  return show(kept.trim());
});
