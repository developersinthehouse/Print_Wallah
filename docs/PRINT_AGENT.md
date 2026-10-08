# Local print agent

The agent runs on the shop's computer, uses only Python's standard library, and polls the shop's print queue. It downloads private documents only for a job already assigned to its shop token.

## Installation

1. Install Python 3.10 or newer on the shop computer.
2. Copy `agent/config.example.json` to `agent/config.json`.
3. Fill in the server URL, shop ID, one-time agent token, and printer name. The Super Admin sees the agent token when creating the shop; later, a shop admin can rotate it.
4. Configure `print_command` as an argument array that includes `{file}`. Example for Linux/macOS with CUPS:

   ```json
   ["lp", "-d", "{printer}", "-n", "{copies}", "-P", "{page_range}", "-o", "media={paper_size}", "-o", "media-type={paper_type}", "-o", "print-color-mode={color}", "-o", "sides={duplex}", "-o", "orientation-requested={orientation}", "-o", "print-scaling={scaling}", "{file}"]
   ```

   On Windows with SumatraPDF, use its settings-list placeholder to map the order's pages, copies, paper size, color, duplex, orientation, and scaling. Photo-sheet PDFs are already composed to their selected page layout, so the agent preserves their size instead of rotating or scaling them again:

   ```json
   ["C:\\Program Files\\SumatraPDF\\SumatraPDF.exe", "-print-to", "{printer}", "-print-settings", "{print_settings}", "-silent", "{file}"]
   ```

   Change the executable path if SumatraPDF is installed elsewhere. `{print_settings}` is for SumatraPDF and generates its comma-separated `-print-settings` options. SumatraPDF cannot select normal versus glossy media; keep `allow_glossy` false with this command. Glossy/photo orders need a separately tested printer-specific command containing `{paper_type}` or must be printed manually.

5. From `agent/`, start the worker with `python print_agent.py`. Run it under the shop's logged-in printer account. The worker logs to `print-agent.log` and stores its duplicate-protection journal in `agent-state.sqlite3`.

The agent checks that the configured executable exists before starting. While a print command runs, it renews that job's server lease every 20 seconds; this prevents the 15-minute stale-lease sweep from assigning a long-running print to another agent.

`allow_glossy` defaults to `false`. Glossy orders are reported failed instead of being sent to a printer whose media selection has not been tested. For the SumatraPDF command above, leave it `false`: SumatraPDF does not expose a generic normal/glossy media option. Set it to `true` only with a different, tested printer command that contains `{paper_type}`.

## Command placeholders

`{file}`, `{printer}`, `{copies}`, `{page_range}`, `{paper_size}`, `{paper_type}`, `{color}`, `{duplex}`, `{orientation}`, `{scaling}`, and `{order_code}` are replaced before execution. `{print_settings}` builds SumatraPDF's comma-separated settings list; do not use it with CUPS. The process runs without a shell. The sample CUPS command maps the selected page list, color mode, paper type/size, scaling, orientation, copies, and duplex settings to common CUPS options. Printer command flags and supported values vary by OS and model. The agent marks a job failed instead of silently ignoring a selected non-default setting when the command omits its required placeholder. Test the options locally before using customer jobs.

The agent marks a job complete when the configured OS command exits successfully. That confirms command acceptance, not physical paper output. If the machine stops after printing but before recording its result, the local journal blocks an automatic second print and the operator should inspect the printer before retrying. Keep the agent token private and rotate it if exposed.
