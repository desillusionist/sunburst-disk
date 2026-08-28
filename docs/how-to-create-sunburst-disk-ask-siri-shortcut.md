# How to Create “Sunburst Disk — Ask Siri” Shortcut

This guide configures a macOS Shortcut that accepts an object description from Sunburst Disk, performs optional web/AI research, and returns plain text to Sunburst Disk. Sunburst Disk pipes the prompt as text and uses a temporary output file because the macOS command-line tool documents `--input-path` for file input and `--output-path` for file output; a dash is not passed as the input path. The result should appear in the Sunburst Disk **Object Information** panel, not in a separate Shortcuts result window.

> **Important:** Use the exact shortcut name `Sunburst Disk — Ask Siri`. The app checks this name before launching the background command.

## 1. Create the Shortcut

Open **Shortcuts** on macOS and create a new shortcut. Name it exactly:

```text
Sunburst Disk — Ask Siri
```

Open the shortcut's Details and allow it to receive input from other apps. Keep **Text** enabled as an accepted input type. The input sent by Sunburst Disk is a text description containing the selected object's name, type, size, parent folder, and category.

The normal action chain should be:

```text
Receive Text from Shortcut Input
        ↓
Use Cloud Model / Ask ChatGPT / Apple Intelligence
        ↓
Get Text from Input       (only if the model result is not already text)
        ↓
Stop and Output
```

## 2. Configure the Receive action

The first action should be the shortcut input action. Its accepted content type must include **Text**. The input should be used directly in the model prompt; do not add an `Ask for Input` action when input is already present.

A suitable model instruction is:

```text
Use the received Shortcut Input as the complete prompt. Research the selected filesystem object using current web information when relevant. Explain what it is, what normally uses it, why it may be large, and whether removal is Safe, Review required, High risk, or Do not delete. Prefer official Apple and vendor documentation. Do not recommend deletion solely because an item is large, old, cache-like, or duplicated. Return a concise plain-text answer with source links. Never delete, move, rename, modify, upload, or reveal the full filesystem path of any file.
```

## 3. Remove display-only actions

If the AI assistant generated an action called **Show Response**, remove that action. Also remove **Show Result**, **Show Alert**, **Quick Look**, **Ask for Input**, and **Choose from Menu** from the normal input-present path.

These actions are intended to display a result or wait for a person. They do not provide the clean text return-value that the background command needs. A shortcut launched from the editor may show a preview, but the command-line integration needs a final output value instead.

## 4. Configure Stop and Output

Keep **Stop and Output** as the final action.

In its blue content field, remove the generated `Show Content` variable if it refers to the removed `Show Response` action. Select the direct output of **Use Cloud Model**. If the model returns a rich object that cannot be selected as text, insert **Get Text from Input** between the model action and Stop and Output:

```text
Use Cloud Model → Get Text from Input → Stop and Output
```

Set the input of **Get Text from Input** to the Cloud Model result. Then set the content of **Stop and Output** to the output of **Get Text from Input**.

Leave the fallback `If there's nowhere to output: Do Nothing` unchanged. Sunburst Disk provides an output destination, so the fallback should not be used during normal operation.

## 5. Avoid interactive branches

For the background invocation, the shortcut must finish without asking the user a question. In particular, do not use an input-present branch that contains any of the following:

| Action | Why it is not suitable here |
|---|---|
| `Show Response` | Opens a Shortcuts result UI instead of returning clean output. |
| `Show Result` or `Show Alert` | Displays a modal/window and can interrupt the caller. |
| `Ask for Input` | Pauses the command-line process waiting for a person. |
| `Choose from Menu` | Requires a UI choice that the background caller cannot provide. |
| `Quick Look` | Opens another application and is unrelated to text output. |

If no input is received, the shortcut may use **Stop and Output** to return a short text message such as `Sunburst Disk Text input is required.` Do not ask interactively for missing input.

## 6. Test the return value in Terminal

Before testing from Sunburst Disk, run this harmless test in Terminal:

```sh
output=$(mktemp -t sunburst-ask-siri-output).txt
printf '%s\n' 'Explain what ~/Library/Caches is used for. Return a short text answer with official sources.' \\
  | shortcuts run "Sunburst Disk — Ask Siri" \\
      --output-path "$output"
cat "$output"
rm -f "$output"
```

