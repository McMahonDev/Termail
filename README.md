# Termail

A terminal email client. Type one command in the terminal you're already
living in and read your inbox, instead of alt-tabbing to a browser tab that
wants to be a whole application.

Built with [Ink](https://github.com/vadimdemedes/ink) (React for the terminal),
[ImapFlow](https://imapflow.com) for reading, and
[Nodemailer](https://nodemailer.com) for sending.

> **Status: in progress.** Reading, searching, and mailbox state all work
> against a real account. The send flow is the unfinished part — `n` sends a
> fixed quick-mail and there's no compose UI yet, so treat this as a reader
> with a send hook rather than a mail client you'd switch to.

## Running it

```sh
npm install
cp .env.example .env   # then fill in your IMAP/SMTP details
npm run dev
```

`npm start` runs the same thing through `bin/hello-tui.mjs`, which is what the
`hello-tui` bin points at if you install the package globally.

Credentials are read from the first `.env` that exists, in this order: the
current directory, the package root, then `~/.config/hello-tui/.env`. That last
one is the useful one once it's installed globally.

Most providers reject your account password over IMAP and SMTP — generate an
app-specific password. The client starts fine without any credentials and
reports each connection as unconfigured in the status bar, so you can look
around before committing to a mailbox.

## Keys

| Key | Does |
| --- | --- |
| `j` / `k`, arrows | Move through the message list |
| `Ctrl-D` / `Ctrl-U`, page keys | Page through it |
| `Tab` | Cycle panes |
| `/` | Search; `Esc` clears |
| `y` | Sync the last 200 messages |
| `Y` | Sync the last 1000 |
| `s` | Star |
| `u` | Toggle unread |
| `e` | Archive |
| `d` / `Del` | Delete |
| `o` | Open the selected message in a browser |
| `n` | Send the quick-mail |
| `t` | Send an SMTP test to `SMTP_TEST_TO` |
| `q` | Quit |

## Local state

Synced mail is cached in `.data/mail-cache.json` so the list renders instantly
on launch instead of blocking on IMAP. That file is real mail, so it's
gitignored — don't commit it, and delete it if you point the client at a
different account.
