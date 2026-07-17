4EST Part & Assembly Browser

Purpose:
- A companion Trimble Connect extension to the 4EST Drawing Locator.
- Instead of typing a value to search for, this lists every Assembly/Cast
  unit position and every PART Position found in the loaded model,
  alphabetically (natural sort, so "LGS2" sorts before "LGS10"), so you can
  browse and click instead of remembering/typing an exact value.

How it works:
- On load, it automatically reads every object it can from the model
  (same multi-strategy approach as the search tool - tries a couple of
  automatic methods, falls back to your current viewer selection if
  needed) and pulls out just two property values per object:
    - "Assembly/Cast unit position"
    - "PART Position"
- These property names are fixed (hardcoded at the top of app.js in
  PROPERTY_NAMES) since the company's models use them consistently. If
  that ever changes, update the two values there.
- Two tabs: Assemblies and Parts. Each is a scrollable, alphabetically
  sorted list. Click any row to select and zoom to it in the 3D Viewer.
- A small "3x" style badge appears next to values that aren't unique
  (multiple objects share the same value) - clicking it selects/zooms to
  all of them together.
- A filter box above each list narrows it as you type (client-side, does
  not re-query the model).
- "Refresh" re-reads the model from scratch - use this after the model
  changes or objects are added/removed.

Performance note:
- Building the list requires fetching properties for every object in the
  model (in batches of 200), so it can take a while on large models. The
  loading indicator shows a running count while this happens.

Setup:
- Same deployment approach as the Drawing Locator extension: host these
  files somewhere with a public HTTPS URL (GitHub Pages works well), then
  add the manifest.json URL as a Custom Extension in your Trimble Connect
  project settings.
