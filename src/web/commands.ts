export interface Command {
  /** What a keybinding or another command names it by. It doesn't change when the title does. */
  id: string;
  title: string;
  run: () => void;
}

export interface Commands {
  /** Returns a function that takes the command back out. */
  register(command: Command): () => void;
  list(): Command[];
  /** False when no command has that id. */
  run(id: string): boolean;
}

export function createCommands(): Commands {
  const byId = new Map<string, Command>();
  return {
    register(command) {
      if (byId.has(command.id)) throw new Error(`There's already a command with the id ${command.id}`);
      byId.set(command.id, command);
      return () => {
        if (byId.get(command.id) === command) byId.delete(command.id);
      };
    },
    list: () => [...byId.values()],
    run(id) {
      const command = byId.get(id);
      command?.run();
      return command !== undefined;
    },
  };
}
