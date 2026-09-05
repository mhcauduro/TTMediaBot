import threading
from unittest import TestCase
from unittest.mock import Mock

from bot.services.yt import YtService


class YtWarmupTests(TestCase):
    def test_warmup_does_not_start_autoplay_or_resolve_an_unrelated_video(self):
        service = object.__new__(YtService)
        service._is_warmed = False
        service._warm_lock = threading.Lock()
        service._bridge = Mock()
        service._bridge.resolve.side_effect = RuntimeError("Video unavailable")
        service.search = Mock(side_effect=AssertionError("Would start autoplay"))

        service._pre_warm()
        service._pre_warm()

        self.assertTrue(service._is_warmed)
        service._bridge.search.assert_called_once_with("test", 1, mode="video")
        service._bridge.resolve.assert_not_called()
        service.search.assert_not_called()
