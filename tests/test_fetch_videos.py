"""Unit tests for tools/fetch_videos.py, with pretend YouTube results (no key, no internet).

Run:  python -m unittest discover -s tests -p "test_*.py"
"""
import datetime
import importlib.util
import json
import os
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('fetch_videos', os.path.join(HERE, '..', 'tools', 'fetch_videos.py'))
fv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fv)


def item(vid, title, channel, live='none'):
    return {'id': {'videoId': vid}, 'snippet': {'title': title, 'channelTitle': channel, 'liveBroadcastContent': live}}


CSV = '''category,nominee,subtitle,link
Anime Opening of the Year 2026,lulu.,Mrs. GREEN APPLE · Frieren Season 2,
Anime Opening of the Year 2026,AIZO,King Gnu · Jujutsu Kaisen Season 3,https://youtu.be/handpicked1
Anime Ending of the Year 2026,Hanakage,Superfly,
Anime Ending of the Year 2026,Nothing Here,Nobody,
Anime of the Year 2026,Frieren,,
'''

RESULTS = {
    'lulu.': [item('fanAMV00001', 'Frieren AMV - lulu. (Mrs. GREEN APPLE)', 'SomeFan'),
              item('credless001', '『葬送のフリーレン』第2期 ノンクレジットOP｜Mrs. GREEN APPLE「lulu.」', 'TOHO animation チャンネル'),
              item('museasia001', 'Frieren Season 2 Opening | lulu. by Mrs. GREEN APPLE', 'Muse Asia'),
              item('lyrics00001', 'lulu. lyrics', 'LyricsHub')],
    'Hanakage': [item('cover000001', 'Hanakage (cover)', 'Singer'),
                 item('official001', 'Superfly 『Hanakage』Music Video', 'Superfly Official YouTube Channel')],
    'Nothing Here': [item('random00001', 'Totally unrelated video', 'Someone')],
}

# Every video plays everywhere unless listed here: (embeddable, blocked, allowed or None).
RULES = {}


def fake_search(key, q, region='PH'):
    for song, items in RESULTS.items():
        if q.startswith(song):
            return items
    return []


def fake_details(key, ids):
    return {i: RULES.get(i, (True, set(), None)) for i in ids}


def fake_thumb(vid):
    return f'https://i.ytimg.com/vi/{vid}/maxresdefault.jpg'


def patched():
    return mock.patch.multiple(fv, search=fake_search, details=fake_details, thumb_for=fake_thumb)


