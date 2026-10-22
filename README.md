# AutoFill Agent (Firefox, Windows/Linux)

An LLM-driven form filler. Store documents (CV, insurance sheet...), open any form, click **Fill this page**.
No per-site rules: the content script describes whatever widgets it finds (inputs, selects, radios, checkboxes,
file inputs, ARIA comboboxes/dropdowns, rich-text boxes, shadow DOM, iframes) and DeepInfra's model decides what to do.

## Install
**Quick (temporary, until Firefox restarts):** `about:debugging#/runtime/this-firefox` -> *Load Temporary Add-on* -> pick `manifest.json`.

**Permanent:** Firefox Developer Edition/Nightly/ESR with `xpinstall.signatures.required = false` in `about:config`
(zip the folder contents, rename to `.xpi`, drag onto Firefox), or sign it free via `npx web-ext sign` (AMO API keys, "unlisted").
Or run it with `npx web-ext run` while developing.

## Setup
Toolbar icon -> *Settings & documents*:
1. Paste your DeepInfra API key. Check the model name against deepinfra.com/models (default `meta-llama/Llama-3.3-70B-Instruct-Turbo`).
2. Add documents. Name them plainly ("CV", "Insurance details"). The **text** is what the AI reads. `.txt/.md/.csv/.json/.docx` are read
   automatically; for PDFs paste the text (the PDF is still kept and uploaded as-is when a form asks for a file).
3. Tick *Tailor* on your CV: when a form asks for a CV, the AI rewrites it for that job (truthfully, no invented facts)
   and exports PDF or DOCX depending on the field's `accept` list, then uploads it.
4. Optional "profile notes": standing facts (notice period, salary, work authorisation, tone for written answers).

## Use
Open the form page -> toolbar icon -> tick documents -> (optional instruction) -> **Fill this page**.
A panel appears bottom-right showing progress, then a report:
- **Needs your input**: things not in your documents, consent boxes, missing files. Orange-outlined on the page; click an item to jump to it.
- **Could not fill**, **Stopped before** (the submit-type button it refused to press), **Filled**, **Uploaded**.

## How it works
Loop (up to 8 rounds): scan all frames -> LLM returns JSON actions -> execute (fill/select/check/upload/click) -> re-scan
(catches conditional fields and the next step after "Next"). Failed actions are retried with HTML snippets, visible dropdown
options, and, if nothing was found at all, a compact DOM outline; the model may then target elements by CSS selector.
Free-text answers are written by the model from the page text (role/company) plus your documents.

## Never submits
Three layers: the prompt forbids it; the content script blocks clicks on submit-like buttons (text match, or a submit button
in a form with 3+ fields); and any form `submit` event not caused by an approved Next/Continue click is cancelled during a run.

## Limits (be aware)
- Your document text and the page text are sent to DeepInfra. Do not use this with data you can't share with that provider. Check their retention policy.
- Documents are stored unencrypted in the extension's local storage, including the API key.
- Tailored CVs are plain-styled (headings/bullets), not your original layout. Untailored uploads send your original file.
- Custom widgets (fancy date pickers, canvas forms, sites that block synthetic events) may fail; the report tells you which.
- Captchas, logins and payment fields are left to you. Always review before pressing submit yourself.
- Small models mis-plan more often; try a larger one if results are poor.


Original deisgn prompt:"write some code for windows/linux that will work on firefox. it works like a browser extension, though if it needs to run from terminal or whatever i don't mind that. It can connect to deepinfra api. i don't want to tune it per site obviously, that defeats the purpose of saving time filling forms on different sites. Ideally i could store different files, like a CV or insurance detail sheet. The i open up a site, tell it to fill it in using CV, then it fills it in using dropdowns, texts, or other widgets. It can take agency, for example if asked to fill in a "why you want this role" it can read the webpage and CV and formulate a natural personalised answer, not everything will be just input exact date. If it asks for extra info or files, it will mark in a follow-up response, though if it asks for something it does have like the CV it can personalise the CV file, save as required format, then upload. Similar process for insurance forms. it can click through the page but doesn't hit final submit. Ideally if page doesn't work the ai can troubleshoot the scraping.
Looping rounds until no new fields or failures remain.

I’ll build this as a Firefox extension (Manifest V2, which Firefox still fully supports and which grants the permissions at install time). It’s generic, with no per-site rules.
Created 2 files, ran a command, shared files
Content
JS 
Docgen
JS 
Manifest
Code·JSON 

Continue
Ran 2 commands, created a file

The generators work: the PDF opens and extracts correctly, python-docx loads the DOCX, and accents and bullets survive. Next is a quick check of the scanner and fill logic against a mock form.
Ran 3 commands, shared files

The extension is built as a Firefox add-on that works on Windows and Linux, and everything is in autofill-agent.zip. I haven’t run it in Firefox or against DeepInfra. I tested the scanner and form-filling in a simulated page (text, select, radio and textarea fill; the submit button is blocked and “Next” is allowed), and checked that the PDF and DOCX generators produce files that open correctly. The file-upload step couldn’t be tested there.
Setup

    Go to about:debugging#/runtime/this-firefox and choose Load Temporary Add-on, then pick manifest.json. README.md covers permanent install options.
    Open the extension’s settings and paste your DeepInfra key. Check the model name there, because the default (meta-llama/Llama-3.3-70B-Instruct-Turbo) is a guess you should confirm on DeepInfra.
    Add your documents under their plain names (“CV”, “Insurance details”). .txt, .md, .csv, .json and .docx are read automatically. For a PDF, paste its text in as well. The PDF itself is kept and uploaded unchanged when a form asks for a file.

What it does

    No per-site rules. It reads every field on any page, including dropdowns, radios, checkboxes, file inputs, custom widgets, iframes and shadow DOM. DeepInfra’s model decides what goes in each one.
    Free-text answers. For things like “why do you want this role”, it writes a first-person answer from the page text and your documents. It won’t invent personal facts.
    Multi-step forms. It fills the page, clicks Next or Continue, rescans, and repeats for up to 8 rounds.
    CV tailoring. If a form asks for a CV and the document is marked “Tailor”, it rewrites it for that job without inventing facts. It exports a PDF or DOCX depending on what the field accepts, then uploads it. The tailored CV is plain-styled (headings and bullets), not your original layout.
    Troubleshooting. If a fill fails, it retries with the field’s HTML and the dropdown options it actually saw. If it finds no fields at all, it sends a compact outline of the page and may target elements by CSS selector instead.
    Follow-up report. A panel appears on the page with the fields that need your input, outlined in orange (click one to jump to it). It also lists files it doesn’t have, fields it couldn’t fill, and what it filled.
    Never submits. Three layers stop it. The prompt forbids it, submit-style button clicks are blocked, and any form submission it didn’t trigger is cancelled while it runs. The report names the button it refused to press.

Limitations

    Your documents and the page text go to DeepInfra, and the API key and documents are stored unencrypted locally. Be careful with insurance and health details.
    Fancy date pickers and sites that ignore synthetic events may fail. The report says which fields.
    Captchas, logins and payment fields are left to you.
    Smaller models plan less reliably, so try a bigger one if results are poor.
"
