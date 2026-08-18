# TerMail

A terminal email client. Type one command in the terminal you're already living
in and read your inbox, instead of alt-tabbing to a browser tab that wants to be
a whole application.

Built with [Ink](https://github.com/vadimdemedes/ink) (React for the terminal),
[ImapFlow](https://imapflow.com) for reading, and
[Nodemailer](https://nodemailer.com) for sending.

> **Status: in progress.** Reading, searching, account management, and mailbox
> state all work against a real account. The send flow is the unfinished part —
> `n` sends a fixed quick-mail and there's no compose UI yet, so treat this as a
> reader with a send hook rather than a mail client you'd switch to.

## Install

```sh
npm run install-global
```

That installs dependencies and links the package globally, putting `TerMail` on
your `PATH`. Open a new shell and run it from anywhere:

```sh
TerMail
```

`termail` works too, for when you don't feel like reaching for shift.

To uninstall: `npm uninstall -g termail`.

## Accounts

Everything is managed inside the app — press `A`.

| Key | Does |
| --- | --- |
| `enter` | Switch to the highlighted account |
| `a` | Add an account |
| `e` | Edit the highlighted account |
| `x` | Remove it (asks whether to delete its cached mail too) |
| `t` | Test IMAP and SMTP for it |
| `esc` | Back to the mailbox |

Adding an account starts with a provider preset — Gmail, Outlook, iCloud,
Fastmail, Yahoo, Zoho, or a custom server — which fills in the host and port for
you. From there the common case is three fields: a name, your address, and your
password. The address and password are copied into the per-protocol fields
automatically; press `ctrl-o` if you need to set the servers separately.
`ctrl-t` tests the connection before you commit, `ctrl-s` saves.

Most providers reject your account password over IMAP, POP3, and SMTP —
generate an app-specific password. The preset tells you where to get one.

### IMAP or POP3

Under `ctrl-o` the **Incoming** row switches between IMAP and POP3 with `←`/`→`
or space; the host and port swap to match. Prefer IMAP when your provider offers
it. POP3 is there for accounts where IMAP isn't available — Zoho, for instance,
leaves IMAP switched off until you enable it in its settings, while POP3 works
out of the box.

The two are not equivalent:

| | IMAP | POP3 |
| --- | --- | --- |
| Read/unread from the server | Yes | No — anything newly downloaded is unread |
| Starred flag from the server | Yes | No |
| Fetches | Headers and body as needed | Whole message, always |
| Repeat syncs | Re-reads the window | Skips anything already cached |

Under POP3 the local cache is the only record of what you've read, starred, or
archived. Deleting a message removes it from TerMail only — it stays on the
server, so nothing is destroyed if you later switch to IMAP.

Accounts are stored in `~/.config/termail/config.json`, written with mode `600`
(readable only by you). Passwords are stored in plaintext in that file, which is
what most CLI mail tools do, but it does mean anyone who can read your home
directory as you can read them.

If you used a pre-TerMail build, the first launch imports your old `.env` and
moves `.data/` into the locations below. It only happens when no account exists
yet, and it doesn't delete anything.

## Syncing

Both protocols list message ids first, subtract everything already cached, then
download the newest `limit` of what's left. So syncing repeatedly walks
backwards through the mailbox instead of re-reading the same window:

```
y   next 200      Y   next 1000      F   everything left
```

The status bar reports what remains — `Synced 200 new · 4310 older still on
server` — so you can keep pressing `Y`, or press `F` to finish the job. `F`
counts first and shows the total before downloading anything; press it again to
confirm, `esc` to back out. `esc` also stops a sync in progress, and because
messages are fetched newest-first, a stopped run still leaves you the most
recent mail.

> **POP3 caveat.** Some providers only offer each message to POP once, or only
> mail that arrived after POP was first used — Zoho is one of them. If a full
> sync reports far fewer messages than the mailbox holds, that's the server's
> POP download-scope setting, not TerMail. Switch that setting to download all
> mail, or use IMAP, if you want the archive.

## Cache

Synced mail is cached so the list renders instantly on launch instead of
blocking on IMAP. Each account gets its own cache directory, so switching
accounts never mixes mail.

The cache is split in two on purpose. `mail-cache.json` is an index — headers,
flags, and the preview line — and it is the only part held in memory; message
bodies live one file each under `bodies/`, read only when you open a message.
Bodies are the overwhelming bulk of a real mailbox (HTML mail ran to 85% of a
200MB cache here), so keeping them out of the index is what lets a full sync of
a large mailbox run in a flat ~150MB instead of growing until it dies. An index
written by an older version is migrated to this layout on first launch, once.

Press `C` for the cache screen. It shows what each option would free and asks
before deleting:

| Option | Removes |
| --- | --- |
| Cached messages | The message list and bodies for this account |
| Downloaded attachments | Attachment files for this account |
| Everything for this account | Both of the above |
| Every account's cache | The whole data directory |

Clearing a cache never touches your login details. There's a non-interactive
form too:

```sh
TerMail clear-cache              # everything for the active account
TerMail clear-cache messages     # just the message list
TerMail clear-cache attachments  # just the attachments
TerMail clear-cache all          # every account
```

## Keys

| Key | Does |
| --- | --- |
| `j` / `k`, arrows | Move through the message list |
| `Ctrl-D` / `Ctrl-U`, page keys | Page through it |
| `Tab` | Cycle panes |
| `/` | Search; `Esc` clears |
| `y` | Download the next 200 messages |
| `Y` | Download the next 1000 |
| `F` | Full sync — counts first, then asks before starting |
| `s` | Star |
| `u` | Toggle unread |
| `e` | Archive |
| `d` / `Del` | Delete |
| `o` | Open the selected message in a browser |
| `n` | Send the quick-mail |
| `t` | Send an SMTP test to your own address |
| `r` | Recheck the incoming and SMTP connections |
| `A` | Accounts |
| `C` | Clear cache |
| `q` | Quit |

Panes respond to the mouse too — click one to focus it, or click a row to
select it.

## Commands

```sh
TerMail                     # open the mailbox
TerMail accounts            # open the account manager
TerMail clear-cache [what]  # delete cached mail without opening the UI
TerMail where               # print config and data locations, and cache size
TerMail --version
TerMail --help
```

## Where things live

| Path | Holds |
| --- | --- |
| `~/.config/termail/config.json` | Accounts and credentials, mode `600` |
| `~/.local/share/termail/accounts/<id>/mail-cache.json` | Message index — headers, flags, previews |
| `~/.local/share/termail/accounts/<id>/bodies/` | Message bodies, one file each |
| `~/.local/share/termail/accounts/<id>/attachments/` | Downloaded attachments |

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` are honoured if you set them.

## Development

```sh
npm install
npm run dev        # same entry point as the installed binary
npm run typecheck
```

The TypeScript source is compiled on load by
[tsx](https://github.com/privatenumber/tsx), so there's no build step to keep in
sync. `bin/termail.mjs` registers tsx in-process rather than spawning a child —
a TUI needs to own stdin and stdout directly.

Reading and writing mail goes straight to the store. The loopback HTTP server
that starts with the app exists only to render a full HTML message, with its
inline images, when you press `o`.

Incoming mail goes through [`src/incoming.js`](src/incoming.js), which picks
between [`imapSync.js`](src/imapSync.js) and [`popSync.js`](src/popSync.js) so
nothing above it branches on protocol. The POP3 client is written directly
against the socket rather than pulled from a dependency — the protocol is a
dozen commands, and the two parts worth care (multi-line responses ending in a
lone `.`, and data lines whose leading `.` is doubled in transit) are handled in
`Pop3Client`.
