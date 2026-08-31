# Sunburst Disk — Ask Siri Shortcut

This guide creates the macOS Shortcut required by Sunburst Disk. The exact name must be:

```text
Sunburst Disk — Ask Siri
```

Sunburst Disk sends a plain-text description of the selected file or folder to this Shortcut and reads its plain-text result back into the in-app Object Information panel.

## Create the Shortcut

1. Open **Shortcuts** on macOS and choose **New Shortcut**.
2. Name it exactly `Sunburst Disk — Ask Siri`.
3. Open the shortcut details. Allow the shortcut to receive input from other apps and keep **Text** enabled as an accepted input type.

## Add these actions in this order

```text
Receive Text from Shortcut Input
        ↓
Use Cloud Model / Ask ChatGPT / Apple Intelligence
        ↓
Get Text from Input       (only when the model returns rich/non-text data)
        ↓
Stop and Output
```

The first action must use the incoming Shortcut Input. Add one AI action that is available on your Mac. In its instruction, use the received input as the complete prompt and ask for a concise explanation of the selected object, its normal purpose, why it may be large, and whether removal is Safe, Review required, High risk, or Do not delete. Ask it to prefer official Apple or vendor sources and never change, delete, move, rename, or upload files.

If the AI action already returns plain text, connect it directly to **Stop and Output**. If it returns a rich result, place **Get Text from Input** between the AI action and **Stop and Output**, then select its output in the blue field of **Stop and Output**.

## Remove interactive display actions

Remove these actions from the normal input-present path:

- Show Response
- Show Result
- Show Alert
- Ask for Input
- Choose from Menu
- Quick Look

They can open a window or wait for a person, which prevents the background command-line call from returning clean text to Sunburst Disk.

## Test the output before using the app

Temporarily replace the final output with a plain **Text** action containing exactly:

```text
SUNBURST_DEBUG_OUTPUT_OK
```

Send that Text action to **Stop and Output**. In Terminal, run:

```sh
output=$(mktemp -t sunburst-ask-siri-output).txt
printf '%s\n' 'Reply with exactly OK.' \
  | shortcuts run "Sunburst Disk — Ask Siri" \
      --output-path "$output"
cat "$output"
rm -f "$output"
```

If `SUNBURST_DEBUG_OUTPUT_OK` or `OK` is printed, the Shortcut input/output bridge works. Restore the AI action and connect its text result to **Stop and Output**. Do not add `--output-type`; on some macOS versions that prevents the output file from being created.

## Use the Shortcut in Sunburst Disk

Right-click a file or folder in Sunburst Disk and choose **Ask Siri…**. The answer should appear in the in-app **Object Information** panel. The Shortcut is informational only; Sunburst Disk does not delete, move, rename, modify, or upload the selected object.

## Privacy

The prompt contains the selected object's name, type, size, parent folder name, and category. It intentionally omits the full filesystem path. The AI action may transmit the prompt to its provider according to that provider's settings. Do not add file contents or personal data unless you explicitly intend to do so.
