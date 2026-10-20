# commonink

`ink` reads and writes your [Common Ink](https://commonink.app) notes from a shell. It is how an agent with a terminal, or you, works in your notebook without the browser.

## Install

```sh
npm i -g commonink
```

Or run it without installing:

```sh
npx commonink help
```

It needs Node 20 or later. Installed, it is both `ink` and `commonink`.

## Connect it

`ink` acts as an agent you connect in Common Ink. Make one there, copy its token, and set it:

```sh
export INK_TOKEN=cink_...
ink workspaces
```

`INK_URL` is the Common Ink it talks to, `https://commonink.app` unless you set it.

## Use it

```sh
ink help
```

lists every command. The [docs](https://commonink.app/docs/cli) say more about each one.
