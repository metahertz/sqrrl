# Apple Notes, Calendar and Mail -> sqrrl

Exports your Apple Notes to markdown, your Calendar.app meetings as events,
and your Mail.app mail (Inbox and Sent), and submits them to an sqrrl
server. Notes need nothing beyond
what macOS ships; the calendar exporter is compiled on first use with the
Xcode Command Line Tools (`xcode-select --install`). Calendar is described
under "Calendar" below.

## Setup

    chmod +x sqrrl-notes-sync.sh sqrrl-notes-export.js

    export SQRRL_API_URL=http://your-sqrrl-host:3847
    export SQRRL_API_KEY=mdb_...

## How long it takes

The server runs two LLM calls per note — one to build the page and its claims,
one to extract action items — and this script waits for each note to finish
before sending the next. On a local model that is minutes per note, not
seconds, so a first full export of a few hundred notes is an overnight job
rather than a coffee break.

Ctrl-C is safe. A note is only marked done once the server has accepted it, so
re-running picks up where you stopped rather than starting over or
double-importing.

Sending is deliberately serial: a local gateway generally serialises anyway,
and issuing them in parallel measurably slows each one down while making
failures harder to attribute.

## Use

    ./sqrrl-notes-sync.sh --dry-run   # list what would be sent, send nothing
    ./sqrrl-notes-sync.sh --all       # first run: export and send everything
    ./sqrrl-notes-sync.sh             # after that: only notes changed since
    ./sqrrl-notes-sync.sh --force     # rebuild the wiki even for unchanged notes

If a run is interrupted or some notes fail, run it again **without** `--all`:
the notes that did not go through are still queued and are the only ones
sent. Re-running with `--all` is safe too: every note is exported again, but
the ones the server already holds unchanged are skipped in seconds rather
than re-processed. Use `--force` only after wiki pages were deleted.

Run it from Terminal the first time. macOS will ask whether Terminal may
control Notes; under a scheduler that prompt cannot appear and the export
fails silently.

## Run it on a schedule

    ./sqrrl-schedule.sh notes install   # hourly launchd agent, then one run now
    ./sqrrl-schedule.sh notes status    # state, last exit code, log tail
    ./sqrrl-schedule.sh notes run       # run now
    ./sqrrl-schedule.sh notes uninstall

(`./sqrrl-notes-schedule.sh install` still works and does the same.)

`install` asks for the API URL, a key and the scope, and keeps them in
`~/.config/sqrrl/notes.env` (mode 600) rather than in the agent's plist,
which any local user can read. Use a scoped key that can write one scope,
not the master key. The agent runs the scripts from this folder, so leave
the folder where it is. Output goes to `~/Library/Logs/sqrrl-notes-sync.log`.

Do the Terminal run above first: the Notes permission prompt cannot appear
for a launchd job. Error -1743 in the log means it was never granted; allow
it in System Settings -> Privacy & Security -> Automation.

Each run only sends notes changed since the last, so an hourly agent costs
nothing when you have not written anything. `SQRRL_SYNC_INTERVAL=1800
./sqrrl-schedule.sh notes install` changes the interval.

## Options

    SQRRL_SCOPE_REF   wiki scope to file notes under (default "default").
                        Use separate values to keep work and personal apart.
    SQRRL_NOTES_DIR   where exported markdown is kept (default ~/sqrrl-notes)
    SQRRL_TIMEOUT     seconds to wait per note (default 900). The server
                        makes two LLM calls per note, which on a local model
                        is minutes rather than seconds.

## What it does

Reads notes through AppleScript, not the SQLite store: note bodies there are
gzipped protobuf in an undocumented format that changes between macOS
releases and needs Full Disk Access. The scripting interface is supported and
survives upgrades. Notes written on an iPhone are picked up too, once iCloud
has synced them to the Mac.

Filenames are a hash of each note's stable identifier rather than its title,
because sqrrl derives a wiki page from the file path — a title-based name
would create a brand new page every time you renamed a note. The readable
title is inside the file.

Password-protected notes are skipped rather than exported as garbage.

Each note becomes a wiki page with extracted claims, one task page per action
item (owner, due date, status), and graph links joining tasks to the note,
tasks to the people who own them, and notes to shared topics.

## Calendar

    ./sqrrl-calendar-sync.sh --list-calendars   # which calendars it can see
    ./sqrrl-calendar-sync.sh --dry-run          # events per week, nothing sent
    ./sqrrl-calendar-sync.sh --all              # first run: the past year
    ./sqrrl-calendar-sync.sh                    # after that: 30 days back, 14 ahead

    ./sqrrl-schedule.sh calendar install        # hourly agent, then one run now

Reads Calendar.app through EventKit, so it sees every account you have
added to Calendar (Google Workspace, Exchange, iCloud) without any app
approval from your organization. Holiday and birthday calendars are
skipped; `--calendars "Work,Team"` (or `SQRRL_CALENDARS`) picks calendars
by name. Meetings you declined and all-day events are left out unless you
pass `--include-declined` / `--include-all-day`.

The first run compiles `sqrrl-calendar-export.swift` into `.build/` and
macOS asks for calendar access. The prompt follows whoever started it: from
Terminal it grants Terminal, which covers your own runs; the run that
`./sqrrl-schedule.sh calendar install` starts asks on behalf of
sqrrl-calendar-export, which is what the hourly agent needs. Allow both.
"no calendar access" in the log means it was declined; allow it in System
Settings -> Privacy & Security -> Calendars.

Each week in the range is sent whole, so the server can tell when a
meeting was deleted or moved out of it; its page is kept and marked as
removed rather than deleted. No LLM is involved: a year of meetings takes
seconds. Each meeting becomes a page under meetings/ with its time,
attendees and agenda, linked to a people/ page per attendee (created for
meetings of up to 12 people; larger ones only link people already known)
and to the meeting's transcript when one was uploaded in the same scope
around that time. Zoom passcodes and links' query strings are not stored.

## Mail

    ./sqrrl-mail-sync.sh --dry-run          # messages per day, nothing sent
    ./sqrrl-mail-sync.sh --all              # first run: the last 30 days
    ./sqrrl-mail-sync.sh                    # after that: the last 3 days

    ./sqrrl-schedule.sh mail install        # hourly agent, then one run now

Reads the Inbox and Sent mailboxes of every enabled account in Mail.app
(Google Workspace, Exchange, iCloud), so no app approval is needed from
your organization. `--accounts "Work"` (or `SQRRL_MAIL_ACCOUNTS`) limits
it to named accounts. Run it from Terminal once first: macOS asks whether
Terminal may control Mail; error -1743 means it was not allowed (System
Settings -> Privacy & Security -> Automation).

Only mail people wrote is kept: the server drops mailing lists, anything
with an unsubscribe link, notifications and no-reply senders, auto-replies
and calendar invitations (the calendar sync has those). Quoted history is
cut, so each message stores what it newly said. Messages are grouped into
threads, and each thread becomes one wiki page with its decisions and tasks
(yours are "me" tasks), linked to the people in it. Archiving or deleting
mail later does not remove it from the brain.

Each new or changed thread costs two LLM calls on the server, so the first
`--all` run takes a while; later runs only pay for new mail.
