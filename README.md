# Anime X Angas Awards

Website, ballot and admin tools for the Anime X Angas community awards. Live at https://benburnsred.github.io/awards/

**First time setting up the Google Sheet? Follow [SETUP.md](SETUP.md) step by step.**

| Page | URL | What it is |
|---|---|---|
| Awards 2025 | https://benburnsred.github.io/awards/2025/ | Permanent page for the 2025 edition: categories, nominees, winners |
| Awards 2026 | https://benburnsred.github.io/awards/2026/ | Current edition: voting open, winners hidden until the ceremony |
| Latest awards | https://benburnsred.github.io/awards/ | Forwards to the newest edition (currently 2026) |
| Ballot | https://benburnsred.github.io/awards/vote/ | Tier-list voting, saved to a private Google Sheet |
| Admin dashboard | https://benburnsred.github.io/awards/admin/ | Short link to the admin dashboard (Google sign-in, admins only) |

# Awards site (`<year>/index.html`)

Each edition lives in its own folder (`2025/`) with its own copy of the page and data, so it stays exactly as it is when the next year's page is built or redesigned. Shared images such as the trophy live in `img/`.

Everything on a year's page comes from two tables in its folder, so you never edit code to change it:
- `data/nominees.csv`: categories and nominees
- `data/settings.csv`: event details

Either edit those files or point the page at a Google Sheet you manage.

## Cover art

Every deploy runs `tools/fetch_covers.py`: for each nominee with an `image_search` title and no `image`, it finds the poster on AniList (then Jikan / MyAnimeList), saves it to `img/covers/`, fills in `image`, and commits the result. Pages load covers from the site itself, so they keep working even when those services are down, and archived years stay complete. The step's summary on the Actions tab lists any titles it couldn't find; give those a different `image_search` (or alternatives separated by ` | `) or paste an image link into `image`.

## Nominees table

One row per nominee. Rows with the same `category` are grouped, in sheet order. A row with only a category name (no nominee) shows that category as "Nominees coming soon".

| Column | Required | Example | Notes |
|---|---|---|---|
| `category` | yes | Best Anime Opening | |
| `category_description` | no | The opening that never got skipped. | Only needed on one row per category |
| `category_color` | no | #8aa8ff | Accent colour for that award section. Blank = automatic palette |
| `nominee` | yes* | lulu. | Leave blank for a category with no nominees yet |
| `subtitle` | no | Mrs. GREEN APPLE · Frieren Season 2 | Artist, studio, show… |
| `image` | no | https://…/poster.jpg | Direct image link. Tall (3:4) images look best |
| `image_search` | no | Sousou no Frieren 2nd Season | Anime title to fetch cover art for when `image` is blank. List alternatives with ` \| ` if one name doesn't match. Use `image` to pick an exact picture |
| `link` | no | https://youtube.com/… | Makes the card clickable |
| `winner` | no | TRUE | `TRUE`, `yes` or `x` marks the winner. Shown only when `reveal_winners` is on |
| `result` | no | 412 pts · 31% | Free text under the nominee. Shown only when `show_results` is on |

## Settings table

Two columns, `key` and `value`:

| key | Example | Effect |
|---|---|---|
| `title` | Anime X Angas Awards 2026 | Big heading and browser tab |
| `tagline` | Celebrating the year's best anime | Line under the title |
| `date` | 2026-12-20T19:00:00+08:00 | Date line and countdown. Blank = "Date to be announced". Include the time zone offset |
| `venue` | Online · YouTube | Shown next to the date |
| `stream_url` | https://youtube.com/live/… | Shows a **Watch live** button |
| `vote_url` | ../vote/ | Where **Vote now** goes |
| `vote_open` | TRUE | Show or hide the **Vote now** buttons |
| `reveal_winners` | FALSE | Turn on at the ceremony. Winners get a gold highlight and move to the front |
| `show_results` | FALSE | Show the `result` text (points, percentages) |
| `trophy_image` | https://…/trophy.png | Trophy picture beside the title on laptops and tablets. Blank = no trophy. A transparent PNG looks best |

For a live ceremony, set `reveal_winners` to TRUE and fill in each `winner` cell as you announce it. As soon as one winner is revealed, a **The Winners** summary appears under the title, with one card per award linking to its full category, and the hero button changes to **See the winners**.

