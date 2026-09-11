from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock

from bot.player import Player


class PlayerHttpHeaderTests(TestCase):
    def _make_player(self):
        player = object.__new__(Player)
        player.track = SimpleNamespace(
            extra_info={"http_headers": {"User-Agent": "custom-agent", "Referer": "https://example.test/page"}}
        )
        player.track_list = []
        player.track_index = -1
        player.cache = SimpleNamespace(recents=[])
        player.cache_manager = SimpleNamespace(save=Mock())
        player._player = SimpleNamespace(
            user_agent="default-agent",
            http_header_fields=[],
            pause=True,
            play=Mock(),
        )
        player._default_user_agent = "default-agent"
        player._current_user_agent = None
        player._current_header_fields = None
        player._start_playback_trace = Mock(return_value=1)
        player._log_playback_timing = Mock()
        player._schedule_prefetch = Mock()
        return player

    def test_applies_track_http_headers(self):
        player = self._make_player()

        player._play("https://cdn.example.test/audio.mp3", save_to_recents=False)

        self.assertEqual(player._player.user_agent, "custom-agent")
        self.assertEqual(
            player._player.http_header_fields,
            ["Referer: https://example.test/page"],
        )

    def test_clears_track_headers_for_next_plain_url(self):
        player = self._make_player()
        player._current_user_agent = "custom-agent"
        player._current_header_fields = ["Referer: https://example.test/page"]
        player.track.extra_info = None

        player._play("https://radio.example.test/live", save_to_recents=False)

        self.assertEqual(player._player.user_agent, "default-agent")
        self.assertEqual(player._player.http_header_fields, [])
