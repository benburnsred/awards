"""Find the official video for every anime opening and ending nominee, on YouTube.

For each awards edition (<year>/index.html), reads its nominees from NOMINEES_CSV (the published Google Sheet,
or data/nominees.csv once archived). In every category whose name says Opening or Ending, it searches YouTube
for each song, preferring the official creditless opening/ending, then the official music video, and only
videos that are allowed to play on other websites. The picks go into <year>/data/videos.json:

    {"<category>|<nominee>": {"id": "<YouTube video id>", "title": ..., "channel": ..., "checked": "YYYY-MM-DD"}}

The awards page and the ballot read that file and play the video in theater mode when a nominee is clicked.

- A nominee whose `link` in the Sheet is already a YouTube link is skipped: that hand-picked link wins.
- Songs already in the file are never searched again (so a wrong pick can be fixed by editing the file,
  or by pasting the right YouTube link into the nominee's link in the Sheet).
- Songs with no good match are retried after a week.

Needs a YouTube Data API key in the YOUTUBE_API_KEY environment variable (a GitHub Actions secret); without
one it does nothing. Each search costs 100 of the free 10,000 daily quota units. Stdlib only.
"""
import csv
import datetime
import html
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # repository root
API = 'https://www.googleapis.com/youtube/v3/search'
RETRY_DAYS = 7
MAX_SEARCHES = 60   # per run: 6,000 quota units at most, well under the free daily 10,000

KIND = re.compile(r'\b(opening|ending)s?\b', re.I)
CREDITLESS = re.compile(r'creditless|non[- ]?credit|textless|non[- ]?telop|ノンクレジット|ノンテロップ|\bnc ?(op|ed)\b', re.I)
OFFICIAL = re.compile(r'official|公式|\bmv\b|music video|ミュージックビデオ', re.I)
# Channels of anime studios, publishers and labels that post official openings and endings.
STUDIO = re.compile(r'animation チャンネル|toho animation|aniplex|kadokawa|crunchyroll|muse asia|ani-one|pony ?canyon|avex|'
                    r'sony music|lantis|king records|bandai namco|warner bros\. japan|東宝|アニプレックス', re.I)
# Fan edits, covers and re-uploads that shouldn't be picked (re-uploads tend to advertise their quality).
AVOID = re.compile(r'\bamv\b|\bcover\b|lyric|reaction|\breact\b|nightcore|slowed|sped ?up|8d audio|1 ?hour|'
                   r'piano|guitar|karaoke|instrumental|remix|tutorial|\bfan\b|mashup|#shorts|\bshorts\b|'
                   r'\b\d{2,3} ?fps\b|upscal|\b4k\b|\buhd\b', re.I)


def norm(s):
    """Lower case, letters and digits only (keeps Japanese characters), for loose matching."""
    return re.sub(r'[\W_]+', '', html.unescape(str(s or '')).lower())


def fetch_text(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'axa-awards-video-finder'}), timeout=30) as r:
        return r.read().decode('utf-8')


def editions():
    """(year folder, nominees CSV text) for every edition page that names a NOMINEES_CSV and loads videos.json."""
    for name in sorted(os.listdir(ROOT)):
        page = os.path.join(ROOT, name, 'index.html')
        if not re.fullmatch(r'\d{4}', name) or not os.path.isfile(page):
            continue
        with open(page, encoding='utf-8') as f:
            html_text = f.read()
        m = re.search(r"const NOMINEES_CSV = '([^']*)';", html_text)
        if not m or 'videos.json' not in html_text:   # only pages that can play the videos
            continue
        src = m.group(1)
        try:
            if re.match(r'https?://', src):
                text = fetch_text(src + ('&' if '?' in src else '?') + 'output=csv' if 'output=csv' not in src else src)
            else:
                with open(os.path.join(ROOT, name, src), encoding='utf-8') as f:
                    text = f.read()
        except Exception as e:  # sheet unreachable: skip this edition, keep what's already in the file
            print(f'{name}: could not read nominees ({e})')
            continue
        yield name, text


def is_youtube(link):
    return bool(re.search(r'(youtube\.com|youtu\.be)/', link or ''))