**After the awards:** keep `reveal_winners` TRUE, set `vote_open` to FALSE to hide the vote buttons, and optionally set `show_results` to TRUE with points or percentages in the `result` column. If the page was reading a Google Sheet, export both tabs as CSV into the year's `data/` folder and point `NOMINEES_CSV` / `SETTINGS_CSV` back at them, so the archive no longer depends on the Sheet.

## Starting next year's edition

1. Copy the latest year's folder (e.g. `2026/`) to the new year (`2027/`).
2. Replace the new folder's `data/nominees.csv` with the new categories (or point it at a new Google Sheet) and update `settings.csv`: new `title`, `date`, `reveal_winners` FALSE, `vote_open` TRUE.
3. In `index.html`, change every year link to the new year so `/awards/` forwards to the new edition.
4. Optionally add a link to the previous year in the new page's footer (2026 links to `../2025/`).

Earlier years keep working unchanged.

## Managing it from Google Sheets

1. Create a **new** Google Sheet just for the awards content. Don't use the one that stores votes.
2. Make two tabs, `Nominees` and `Settings`. Import [`2025/data/nominees.csv`](2025/data/nominees.csv) and [`2025/data/settings.csv`](2025/data/settings.csv) as starting templates (**File → Import → Upload → Replace current sheet**).
3. Go to **File → Share → Publish to web**, choose the `Nominees` tab and **Comma-separated values (.csv)**, then click **Publish** and copy the link. Do the same for `Settings`.
4. Paste the two links into `NOMINEES_CSV` and `SETTINGS_CSV` at the top of that year's `<year>/index.html` (or send them to me).

Only the two published tabs become public, and only you can edit them. Anything you type there is what visitors see.

# Ballot (`vote/index.html`)

## How voting works

- **Name first:** voters enter their name before they see the ballot. It's used for every category, and the page checks with the Sheet straight away whether that name has already voted (ignoring capitals and extra spaces).
- **One submission:** voters fill in every category (or skip some), see a summary, and submit everything at once. After that the ballot is locked: votes can't be changed or added to, from any device. To redo someone's ballot, delete that name's rows in the `Votes` tab; the name is then free again.
- Tap a card then tap a tier, or drag it on desktop. Tap ▶ to hear the song on YouTube.
- Nominees left in the pool score 0, so voters only rank what they know.
- Tier caps force real choices. You set them in `TIERS` in `vote/index.html`:

| Tier | Points | Max per ballot |
|---|---|---|
| S | 5 | 1 |
| A | 4 | 2 |
| B | 3 | 3 |
| C | 2 | — |
| D | 1 | — |

- **Ranking:** nominees are ordered by total points. Ties go to whoever has more S placements, then more A, and so on.
- **After voting:** each voter gets a shareable picture of their picks for each category.

## Modes

- **Demo** (default, `APPS_SCRIPT_URL = ''`): ballots are stored in the browser. The Results tab has an **Add 25 demo ballots** button to preview the leaderboard.
- **Connected:** ballots go to your private Google Sheet through Apps Script. Voters see only the ballot: the Results tab, demo badge and "Prototype" label are hidden.

## Connecting Google Sheets

1. Create a new Google Sheet in your account. Don't share it with anyone.
2. Open **Extensions → Apps Script**, replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs), and save.
3. In the function dropdown pick `setup`, click **Run**, and approve the permission prompt. Google warns that the app isn't verified because it's your own script: click **Advanced → Go to (project name)**. This creates the `Votes`, `Results` and `Codes` tabs.
4. Click **Deploy → New deployment**, choose **Web app**, and set:
   - **Execute as:** Me
   - **Who has access:** Anyone (not "Anyone with Google account", which would make voters sign in)
5. Click **Deploy** and copy the **Web app URL** (ends in `/exec`).
6. Paste it into `APPS_SCRIPT_URL` near the top of `vote/index.html` and push to `main`.

After changing `Code.gs` later, use **Deploy → Manage deployments → Edit → Version: New version** so the URL stays the same.

## What's public and what stays private

| | Who can see it |
|---|---|
| The page and its code, including the `/exec` URL | Anyone. The URL isn't a password: it can only submit ballots. |
| The Google Sheet, voter names, every ballot | Only you, as long as you don't share the Sheet. |
| Your Google account and email | Nobody. The web app's responses contain only `ok` and an error message. |
| Point totals | Nobody, until you set `SHOW_RESULTS = true` in `Code.gs` and `SHOW_RESULTS_TAB = true` in `vote/index.html`. |

