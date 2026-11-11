"""Find the official video for every anime opening and ending nominee, on YouTube.

For each awards edition (<year>/index.html), reads its nominees from NOMINEES_CSV (the published Google Sheet,
or data/nominees.csv once archived). In every category whose name says Opening or Ending, it searches YouTube
for each song, preferring the official creditless opening/ending, then the official music video. Only official
channels count (studios, publishers, labels, the artist or the anime), and only videos that may play on other
websites and aren't blocked in the Philippines (REGION). Up to three are kept per song; the page falls back to
the next one if a video won't play for a visitor. The picks go into <year>/data/videos.json:

    {"<category>|<nominee>": {"id": "<YouTube video id>", "alts": [<backup ids>], "title": ..., "channel": ...,
                              "region": "PH", "checked": "YYYY-MM-DD", "v": 2}}

The awards page and the ballot read that file and play the video in theater mode when a nominee is clicked.

- A nominee whose `link` in the Sheet is already a YouTube link is skipped: that hand-picked link wins.
- Songs already in the file are never searched again (so a wrong pick can be fixed by editing the file,
  or by pasting the right YouTube link into the nominee's link in the Sheet).
- Songs with no good match are retried after a week.

Needs a YouTube Data API key in the YOUTUBE_API_KEY environment variable (a GitHub Actions secret); without
one it searches nothing. Each search costs 100 of the free 10,000 daily quota units. Stdlib only.

Each song also gets a `thumb`: the YouTube still of its official video (or, when no video plays in the region,
of the best official upload), used as the card picture when the nominee has no anime poster.
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
VIDEOS_API = 'https://www.googleapis.com/youtube/v3/videos'
REGION = 'PH'   # the country most voters watch from; override with the VIDEO_REGION environment variable
KEEP = 3        # videos saved per song: the first plays, the others are backups if it won't play for a visitor
VERSION = 2     # bump when the rules change, so earlier picks are searched again once
RETRY_DAYS = 7
MAX_SEARCHES = 70   # per run: about 7,000 quota units at most, under the free daily 10,000

KIND = re.compile(r'\b(opening|ending)s?\b', re.I)
CREDITLESS = re.compile(r'creditless|non[- ]?credit|textless|non[- ]?telop|ノンクレジット|ノンテロップ|\bnc ?(op|ed)\b', re.I)
OFFICIAL = re.compile(r'official|公式|\bmv\b|music video|ミュージックビデオ', re.I)
# Channels of anime studios, publishers and labels that post official openings and endings.
STUDIO = re.compile(r'animation チャンネル|toho animation|aniplex|kadokawa|crunchyroll|muse asia|ani-one|pony ?canyon|avex|'
                    r'sony music|lantis|king records|bandai namco|warner bros\. japan|東宝|アニプレックス|medialink|aniplus|'
                    r'netflix anime|tms entertainment|mappa|toei animation|ufotable|kyoto animation|cloverworks|a-1 pictures', re.I)
# Channels that name themselves official.
OFFICIAL_CHANNEL = re.compile(r'official|公式|オフィシャル', re.I)
# Fan edits, covers and re-uploads that shouldn't be picked (re-uploads tend to advertise their quality).
AVOID = re.compile(r'\bamv\b|\bcover\b|lyric|reaction|\breact\b|nightcore|slowed|sped ?up|8d audio|1 ?hour|'
                   r'piano|guitar|karaoke|instrumental|remix|tutorial|\bfan\b|mashup|#shorts|\bshorts\b|'
                   r'\b\d{2,3} ?fps\b|upscal|\b4k\b|\buhd\b|vietsub|lirik|terjemahan|sub espa|legendado|extended|\[en sub\]', re.I)


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


OPENING_WORDS = re.compile(r'opening|\bop\b|オープニング|ノンクレジットop', re.I)
ENDING_WORDS = re.compile(r'ending|\bed\b|エンディング|ノンクレジットed', re.I)


def other_kind(title, kind):
    """True if the title says it's an ending while we want an opening, or the other way round."""
    want, other = (OPENING_WORDS, ENDING_WORDS) if kind == 'opening' else (ENDING_WORDS, OPENING_WORDS)
    return bool(other.search(title) and not want.search(title))


def search(key, q, region):
    params = {'part': 'snippet', 'type': 'video', 'videoEmbeddable': 'true', 'maxResults': '10', 'q': q,
              'regionCode': region, 'key': key}
    data = json.loads(fetch_text(API + '?' + urllib.parse.urlencode(params)))
    return data.get('items', [])


def details(key, ids):
    """{video id: (embeddable, blocked countries, allowed countries or None)} for up to 50 videos (1 quota unit)."""
    if not ids:
        return {}
    params = {'part': 'contentDetails,status', 'id': ','.join(ids[:50]), 'key': key}
    data = json.loads(fetch_text(VIDEOS_API + '?' + urllib.parse.urlencode(params)))
    out = {}
    for v in data.get('items', []):
        rr = (v.get('contentDetails') or {}).get('regionRestriction') or {}
        allowed = rr.get('allowed')
        out[v['id']] = (bool((v.get('status') or {}).get('embeddable', True)), set(rr.get('blocked') or []),
                        set(allowed) if allowed is not None else None)
    return out


