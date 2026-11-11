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
              item('lyrics00001', 'lulu. lyrics', 'LyricsHub')],
    'Hanakage': [item('cover000001', 'Hanakage (cover)', 'Singer'),
                 item('official001', 'Superfly 『Hanakage』Music Video', 'Superfly Official YouTube Channel')],
    'Nothing Here': [item('random00001', 'Totally unrelated video', 'Someone')],
}


def fake_search(key, q):
    for song, items in RESULTS.items():
        if q.startswith(song):
            return items
    return []


class Scoring(unittest.TestCase):
    def test_creditless_beats_fan_amv_and_lyrics(self):
        with mock.patch.object(fv, 'search', fake_search):
            best = fv.find('k', 'lulu.', 'Mrs. GREEN APPLE', 'Frieren Season 2', 'opening')
        self.assertEqual(best[0]['id']['videoId'], 'credless001')

    def test_official_music_video_beats_cover(self):
        with mock.patch.object(fv, 'search', fake_search):
            best = fv.find('k', 'Hanakage', 'Superfly', '', 'ending')
        self.assertEqual(best[0]['id']['videoId'], 'official001')

    def test_no_good_match_gives_nothing(self):
        with mock.patch.object(fv, 'search', fake_search):
            self.assertIsNone(fv.find('k', 'Nothing Here', 'Nobody', '', 'ending'))

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
        with mock.patch.object(fv, 'search', lambda k, q: frieren):
            self.assertEqual(fv.find('k', 'lulu.', 'Mrs. GREEN APPLE', 'Frieren Season 2', 'opening')[0]['id']['videoId'], 'C0BG3B7aksU')
        with mock.patch.object(fv, 'search', lambda k, q: jjk):
            self.assertEqual(fv.find('k', 'AIZO', 'King Gnu', 'Jujutsu Kaisen Season 3', 'opening')[0]['id']['videoId'], 'Xr032EhUDPw')

    def test_fan_edits_and_live_streams_score_low(self):
        good = fv.score(item('a', 'Song - Artist (Official Music Video)', 'Artist'), 'Song', 'Artist', '', 'opening')
        for bad in ['Song AMV', 'Song cover', 'Song nightcore', 'Song 1 hour loop', 'Song #shorts', 'Song piano']:
            self.assertLess(fv.score(item('b', bad, 'X'), 'Song', 'Artist', '', 'opening'), good, bad)
        self.assertLess(fv.score(item('c', 'Song official', 'Artist', live='live'), 'Song', 'Artist', '', 'opening'), good)

    def test_matching_ignores_case_and_punctuation(self):
        self.assertEqual(fv.norm('Mrs. GREEN APPLE'), fv.norm('mrs green apple'))
        self.assertIn(fv.norm('lulu.'), fv.norm('「lulu.」'))


class Run(unittest.TestCase):
    def run_main(self, existing=None, key='k'):
        tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(tmp, '2026', 'data'))
        if existing is not None:
            with open(os.path.join(tmp, '2026', 'data', 'videos.json'), 'w', encoding='utf-8') as f:
                json.dump(existing, f)
        calls = []
        def counted(k, q):
            calls.append(q)
            return fake_search(k, q)
        with mock.patch.object(fv, 'ROOT', tmp), mock.patch.object(fv, 'editions', lambda: iter([('2026', CSV)])), \
                mock.patch.object(fv, 'search', counted), mock.patch.dict(os.environ, {'YOUTUBE_API_KEY': key}):
            fv.main()
        path = os.path.join(tmp, '2026', 'data', 'videos.json')
        out = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else None
        return out, calls

    def test_only_openings_and_endings_without_a_youtube_link(self):
        out, _ = self.run_main()
        self.assertEqual(sorted(out), ['Anime Ending of the Year 2026|Hanakage', 'Anime Ending of the Year 2026|Nothing Here',
                                       'Anime Opening of the Year 2026|lulu.'])
        self.assertEqual(out['Anime Opening of the Year 2026|lulu.']['id'], 'credless001')
        self.assertIsNone(out['Anime Ending of the Year 2026|Nothing Here']['id'])

    def test_found_songs_are_not_searched_again(self):
        first, _ = self.run_main()
        found = {k: v for k, v in first.items() if v['id']}
        _, calls = self.run_main(existing=found)
        self.assertTrue(all(q.startswith('Nothing Here') for q in calls), calls)

    def test_misses_are_retried_only_after_a_week(self):
        today = datetime.date.today()
        recent = {'Anime Ending of the Year 2026|Nothing Here': {'id': None, 'checked': today.isoformat()}}
        old = {'Anime Ending of the Year 2026|Nothing Here': {'id': None, 'checked': (today - datetime.timedelta(days=8)).isoformat()}}
        _, calls = self.run_main(existing=recent)
        self.assertFalse(any(q.startswith('Nothing Here') for q in calls))
        _, calls = self.run_main(existing=old)
        self.assertTrue(any(q.startswith('Nothing Here') for q in calls))

    def test_without_a_key_nothing_happens(self):
        out, calls = self.run_main(key='')
        self.assertIsNone(out)
        self.assertEqual(calls, [])

    def test_api_failure_keeps_what_was_found(self):
        def boom(k, q):
            raise RuntimeError('quota exceeded')
        tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(tmp, '2026', 'data'))
        keep = {'Anime Opening of the Year 2026|lulu.': {'id': 'credless001', 'checked': '2026-11-01'}}
        with open(os.path.join(tmp, '2026', 'data', 'videos.json'), 'w', encoding='utf-8') as f:
            json.dump(keep, f)
        with mock.patch.object(fv, 'ROOT', tmp), mock.patch.object(fv, 'editions', lambda: iter([('2026', CSV)])), \
                mock.patch.object(fv, 'search', boom), mock.patch.dict(os.environ, {'YOUTUBE_API_KEY': 'k'}):
            self.assertEqual(fv.main(), 0)
        self.assertEqual(json.load(open(os.path.join(tmp, '2026', 'data', 'videos.json'), encoding='utf-8')), keep)


if __name__ == '__main__':
    unittest.main()