The script checks every ballot, so a tampered page can't change the scoring or inject data:
- It accepts only known categories, nominees and tiers, and enforces tier caps.
- It calculates points itself.
- Names starting with `=`, `+`, `-` or `@` are stored as plain text, never as formulas.
- It allows one ballot per name for the whole event (and one per code if you use codes), and checks again at submission, so two people can't take the same name at once.

## Your Sheet

`Results` shows a live leaderboard (points and voter count per nominee). `Votes` has one row per voter per nominee:

| Timestamp | Voter | Code | Category | Nominee | Tier | Points |
|---|---|---|---|---|---|---|

`Codes` is optional. By default the page asks for a name only (`USE_VOTER_CODES = false` in `vote/index.html`). To use codes, set `USE_VOTER_CODES = true` and put one code per row in column A, leaving the other columns blank. Each code can then vote once.

## Categories and nominees

The ballot has no list of its own. It reads the current edition's nominees table (`NOMINEES_CSV`, now `../2026/data/nominees.csv`), so adding nominees on the awards side opens that category for voting:
- Every category appears as a tab. Ones without nominees show "Nominees coming soon".
- A nominee's `link` adds a ▶ button on its card (the 2026 openings link to a YouTube search).
- Category and nominee ids are made from their names, so renaming one after people have voted starts a fresh tally for it.

The Sheets script checks ballots against the same file (`NOMINEES_URL` in `Code.gs`, re-read every 10 minutes), so there's nothing to keep in sync. When you move to a new edition, point both at the new year's file.

The Results tab is hidden (`SHOW_RESULTS_TAB = false`) until it's decided how results are shown at the ceremony.

## Sample nominees

These are popular 2026 anime songs from the Billboard JAPAN Hot Animation mid-year chart and the Anime Corner and Anime!Anime! seasonal fan polls. Treat them as placeholder data. "IRIS OUT" is a movie theme rather than a TV opening.

# Admin dashboard (2026 onwards)

The committee agrees the categories and nominees in its own shared spreadsheet, and sends thumbnails to an admin. An admin then enters them here. The dashboard is served by the Apps Script (`apps-script/Code.gs` + `apps-script/Admin.html`). Who is an admin is set by the `role` column of the `Committee` tab. Admins can:

- **Create categories:** name, description, and type:
  - **Public vote:** appears on the ballot.
  - **Special award / mention:** no voting. The committee ticks the winner.
- **Choose a voting method per category:** tier list (S=5 … D=1), pick one, pick up to N, or rank top N (1st place scores most).
- **Set one voting window for the whole event:** Settings → Voting starts / Voting ends. The ballot opens and closes by itself; Voting open = No closes it at once.
- **Automatic posters:** a nominee saved with an anime title and no picture gets its poster from AniList (then MyAnimeList) straight away. **Find posters** fills in any that are missing. Pictures that live elsewhere are downloaded into the site when the edition is archived.
- **Add, edit and delete nominees:** with picture, subtitle, anime title for an automatic poster, and a watch/listen link. Categories and nominees that already have votes can't be deleted.
- **Reorder categories.**
- **See live results (admins only):** points, voters and first-place picks. Ties are flagged, and the committee ticks the winner(s).
- **Edit event settings:** title, date, voting open, reveal winners, social links.
- **Publish to site:** copies categories, nominees and winners to the `Site` tab, which the public awards page and ballot read.
- **Activity log:** who changed what.

## Setup (once per edition)

1. Create a new Google Sheet for the edition. Open **Extensions → Apps Script**, then:
   - paste `Code.gs`
   - add an HTML file named `Admin` with the contents of `Admin.html`
   - run `setup`
2. In the `Committee` tab, list each admin's Google email, name and role `admin`. Share the Sheet with them as **Editor**.
3. Make two deployments: **Deploy → New deployment → Web app**, once with each of these settings:
   - **Public:** Execute as *Me*, access *Anyone*. Paste this URL into `APPS_SCRIPT_URL` in `vote/index.html`.
   - **Admin:** Execute as *User accessing the web app*, access *Anyone with Google account*. Admin dashboard: this URL + `?page=admin`.
4. Publish the data to the site: **File → Share → Publish to web**, once for the `Site` tab and once for the `Settings` tab, choosing CSV each time. Put the two links in:
   - `NOMINEES_CSV` / `SETTINGS_CSV` at the top of `2026/index.html`
   - the same two variables in `vote/index.html`

