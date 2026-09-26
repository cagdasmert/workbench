# Images (P4) — design deltas

**Date:** 2026-09-25 · **Source PRD:** vault `02_Projects/Huggingface/PRD/P4-image.md`
(constraints C1–C5 in `PRD/README.md`) · **Status:** approved in session, implementing M1

The PRD is the spec. This file records what was decided on top of it, and the places where the
code on this machine disagrees with what the PRD assumed.

## What the PRD assumed that is not true

1. **"The runtime is already written" is false for these models.** `image_gen.py` uses
   diffusers and torch, not mflux or mlx-gen. It handles a single `pipe(prompt)` call with no
   image input, so it cannot edit or upscale, and it has no Z-Image preset. `diffusers`, `PIL`
   and `mflux` are not installed in the venv. Qwen-Image-Edit at bf16 through diffusers is about
   55 GB, which does not fit in 48 GB unquantized. **M1 writes a runtime; it does not wrap one.**
2. **The ids collide with `image-viewer`.** That plugin owns `image.open`, `image.main` and
   `cmd+shift+i`. The host keeps panels and commands in global maps where the last
   registration wins, silently, so the PRD's manifest would take over the viewer.
3. **`copyFile` cannot serve *Save as…*.** It requires a read grant on the source, and the
   daemon's output folder never has one.
4. **`image-viewer` needs bytes.** It builds its view from a `Uint8Array`, and the panel only
   holds a preview no larger than 512 px.
5. **The one-job-per-repo rule does not prevent swapping.** It refuses two Z-Image runs, but it
   allows Z-Image and Qwen-Edit to run together, which is exactly the case in PRD §6.

## Where the code lives

| Part | Location |
|---|---|
| Plugin (TypeScript) | `workbench/plugins/image-gen/` |
| Runtime script | `workbench/daemon/image.py` (new) |
| Routes, the one-image-job rule | `workbench/daemon/modelctld.py` (edited) |

The daemon moved into the repo as this branch's first commit (`6308694`); see
`daemon/README.md`. `image_gen.py` stays a standalone diffusers CLI and is not touched.

## Decisions

1. **The runtime is mflux 0.20, in a new `image.py`.** mflux covers every role in PRD §6:
   Z-Image, Qwen-Image editing, FLUX.2 Klein, and SeedVR2 upscaling. It installs into the
   shared venv without touching `mlx` or `mlx-lm`: a dry run adds Pillow, OpenCV and matplotlib.
   `daemon/requirements.txt` is refreshed after the install.
   (Rejected: adding mflux to `image_gen.py`, which would mix two runtimes' quirks in one file;
   staying on diffusers, because Qwen-Edit does not fit and SeedVR2 is not in diffusers.)
2. **Each run is a fresh subprocess job, and M1 measures it.** This is the asr pattern: memory
   is released when the job ends, and cancel is killing the process. Every result carries
   `load_s`, `gen_s` and `peak_gb`. A warm worker, like vault-search's `EmbedWorker`, is added
   only if those numbers show loading dominates a run. (Rejected for now: a warm worker from
   the start, which keeps 12–28 GB resident between runs and makes cancel harder.)
3. **Weights are pre-quantized `mflux-community` repos, pulled through modelctl.** They are
   ordinary Hugging Face repos, so `modelctl pull` and `resolve()` handle them unchanged, and a
   fresh subprocess does not re-quantize the full weights on every run. Each setting takes a
   repo id or an absolute folder path (decision 5).

   | Setting | Default | Disk |
   |---|---|---|
   | `model` | `mflux-community/z-image-turbo-mflux-q8` | 11.0 GB |
   | `editModel` | `mflux-community/qwen-image-edit-2511-mflux-q6`, until the facade spike decides | 32.4 GB |
   | spike alternative | `mflux-community/flux2-klein-9b-mflux-q8` | 17.9 GB |

   (Rejected: the original repos quantized on load, about 91 GB of disk and a full re-read and
   re-quantize on every run; Qwen-Edit at q8, 37.5 GB with a peak near 40 GB on a 48 GB machine.)
4. **`image.py` is cheap to import.** Its top level holds `FAMILIES`, a table that maps a
   substring of the repo name to a role (`generate`, `edit` or `upscale`), an mflux class, and
   defaults: steps, width, height, and whether the model takes a negative prompt. It also holds
   request validation. mflux is imported only inside the run functions. The daemon imports
   `image.py` in-process to validate each request, so a bad request is a 400, not a failed job.
   The "Z-Image uses 9 steps" knowledge exists in this table and nowhere else.
