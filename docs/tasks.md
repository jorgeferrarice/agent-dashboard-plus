# Tasks tab

The **Tasks** tab shows your tasks on a Kanban board inside the
dashboard. It holds tasks you create in the dashboard itself
("local tasks"), and later also tasks read from Jira, Shortcut
and Huly.

## Opening the tab

Click **Tasks** in the top right of the Dashboard. The board opens
in a tab next to your session tabs. Like a session tab, it can be
moved, closed and opened again, and it is remembered across
reloads and devices.

## The board

The board has four fixed columns:

| Column      | Meaning                           |
| ----------- | --------------------------------- |
| To do       | Not started                       |
| In progress | Being worked on                   |
| In review   | Waiting for review, QA or approval |
| Done        | Finished                          |

Each card shows where the task comes from (a badge), its key in
the tracker when it has one, its title, and when set its priority,
due date and tags. A due date in the past turns red until the task
is done.

### Order of the cards

Cards in a column are ordered automatically:

1. By priority: Urgent, High, Medium, Low, then tasks without one.
2. Then by due date, nearest first; tasks without one come last.
3. Then by the last change, newest first.

### Changing the status

Two ways:

- **Drag the card** to another column (with a mouse or trackpad).
  If that column holds more than one status the task can move to —
  say "Code review" and "QA" both count as *In review* — the
  dashboard asks which one. If none fits, the card stays where it
  was and a message says why.
- **Use the dropdown** on the card (also in the list view, and the
  way to do it on a phone, where dragging scrolls the board). It
  lists the statuses the task can move to right now.

If the change fails, the card goes back to its column and the error
is shown above the board.

## Task details

Click a task's title (on a card or in the list) to open its side
panel. On a phone the panel fills the screen. Close it with the ✕,
the Escape key, or a click outside it.

- For a **local task** the panel edits every field. Click **Save**
  to keep the changes or **Discard** to drop them. **Delete task**
  asks once more before deleting; a deleted task cannot be brought
  back.
- For a task from a **tracker** the panel shows its status (with the
  same dropdown as the card), priority, assignee, due date, labels
  and description, plus a link to open it in the tracker. There you
  can also:
  - **change the assignee**: *Change*, type part of a name and pick
    the person (only people the tracker lets you assign appear), or
    *Unassign*. A task you give to someone else stays on your board
    until the next read;
  - **read and add comments**: comments are shown as plain text,
    oldest first (the latest 100), and yours are sent as plain text.

  When the tracker does not allow your account to do something, the
  panel says so.

## List view

Use the **Board / List** switch at the top to see the tasks as a
table instead. The table is grouped by the same four columns and
shows source, key, title, status, priority, assignee, due date and
last change (on a phone, key, assignee and last change are hidden
to save room).

Click a column header to sort by it, click again to reverse, and a
third time to go back to the board's order. The status dropdown
works in the table too. The browser remembers which view you used
last.

## Local tasks

Click **New task** to create one. A local task has:

- a **title** (required) and a **description**;
- a **column**;
- a **priority** (Urgent, High, Medium or Low), optional;
- a **due date**, optional;
- **tags**: free labels, typed separated by commas (up to 20, of up
  to 40 characters each).

Local tasks belong to the account you signed in with: other people
signed in to the same dashboard do not see them.

## Creating a task in a tracker

With a connection set up, **New task** has a *Create in* menu: keep
*This dashboard* for a local task, or pick a connection. For a
tracker you choose the project, the type (e.g. Task, Bug, Story),
the priority (the tracker's own list; *Default* lets the tracker
decide), the title and a description. The new task is assigned to
the connection's account and shows on the board right away.

Some projects require more fields than these (e.g. a *Team* field
in Jira). The form then shows the tracker's message and a link to
create the task in the tracker itself.

## Connections to trackers

Click **Connections** at the top of the Tasks tab to connect your
tracker accounts. You can add several connections per tracker
(e.g. two Jira sites) and give each a name; the name is shown on
the badge of its cards.

The dashboard checks the token with the tracker before saving it,
then reads the tasks assigned to you. Each connection belongs to
the account you signed in with: nobody else sees its tasks or
uses its token.

Each connection in the list shows who the token belongs to, how
many tasks it found, and when it last read them. The ⟳ button
reads them again; the pencil edits the connection (leave the token
blank to keep the saved one); the bin removes the connection (this
changes nothing in the tracker). When a read fails, the reason is
shown on the connection and above the board, and the board keeps
showing the tasks it read last.

### Choosing which tasks show

**On the board:** above it, one chip per source — *Local* and each
connection by name. Click a chip to hide its tasks, click again to
show them. This only changes what this browser shows.

**Per connection:** edit the connection (pencil) and use the
*Which tasks* section:

