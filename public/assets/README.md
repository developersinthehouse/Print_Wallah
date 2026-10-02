# Logo assets

An optional brand override can be placed here as `logo.png`. If it is absent, the server serves the checked-in `print-wallah_logo.png`; if both are absent, it serves `logo-placeholder.svg`.

- `/assets/logo.png` is loaded first by every page header, auth page and the favicon.
- `/assets/logo.png` prefers the optional `logo.png` override, then uses `print-wallah_logo.png`, then the text placeholder SVG.
- Use a transparent PNG/SVG with light artwork for the dark theme. The header scales it to 32px high and keeps the aspect ratio; no border, shadow or background is applied.