def playable(info, region):
    """True if a video may be embedded and isn't blocked in the region."""
    if not info:
        return False
    embeddable, blocked, allowed = info
    return embeddable and region not in blocked and (allowed is None or region in allowed)


def trusted(item, artist, anime):
    """Official sources only: studio, publisher or label channels, channels that call themselves official,
    the artist's own channel, or the anime's own channel. Fan re-uploads are never used."""
    channel = html.unescape(item['snippet']['channelTitle'])
    c = norm(channel)
    if STUDIO.search(channel) or OFFICIAL_CHANNEL.search(channel):
        return True
    if len(norm(artist)) >= 3 and norm(artist) in c and not re.search(r'\btopic\b', channel, re.I):
        return True
    return bool(len(norm(anime)) >= 4 and norm(anime) in c)


def find(key, song, artist, anime, kind, region):
    """(up to KEEP official videos that play in the region, best first; the best official video id even if it
    doesn't play there, for its picture, or '')."""
    queries = [f'{song} {artist} {anime} creditless {kind}'.strip(), f'{song} {artist} official music video'.strip()]
    scored = {}
    for q in queries:
        for item in search(key, q, region):
            vid = item['id']['videoId']
            if vid in scored or not trusted(item, artist, anime):
                continue
            # Official uploads often name the song only in Japanese, so the romaji title can be missing. Then the
            # video must at least not be the other kind: an artist's opening for another anime isn't this ending.
            title = html.unescape(item['snippet']['title'])
            if norm(song) not in norm(title) and other_kind(title, kind):
                continue
            sc = score(item, song, artist, anime, kind)
            if sc >= 5:   # at least the song title and one more sign
                scored[vid] = (item, sc)
    ranked = sorted(scored.values(), key=lambda x: -x[1])
    info = details(key, [it['id']['videoId'] for it, _ in ranked])
    picks = [it for it, _ in ranked if playable(info.get(it['id']['videoId']), region)][:KEEP]
    return picks, (ranked[0][0]['id']['videoId'] if ranked else '')


def thumb_for(vid):
    """The largest still YouTube has for a video (thumbnails are never region-blocked), or ''. No quota used."""
    for name in ('maxresdefault', 'hq720', 'hqdefault'):
        url = f'https://i.ytimg.com/vi/{vid}/{name}.jpg'
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'axa-awards-video-finder'}), timeout=15) as r:
                if r.status == 200 and len(r.read()) > 2000:
                    return url
        except Exception:
            continue
    return ''


def main():
    try:  # Japanese titles must never crash the run on a console that can't show them
        sys.stdout.reconfigure(errors='replace')
    except Exception:
        pass
    key = os.environ.get('YOUTUBE_API_KEY', '').strip()
    if not key:
        print('videos: no YOUTUBE_API_KEY, so no searching (pictures for videos already found are still added)')
    region = (os.environ.get('VIDEO_REGION') or REGION).strip().upper()
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
            # Picks from an older version of this script (fan uploads allowed, no region check) are redone once.
            current = old and old.get('v') == VERSION
            if current and 'thumb' not in old and old.get('id'):
                old['thumb'] = thumb_for(old['id'])   # a picture for the card, from the video already found
            if current and (old.get('id') or ('thumb' in old and
                    (today - datetime.date.fromisoformat(old.get('checked', '2000-01-01'))).days < RETRY_DAYS)):
                continue
            if not key or searches + 2 > MAX_SEARCHES:
                continue
            parts = [p.strip() for p in re.split(r'\s*·\s*', r.get('subtitle') or '')]
            artist, anime = (parts + ['', ''])[:2]
            try:
                picks, best_any = find(key, song, artist, anime, m.group(1).lower(), region)
            except Exception as e:  # quota used up or API trouble: stop for today, keep what we have
                print(f'  YouTube search failed: {e}')
                searches = MAX_SEARCHES
                break
            searches += 2
            if picks:
                first = picks[0]
                videos[k] = {'v': VERSION, 'id': first['id']['videoId'], 'alts': [p['id']['videoId'] for p in picks[1:]],
                             'title': html.unescape(first['snippet']['title']),
                             'channel': html.unescape(first['snippet']['channelTitle']), 'region': region,
                             'thumb': thumb_for(first['id']['videoId']), 'checked': today.isoformat()}
                found += 1
                print(f'  {song}: {videos[k]["title"]} ({videos[k]["channel"]}) + {len(picks) - 1} backup(s)')
            else:
                # No video that plays here, but an official one's picture still works for the card.
                videos[k] = {'v': VERSION, 'id': None, 'region': region, 'thumb': thumb_for(best_any) if best_any else '',
                             'checked': today.isoformat()}
                missed += 1
                print(f'  {song}: no official video that plays in {region}')
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