5. **A model is a repo id or an absolute folder path.** *(Amended 2026-09-26: the user manages
   downloads through modelctl, and wants the plugin configurable by the path of downloaded
   models.)*
   - **A repo id** is found through `modelctl.resolve()`, wherever modelctl put it, on the
     internal or the external drive. A repo that has not been pulled is a 404 whose hint is the
     `modelctl pull` command.
   - **A value starting with `/` or `~`** is a folder path and is used exactly as given. It must
     be an existing folder, otherwise the request is a 400, and it is never looked up in the
     catalog.
   - **The family comes from the name either way**, so a folder's path must contain a family
     name (`z-image-turbo`, `qwen-image-edit`, `flux2-klein-9b`, `seedvr2`), or the 400 lists
     them. modelctl's own layout (`models--org--name/snapshots/…`) always does.
   - **The resolved folder is passed to mflux as `model_path`.** mflux never downloads anything,
     and no route or job downloads weights: the user pulls them with modelctl.
6. **Output.** Each image is written to `<out_dir>/YYYYMMDD-HHMMSS_<mode>_<seed>.png` with
   exclusive create, adding `-2`, `-3` and so on after a collision. Beside it goes a JSON
   sidecar with the full request, the seed and the model, and the PNG carries the same fields
   as text chunks. The result includes a base64 JPEG preview no larger than 512 px on its long
   edge (C3), never the full PNG.
7. **Loading shows as `percent: null`.** `image.py` prints `loading <repo>`, then its own
   `step i/n  p%` lines. mflux's own progress output is suppressed, so no `%` appears before
   step 1, and `percent` stays `null` exactly while the model loads. The panel shows "Loading
   model…" while it is `null` and "Generating n%" after that, with no new job field. M1 has to
   confirm that mflux's step callback can drive these lines.
8. **One image job at a time, across all models.** A second `image` job of any mode or model
   gets a 409 whose hint names the running job's id. The one-job-per-repo rule still applies on
   top, so an image job also cannot start while its model is being pulled or moved. Queueing is
   deferred, as it was in transcribe. The conflict check and the job's registration happen under
   one lock (`JobStore.claim`). That closes the gap the existing `running_for`-then-`add` pair
   left, where two requests arriving together could both pass.
9. **`out_dir`** comes from the plugin's `outputDir` setting. When the setting is empty, the
   daemon writes to `~/Pictures/Workbench` and creates the folder. An explicit `out_dir` must be
   an existing absolute directory, otherwise it is a 400, so a typo in settings cannot create a
   stray folder.
10. **The daemon's writes stay out of the Workbench plugin directory.** `out_dir` and the
    `/save` destination both refuse `~/Library/Application Support/Workbench/plugins/` and
    everything under it, mirroring the broker's deny-list (CLAUDE.md, "Watch for"). Only image
    files are ever written, always with exclusive create.
11. **Sources are PNG, JPEG or WebP.** HEIC is refused with a hint to convert it first (`sips -s
    format jpeg in.heic --out out.jpg`). That keeps `pillow-heif` out until a real photo needs
    it.
12. **`strength` is dropped** from the edit route. Qwen-Image-Edit edits by instruction; it is
    not img2img.
13. **Upscaling is SeedVR2 3B from `numz/SeedVR2_comfyUI`, the repo mflux itself loads.** It
    is the default of the new `upscaleModel` setting. The repo holds 60 GB of variants, and mflux
    reads two of its files (7.3 GB), so it is pulled with `--include
    seedvr2_ema_3b_fp16.safetensors ema_vae_fp16.safetensors`. `POST /v1/catalog/pull` has no
    `include`, so when the model is missing, the 404 hint gives the `modelctl` command instead of
    a POST. The factor is 2 or 3. mflux parses any positive factor, but only `2x` and `3x` are
    documented. The upscaled long edge is capped at 4096 px, and a larger result is a 400.
14. **The ids change to the `imagegen.*` prefix.** The commands are `imagegen.open`,
    `imagegen.generate`, `imagegen.edit` and `imagegen.upscale`; the panel is `imagegen.main`;
    the keybinding is `cmd+shift+g`, which is free. Every command has a complete `args` block
    (C5).
15. **Permissions:** the two `net:fetch` hosts, plus `fs:read:user-selected` for picking a
    source image, plus `fs:write:user-selected` for the *Save as…* folder dialog. The daemon does
    the actual copy. `pickDirectoryForWrite` is the consent step, and its "Copy Here" button is
    the right label for it. The permission is declared because the plugin does cause a write.
