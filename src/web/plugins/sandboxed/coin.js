// A coin in the bottom bar. It needs no note: it is there on every page.
const button = document.createElement("button");
button.type = "button";
button.setAttribute("aria-label", "Coin");
button.textContent = "Heads";
button.style.font = "inherit";
button.style.height = "25px";
button.style.padding = "0 8px";
button.style.border = "0";
button.style.background = "transparent";
button.style.color = "inherit";
button.addEventListener("click", () => {
  button.textContent = button.textContent === "Heads" ? "Tails" : "Heads";
});
ink.root.append(button);
