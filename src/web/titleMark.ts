/**
 * What an empty note is opened with, for a member who can write in it: the mark of its title, with
 * the cursor after it, so the title is the first thing typed. It is only in the editor. The note is
 * still empty to the server, and to everyone else, until something is typed after the mark, and then
 * the mark and what was typed are saved as the one change.
 */
export const TITLE_MARK = "# ";
