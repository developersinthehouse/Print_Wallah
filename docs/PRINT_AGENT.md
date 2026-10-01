# Local print agent

The agent runs on the shop's computer, uses only Python's standard library, and polls the shop's print queue. It downloads private documents only for a job already assigned to its shop token.

## Installation

1. Install Python 3.10 or newer on the shop computer.
2. Copy `agent/config.example.json` to `agent/config.json`.
3. Fill in the server URL, shop ID, one-time agent token, and printer name. The Super Admin sees the agent token when creating the shop; later, a shop admin can rotate it.
4. Configure `print_command` as an argument array that includes `{file}`. Example for Linux/macOS with CUPS:

   ```json
   ["lp", "-d", "{printer}", "-n", "{copies}", "-P", "{page_range}", "-o", "media={paper_size}", "-o", "print-color-mode={color}", "-o", "sides={duplex}", "-o", "orientation-requested={orientation}", "-o", "print-scaling={scaling}", "{file}"]
   ```

   On Windows, install a command-line PDF printer such as SumatraPDF and configure its documented silent-print arguments for your installation. For example, arguments can include `-print-to`, `{printer}`, `-print-settings`, `{copies}x`, and `{file}`. Confirm syntax against the installed version and run a test from the shop computer before using customer jobs.

5. From `agent/`, start the worker with `python print_agent.py`. Run it under the shop's logged-in printer account. The worker logs to `print-agent.log` and stores its duplicate-protection journal in `agent-state.sqlite3`.

## Command placeholders

`{file}`, `{printer}`, `{copies}`, `{page_range}`, `{paper_size}`, `{color}`, `{duplex}`, `{orientation}`, `{scaling}`, and `{order_code}` are replaced before execution. The process runs without a shell. The sample CUPS command maps the selected page list, color mode, paper, scaling, orientation, copies, and duplex setting to common CUPS options. Printer command flags and supported values vary by OS and model. The agent marks a job failed instead of silently printing a partial page range or unsupported non-default copies/color/duplex/paper/orientation/scaling setting when the command omits its required placeholder. Test the options locally before using customer jobs.

The agent marks a job complete when the configured OS command exits successfully. That confirms command acceptance, not physical paper output. If the machine stops after printing but before recording its result, the local journal blocks an automatic second print and the operator should inspect the printer before retrying. Keep the agent token private and rotate it if exposed.
