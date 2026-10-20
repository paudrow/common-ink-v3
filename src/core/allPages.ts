/** Every row of a list that pages, asked for a page at a time until a page's `next` is null. */
export async function allPages<A extends { next: string | null }, R>(ask: (after: string | undefined) => Promise<A>, rows: (answer: A) => readonly R[]): Promise<R[]> {
  const all: R[] = [];
  for (let after: string | undefined; ; ) {
    const answer = await ask(after);
    all.push(...rows(answer));
    if (answer.next === null) return all;
    after = answer.next;
  }
}
