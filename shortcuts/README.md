# Stopping and starting the watcher without a function key

PixInsight's own abort is Ctrl+F11, which is useless on a Mac keyboard with no
function row, and its Pause/Abort button stays greyed out because the watcher is
a running *script*, not a running *process*.

None of that matters any more: the watcher stops on a sentinel file, so anything
that can create one file can stop it.

## Double-click

`Stop PixInsight Watcher.command` and `Start PixInsight Watcher.command` in this
directory are executable and open in Terminal when double-clicked. Drag them to
the Desktop, the Dock, or a Finder sidebar — they resolve their own location, so
they keep working from anywhere as long as this repo stays where it is.

Stopping leaves PixInsight open with its images. Only the watcher loop ends.

## A real global hotkey

Shortcuts.app can bind any key combination you like:

1. Shortcuts.app → File → New Shortcut
2. Add the **Run Shell Script** action
3. Set the script to:

   ```
   /opt/homebrew/bin/node /Users/adebert/astro-tools/pixinsight-mcp/scripts/pi-stop.mjs
   ```

4. Name it "Stop PixInsight Watcher"
5. In the shortcut's details pane, click **Add Keyboard Shortcut** and press the
   combination you want — Cmd+Option+P, or anything else that is free.

The same works for `pi-launch.mjs` if you want a start key too.

## From a terminal

```bash
cd /Users/adebert/astro-tools/pixinsight-mcp
npm run stop      # stop the watcher, leave PixInsight open
npm run launch    # start it again
npm run doctor    # check what state everything is in
```

## From anywhere, as a command

Add to your shell profile:

```bash
alias pi-stop='node /Users/adebert/astro-tools/pixinsight-mcp/scripts/pi-stop.mjs'
alias pi-start='node /Users/adebert/astro-tools/pixinsight-mcp/scripts/pi-launch.mjs'
```

## What stopping does NOT do

It does not interrupt work in progress. The watcher checks for the sentinel
between commands, so a stop requested during a twenty-minute BlurXTerminator run
waits for that run to finish — interrupting mid-process would leave the image in
an unknown state. `pi-stop` reports that it is waiting, and names the command it
is waiting on.

To kill PixInsight outright, losing any unsaved images: `npm run stop -- --force`.
