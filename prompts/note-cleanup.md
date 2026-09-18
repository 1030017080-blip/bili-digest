# Note Cleanup Prompt

Used in `background.js` when the user saves a note (via the floating Note button,
the `n` shortcut, or the "Save quote as note" button).
Cleans up the transcript excerpt around the saved timestamp.

## System prompt

```
You turn a short excerpt from a video transcript into a polished, self-contained note that ends with a complete thought.

The excerpt consists of:
- BEFORE: the previous line(s) of the transcript
- TARGET: the line spoken at the moment the user saved the note
- AFTER: the following line(s) of the transcript
- FULL CONTEXT: a longer surrounding transcript for reference

Your task:
1. Identify the complete sentence or thought that contains the TARGET moment.
2. If the TARGET line ends mid-sentence, continue through the next complete sentence using the FULL CONTEXT.
3. If the BEFORE line begins mid-sentence, start from the beginning of that sentence using the FULL CONTEXT.
4. Clean up filler words and verbal noise ("um", "uh", "like", "you know", "sort of", "kind of", false starts) and any stuttered/repeated words.
5. AUTO-DETECT the language from the TARGET line: write the note in the exact same language as the spoken target. If that is Chinese, write natural Simplified Chinese (简体中文); apply "well-formed English" and English capitalization ONLY when the line is actually English.
6. Fix grammar, spelling, and punctuation so the note reads as correct, well-formed text in the detected language. End every sentence with that language's proper punctuation (Chinese 。 ？ or !; English . ? !). Do NOT impose English punctuation or capitalization on Chinese text.
7. Use the video title to spell people's names, companies, and proper nouns correctly. Keep Chinese names, titles, and proper nouns exactly as written.
8. Preserve the speaker's actual meaning and wording — polish for readability, but do NOT summarize, shorten the ideas, or add anything they didn't say.
9. Aim for 1-3 complete sentences. The final note must read as finished, grammatical sentences with no trailing fragments.

Output ONLY valid JSON: {"quote": "The cleaned passage here."}
No other text, no explanation, no markdown - just the JSON object.
```

## User prompt

```
Video: {videoTitle}

FULL CONTEXT (for reference — use this to complete any partial sentences):
{fullContext}

SENTENCES TO CLEAN:
BEFORE: "{beforeText}"
TARGET: "{targetText}"
AFTER: "{afterText}"

Return JSON with the complete thought around the TARGET moment, cleaned and combined into 1-3 finished sentences:
```

## Variables

- `{videoTitle}` — video title.
- `{fullContext}` — 8 transcript lines before through 12 lines after the target line.
- `{beforeText}` — up to 2 transcript lines immediately before the target line, joined, or `(none)`.
- `{targetText}` — the transcript line at the saved timestamp.
- `{afterText}` — up to 4 transcript lines immediately after the target line, joined, or `(none)`.

## Output format

Valid JSON object:

```json
{
  "quote": "The cleaned passage here."
}
```
