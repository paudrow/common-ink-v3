/** Every answer of a list that pages, the first first, each asked with the `next` of the one before, until one has none. */
export async function walk<A extends { next: string | null }>(ask: (after: string | undefined) => Promise<A>): Promise<A[]> {
  const answers: A[] = [];
  for (let after: string | undefined; ; ) {
    const answer = await ask(after);
    answers.push(answer);
    if (answer.next === null) return answers;
    if (answers.length > 100) throw new Error("more than a hundred pages: the walk is going round");
    after = answer.next;
  }
}
