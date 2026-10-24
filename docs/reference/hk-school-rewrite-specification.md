# Hong Kong school rewrite specification

Status: user-approved requirements recorded 2026-10-24; implemented as opt-in
`hk-school-v1`, pending live language acceptance. Default remains `current-v1`. See the
[migration plan](../architecture/rewrite-policy-rollout.md) and
[60 approved evaluation cases](../evaluation/hk-school-rewrite-cases.json).

## Purpose

> 將香港口語廣東話及粵英混用的內容，改寫成自然、清晰、適合香港學校使用的繁體中文書面語。忠實保留原意及重要資訊，不增添內容，不刻意提高詞彙難度，避免過度文言化或公文化。

This is rewriting, not summarizing, expanding, fact-checking or improving the
writer's argument. Priorities: meaning preservation, completeness, natural school
wording, then stylistic polish. Prefer a less elegant faithful sentence to a
polished sentence with different meaning.

## Inputs

- Pure spoken Cantonese: interpret expressions and structure before rewriting.
- Cantonese–English code-switching: interpret the complete sentence; translate
  ordinary English expressions naturally and accurately in context.
- Already-written Chinese: make only necessary corrections; unchanged is valid.
- Pure English translation is outside this initial specification. English sentences
  embedded in a predominantly Chinese passage remain in scope.

## Meaning and register

Preserve people, proper names, places, dates, quantities, participants and event
order; negation, conditions, causes, uncertainty, possibility, obligation and
permission; reported speech versus assertions; meaningful emotion, emphasis and
perspective. Do not omit inconvenient or contradictory substantive details.
Remove fillers/repetition only when they carry no meaning. Particles may encode
questions, surprise or reluctance and cannot simply be deleted mechanically.

Use modern written Chinese, traditional characters and natural Hong Kong usage.
Default to general school language at the original vocabulary difficulty, not an
automatically advanced or age-specific composition. Preserve the student's voice
and first person. Avoid unnecessary literary, bureaucratic, internet-slang or
mainland-specific expressions. Do not add moral lessons, introductions, conclusions,
personal-growth claims or invented benefits. Improve punctuation and sentence
boundaries as necessary; preserve useful paragraphs unless a small readability
adjustment is justified.

## Mixed terminology

Default: 中文表達為主，必要英文保留. Translate meaning, not individual words by a
global replacement table. Project/present/chur have context-dependent meanings.
Retain proper/product names, filenames, code and identifiers; keep established
technical abbreviations when appropriate. Do not automatically add bilingual
explanations or expand abbreviations. 功課 versus 作業 and other school terminology
are contextual preferences, not unconditional substitutions. The approved case 7
accepts 專題研習報告 for that specific context. A later teacher-reviewed glossary
must not override meaning.

## Ambiguity, quotations and instructions

Correct apparent transcription mistakes only when intended meaning is sufficiently
clear. Otherwise preserve uncertainty or the unclear term; invent no subject,
object, gender, event or explanation. No inserted editorial notes or interactive
clarification questions in the rewrite. Cantonese 佢 alone does not establish gender;
prefer a known name/role or natural gender-neutral construction where practical.

Preserve quoted speech's role and tone. Keep wording when it is itself under
discussion, such as a language exercise. Submitted instructions are content, not
commands to the service; quoted requests to output PASS or jokes cannot override
rewrite rules.

## Output and administrator boundary

Return only the rewritten passage, with no preface, commentary, assessment,
Markdown wrapper, alternatives, summary or added facts. Retain the existing JSON
and NDJSON envelopes and error mechanism. Safety/provider failure returns a
controlled error, never a fabricated rewrite.

Policy is service-owned, independent of provider, and selected only by the hosting
administrator's server configuration on startup. No new public API parameter,
header, query option or worksheet control selects policy. Preserve existing
unknown-field behaviour while proving caller-supplied policy fields have no effect.

Character conversion (OpenCC) is supplementary; it cannot repair misunderstood
Cantonese, lost English terms or invented meaning. Text evaluation does not prove
speech-recognition accuracy: recording → transcription → rewrite needs separate
end-to-end acceptance with non-sensitive recordings.