After that, everything is done from the dashboard. Google's published CSV can take a few minutes to refresh after **Publish to site**.

## Locking

**Publish to site** locks every public-vote category that has nominees, so every voter sees the same ballot:
- While locked, nominees can't be added, edited or deleted, and the type and voting method can't change. The name, description and voting window can still be edited.
- **Unlock** is on the category, and every lock and unlock is in the activity log.

Only the committee decides categories and nominees; voters can only vote.

## Votes datasource

Votes can live in a separate Google Sheet, for example an existing one:
- Set **Votes spreadsheet ID** and **Votes tab name** in Settings.
- Map each field to that tab's column header in the `VotesMapping` tab:

| field | meaning | if the column is missing |
|---|---|---|
| timestamp | when the vote was cast | left blank |
| voter | voter name (one ballot per name per category) | — required |
| code | voter code | ignored |
| category | category id **or name** | — required |
| nominee | nominee id **or name** | — required |
| value | tier letter, rank number, or "pick" | — |
| points | points for this row | tier letters score their tier points, anything else 1 |

The Settings tab shows which fields are still unmapped. New ballots are written with readable names into a re-mapped sheet, and with ids into the built-in layout. Admins need view access to the votes sheet to see results. An Excel file has to be converted first (open it in Google Drive → **File → Save as Google Sheets**). For a sheet that's shaped differently, such as one row per ballot like Google Forms, send it over and an adapter can be added.

## Hosting

- **Now (testing and development):** the Google Sheet and Apps Script run on the repo owner's personal Google account.
  - Sheet: the private "AxA Awards 2026" Google Sheet in the owner's Drive (its link isn't published here; ask the owner or an admin).
  - Admin dashboard: https://benburnsred.github.io/awards/admin/
  - The short link forwards to the admin deployment. Its full URL is `ADMIN_APP` in [`admin/index.html`](admin/index.html).
  - The 2026 page and the ballot read that Sheet's published Site and Settings tabs, and send votes to its public deployment.
- **Production:** everything moves to **animexangas@gmail.com**: the Sheet, the Apps Script deployments, and this repository (Settings → Transfer; the site then lives at animexangas.github.io/awards/).

To move the Sheet:
1. Transfer ownership of the Sheet (Share → *Transfer ownership*), or make a fresh copy under animexangas.
2. Signed in as animexangas, create both web app deployments again. Deployments run as the account that made them, so the URLs change.
3. Update `APPS_SCRIPT_URL` and the published CSV links in `vote/index.html` and the edition's `index.html`, and `ADMIN_APP` in `admin/index.html` (the short link then points at the new deployment).
4. Clear test data (`Votes`, `Log`) before launch.

# Tests

`tests/` holds unit tests for the voting script (`apps-script/Code.gs`): scoring, one ballot per name, voting window, voter codes, Discord passes, the flood limit, the Data check and the admin-only rule. They run against a pretend Google Sheet, so nothing real is touched.

- **In a browser:** open https://benburnsred.github.io/awards/tests/ (or `tests/index.html` from a local server). Every test shows as passed or failed.
- **On GitHub:** they run on every change (`.github/workflows/tests.yml`); a red ✗ next to a commit means a test failed.
- **With Node:** `node tests/run.js`

Run them before pasting a new `Code.gs` into Apps Script.

# Opening and ending videos

Clicking an opening or ending nominee (the ▶ badge) plays its official video in theater mode, on the awards page and the ballot.

- **Where the videos come from:** the **Find opening and ending videos** GitHub Action (`.github/workflows/videos.yml`, script `tools/fetch_videos.py`) runs every 6 hours. It searches YouTube for each new song in any category named Opening or Ending, preferring the studio's creditless opening/ending, then the official music video. Only official channels count (studios, publishers like Muse Asia and Ani-One, labels, the artist or the anime), and only videos that may play on other websites and aren't blocked in the Philippines. Up to three are kept per song in `2026/data/videos.json`; if one won't play for a visitor, the player tries the next, then offers YouTube.
- **Needs:** a YouTube Data API v3 key saved as the repository secret `YOUTUBE_API_KEY`. Without it the Action does nothing.
- **Wrong video?** Paste the right YouTube link into that nominee's link in the admin dashboard (it always wins), or edit `videos.json`.
- **Run it now:** Actions → Find opening and ending videos → Run workflow.