16. **History entries are widened** so a tile restores everything:
    `{ id (the job id), mode, model, seed, steps, width, height, prompt?, negative?, instruction?,
    source?, factor?, path, thumb_b64, when, elapsed }`, where `thumb_b64` is the result's
    `preview_b64` stored unchanged. History is kept in `ctx.storage` under
    `history` (PRD §8), capped at `historyLimit`, oldest pruned first, and **persisted from M2**,
    because a strip that only lived in memory would be throwaway work. Clicking a tile switches
    to its mode, fills every field, and **locks its seed**. If a file on disk is gone, the
    thumbnail stays and *Save as…* and *Send to viewer* report "file missing".
17. **Re-attach by asking the daemon.** When the panel mounts it reads `GET /v1/jobs`. A running
    `image` job gets its placeholder tile back and is polled again. A finished `image` job whose
    id is not in history is fetched by id and added, which covers a run that finished while the
    panel was closed. No job ids are stored (transcribe decision 9). A finished job lost to a
    daemon restart misses the strip, but its PNG and sidecar are still on disk.
18. **Commands post their own job, then open the panel,** and the panel finds the job through
    decision 17. No mailbox is needed, and the commands already work without a panel, which the
    S2 MCP server will rely on. Errors arrive as `ui.notify` messages carrying the daemon's hint.
19. **Bus.** The plugin *emits* `image/png` as a `Uint8Array` fetched from `/file`, with
    `meta.filename` and `meta.path`. The host never routes content back to its sender, so
    `image-viewer` is the only candidate and receives it directly (criterion 6). The plugin
    *accepts* `text/plain`, which fills in the Generate prompt without running it (ai-provider's
    rule). It also accepts `image/png` and `image/jpeg`: with a string `meta.path` the image
    becomes the Edit source, and bytes alone get a notice (C2).
20. **Dropping a file is deferred.** A sandboxed renderer cannot learn a dropped file's path
    without a new host API, which would be an SDK change. Sources come from *Pick…*, from *Use as
    edit source* on a tile, or from the bus.
21. **The *Loading model…* status, the before/after view, and the written path under every
    result** are required UI, not polish. They answer PRD §9's first risk and criteria 4 and 5.
22. **`poller.ts` is copied a third time.** The copies in transcribe and vault-search are
    byte-identical. Extracting all three is a follow-up, so this branch does not change the
    build of two plugins that have already shipped.
23. **Size limits.**
    - **Generate:** width and height are 256–2048 and multiples of 16, defaulting to the
      family's size.
    - **Edit:** the output keeps the source's aspect ratio at no more than one megapixel, with
      both sides multiples of 16. A 12 MP phone photo edited at full size would not fit in
      memory, and these models work at about 1 MP anyway.
    - **Steps:** 1–100. A value of 0 means "use the default", as the plugin's command args
      define it; the same holds for seed 0, which means "random".
24. **`image.py` runs mflux the way mflux's own command-line tools do.** It registers mflux's
    `MemorySaver`, which evicts the text encoders once the prompt is encoded (8–12 GB by mflux's
    own measurement), and leaves `quantize` unset so pre-quantized weights load as they are
    stored. `HF_HUB_OFFLINE=1` makes any download mflux attempts fail rather than bypass
    modelctl. `TQDM_DISABLE=1` removes mflux's progress bars, so the `%` lines in the log are
    only `image.py`'s own. mflux is pinned to `0.20.0`.

## Wire contract

Additions to the PRD §7 contract are marked ★, removals ✗.

```
GET  /v1/generate/image/models
     → { models: [{ repo, role, family, defaults: { steps, width, height }, negative }] }
     only downloaded repos that match a FAMILIES entry. The panel names a configured
     default that is not downloaded ("pull it in Models"); the daemon never sees settings.

POST /v1/generate/image           { prompt, model?, steps?, seed?, width?, height?, negative?, out_dir? }
POST /v1/generate/image/edit      { path, instruction, model?, seed?, steps?, out_dir? }    ✗ strength
POST /v1/generate/image/upscale   { path, factor? = 2, model?, out_dir? }
     → Job (kind 'image', repo = the model)
     model: a repo id, or an absolute folder path (decision 5).
     seed 0 or absent = random; the seed actually used is always in the result.
     400 bad field, source not an absolute PNG/JPEG/WebP file, out_dir not an existing absolute
         directory, out_dir under the Workbench plugin directory, model folder missing or naming
         no family
     404 model not downloaded (hint: the modelctl pull command, with --include for SeedVR2)
     409 ★ another image job is running (hint: its id) · model busy (pull/mv/rm)

GET  /v1/jobs/<id>
     → Job + { params, result? }
       result: { mode, path, preview_b64, seed, model, steps, width, height,
                 prompt | instruction, source?, factor?, ★ load_s, gen_s, peak_gb }
       elapsed comes from the job itself.

★ GET  /v1/generate/image/file?path=<abs>   → { path, type, b64 }
     the full-resolution image, for Send to viewer and the before/after view.
     400 not a PNG/JPEG/WebP · 404 missing · 413 over 50 MB

★ POST /v1/generate/image/save   { path, dir } → { path }
     copies one image into dir with exclusive create (name-2.png after a collision); never
     overwrites. 400 source not an image · 400 dir not an existing absolute directory or under
     the Workbench plugin directory · 404 source missing
```