def score(item, song, artist, anime, kind):
    """How likely a search result is the right official video. Higher is better."""
    title = html.unescape(item['snippet']['title'])
    channel = html.unescape(item['snippet']['channelTitle'])
    t, c = norm(title), norm(channel)
    s = 0
    if norm(song) and norm(song) in t:
        s += 4
    if norm(artist) and (norm(artist) in t or norm(artist) in c):
        s += 2
    if norm(anime) and (norm(anime) in t or norm(anime) in c):
        s += 1
    if CREDITLESS.search(title):
        s += 4
    if kind and re.search(r'\b' + kind[:2] + r'\b|' + kind, title, re.I):
        s += 1
    if OFFICIAL.search(title) or OFFICIAL.search(channel):
        s += 2
    if STUDIO.search(channel):
        s += 2
    if AVOID.search(title):
        s -= 8
    if item['snippet'].get('liveBroadcastContent', 'none') != 'none':
        s -= 8
    return s


def search(key, q):
    params = {'part': 'snippet', 'type': 'video', 'videoEmbeddable': 'true', 'maxResults': '8', 'q': q, 'key': key}
    data = json.loads(fetch_text(API + '?' + urllib.parse.urlencode(params)))
    return data.get('items', [])


def find(key, song, artist, anime, kind):
    """Best (video, score) for one song, trying creditless first and the music video second. None if no good match."""
    queries = [f'{song} {artist} {anime} creditless {kind}'.strip(), f'{song} {artist} official music video'.strip()]
    best = None
    for q in queries:
        for item in search(key, q):
            sc = score(item, song, artist, anime, kind)
            if best is None or sc > best[1]:
                best = (item, sc)
        if best and best[1] >= 8:   # song + creditless/official: good enough, save the second search
            break
    return best if best and best[1] >= 5 else None   # at least the song title and one more sign


def main():
    try:  # Japanese titles must never crash the run on a console that can't show them
        sys.stdout.reconfigure(errors='replace')
    except Exception:
        pass
    key = os.environ.get('YOUTUBE_API_KEY', '').strip()
    if not key:
        print('videos: no YOUTUBE_API_KEY, skipping')
        return 0
    today = datetime.date.today()
    searches = 0
    found = missed = 0
    for year, text in editions():
        rows = list(csv.DictReader(io.StringIO(text)))
        path = os.path.join(ROOT, year, 'data', 'videos.json')
        try:
            with open(path, encoding='utf-8') as f:
                videos = json.load(f)
        except (FileNotFoundError, ValueError):
            videos = {}
        before = json.dumps(videos, sort_keys=True)
        for r in rows:
            cat, song = (r.get('category') or '').strip(), (r.get('nominee') or '').strip()
            m = KIND.search(cat)
            if not song or not m or is_youtube(r.get('link')):
                continue
            k = cat + '|' + song
            old = videos.get(k)
            if old and (old.get('id') or (today - datetime.date.fromisoformat(old.get('checked', '2000-01-01'))).days < RETRY_DAYS):
                continue
            if searches >= MAX_SEARCHES:
                break
            parts = [p.strip() for p in re.split(r'\s*·\s*', r.get('subtitle') or '')]
            artist, anime = (parts + ['', ''])[:2]
            try:
                best = find(key, song, artist, anime, m.group(1).lower())
            except Exception as e:  # quota used up or API trouble: stop for today, keep what we have
                print(f'  YouTube search failed: {e}')
                searches = MAX_SEARCHES
                break
            searches += 2 if best is None else 1
            if best:
                item = best[0]
                videos[k] = {'id': item['id']['videoId'], 'title': html.unescape(item['snippet']['title']),
                             'channel': html.unescape(item['snippet']['channelTitle']), 'checked': today.isoformat()}
                found += 1
                print(f'  {song}: {videos[k]["title"]} ({videos[k]["channel"]})')
            else:
                videos[k] = {'id': None, 'checked': today.isoformat()}
                missed += 1
                print(f'  {song}: no good match')
        if json.dumps(videos, sort_keys=True) != before:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='utf-8', newline='\n') as f:
                json.dump(videos, f, ensure_ascii=False, indent=1, sort_keys=True)
                f.write('\n')
            print(f'updated {os.path.relpath(path, ROOT)}')
    print(f'videos: {found} found, {missed} without a good match')
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write(f'### Opening and ending videos\n{found} found, {missed} without a good match\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
