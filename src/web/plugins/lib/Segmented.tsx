/** One choice of a few, as a row of words with the chosen one raised. `chosen` is null when what is asked for is none of them. */
export function Segmented<Id extends string>({ name, label, className, choices, chosen, onChoose }: { name: string; label: string; className?: string; choices: readonly { id: Id; label: string }[]; chosen: Id | null; onChoose: (id: Id) => void }) {
  return (
    <div className={className ? `segmented ${className}` : "segmented"} role="radiogroup" aria-label={label}>
      {choices.map((choice) => (
        <label key={choice.id}>
          {/* A click on the choice already made writes it into the bar again, where it may have been taken out by hand. */}
          <input type="radio" name={name} checked={chosen === choice.id} onClick={() => onChoose(choice.id)} onChange={() => onChoose(choice.id)} />
          <span>{choice.label}</span>
        </label>
      ))}
    </div>
  );
}