class Scoring(unittest.TestCase):
    def setUp(self):
        RULES.clear()

    def test_creditless_beats_fan_amv_and_lyrics(self):
        with patched():
            picks = fv.find('k', 'lulu.', 'Mrs. GREEN APPLE', 'Frieren Season 2', 'opening', 'PH')[0]
        self.assertEqual(picks[0]['id']['videoId'], 'credless001')

    def test_official_music_video_beats_cover(self):
        with patched():
            picks = fv.find('k', 'Hanakage', 'Superfly', '', 'ending', 'PH')[0]
        self.assertEqual([p['id']['videoId'] for p in picks], ['official001'])

    def test_no_good_match_gives_nothing(self):
        with patched():
            self.assertEqual(fv.find('k', 'Nothing Here', 'Nobody', '', 'ending', 'PH')[0], [])

    def test_fan_edits_and_live_streams_score_low(self):
        good = fv.score(item('a', 'Song - Artist (Official Music Video)', 'Artist'), 'Song', 'Artist', '', 'opening')
        for bad in ['Song AMV', 'Song cover', 'Song nightcore', 'Song 1 hour loop', 'Song #shorts', 'Song piano',
                    'Song Vietsub', 'Song lirik terjemahan', 'Song Sub Español', 'Song [Extended Version]']:
            self.assertLess(fv.score(item('b', bad, 'X'), 'Song', 'Artist', '', 'opening'), good, bad)
        self.assertLess(fv.score(item('c', 'Song official', 'Artist', live='live'), 'Song', 'Artist', '', 'opening'), good)

    def test_real_search_results_pick_the_studio_upload(self):
        # Titles and channels as YouTube listed them for these two songs (November 2026).
        frieren = [item('C0BG3B7aksU', '"Frieren : Beyond Jouney\'s End" Season 2 Opening Video Non Telop ver. / ♪ "lulu." Mrs. GREEN APPLE', 'TOHO animation チャンネル'),
                   item('37iU_fjnjus', 'FRIEREN: Beyond Journey\'s End Season 2 OP / Opening "lulu." by Mrs. GREEN APPLE [4K 60FPS]', 'Anicrad'),
                   item('weGCg61AWhM', 'Frieren: Beyond Journey\'s End Season 2 - Opening FULL "lulu." by Mrs. GREEN APPLE (Lyrics)', 'Jamong'),
                   item('-kpHrSd2wOc', 'Mrs. GREEN APPLE "lulu." × "Frieren: Beyond Journey\'s End" Season 2 Special Music Video', 'TOHO animation チャンネル')]
        jjk = [item('4RWUhqbVpVc', 'Jujutsu Kaisen Season 3 OP / Opening "AIZO" by King Gnu [4K 60FPS]', 'Anicrad'),
               item('Xr032EhUDPw', 'TVアニメ『呪術廻戦』第3期「死滅回游 前編」ノンクレジットOPムービー／OPテーマ：King Gnu「AIZO」', 'TOHO animation チャンネル and King Gnu official YouTube channel'),
               item('tWn_GlPZd-I', '「Creditless」Jujutsu Kaisen Season 3 OP / Opening 1「UHD 60FPS」', 'TriaxFx'),
               item('zz2a9Q2Wru0', 'King Gnu - AIZO', 'King Gnu official YouTube channel')]
        with mock.patch.multiple(fv, search=lambda k, q, r: frieren, details=fake_details):
            ids = [p['id']['videoId'] for p in fv.find('k', 'lulu.', 'Mrs. GREEN APPLE', 'Frieren Season 2', 'opening', 'PH')[0]]
        self.assertEqual(ids[0], 'C0BG3B7aksU')
        self.assertNotIn('37iU_fjnjus', ids, 'fan re-upload')
        self.assertNotIn('weGCg61AWhM', ids, 'lyrics re-upload')
        with mock.patch.multiple(fv, search=lambda k, q, r: jjk, details=fake_details):
            ids = [p['id']['videoId'] for p in fv.find('k', 'AIZO', 'King Gnu', 'Jujutsu Kaisen Season 3', 'opening', 'PH')[0]]
        self.assertEqual(ids, ['Xr032EhUDPw', 'zz2a9Q2Wru0'])

    def test_matching_ignores_case_and_punctuation(self):
        self.assertEqual(fv.norm('Mrs. GREEN APPLE'), fv.norm('mrs green apple'))
        self.assertIn(fv.norm('lulu.'), fv.norm('「lulu.」'))


class OfficialOnly(unittest.TestCase):
    def test_trusted_channels(self):
        ok = ['TOHO animation チャンネル', 'Crunchyroll', 'Muse Asia', 'Ani-One Asia', 'Aniplex', 'TVアニメ【推しの子】公式チャンネル',
              'Superfly Official YouTube Channel', 'Mrs. GREEN APPLE', 'Frieren Season 2 Anime']
        for ch in ok:
            self.assertTrue(fv.trusted(item('x', 't', ch), 'Mrs. GREEN APPLE', 'Frieren Season 2'), ch)
        for ch in ['Zuax anime and music', 'OPEDAnimeHub', 'Lirik Jp', '7umi', 'AQUA_BLUEEE', 'Anicrad', 'Mrs. GREEN APPLE - Topic']:
            self.assertFalse(fv.trusted(item('x', 't', ch), 'Mrs. GREEN APPLE', 'Frieren Season 2'), ch)

    def test_a_good_fan_upload_is_never_picked(self):
        fan = [item('fan00000001', 'Song Opening | "Song" by Artist (Creditless)', 'Zuax anime and music')]
        with mock.patch.multiple(fv, search=lambda k, q, r: fan, details=fake_details):
            self.assertEqual(fv.find('k', 'Song', 'Artist', 'Show', 'opening', 'PH')[0], [])


