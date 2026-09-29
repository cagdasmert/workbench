from __future__ import annotations

import inspect
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import image

try:
    import mflux  # noqa: F401  -- only to test for its presence; nothing here loads weights
    _MFLUX_AVAILABLE = True
except ImportError:
    _MFLUX_AVAILABLE = False


def _family(name: str) -> image.Family:
    return next(f for f in image.FAMILIES if f.name == name)


class _Recorder:
    """Stands in for an mflux model: records the kwargs image._generate passes
    to generate_image, and returns something with an `.image` attribute so
    `run()`-shaped callers would be happy too. Nothing here runs a model or
    touches a file."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def generate_image(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return SimpleNamespace(image=None)


def _captured_kwargs(family: image.Family, req: image.Request,
                     size: tuple[int, int] | None) -> dict[str, Any]:
    """The kwargs image._generate sends generate_image for `family`, captured
    by a fake rather than duplicated here by hand -- so this test fails only
    when _generate's own arguments stop matching mflux's real signature, not
    whenever _generate's kwargs are rearranged."""
    model = _Recorder()
    image._generate(family, model, req, seed=1, steps=req.steps or family.steps, size=size)
    return model.calls[0]


@unittest.skipUnless(_MFLUX_AVAILABLE, "mflux is not installed")
class MfluxCallContractTest(unittest.TestCase):
    """image.load_model and image._generate hardcode which mflux class, which
    ModelConfig, and which keyword arguments each family needs -- mflux is
    pinned to 0.20.0, but nothing stops a future bump from moving one of
    them. Binding those calls against mflux's real signatures (inspect.bind
    never invokes anything) fails this test the day the API drifts out from
    under that assumption, rather than a real generation the day someone
    updates the pin. No model is constructed and no weights are loaded.
    """

    def test_z_image_turbo(self) -> None:
        from mflux.models.common.config.model_config import ModelConfig
        from mflux.models.z_image.variants.z_image import ZImage

        inspect.signature(ZImage.__init__).bind(None, model_path="x", model_config=ModelConfig.z_image_turbo())
        family = _family("z-image-turbo")
        req = image.Request("generate", "repo/x", Path("/out"), prompt="a gate")
        kwargs = _captured_kwargs(family, req, size=(1024, 1024))
        inspect.signature(ZImage.generate_image).bind(None, **kwargs)

    def test_qwen_image_edit(self) -> None:
        from mflux.models.common.config.model_config import ModelConfig
        from mflux.models.qwen.variants.edit.qwen_image_edit import QwenImageEdit

        inspect.signature(QwenImageEdit.__init__).bind(None, model_path="x",
                                                        model_config=ModelConfig.qwen_image_edit())
        family = _family("qwen-image-edit")
        req = image.Request("edit", "repo/x", Path("/out"), instruction="stone", source=Path("/x/src.png"))
        kwargs = _captured_kwargs(family, req, size=(1168, 880))
        inspect.signature(QwenImageEdit.generate_image).bind(None, **kwargs)

    def test_flux2_klein_9b(self) -> None:
        from mflux.models.common.config.model_config import ModelConfig
        from mflux.models.flux2.variants import Flux2KleinEdit

        inspect.signature(Flux2KleinEdit.__init__).bind(None, model_path="x",
                                                        model_config=ModelConfig.flux2_klein_9b())
        family = _family("flux2-klein-9b")
        req = image.Request("edit", "repo/x", Path("/out"), instruction="stone", source=Path("/x/src.png"))
        kwargs = _captured_kwargs(family, req, size=(1024, 1024))
        inspect.signature(Flux2KleinEdit.generate_image).bind(None, **kwargs)

    def test_seedvr2(self) -> None:
        from mflux.models.common.config.model_config import ModelConfig
        from mflux.models.seedvr2.variants.upscale.seedvr2 import SeedVR2

        inspect.signature(SeedVR2.__init__).bind(None, model_path="x", model_config=ModelConfig.seedvr2_3b())
        family = _family("seedvr2")
        req = image.Request("upscale", "repo/x", Path("/out"), source=Path("/x/src.png"), factor=2)
        kwargs = _captured_kwargs(family, req, size=None)
        inspect.signature(SeedVR2.generate_image).bind(None, **kwargs)

    def test_memory_saver_keywords(self) -> None:
        # load_model's own call: MemorySaver(model=model, keep_transformer=True, cache_limit_bytes=None)
        from mflux.callbacks.instances.memory_saver import MemorySaver

        inspect.signature(MemorySaver.__init__).bind(
            None, model=object(), keep_transformer=True, cache_limit_bytes=None)

    def test_scale_factor_renders_as_nx(self) -> None:
        from mflux.utils.scale_factor import ScaleFactor

        self.assertEqual(str(ScaleFactor(value=2)), "2x")


if __name__ == "__main__":
    unittest.main()
