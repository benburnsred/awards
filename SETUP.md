# Setting up the awards backend (about 15 minutes)

Do this once, on a computer, signed in to the Google account that will host it (your own for testing).

---

## Part 1 — Make the Sheet

1. Go to **sheets.new**. A blank Google Sheet opens.
2. Click **Untitled spreadsheet** (top left) and name it **AxA Awards 2026**.

## Part 2 — Paste the code

3. In the Sheet's menu, click **Extensions → Apps Script**. A new tab opens with a file called `Code.gs`.
4. Open this link in another tab: https://raw.githubusercontent.com/benburnsred/awards/main/apps-script/Code.gs
5. Press **Ctrl + A**, then **Ctrl + C** (copies everything).
6. Go back to the Apps Script tab. Click inside the code box, press **Ctrl + A**, then **Ctrl + V** (replaces it).
7. On the left, next to **Files**, click **+** → **HTML**. Type **Admin** (exactly, no `.html`) and press Enter.
8. Open https://raw.githubusercontent.com/benburnsred/awards/main/apps-script/Admin.html, press **Ctrl + A**, **Ctrl + C**.
9. Back in Apps Script, click inside the new `Admin` file, press **Ctrl + A**, **Ctrl + V**.
10. Press **Ctrl + S** to save.

## Part 3 — Run setup once

11. Click the `Code.gs` file on the left.
12. At the top, there's a dropdown next to **Debug**. Pick **setup**.
13. Click **▶ Run**.
14. A box says *Authorization required*. Click **Review permissions** → pick your account.
15. If you see *Google hasn't verified this app*: click **Advanced** → **Go to Untitled project (unsafe)**. (It's your own script, so this is fine.)
16. Click **Allow**.
17. Wait until the bottom says **Execution completed**.

Go back to the Sheet tab. You'll now see new tabs at the bottom (Settings, Categories, Nominees, Committee…).

## Part 4 — Add the admins

18. Click the **Committee** tab. Your email is already there as `admin`.
19. Under it, add one row per admin: **email** | **name** | **admin**.
20. Click **Share** (top right). Add the same emails as **Editor**. Click **Send**.

## Part 5 — Turn on the admin dashboard

21. Back in the Apps Script tab, click **Deploy** (top right) → **New deployment**.
22. Click the **⚙ gear** next to *Select type* → **Web app**.
23. Fill in:
    - Description: **admin**
    - Execute as: **User accessing the web app**
    - Who has access: **Anyone with Google account**
24. Click **Deploy** (approve permissions again if asked).
25. Copy the **Web app URL** (ends in `/exec`). Paste it somewhere safe.

The admin dashboard is that URL plus `?page=admin`. Open it now to check it works.

## Part 6 — Turn on public voting

26. Click **Deploy** → **New deployment** again → ⚙ → **Web app**.
27. Fill in:
    - Description: **public**
    - Execute as: **Me**
    - Who has access: **Anyone**
28. Click **Deploy** and copy this second **Web app URL**.

## Part 7 — Let the website read the Sheet

29. Go to the Sheet tab. Click **File → Share → Publish to web**.
30. In the first dropdown pick **Site**, in the second pick **Comma-separated values (.csv)**. Click **Publish** → **OK**. Copy the link.
31. Change the first dropdown to **Settings** (keep .csv). Click **Publish** → **OK**. Copy that link too.

## Part 8 — Send the links

32. Send these 4 things to Claude (or whoever maintains the site):
    - the **admin** URL (Part 5)
    - the **public** URL (Part 6)
    - the **Site** CSV link (Part 7)
    - the **Settings** CSV link (Part 7)

They get wired into the website, and you're done.

---

## Every day after that

- **Committee:** agrees categories and nominees in its shared spreadsheet and sends thumbnails to an admin.
- **Admin:** open https://benburnsred.github.io/awards/admin/:
  - **Categories:** enter the agreed categories and nominees.
  - **Publish to site:** puts it on the website.
  - **Results:** see votes, tick winners, publish again.

## If something goes wrong

| You see | Do this |
|---|---|
| "Not on the admin list" | Add that email to the Committee tab, and make sure they're signed in to that Google account |
| "Admins only" | Change their role to `admin` in the Committee tab |
| "You need permission" | Share the Sheet with them as Editor |
| Changed the code later | **Deploy → Manage deployments** → ✏️ → Version: **New version** → **Deploy** (keeps the same links). Do it for both deployments |
| Website not updating | Wait 5 minutes after **Publish to site**; Google refreshes the published sheet slowly |

---

## After the ceremony — make the page permanent (Archive)

1. Admin dashboard → **Results**: tick each winner. **Categories**: tick winners of special awards.
2. **Settings** → Voting open: **No**, Reveal winners: **Yes** → **Save settings** → **Publish to site**.
3. Wait 5 minutes.
4. Open https://github.com/benburnsred/awards/actions/workflows/pages.yml
5. Click **Run workflow** (right side) → type the year (e.g. `2026`) in the box → click the green **Run workflow**.
6. Wait about 5 minutes. The year's page now runs from files saved in the site, like 2025. It no longer needs the Sheet.

## Updating the dashboard code

When the code changes, paste the new files and push a new version:

1. Apps Script → paste the new `Code.gs` and/or `Admin` (same links as Part 2) → **Ctrl + S**.
2. **Deploy → Manage deployments** → click **admin** (older setups call it **committee**) → ✏️ → Version: **New version** → **Deploy**.
3. Repeat step 2 for **public**.