The answer should be printed in Terminal after `cat "$output"`. Do not add `--output-type public.utf8-plain-text` to this test: on some macOS/Shortcut combinations it prevents the text output file from being created even though the shortcut exits with code 0. The command should not require a click in Shortcuts or display a result window for this command-line run. If the output file is empty, inspect the final Stop and Output variable. If the command reports that the file is missing, verify that Stop and Output is the final action and that its value is the model's text. If it opens a result window, remove Show Response/Show Result and ensure that Stop and Output receives the model's text directly.

## 7. Debug the output variable step by step

Use a temporary duplicate of the shortcut if possible, so the working shortcut is not lost. First isolate Shortcuts from the AI action:

1. Keep the shortcut configured to receive **Text** from Shortcut Input.
2. Temporarily bypass **Use Cloud Model** and add a **Text** action containing exactly `SUNBURST_DEBUG_OUTPUT_OK`.
3. Set the final **Stop and Output** action to the result of that Text action. Do not use Show Response or Show Result.
4. Run the Terminal test above. If `SUNBURST_DEBUG_OUTPUT_OK` appears in `cat "$output"`, the command-line input/output bridge is working and the problem is in the model result connection. If the file remains empty, the problem is still in the Shortcut's completion/output configuration.

Then restore the model path and make the conversion explicit:

```text
Receive Text → Use Cloud Model → Get Text from Input → Stop and Output
```

In **Stop and Output**, click the blue content variable and verify that it is the output of **Get Text from Input**, not a variable belonging to Show Response. To make an empty model result visible during debugging, temporarily use an If action: if the model result has any value, output `MODEL_OUTPUT_PRESENT`; otherwise output `MODEL_OUTPUT_EMPTY`. Once the branch is understood, remove the marker and reconnect the real text result.

Use this diagnostic Terminal command when reporting the result. It records only process metadata and output byte counts, not the filesystem object prompt:

```sh
tmp=$(mktemp -d)
printf '%s\n' 'Reply with exactly OK. Do not use web search.' \\
  | shortcuts run "Sunburst Disk — Ask Siri" \\
      --output-path "$tmp/result.txt" \\
      >"$tmp/stdout.txt" 2>"$tmp/stderr.txt"
status=$?
printf 'exit=%s\\n' "$status"
printf 'result-bytes='; wc -c < "$tmp/result.txt"
printf 'stdout-bytes='; wc -c < "$tmp/stdout.txt"
printf 'stderr-bytes='; wc -c < "$tmp/stderr.txt"
printf '%s\\n' '--- result ---'; cat "$tmp/result.txt"
printf '%s\\n' '--- stderr (last 20 lines) ---'; tail -n 20 "$tmp/stderr.txt"
rm -rf "$tmp"
```

Interpret the result as follows: `exit=0` with `result-bytes=0` means the Shortcut completed but Stop and Output produced no text; a non-zero exit means the CLI invocation or Shortcut failed; a positive `result-bytes` value means the Shortcut returned text and any remaining error is inside the app integration. The Sunburst Disk error drawer also exposes the same safe metadata under **Technical diagnostics**.

## 8. Use it from Sunburst Disk

In Sunburst Disk, right-click a real file or folder in the content tree or Sunburst and choose **Ask Siri…**. The app opens an in-app **Object Information** panel, starts the named Shortcut through `/usr/bin/shortcuts`, pipes the object description as text, asks Shortcuts to write a temporary `output.txt` with `--output-path` (without forcing an output UTI), reads the result, and deletes the temporary directory.

The result panel is informational only. Sunburst Disk does not delete, move, rename, modify, or upload objects as a consequence of Ask Siri.

## Privacy and permissions

The object description sent to the Shortcut intentionally omits the full filesystem path. The AI/web action inside the Shortcut may transmit the prompt to an external provider according to that provider's settings and permissions. Do not add file contents or personal data to the prompt unless you have explicitly decided to do so.

## References

[1]: https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac "Apple Support — Run shortcuts from the command line"

[2]: https://support.apple.com/guide/shortcuts-mac/shortcut-completion-apda9578f70f/mac "Apple Support — Shortcut completion on Mac"

[3]: https://support.apple.com/guide/shortcuts-mac/limit-the-input-for-a-shortcut-apd8195f96d6/mac "Apple Support — Limit the input for a shortcut when run from another app on Mac"
