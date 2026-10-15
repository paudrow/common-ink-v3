/** Where a person's page is, which Mentions draws and Contacts links to: `/person/` and who they are, as a mention names them. */
export const PERSON_PATH = "/person";
export const personPath = (who: string) => `${PERSON_PATH}/${encodeURIComponent(who)}`;
export const whoOn = (path: string) => {
  try {
    return path.startsWith(`${PERSON_PATH}/`) ? decodeURIComponent(path.slice(PERSON_PATH.length + 1)) : null;
  } catch {
    return null;
  }
};