class Region(unittest.TestCase):
    def setUp(self):
        RULES.clear()

    def test_playable(self):
        self.assertTrue(fv.playable((True, set(), None), 'PH'))
        self.assertFalse(fv.playable((True, {'PH'}, None), 'PH'))
        self.assertFalse(fv.playable((True, set(), {'US', 'CA'}), 'PH'))
        self.assertTrue(fv.playable((True, set(), {'PH', 'SG'}), 'PH'))
        self.assertFalse(fv.playable((False, set(), None), 'PH'))
        self.assertFalse(fv.playable(None, 'PH'), 'a video YouTube no longer returns')

    def test_a_video_blocked_in_the_philippines_is_skipped_for_the_next_official_one(self):
        RULES['credless001'] = (True, {'PH'}, None)
        with patched():
            picks = fv.find('k', 'lulu.', 'Mrs. GREEN APPLE', 'Frieren Season 2', 'opening', 'PH')[0]
        self.assertEqual([p['id']['videoId'] for p in picks], ['museasia001'])

    def test_allowed_list_without_the_philippines_is_skipped(self):
        RULES['credless001'] = (True, set(), {'JP'})
        RULES['museasia001'] = (True, set(), {'PH', 'SG', 'MY'})
        with patched():
            picks = fv.find('k', 'lulu.', 'Mrs. GREEN APPLE', 'Frieren Season 2', 'opening', 'PH')[0]
        self.assertEqual([p['id']['videoId'] for p in picks], ['museasia001'])

    def test_keeps_up_to_three_official_videos(self):
        many = [item(f'off{i:08d}', f'Song Opening creditless {i}', 'Crunchyroll') for i in range(6)]
        with mock.patch.multiple(fv, search=lambda k, q, r: many, details=fake_details):
            self.assertEqual(len(fv.find('k', 'Song', 'Artist', '', 'opening', 'PH')[0]), fv.KEEP)


