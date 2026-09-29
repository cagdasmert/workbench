from __future__ import annotations

import unittest

import text


class ValidateMessagesTest(unittest.TestCase):
    def test_accepts_a_normal_conversation(self) -> None:
        msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "soru?"}]
        self.assertEqual(text.validate_messages(msgs), msgs)

    def test_rejections(self) -> None:
        for bad in (None, "hi", [], [{"role": "tool", "content": "x"}], [{"role": "user", "content": 3}],
                    [{"role": "user"}], ["user: hi"], [{"role": "user", "content": "x" * 200_001}],
                    [{"role": "user", "content": "x"}] * 51):
            with self.assertRaises(text.TextError, msg=repr(bad)[:60]):
                text.validate_messages(bad)

    def test_extra_keys_are_dropped(self) -> None:
        self.assertEqual(text.validate_messages([{"role": "user", "content": "x", "name": "n"}]),
                         [{"role": "user", "content": "x"}])


class StripThinkTest(unittest.TestCase):
    def test_closed_block(self) -> None:
        self.assertEqual(text.strip_think("<think>hmm\nplan</think>\n\nCevap [1]."), "Cevap [1].")

    def test_unclosed_leading_block_is_all_thinking(self) -> None:
        self.assertEqual(text.strip_think("<think>ran out of tokens"), "")

    def test_no_block(self) -> None:
        self.assertEqual(text.strip_think("  Düz cevap.  "), "Düz cevap.")

    def test_orphan_close_tag(self) -> None:
        # Some templates open the block in the prompt, so only the close arrives.
        self.assertEqual(text.strip_think("reasoning here</think>Cevap."), "Cevap.")
