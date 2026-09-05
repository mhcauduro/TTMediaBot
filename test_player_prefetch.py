import threading
from unittest import TestCase
from unittest.mock import Mock

from bot.player import Player
from bot.player.enums import Mode, State
from bot.player.queue_manager import QueueManager


class PrefetchTests(TestCase):
    def setUp(self):
        self.player = object.__new__(Player)
        self.player.queue = QueueManager()
        self.player.track_list = [Mock(_is_fetched=False, _fetch_failed=False) for _ in range(6)]
        self.player.track_index = 1
        self.player.mode = Mode.TrackList
        self.player.state = State.Playing
        self.player._prefetch_lock = threading.Lock()

    def test_prepares_three_upcoming_tracks_without_changing_navigation(self):
        self.assertEqual(self.player._prefetch_candidates(), self.player.track_list[2:5])
        self.assertEqual(self.player.track_index, 1)

    def test_queue_replaces_playlist_and_is_limited_to_three(self):
        queued = [Mock() for _ in range(4)]
        for track in queued:
            self.player.queue.add(track)
        self.assertEqual(self.player._prefetch_candidates(), queued[:3])
        self.assertEqual(self.player.queue.size, 4)

    def test_repeating_list_wraps_without_prefetching_current_track(self):
        self.player.mode = Mode.RepeatTrackList
        self.player.track_index = 4
        self.assertEqual(self.player._prefetch_candidates(), [self.player.track_list[i] for i in [5, 0, 1]])

    def test_random_uses_existing_order_without_predicting_reshuffle(self):
        self.player.mode = Mode.Random
        self.player._index_list = [0, 3, 1, 5, 2, 4]
        self.player._sync_index_list = Mock()
        self.assertEqual(self.player._prefetch_candidates(), [self.player.track_list[i] for i in [5, 2, 4]])

    def test_stopping_during_resolution_prevents_more_requests(self):
        class StopTrack:
            _is_fetched = False
            _fetch_failed = False
            service = 'yt'
            name = 'test'

            @property
            def url(track):
                self.player.state = State.Stopped
                return 'https://example.test/audio'

        self.player._prefetch_candidates = Mock(return_value=[StopTrack()])
        self.player._prefetch_next_track()
        self.player._prefetch_candidates.assert_called_once()
        self.assertFalse(self.player._prefetch_lock.locked())
