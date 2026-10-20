# The ink command

`ink` reads and changes your Common Ink notes from a shell, with an agent's token. This page covers installing it, signing it in, and common tasks, then lists every command.

`ink` calls the same tools an agent calls over MCP, so it can do what an agent can and nothing more. Its changes are recorded under the agent whose token it uses.

## Install it

`ink` isn't on npm yet. It's coming as the package `commonink`, and this page will say how to install it when it's out.

Today, `ink` runs from a copy of the Common Ink source, with Node 22 or later:

```sh
git clone https://github.com/paudrow/common-ink-v3.git
cd common-ink-v3
npm install
npm run ink -- workspaces
```

The examples on this page use `ink`. From the source, type `npm run ink --` in its place.

## Give it a token

`ink` reads its token from `INK_TOKEN`. Use an agent's token from the Agents page. [Connect an agent](/docs/agents) shows how to get one, and the limits you set there hold for `ink` too.

```sh
export INK_TOKEN=cink_…
ink workspaces
```

`ink workspaces` lists the workspaces the token reaches, with your role in each. `INK_URL` sets the server and defaults to `https://commonink.app`.

If you are in more than one workspace, add `--workspace` with the workspace's id to each command:

```sh
ink notes --workspace <workspace id>
```

Most commands print their answer as JSON. A flag a command doesn't take is refused before anything is sent.

## List and read notes

```sh
ink folders
ink notes --folder <folder id>
ink read <note id>
```

`ink folders` gives each folder's id and its path, such as `Projects/Skills`. `ink folder-find "Projects/Skills"` finds one folder by its path. `ink read` prints the note's markdown, its revision, and the titles of the notes it links to.

## Create a note

`ink create` reads the note's text from stdin, or from `--text`. Without `--folder`, the note goes in Unsorted.

```sh
ink create --folder <folder id> <<'EOF'
# Groceries

- [ ] Milk
- [ ] Bread
EOF
```

## Search notes and todos

```sh
ink search 'budget #money updated:>=7d'
ink todos 'due:<today priority:>=medium'
```

A query takes words, `"a phrase"`, and filters such as `folder:`, `#tag`, `is:archived`, and `due:`. `ink syntax` lists every form, and `ink syntax todos` lists the forms for todos. Days such as `today` are counted on this machine's date and time zone unless you pass `--today` and `--zone`.

## Change some lines of a note

`ink edit` changes some lines and leaves the rest. Read the note first, and pass its revision as `--base`. Lines count from 0. `--from` is included and `--to` is not.

```sh
ink read <note id>
ink edit <note id> --base 4 --from 2 --to 3 --text "- [x] Milk"
```

With `--from` and `--to` equal, the text is inserted there. An empty `--text` deletes the lines. If someone changed the note since revision 4, `ink edit` merges your lines with their changes. To replace the whole note, use `ink write <note id> --base 4` with the new text on stdin.

## Upload and download files

```sh
ink upload report.pdf --folder <folder id>
ink download <upload id> --out report.pdf
```

`ink upload` sends a file of up to 25 GB in parts, and sends a part again if it fails. It prints the upload and the line that shows it in a note. If it stops, `ink upload-resume <upload id>` says which parts are stored and gives a fresh address for the rest, and `ink upload-abort <upload id>` throws the upload away. `ink download` saves under the upload's name unless you pass `--out`, and doesn't replace a file that is there unless you add `--force true`.

## Revert what an agent changed

`ink authors` lists everyone who has changed a note, each as a kind and an id, such as `agent:abc123def456`. Preview first, then revert:

```sh
ink authors
ink revert-author agent:abc123def456 --preview
ink revert-author agent:abc123def456
```

`--preview` writes nothing. It shows what the revert would do to each note the agent changed. The revert takes out every change of that agent's that still stands, as one new change in each note, and keeps everyone else's changes. Add `--note` with note ids to revert only those notes.

To look at one note's history and revert chosen changes:

```sh
ink history <note id>
ink revert <note id> --changes 7,8 --preview
ink revert <note id> --changes 7,8
```

A revert is a change like any other, so you can revert it too. [History and blame](/docs/history) explains reverts and conflicts.

## All commands

<!-- generated:cli-usage -->
