# Git tab

The **Git** tab shows, in one place, the pull requests and commits
of your GitHub and Bitbucket Cloud accounts:

- **My pull requests**: the ones you opened, with their state;
- **To review / assigned to me**: the ones waiting for your review
  or assigned to you;
- **My commits**: what you committed in the last 14 days.

Every pull request has a **Review PR** button. Claude reads the
pull request and shows a review: a summary, a verdict and
suggested comments. **Nothing is posted by the review.** You edit
each suggestion and post it yourself with its **Post** button.

## Opening the tab

Click **Git** in the top right of the Dashboard, next to
**Tasks**. The tab opens next to your session tabs and, like them,
can be moved, closed and opened again; it is remembered across
reloads and devices.

## Connecting an account

Click **Connections** at the top of the tab, pick the service,
give the connection a name (e.g. "GitHub work") and paste a token.
The dashboard checks the token before saving it. You can add
several connections, e.g. a personal and a work GitHub account;
each item in the tab shows which connection it came from.

### GitHub

Use a **personal access token** from
[github.com/settings/tokens](https://github.com/settings/tokens):

- **Fine-grained token** (recommended): pick the repositories (or
  all), and give it **Pull requests: Read and write** (write is
  only used when you post a comment), **Contents: Read** and
  **Metadata: Read**. A fine-grained token only sees the
  repositories it was given and the organizations that allow
  such tokens.
- **Classic token**: scopes `repo` (private repositories) and
  `read:user`. Organizations with SAML single sign-on need the
  token authorized for them (*Configure SSO* next to the token).

Only github.com is supported (not GitHub Enterprise Server).

### Bitbucket Cloud

Bitbucket Cloud uses an **API token** of your Atlassian account
(app passwords no longer work). Create one at
[id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
with **Create API token with scopes**, pick **Bitbucket**, and give
it these scopes:

- `read:user:bitbucket`
- `read:workspace:bitbucket`
- `read:repository:bitbucket`
- `read:pullrequest:bitbucket`
- `write:pullrequest:bitbucket` (only used when you post a comment)

In the connection form also enter:

- **Atlassian account email**: the email you sign in to
  Atlassian with (the token works together with it);
- **Workspaces**: the slug of each workspace to read, separated by
  commas. The slug is the part after `bitbucket.org/` in the
  workspace's address. Up to 5.

Only Bitbucket Cloud (bitbucket.org) is supported (not Bitbucket
Data Center or Server).

## What each section shows

| Section | GitHub | Bitbucket Cloud |
| --- | --- | --- |
| My pull requests | Your 30 most recently updated pull requests, open or closed | Your open, merged and declined pull requests in each workspace |
| To review / assigned to me | Open pull requests that ask for your review (directly or through a team) and those assigned to you | Open pull requests that list you as a reviewer, in the **10 most recently updated repositories** of each workspace |
| My commits | Your commits of the last 14 days on the branches of your pull requests and on the default branch of their repositories (up to 10 repositories) | Your commits of the last 14 days on the branches of your pull requests and the branches they merge into (up to 5 repositories) |

Each pull request shows:

- its **state**: Open, Draft, Merged or Closed (declined and
  superseded pull requests on Bitbucket show as Closed);
- where **reviews** stand: Approved, Changes requested or Review
  pending;
- on GitHub, the combined **CI** status of its last commit
  (passing, failing or running). Bitbucket does not show CI status:
  reading it would cost one request per pull request.

A pull request in both lists (say, yours and assigned to you) is
listed once, with both badges. Bitbucket has no "assignee" for
pull requests.

Commits only come from repositories where you have a pull request,
so a commit pushed straight to a repository where you have none
does not show up.

## Keeping it up to date

Every connection is read again **every 2 minutes**, and open pages
update by themselves. The ⟳ button reads them at once (a
connection read in the last 15 seconds is skipped). When a read
fails, the reason shows on the connection and at the top of the
tab, and the tab keeps showing what it read last. When GitHub or
Bitbucket asks the dashboard to slow down (rate limit), it waits
the time they ask for.

Request budget per read: GitHub uses 2 GraphQL requests. Bitbucket
uses about 1 + 2 per workspace + 10 per workspace (one per
repository searched for reviews) + up to 5 (commits). Bitbucket
allows about 1,000 requests per hour, so with two or more
workspaces a connection may be slowed down now and then.

## Reviewing a pull request

1. Click **Review PR** on a pull request. A panel opens on the
   right (the whole screen on a phone).
2. If there is no saved review yet, Claude starts one. It reads
   the pull request's title, description and diff — not the rest
   of the repository — and usually takes from a few seconds to a
   couple of minutes.
3. The panel shows the **verdict** (Approve, Comment or Request
   changes), a **summary** and the **suggested comments**, each
   with the file and line it is about (or "General comment").
4. Edit a suggestion if you want and click **Post**. The comment
   goes on that line of the pull request, as the connection's
   account. If the line is not part of the diff, the host refuses
   a comment there, so it is posted as a general comment that
   starts with the file and line; the panel says so.

The review and its suggestions are written **in the language of
the pull request's description** (the title's, when the
description is empty).

The last review of each pull request is saved: opening the panel
again shows it with its date, without a new review. **Review
again** writes a new one, e.g. after new commits.

Suggestions are only suggestions: read them before posting.
Claude only sees the diff, so it can miss context, and it is told
to treat the pull request's text as data, not instructions.

### Setting up reviews

Reviews call the Claude API, which is billed per use. In `.env`:

```bash
# Key from https://platform.claude.com
ANTHROPIC_API_KEY=sk-ant-...
# Optional: the model, claude-sonnet-5-5 when blank.
GIT_REVIEW_MODEL=
```

Then restart the backend (`./scripts/compose.sh up -d --build`,
or your usual command). Without a key the rest of the tab works
and the review panel says the key is missing.

Cost: a review sends the whole diff. On Claude Sonnet 5.5 a diff of
a few hundred lines costs a few cents. Diffs over 600,000
characters (about 150,000 tokens) are not reviewed: the panel says
so instead of reviewing part of it.

## Security

- Tokens are stored encrypted with a key derived from the backend's
  `SECRET_KEY` (the same way as the Tasks tab's, see
  [Tasks tab → How tokens are kept](tasks.md#how-tokens-are-kept)),
  are never sent back to the browser and never written to the logs.
- Tokens only go to `api.github.com` and `api.bitbucket.org`.
- Changing a Bitbucket connection's email or workspaces requires
  entering the token again, so a saved token cannot be pointed at
  another account.
- Connections, cached items and saved reviews belong to your login;
  nobody else sees or uses them. Removing a connection removes its
  cached items and saved reviews (nothing changes on GitHub or
  Bitbucket).
- The dashboard writes to GitHub or Bitbucket only when you click
  **Post** on a comment.
- The review's text is shown as plain text, and links only when
  they are `http(s)` links.

## For developers

The API lives in `backend/app/git.py`, mounted under `/git`. Every
endpoint requires UI login.

| Method and path | What it does |
| --- | --- |
| `GET /git` | `{prs, commits}` of every connection, from the cache |
| `POST /git/refresh` | Read the connections again (`connection_id` or all), then list |
| `GET /git/connections` | The user's connections (never the token) |
| `POST /git/connections` | Add one (`provider`, `name`, `config`, `secret`); the token is checked first |
| `PATCH /git/connections/{id}` | Rename, or change settings and token |
| `DELETE /git/connections/{id}` | Remove one, its cache and its saved reviews |
| `GET /git/prs/{pr_id}/review` | The saved review, or 404 |
| `POST /git/prs/{pr_id}/review` | Write a new review with Claude and save it; posts nothing |
| `POST /git/prs/{pr_id}/comments` | Post `{body, path?, line?}`; answers `{url, inline}` |

A pull request's ID is `<provider>:<connection id>:<repo>:<number>`,
e.g. `github:3:octo/app:42`; the UI URL-encodes it. A commit's is
`<provider>:<connection id>:<sha>`. Open pages get the Socket.IO
event `git_updated` (in the user's room) when a background read
changed something.

- `backend/app/providers/github.py` and `bitbucket.py`: the host
  clients, with the same functions (`normalize_config`, `check`,
  `fetch`, `pr_context`, `post_comment`); shared shapes
  (`PullRequest`, `Commit`, `PRContext`, `PostedComment`) are in
  `providers/__init__.py`.
- `backend/app/git_review.py`: the Claude call. It uses the
  official `anthropic` SDK, structured output (a JSON schema), and
  the server-side refusal fallback (`fallbacks: "default"`). The
  diff is sent with new-file line numbers added, so comments can
  point at exact lines.
- `backend/app/connections.py`: what the Tasks and Git tabs'
  connections share — polling, refresh, ownership checks, token
  verification.
- Tables: `git_connections`, `git_cache`, `git_reviews`.
- Frontend: `frontend/src/gitApi.ts`, `components/git/`, the tab ID
  `git` in `Workspace.tsx`.
- Tests: `backend/tests/test_git*.py` answer GitHub's and
  Bitbucket's requests with fakes (fixture `tracker`) and replace
  the Claude client; `frontend/src/components/git/__tests__/`.