- **Assigned to**: *Me* (default), *Nobody* or *Anyone*.
- **Finished in the last (days)**: also show tasks finished in the
  last N days (0 to 90; 14 by default; 0 shows only unfinished
  ones).
- **Projects** (Jira: project keys, e.g. `WEB, API`): only these
  projects; blank for all.
- **Advanced query** (Jira: JQL): your own query, used instead of
  the fields above. If the tracker rejects it, the connection shows
  the tracker's error and the board keeps the tasks read before.

### Choosing the column of each status

Every tracker status goes in a column automatically (see each
tracker below). To change that, edit the connection and use the
*Columns* section: it lists the statuses of the tasks read so far,
each with a column picker; *(auto)* marks the automatic one. The
board follows the change as soon as you save, without reading the
tracker again. **Reset to automatic** puts every status back. A
status the tracker adds later shows up in the list after the next
read, in its automatic column.

### Keeping tasks up to date

The backend reads every connection again every **10 minutes**, in
the background, whether or not anyone has the Tasks tab open. When
something changed, open Tasks tabs reload by themselves. The top of
the board says when the trackers were last read; the ⟳ button
next to **New task** reads them all right away.

The dashboard never needs to be reachable from the internet for
this (it asks the trackers; they never call it). When a tracker
says it is receiving too many requests, the dashboard waits as long
as the tracker asks before reading that connection again. A
connection that fails does not hold up the others.

### Jira Cloud

