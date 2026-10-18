// A die on its own page. Each roll is this page's alone.
const root = ink.root;
root.style.display = "flex";
root.style.flexDirection = "column";
root.style.alignItems = "flex-start";
root.style.gap = "12px";
root.style.padding = "24px";
root.style.color = "inherit";
root.style.font = "inherit";

const button = document.createElement("button");
button.type = "button";
button.textContent = "Roll";

const face = document.createElement("p");
face.setAttribute("role", "status");
face.style.margin = "0";
face.style.fontSize = "2em";
face.textContent = "Roll the die.";

button.addEventListener("click", () => {
  face.textContent = String(1 + Math.floor(Math.random() * 6));
});
root.append(button, face);