class Run(unittest.TestCase):
    def setUp(self):
        RULES.clear()

    def run_main(self, existing=None, key='k'):
        tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(tmp, '2026', 'data'))
        if existing is not None:
            with open(os.path.join(tmp, '2026', 'data', 'videos.json'), 'w', encoding='utf-8') as f:
                json.dump(existing, f)
        calls = []
        def counted(k, q, r):
            calls.append(q)
            return fake_search(k, q, r)
        with mock.patch.object(fv, 'ROOT', tmp), mock.patch.object(fv, 'editions', lambda: iter([('2026', CSV)])), \
                mock.patch.multiple(fv, search=counted, details=fake_details, thumb_for=fake_thumb), mock.patch.dict(os.environ, {'YOUTUBE_API_KEY': key}):
            fv.main()
        path = os.path.join(tmp, '2026', 'data', 'videos.json')
        out = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else None
        return out, calls

    def test_only_openings_and_endings_without_a_youtube_link(self):
        out, _ = self.run_main()
        self.assertEqual(sorted(out), ['Anime Ending of the Year 2026|Hanakage', 'Anime Ending of the Year 2026|Nothing Here',
                                       'Anime Opening of the Year 2026|lulu.'])
        lulu = out['Anime Opening of the Year 2026|lulu.']
        self.assertEqual((lulu['id'], lulu['alts'], lulu['region'], lulu['v']), ('credless001', ['museasia001'], 'PH', fv.VERSION))
        self.assertIsNone(out['Anime Ending of the Year 2026|Nothing Here']['id'])

    def test_found_songs_are_not_searched_again(self):
        first, _ = self.run_main()
        found = {k: v for k, v in first.items() if v['id']}
        _, calls = self.run_main(existing=found)
        self.assertTrue(all(q.startswith('Nothing Here') for q in calls), calls)

    def test_picks_from_the_older_rules_are_redone_once(self):
        old = {'Anime Opening of the Year 2026|lulu.': {'id': 'fanAMV00001', 'channel': 'SomeFan', 'checked': '2026-11-11'}}
        out, calls = self.run_main(existing=old)
        self.assertTrue(any(q.startswith('lulu.') for q in calls))
        self.assertEqual(out['Anime Opening of the Year 2026|lulu.']['id'], 'credless001')

    def test_misses_are_retried_only_after_a_week(self):
        today = datetime.date.today()
        k = 'Anime Ending of the Year 2026|Nothing Here'
        recent = {k: {'v': fv.VERSION, 'id': None, 'thumb': '', 'checked': today.isoformat()}}
        old = {k: {'v': fv.VERSION, 'id': None, 'thumb': '', 'checked': (today - datetime.timedelta(days=8)).isoformat()}}
        _, calls = self.run_main(existing=recent)
        self.assertFalse(any(q.startswith('Nothing Here') for q in calls))
        _, calls = self.run_main(existing=old)
        self.assertTrue(any(q.startswith('Nothing Here') for q in calls))

    def test_found_videos_get_their_picture_even_without_a_key(self):
        found = {'Anime Opening of the Year 2026|lulu.': {'v': fv.VERSION, 'id': 'credless001', 'checked': '2026-11-11'}}
        out, calls = self.run_main(existing=found, key='')
        self.assertEqual(calls, [])
        self.assertEqual(out['Anime Opening of the Year 2026|lulu.']['thumb'], fake_thumb('credless001'))

    def test_a_song_without_a_playable_video_still_gets_an_official_picture(self):
        RULES['official001'] = (True, {'PH'}, None)   # Hanakage's only official video is blocked here
        out, _ = self.run_main()
        h = out['Anime Ending of the Year 2026|Hanakage']
        self.assertIsNone(h['id'])
        self.assertEqual(h['thumb'], fake_thumb('official001'))

    def test_misses_from_before_pictures_are_searched_once_for_one(self):
        today = datetime.date.today().isoformat()
        k = 'Anime Ending of the Year 2026|Hanakage'
        RULES['official001'] = (True, {'PH'}, None)
        out, calls = self.run_main(existing={k: {'v': fv.VERSION, 'id': None, 'checked': today}})
        self.assertTrue(any(q.startswith('Hanakage') for q in calls))
        _, calls = self.run_main(existing={k: out[k]})
        self.assertFalse(any(q.startswith('Hanakage') for q in calls), 'not searched again within the week')

    def test_without_a_key_nothing_happens(self):
        out, calls = self.run_main(key='')
        self.assertIsNone(out)
        self.assertEqual(calls, [])

    def test_api_failure_keeps_what_was_found(self):
        def boom(k, q, r):
            raise RuntimeError('quota exceeded')
        tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(tmp, '2026', 'data'))
        keep = {'Anime Opening of the Year 2026|lulu.': {'id': 'credless001', 'checked': '2026-11-01'}}
        with open(os.path.join(tmp, '2026', 'data', 'videos.json'), 'w', encoding='utf-8') as f:
            json.dump(keep, f)
        keep['Anime Opening of the Year 2026|lulu.']['thumb'] = ''
        with open(os.path.join(tmp, '2026', 'data', 'videos.json'), 'w', encoding='utf-8') as f:
            json.dump(keep, f)
        with mock.patch.object(fv, 'ROOT', tmp), mock.patch.object(fv, 'editions', lambda: iter([('2026', CSV)])), \
                mock.patch.multiple(fv, search=boom, thumb_for=fake_thumb), mock.patch.dict(os.environ, {'YOUTUBE_API_KEY': 'k'}):
            self.assertEqual(fv.main(), 0)
        self.assertEqual(json.load(open(os.path.join(tmp, '2026', 'data', 'videos.json'), encoding='utf-8')), keep)


if __name__ == '__main__':
    unittest.main()