1. Create an API token at
   [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
2. In **Connections**, pick **Jira Cloud** and enter:
   - **Site**: your Jira address, e.g. `https://your-team.atlassian.net`;
   - **Account email**: the email you sign in to Jira with;
   - **API token**: the token from step 1.

By default the board shows the issues assigned to you that are not
done, plus those finished in the last 14 days (see *Choosing which
tasks show*).

Each issue goes in the column of its Jira *status category*: "To
Do" → **To do**, "In Progress" → **In progress**, "Done" →
**Done**. A status of the "In Progress" category whose name reads
like a review step (review, QA, test, verify, approval) goes in
**In review**. Priorities are mapped as Highest/Blocker/Critical →
Urgent, High/Major → High, Medium → Medium, Low/Lowest/Minor →
Low.

Jira only moves an issue through the *transitions* its workflow
allows, so the status dropdown of a Jira card lists the statuses
reachable from where the issue is now.

Some transitions ask for fields — closing an issue often asks for
a *Resolution*. The dashboard then shows a short form with those
fields before moving the issue: lists of values, text, dates,
numbers and people (type part of a name to search). Cancelling it
leaves the card where it was. A field the dashboard cannot fill
(e.g. a date with a time) is named in the form, with a link to
move the issue in Jira itself.

### Shortcut

1. Create an API token in Shortcut under
   [Settings → Your account → API Tokens](https://app.shortcut.com/settings/account/api-tokens).
2. In **Connections**, pick **Shortcut**, give it a name and paste
   the token. No other setting is needed: the token says which
   workspace it belongs to.

By default the board shows the stories you own that are not done
(archived ones left out), plus those completed in the last 14 days.
In the filters, *Teams* are Shortcut team names, and the advanced
query uses [Shortcut's search syntax](https://help.shortcut.com/hc/en-us/articles/360000046646-Searching-in-Shortcut-Using-Search-Operators)
(e.g. `label:web !is:done`).

A story's column comes from the type of its workflow state:
*Backlog* and *Unstarted* → **To do**, *Started* → **In progress**
(or **In review** when the name reads like a review step), *Done*
→ **Done**. Any state of the story's workflow can be picked from
the status dropdown; Shortcut needs no extra fields. The priority
comes from Shortcut's built-in *Priority* field.

The side panel lists and adds comments and changes the owner (a
story with several owners gets the one you pick). **New task** can
create a story: pick the *workflow* (the story starts in its first
unstarted state), the type (Feature, Bug or Chore) and a priority;
you become its owner. Shortcut allows 200 requests per minute per
token; if the dashboard hits that, it waits as Shortcut asks.

### Huly (self-hosted) — experimental

> Hosted Huly (huly.app) has shut down; only self-hosted Huly 0.7
> is supported. Huly has **no documented API**: the dashboard
> speaks the same protocol as Huly's own client, so a Huly upgrade
> may break it. If it does, the connection shows the error and the
> rest of the board keeps working.

1. In **Connections**, pick **Huly (self-hosted)** and enter:
   - **Huly address**: where your Huly opens, e.g.
     `https://huly.example.com` (plain `http://` works for an
     instance on your local network);
   - **Workspace**: the workspace's name as it appears in Huly's
     URL (`…/workbench/<workspace>/…`);
   - **Account email** and **Password** of a Huly account.
     Consider a separate account for the dashboard; its password
     is stored encrypted like the other tokens.

The board shows the issues assigned to that account that are not
finished, plus those finished in the last 14 days. In the filters,
*Project identifiers* are like `WEB` (the prefix of issue keys);
Huly has no advanced query.

Statuses go in columns by their Huly category: *Backlog* and *To
do* → **To do**, *Active* → **In progress** (or **In review** when
the name reads like a review step), *Done* and *Canceled* →
**Done**. The status dropdown lists the statuses of the issue's
project. Priorities map 1:1 (Urgent, High, Medium, Low).

The side panel lists and adds comments and changes the assignee.
**New task** creates an issue in a project, assigned to you, with
an optional priority and description.

Limitations: issue descriptions are not shown on the board or in
the panel (Huly keeps them in a separate document service, which
would cost one request per issue), and labels are not shown.

### How tokens are kept

Tokens are stored in the dashboard's database encrypted with a key
derived from the backend's `SECRET_KEY`, and are never sent back to
the browser or written to the logs. If `SECRET_KEY` changes (or is
not set, in which case a new random one is made at every start),
saved tokens can no longer be read: each connection then says so,
and you enter its token again. With `BYPASS_AUTH=true` and no
`SECRET_KEY`, a random key is used at each start, so tokens must be
entered again after every restart; set `SECRET_KEY` to keep them.

Other safeguards:

- Jira connections only accept Jira Cloud addresses
  (`*.atlassian.net`), so a token is never sent anywhere else.
- Changing a connection's address, email or workspace requires
  entering its token again, so a saved token cannot be redirected
  to another server.
- Links from trackers are only shown when they are `http(s)` links.
- Invalid requests are answered without echoing what was sent.
- Your tasks and connections are tied to your login email (case
  does not matter); an email your identity provider marks as not
  verified is refused.

## For developers

The backend lives in `backend/app/tasks.py` and is mounted under
`/tasks`. Every endpoint requires UI login.

| Method and path                   | What it does                                  |
| --------------------------------- | --------------------------------------------- |
| `GET /tasks`                      | Every task on the user's board                |
| `POST /tasks/local`               | Create a local task                           |
| `PATCH /tasks/local/{id}`         | Change some fields of a local task            |
| `DELETE /tasks/local/{id}`        | Delete a local task                           |
| `GET /tasks/{task_id}/statuses`   | Statuses the task can move to right now       |
| `POST /tasks/{task_id}/status`    | Move the task to one of those statuses        |
| `GET /tasks/{task_id}/users?query=` | People a tracker's task can be assigned to  |
| `PUT /tasks/{task_id}/assignee`   | Assign a tracker's task (`user_id`, or null)  |
| `GET /tasks/{task_id}/comments`   | A tracker's task's comments, oldest first     |
| `POST /tasks/{task_id}/comments`  | Add a plain-text comment                      |
| `POST /tasks/refresh`             | Read the trackers again, then list the board  |
| `GET /tasks/connections`          | The user's connections (never the token)      |
| `POST /tasks/connections`         | Add one; the token is checked first           |
| `PATCH /tasks/connections/{id}`   | Rename, change settings, token, filters, mapping |
| `DELETE /tasks/connections/{id}`  | Remove one and its cached tasks               |
| `GET /tasks/connections/{id}/statuses` | Known statuses and the column of each    |
| `GET /tasks/connections/{id}/create-options` | Projects and priorities for a new task |
| `GET /tasks/connections/{id}/types?project=` | Task types a project allows        |
| `POST /tasks/connections/{id}/tasks` | Create a task in the tracker             |

Every task reaches the UI in one shape, `TaskItem`, whatever its
source. Its `id` is `local:<id>` for a local task and
`<provider>:<connection id>:<id in the tracker>` for one from a
tracker, e.g. `jira:3:PROJ-12`. The two status endpoints work the same for every
source, so the board has no source-specific code for moving cards.

In the frontend, the tab has the fixed ID `tasks` in the list of
open tabs (`Workspace.tsx`); the board is `components/tasks/`.

Each tracker is a module in `backend/app/providers/` (`jira.py`,
`shortcut.py`, `huly.py`) with the same async functions: `normalize_config`,
`normalize_filters`, `check`, `fetch`, `statuses`, `set_status`
and `search_users`. A status option may carry `fields`: what the
tracker requires to move there, with a `kind` (select,
multiselect, text, richtext, user, date, number or unsupported)
that tells the UI how to ask for it. A tracker's tasks are read into the `task_cache`
table and placed in a column when the board is listed, so a change
of the status mapping needs no new read. Tests answer the
trackers' HTTP requests with fakes (`backend/tests/conftest.py`,
fixture `tracker`).