## Plugin layout

```
plugins/image-gen/
  plugin.json       PRD §5 with the imagegen.* ids, the settings from decisions 3 and 13,
                    and the permissions from decision 15
  src/client.ts     ImageClient, CatalogClient's shape; errors name the fix, and the
                    denied-host error names plugin.json
  src/history.ts    HistoryEntry, fromResult, add and prune (pure)
  src/form.ts       form state ⇄ HistoryEntry, request building, defaults as placeholders (pure)
  src/reattach.ts   which jobs from GET /v1/jobs to adopt (pure)
  src/poller.ts     the third copy (decision 22)
  src/index.tsx     the panel: modes, form, result, before/after, strip, tile menu; commands
  src/*.test.ts     the disposal test first, then the pure modules
```

`ctx.storage` keys: `history`, `lastSaveDir`, `mode`.

## Milestones and gates

| | Builds | Gate |
|---|---|---|
| **M1 wire** | Install mflux 0.20.0. `image.py` (FAMILIES, generate, edit, upscale), models as repo ids or folder paths, the six routes, the one-image-job rule. The user pulls Z-Image q8 and SeedVR2 3B (two files) with modelctl before the gate. | `curl`: generating with no `steps` runs 9 steps; the same seed twice gives pixel-identical output; `load_s`, `gen_s` and `peak_gb` are reported; a second concurrent job gets a 409; one upscale succeeds. |
| **Spike: facade** | No code. Pull Qwen-Edit q6 and Klein 9B q8, then run one instruction on a real photo of the front wall through each. | The user compares the two before/after pairs, with time and peak memory, and picks `editModel`. **If neither is usable, stop** and rethink use case 1 before any Edit UI is built. |
| **M2 generate** | Plugin: client, form, poller, Generate mode, result view, persisted history strip, re-attach, disposal test. | Generate from the app. Close the panel mid-run and reopen it: the job re-attaches. Restart the app: the tile is still there. |
| **M3 edit and upscale** | Both modes, *Pick…*, before/after, *Use as edit source*. | The facade before/after, run from the app (criterion 4). |
| **M4 the memory** | Tiles restore every setting and lock the seed; the tile menu; *Save as…*; *Send to viewer*; bus accepts and emits; the four commands with their args. | PRD §10, all six criteria, and the definition of done in PRD `README.md`. |

Each milestone gets its own plan in `docs/superpowers/plans/` and appends to
`docs/m1-shell-change-log.md`, starting at entry 42.

## Testing

- **Daemon** (`daemon/tests/`, stdlib `unittest`, following `test_asr.py` and
  `test_modelctld_asr.py`): family matching and defaults; request validation, including HEIC,
  factor, and a plugin-directory `out_dir`; output naming with exclusive create; preview sizing;
  and route errors: 400, 404, the global 409, the `/file` type and size refusals, `/save`
  never overwriting. No test loads weights. Rendering is verified at the `curl` gates.
- **Plugin** (vitest): the disposal test first. Then `history` (cap and prune), `form` (a history
  entry fills the form and produces the same request again), `reattach` (which jobs are
  adopted), and `client` (error mapping).

## Risks

- **MLX determinism.** Criterion 3 assumes a fixed seed gives identical pixels. The M1 gate
  tests this before any UI depends on it.
- **Edit-model memory.** Qwen-Edit q6 is 32.4 GB on disk. Its measured `peak_gb` at the spike
  decides whether it stays the default.
- **Disk.** The defaults take about 43 GB, and the spike's Klein pull adds 18 GB, all on the
  internal drive (152 GB free on 2026-09-25) while Kingston is unmounted.
